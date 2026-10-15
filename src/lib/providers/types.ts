import type { ModelConfig } from "../config";
import type { BuiltPrompt } from "../prompt";
import type { Usage } from "../usage";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

/** One in-flight generation from a single provider. */
export interface StreamAttempt {
  textStream: AsyncIterable<string>;
  /** Resolves once the stream completes. Never resolves if the stream throws. */
  usage: Promise<ProviderUsage>;
  /** "stop", "length" (hit the output cap), or whatever the provider reports. */
  finishReason: Promise<string>;
}

/**
 * The substitution point for tests. The real implementation calls a provider over
 * the network; tests pass a fake, which is what makes the chat endpoint testable
 * without network access, API keys, or non-deterministic output.
 */
export type Adapter = (
  model: ModelConfig,
  prompt: BuiltPrompt,
  history: ChatMessage[],
  signal?: AbortSignal,
) => Promise<StreamAttempt>;

export type ErrorCode =
  | "auth"
  | "rate_limit"
  | "unavailable"
  | "quota"
  | "context_too_long"
  | "no_providers"
  | "all_failed"
  | "aborted"
  | "empty_input";

export interface PassageView {
  id: string;
  file: string;
  docTitle: string;
  docDate: string | null;
  heading: string;
  text: string;
}

export interface AnsweringModel {
  id: string;
  label: string;
  provider: string;
  contextWindow: number;
  /** True when this is not the model the user selected, i.e. a fallback was used. */
  fallback: boolean;
  selectedId: string;
}

export type StreamEvent =
  /** Passages first, so sources render before the answer and survive a dead stream. */
  | { type: "meta"; passages: PassageView[]; conflicts: Array<[string, string]> }
  /** Which model actually answered. Emitted once the first text is committed. */
  | { type: "model"; model: AnsweringModel }
  | { type: "delta"; text: string }
  | { type: "usage"; usage: Usage; modelId: string; truncated: boolean }
  | { type: "done" }
  | {
      type: "error";
      code: ErrorCode;
      message: string;
      modelId?: string;
      /** True when text was already shown; the partial reply must be kept and marked. */
      partial?: boolean;
      usage?: Usage;
    };

export class ProviderError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Map whatever a provider SDK threw onto a code and a message a user can act on.
 * Users see "wait 30 seconds or switch model", never a stack trace (E9).
 */
export function classifyError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;

  const err = error as { statusCode?: number; status?: number; message?: string; responseBody?: string };
  const status = err?.statusCode ?? err?.status;
  const text = `${err?.message ?? ""} ${err?.responseBody ?? ""}`.toLowerCase();

  const retryAfter = /retry[- ]after["\s:]*(\d+)/.exec(text);
  const retryAfterSeconds = retryAfter ? Number(retryAfter[1]) : undefined;

  if (status === 401 || status === 403 || text.includes("api key") || text.includes("unauthorized")) {
    return new ProviderError("auth", "That provider rejected our credentials.");
  }
  if (status === 429 || text.includes("rate limit") || text.includes("too many requests")) {
    return new ProviderError(
      "rate_limit",
      retryAfterSeconds
        ? `That provider is rate-limited. Try again in about ${retryAfterSeconds} seconds, or switch to another model from the dropdown.`
        : "That provider is rate-limited right now. Wait a moment and resend, or switch to another model from the dropdown.",
      retryAfterSeconds,
    );
  }
  if (text.includes("quota") || text.includes("credit balance") || text.includes("insufficient")) {
    return new ProviderError("quota", "That provider's account is out of credit.");
  }
  if (text.includes("context") && (text.includes("too long") || text.includes("exceed"))) {
    return new ProviderError(
      "context_too_long",
      "This conversation is too long for the selected model. Start a New Conversation, or pick a model with a larger context window.",
    );
  }
  if (status === 404 || text.includes("model not found") || text.includes("does not exist")) {
    return new ProviderError("unavailable", "That model is not available on this account.");
  }
  if (status !== undefined && status >= 500) {
    return new ProviderError("unavailable", "That provider is having an outage.");
  }

  return new ProviderError("unavailable", "That provider could not be reached.");
}
