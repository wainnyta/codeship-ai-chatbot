import type { ModelConfig } from "../config";
import type { RetrievalResult } from "../kb/retrieve";
import type { BuiltPrompt } from "../prompt";
import { costOf, estimateTokens, estimateUsage } from "../usage";
import {
  type Adapter,
  type ChatMessage,
  type PassageView,
  type RewriteView,
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
  /** Present when a rewrite call was made, so its cost is reported (R4). */
  rewrite?: RewriteView;
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
  const { chain, selectedId, prompt, history, retrieval, adapter, rewrite, signal } = options;

  yield {
    type: "meta",
    passages: toPassageViews(retrieval),
    conflicts: retrieval.conflicts,
    ...(rewrite ? { rewrite } : {}),
  };

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
  const failures: ProviderError[] = [];

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
        failures.push(new ProviderError("unavailable", "That provider returned an empty reply."));
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
      failures.push(classified);

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
      // Nobody is reading any more, so trying the next model spends a provider
      // call on an answer that cannot be delivered.
      if (signal?.aborted) break;
      continue;
    }
  }

  yield { type: "error", code: "all_failed", message: exhausted(failures) };
}

/**
 * What to say once every model in the chain has been tried.
 *
 * The messages `classifyError` writes are written for an attempt, and read as
 * advice because another attempt is usually about to happen: "Another model may
 * still work" is useful when one is next in line and false once none is. The old
 * ending pasted one of them between "Every configured provider failed" and "Try
 * again shortly", which in the case that actually happens — a conversation too
 * long for every window — reported an outage that was not occurring and gave
 * three remedies, two of which could not work.
 *
 * Nothing failed there. It does not fit, and waiting will not help. So the ending
 * is named by what the providers agreed on, and recommends waiting only where
 * waiting is capable of helping.
 */
function exhausted(failures: ProviderError[]): string {
  const first = failures[0];

  // They disagreed, so there is no single story to tell. Say what was tried and
  // report the last reason verbatim rather than inventing a summary of several.
  if (!first || !failures.every((f) => f.code === first.code)) {
    return `Every configured model was tried and none could answer. ${failures.at(-1)?.message ?? ""}`.trim();
  }

  switch (first.code) {
    // Every window has now been tried, so "pick a model with a larger one" —
    // which is the right advice for one model — has stopped being advice at all.
    case "context_too_long":
      return "This conversation is too long for every configured model. Start a New Conversation, or ask this as a shorter question.";

    case "rate_limit": {
      // Any one of them answering is enough, so the soonest a resend can work is
      // the shortest wait asked for, not the longest. Where no provider said,
      // say nothing rather than guess a number someone will sit and wait out.
      const waits = failures
        .map((f) => f.retryAfterSeconds)
        .filter((n): n is number => typeof n === "number");
      return waits.length
        ? `Every configured provider is rate-limited. The soonest any of them will take another request is about ${Math.min(...waits)} seconds from now.`
        : "Every configured provider is rate-limited right now. Wait a moment and resend.";
    }

    // Neither of these is the reader's to fix, and neither improves by waiting,
    // so they say so instead of suggesting a remedy that belongs to someone else.
    case "auth":
      return "No configured provider accepted its API key. The keys on the server need attention — this is not something that can be fixed from here.";
    case "quota":
      return "No configured provider has credit left. The provider accounts need attention — this is not something that can be fixed from here.";

    case "unavailable":
      return "No configured provider could be reached. Try again shortly.";

    default:
      return `Every configured model was tried and none could answer. ${first.message}`;
  }
}
