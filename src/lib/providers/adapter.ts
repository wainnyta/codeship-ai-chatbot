import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText, type LanguageModel } from "ai";
import type { ModelConfig } from "../config";
import { ProviderError, type Adapter, type Rewriter } from "./types";

/**
 * The only place in the application where a provider API key is read.
 *
 * Nothing in this module is importable from a client component, and no key is ever
 * placed in a response body, a prop, or a NEXT_PUBLIC_* variable — which is what
 * makes "API keys never reach the browser" (R5) a property of the architecture
 * rather than something to remember.
 */
function languageModel(model: ModelConfig): LanguageModel {
  const apiKey = process.env[model.apiKeyEnvVar];
  if (!apiKey) {
    throw new ProviderError("auth", `${model.label} has no API key configured on the server.`);
  }

  switch (model.provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(model.id);
    case "openai":
      return createOpenAI({ apiKey })(model.id);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(model.id);
    default: {
      const exhaustive: never = model.provider;
      throw new ProviderError("unavailable", `Unknown provider "${exhaustive}".`);
    }
  }
}

export const liveAdapter: Adapter = async (model, prompt, history, signal) => {
  // streamText does NOT throw provider errors out of `textStream` — it reports them
  // to `onError` and ends the stream cleanly. Without capturing them here, a 429 or
  // a dead model is indistinguishable from a model that simply said nothing, every
  // error message degrades to "returned an empty reply", and the whole error
  // classification layer is unreachable in production.
  let streamError: unknown = null;

  const result = streamText({
    onError: ({ error }) => {
      streamError = error;
    },
    model: languageModel(model),
    system: prompt.system,
    messages: [
      ...history.map((m) => ({ role: m.role, content: m.content }) as const),
      { role: "user" as const, content: prompt.userContent },
    ],
    maxOutputTokens: model.maxOutputTokens,
    abortSignal: signal,
    // Config is plain JSON by construction; the SDK wants its own JSONValue shape.
    providerOptions: model.providerOptions as Parameters<typeof streamText>[0]["providerOptions"],
  });

  /**
   * Re-raise a captured provider error once the underlying stream ends.
   *
   * Throwing here rather than swallowing it keeps the latch honest: an error
   * raised before any delta is pre-latch and falls back silently; one raised after
   * deltas is post-latch and keeps the partial reply. The position of the throw is
   * what preserves that distinction.
   */
  async function* guarded(): AsyncIterable<string> {
    for await (const delta of result.textStream) yield delta;
    if (streamError) throw streamError;
  }

  return {
    textStream: guarded(),
    // The SDK reports these as possibly undefined; a missing count is reported as
    // zero rather than NaN, which would poison the session totals.
    usage: Promise.resolve(result.usage).then((u) => ({
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
    })),
    finishReason: Promise.resolve(result.finishReason).then((r) => String(r)),
  };
};

/**
 * The live query rewriter. Non-streaming on purpose: nothing waits on its first
 * token, only on its last, so streaming would add machinery and no benefit.
 *
 * Errors are thrown rather than classified. The caller treats every failure
 * identically — search the question as typed — so there is nothing for a code or a
 * user-facing message to change, and this call must never surface to the reader.
 * The output cap is low because the output is one line; a model that ignores that
 * is cut off rather than billed for an essay.
 */
export const liveRewriter: Rewriter = async (model, system, userContent, signal) => {
  const result = await generateText({
    model: languageModel(model),
    system,
    prompt: userContent,
    /**
     * Generous for a one-line answer because on models that cannot disable
     * thinking, reasoning tokens are billed as output and spend this budget before
     * a single visible character is produced. At 120 this silently truncated
     * Gemini's query to its first word. The real cost control is that the output
     * IS one line: typical spend is ~15 visible tokens plus whatever the model
     * thinks, not this ceiling.
     */
    maxOutputTokens: 512,
    abortSignal: signal,
    providerOptions: model.providerOptions as Parameters<typeof generateText>[0]["providerOptions"],
  });

  return {
    text: result.text,
    usage: {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    },
    finishReason: String(result.finishReason),
  };
};
