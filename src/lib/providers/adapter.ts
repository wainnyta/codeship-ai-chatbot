import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type LanguageModel } from "ai";
import type { ModelConfig } from "../config";
import { ProviderError, type Adapter } from "./types";

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
  const result = streamText({
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

  return {
    textStream: result.textStream,
    // The SDK reports these as possibly undefined; a missing count is reported as
    // zero rather than NaN, which would poison the session totals.
    usage: Promise.resolve(result.usage).then((u) => ({
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
    })),
    finishReason: Promise.resolve(result.finishReason).then((r) => String(r)),
  };
};
