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

/**
 * The second provider call: a short, non-streaming completion used to rewrite a
 * follow-up question into a standalone search query.
 *
 * Deliberately a separate type from Adapter rather than a mode of it. It produces
 * no reader-visible text, it is not streamed, it never falls back, and it must
 * never be able to fail a question — so sharing Adapter's latch, chain and
 * classification machinery would mean sharing guarantees it does not need and
 * cannot honour. Tests inject a fake here exactly as they do for Adapter; omitting
 * it disables rewriting entirely, which is also the production degradation path.
 */
export type Rewriter = (
  model: ModelConfig,
  system: string,
  userContent: string,
  signal?: AbortSignal,
) => Promise<{
  text: string;
  usage: ProviderUsage;
  /**
   * "length" when the model was cut off before finishing. Reported because a
   * truncated rewrite is a half-written query that still looks like a whole one.
   */
  finishReason: string;
}>;

/** How the question reaching retrieval was produced, and what that cost (R4). */
export interface RewriteView {
  /** The standalone query retrieval actually searched for. */
  query: string;
  modelId: string;
  usage: Usage;
}

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
  | {
      type: "meta";
      passages: PassageView[];
      conflicts: Array<[string, string]>;
      /**
       * Present only when a rewrite changed the question. The reader is shown what
       * was searched for, because a resolved follow-up is retrieving against words
       * they never typed and an unexplained passage list would look arbitrary.
       */
      rewrite?: RewriteView;
      /**
       * Why nothing was retrieved, when the retriever can say precisely.
       *
       * Produced by the retriever from the index, never by the model, and rendered
       * as-is. "I can only answer questions pertaining to the NimbusStack knowledge
       * base" is true but tells a support engineer nothing; "Nimbus Vault has no
       * version 4.2 — the documentation covers 2.8, 3.0, 3.1 and 3.2" is the same
       * refusal with the reason attached, and it is a fact about the corpus rather
       * than a generated claim.
       */
      notice?: string;
      /**
       * Present when a first pass found nothing and a second was attempted: what
       * it cost, and which of the reader's words it found documentation vocabulary
       * for. Reported whether or not the retry succeeded — the tokens were spent.
       */
      retry?: { modelId: string; usage: Usage; mapped: string[] };
    }
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
  // 402 is how Google reports a key with no billing attached; Anthropic reports the
  // same condition as a 400 whose body mentions the credit balance. Both are "the
  // account cannot pay", which is an operator problem, not something a user can retry.
  if (
    status === 402 ||
    text.includes("quota") ||
    text.includes("credit balance") ||
    text.includes("insufficient") ||
    text.includes("billing")
  ) {
    return new ProviderError(
      "quota",
      "That provider's account has no credit or billing set up. Another model may still work.",
    );
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
