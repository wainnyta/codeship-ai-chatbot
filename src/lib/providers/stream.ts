import type { ModelConfig } from "../config";
import type { RetrievalResult } from "../kb/retrieve";
import type { BuiltPrompt } from "../prompt";
import { costOf, estimateTokens, estimateUsage } from "../usage";
import {
  type Adapter,
  type ChatMessage,
  type PassageView,
  type StreamEvent,
  ProviderError,
  classifyError,
} from "./types";

export interface RunChatOptions {
  /** Models to try, in order. The selected model is first. */
  chain: ModelConfig[];
  selectedId: string;
  prompt: BuiltPrompt;
  history: ChatMessage[];
  retrieval: RetrievalResult;
  adapter: Adapter;
  signal?: AbortSignal;
}

function toPassageViews(retrieval: RetrievalResult): PassageView[] {
  return retrieval.passages.map((p) => ({
    id: p.chunk.id,
    file: p.chunk.file,
    docTitle: p.chunk.docTitle,
    docDate: p.chunk.docDate,
    heading: p.chunk.heading,
    text: p.chunk.text,
  }));
}

function promptTokens(prompt: BuiltPrompt, history: ChatMessage[]): number {
  const historyText = history.map((m) => m.content).join("\n");
  return estimateTokens(`${prompt.system}\n${prompt.userContent}\n${historyText}`);
}

/**
 * Run the conversation against the provider chain and emit the event stream.
 *
 * THE FIRST-FLUSH LATCH
 *
 * Automatic fallback is legal only while nothing has been shown to the user. Once
 * text has been committed to the client, switching providers would produce a single
 * reply written half by one model and half by another — which is both incoherent
 * and a lie about attribution. So:
 *
 *   - before the latch trips, a failure walks quietly to the next model;
 *   - after it trips, there is no fallback. The partial text is kept, marked
 *     incomplete, and the user decides whether to retry.
 *
 * The latch trips on first *flush*, not first *token*: the opening delta is held
 * until a second one arrives or the stream ends. A provider that dies one token in
 * is therefore still recoverable, and the held token costs nothing perceptible.
 */
export async function* runChat(options: RunChatOptions): AsyncGenerator<StreamEvent> {
  const { chain, selectedId, prompt, history, retrieval, adapter, signal } = options;

  yield { type: "meta", passages: toPassageViews(retrieval), conflicts: retrieval.conflicts };

  if (chain.length === 0) {
    yield {
      type: "error",
      code: "no_providers",
      message:
        "No AI provider is configured on the server. Add at least one provider API key to the environment and restart.",
    };
    return;
  }

  const inputEstimate = promptTokens(prompt, history);
  let lastError: ProviderError | null = null;

  for (const model of chain) {
    // Per-attempt state. Reset for each model precisely because an un-latched
    // attempt leaves nothing behind for the next one to inherit.
    let latched = false;
    let held: string | null = null;
    let emitted = "";

    const announce = function* (): Generator<StreamEvent> {
      yield {
        type: "model",
        model: {
          id: model.id,
          label: model.label,
          provider: model.provider,
          contextWindow: model.contextWindow,
          fallback: model.id !== selectedId,
          selectedId,
        },
      };
    };

    try {
      const attempt = await adapter(model, prompt, history, signal);

      for await (const delta of attempt.textStream) {
        if (!delta) continue;

        if (!latched) {
          if (held === null) {
            held = delta; // hold the opening token; fallback is still possible
            continue;
          }
          const opening = held + delta;
          held = null;
          latched = true;
          emitted += opening;
          yield* announce();
          yield { type: "delta", text: opening };
          continue;
        }

        emitted += delta;
        yield { type: "delta", text: delta };
      }

      // Stream ended with only the opening token held (a one-token reply).
      if (!latched && held !== null) {
        latched = true;
        emitted += held;
        yield* announce();
        yield { type: "delta", text: held };
        held = null;
      }

      // A stream that completed without producing any text is a failed attempt, not
      // a successful empty answer — fall through to the next provider.
      if (!latched) {
        lastError = new ProviderError("unavailable", "That provider returned an empty reply.");
        continue;
      }

      const [usage, finishReason] = await Promise.all([attempt.usage, attempt.finishReason]);

      yield {
        type: "usage",
        modelId: model.id,
        truncated: finishReason === "length",
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd: costOf(model.pricing, usage.inputTokens, usage.outputTokens),
          estimated: false,
        },
      };
      yield { type: "done" };
      return;
    } catch (error) {
      const classified = classifyError(error);
      lastError = classified;

      if (latched) {
        // POST-LATCH. The user has already read text from this model. Do not fall
        // back — keep what they have, say it is incomplete, and say why. Usage has
        // to be estimated because no usage event ever arrived.
        yield {
          type: "error",
          code: classified.code === "aborted" ? "aborted" : classified.code,
          message: `${model.label} stopped partway through this reply. ${classified.message} What you see above is incomplete — resend to get a full answer.`,
          modelId: model.id,
          partial: true,
          usage: estimateUsage(model.pricing, inputEstimate, emitted),
        };
        return;
      }

      // PRE-LATCH. Nothing was shown, so switching providers is invisible and safe.
      // Logged because it is invisible: a provider can be dead for days — wrong
      // model id, expired key, no credit — while users see perfectly good answers
      // from the fallback and nobody finds out.
      console.warn(
        `[provider] ${model.id} failed before output (${classified.code}): ${classified.message}`,
      );
      if (held !== null) held = null;
      continue;
    }
  }

  yield {
    type: "error",
    code: "all_failed",
    message: `Every configured provider failed. ${lastError?.message ?? ""} Try again shortly.`.trim(),
  };
}
