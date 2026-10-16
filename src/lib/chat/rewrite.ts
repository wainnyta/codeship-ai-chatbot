import { REWRITE_MODEL_ID, resolveChain, type ModelConfig } from "../config";
import { hasMeaningfulTerm } from "../kb/retrieve";
import type { ChatMessage, Rewriter } from "../providers/types";
import { type Usage, costOf, sumUsage } from "../usage";

/**
 * Query rewriting: turn a follow-up question into a standalone search query.
 *
 * WHY THIS EXISTS
 *
 * Retrieval needs a self-contained query. Conversation does not supply one —
 * "how can I use it" carries its subject in the previous turn, and "and for
 * Vault?" carries its whole topic there. The previous approach resolved this by
 * string matching: find a product name in the question, and failing that, reuse
 * the last product named in the history. That resolves one noun and discards
 * everything else, so "how can I use it" reached the index as `use`, matched
 * nothing, and was refused.
 *
 * Coreference is semantic, so a model resolves it and a heuristic cannot. This is
 * the standard pre-retrieval step in conversational RAG, and it is what a
 * tool-calling assistant does implicitly when it writes its own search query: the
 * difference is only that here the query is written by a separate cheap call,
 * because R2 requires retrieval to happen before the answering model runs.
 *
 * THE SAFETY PROPERTY
 *
 * The rewritten query is used for retrieval and nothing else. The answering model
 * still receives the user's question verbatim and the real conversation history.
 * A bad rewrite therefore degrades which passages are found; it can never change
 * what the model was asked, or what it is permitted to claim. Every failure mode
 * below — provider down, empty output, the model explaining itself instead of
 * answering — falls back to the original question and the old heuristic carry, so
 * the worst case is the behaviour we had before.
 */

export const REWRITE_SYSTEM = `You rewrite the latest question in a conversation into a standalone search query.

The conversation is between a NimbusStack employee and an internal product assistant. NimbusStack sells four products: Nimbus Relay, Nimbus Vault, Nimbus Pulse and Nimbus Ledger.

RULES
- Replace pronouns and implicit references ("it", "that one", "the Pro tier") with the specific thing the earlier messages show they mean.
- Carry over the product name AND the topic when the question leaves them out. "How can I use it" after a question about Relay becomes a query about using Nimbus Relay; "and for Vault?" after a question about P1 response times becomes a query about Vault's P1 response times.
- Never write a query that excludes something. A keyword index cannot express "not this": a query saying "other than Nimbus Vault" retrieves Vault's documents and nothing else, which is the opposite of what was asked. When the question asks about the products OTHER than one already discussed, name the products it is asking about instead — "any other product with a monthly plan", after a question about Vault, becomes a query naming Nimbus Relay, Nimbus Pulse and Nimbus Ledger.
- Keep the user's own wording everywhere else. Do not answer the question, explain your reasoning, add detail the conversation does not support, or introduce product names nobody mentioned.
- If the question already stands alone, repeat it unchanged.
- Output the query on a single line, and output nothing else.`;

/** Enough history to resolve a reference; not enough to make this call expensive. */
const MAX_HISTORY_MESSAGES = 6;
/** Assistant replies are long and only their subject matter is needed here. */
const MAX_MESSAGE_CHARS = 400;
/** A rewrite longer than this is the model explaining itself, not a query. */
export const MAX_QUERY_CHARS = 200;

export function buildRewriteInput(question: string, history: ChatMessage[]): string {
  const recent = history.slice(-MAX_HISTORY_MESSAGES).map((m) => {
    const flat = m.content.replace(/\s+/g, " ").trim();
    const text = flat.length > MAX_MESSAGE_CHARS ? `${flat.slice(0, MAX_MESSAGE_CHARS)}…` : flat;
    return `${m.role === "user" ? "User" : "Assistant"}: ${text}`;
  });

  return `CONVERSATION SO FAR:
${recent.join("\n")}

LATEST QUESTION: ${question}

STANDALONE QUERY:`;
}

/**
 * Decide whether to trust what came back, structurally rather than semantically.
 *
 * Judging a rewrite's *meaning* would need another model call, and getting that
 * wrong costs more than the rewrite does. These checks only catch the shapes that
 * are definitely not a query — nothing, or an essay. Anything else is accepted,
 * which is affordable precisely because a wrong query cannot produce a wrong
 * claim: it can only retrieve the wrong passages, and the answer is still bound to
 * whatever passages arrive.
 */
export function acceptRewrite(question: string, raw: string): string {
  const firstLine = raw.split("\n").find((line) => line.trim().length > 0) ?? "";
  const unquoted = firstLine.trim().replace(/^["'`\s]+|["'`\s]+$/g, "");

  if (!unquoted) return question;
  if (unquoted.length > MAX_QUERY_CHARS) return question;
  // Nothing the index can match on. Searching it is worse than searching the
  // question as typed, because it scores evenly against every document and lets
  // whichever one ranks first decide the topic.
  if (!hasMeaningfulTerm(unquoted)) return question;
  return unquoted;
}

/** What retrieval searched for, and what resolving it cost. */
export interface ResolvedQuery {
  query: string;
  /** True when the query differs from what the user typed. */
  rewritten: boolean;
  /** The model that rewrote it, or null when no rewrite happened. */
  modelId: string | null;
  /** Null when no call was made, or when a failed call reported no usage. */
  usage: Usage | null;
}

export interface ResolveQueryOptions {
  question: string;
  history: ChatMessage[];
  rewriter?: Rewriter;
  signal?: AbortSignal;
}

/** Attempts that reached a provider, so their tokens are reported even if rejected. */
interface Spend {
  model: ModelConfig;
  usage: Usage;
}

function report(query: string, question: string, spent: Spend[]): ResolvedQuery {
  return {
    query,
    rewritten: query !== question,
    modelId: spent.at(-1)?.model.id ?? null,
    usage: spent.length ? sumUsage(spent.map((s) => s.usage)) : null,
  };
}

export async function resolveQuery(options: ResolveQueryOptions): Promise<ResolvedQuery> {
  const { question, history, rewriter, signal } = options;

  // The first question in a conversation has nothing to resolve against, which is
  // also the common case — so the common case pays nothing.
  if (!rewriter || history.length === 0) return report(question, question, []);

  const input = buildRewriteInput(question, history);

  /**
   * This call falls back across providers like every other one (R3, R5), and for a
   * sharper reason than the answering call: it is load-bearing. A question like
   * "how can I use it" reaches the index as `use` without it, matches nothing, and
   * is honestly refused — so an unavailable rewrite provider does not produce a
   * worse answer, it produces no answer. Falling back is cheap here because
   * nothing is streamed and nothing has been shown, so there is no latch to
   * respect: a failed attempt costs one more short call and is invisible.
   */
  const spent: Spend[] = [];

  for (const model of resolveChain(REWRITE_MODEL_ID)) {
    try {
      const { text, usage, finishReason } = await rewriter(model, REWRITE_SYSTEM, input, signal);

      spent.push({
        model,
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd: costOf(model.pricing, usage.inputTokens, usage.outputTokens),
          estimated: false,
        },
      });

      /**
       * A cut-off reply is a half-written query that still looks like a whole one,
       * and that is the worst possible shape for this value: "and for relay?"
       * truncated to "What" scored evenly against the corpus and silently kept the
       * PREVIOUS product's documents, producing a confident "not documented" about
       * the wrong product. There is nothing to salvage from a prefix, so this is a
       * failed attempt — try the next provider.
       */
      if (finishReason === "length") {
        console.warn(`[rewrite] ${model.id} was cut off before finishing the query.`);
        continue;
      }

      return report(acceptRewrite(question, text), question, spent);
    } catch (error) {
      // Logged because it is otherwise invisible: the next provider answers, and a
      // dead rewrite model stays dead for days while follow-ups get quietly worse.
      console.warn(
        `[rewrite] ${model.id} could not rewrite the query (${(error as Error)?.message ?? "unknown error"}).`,
      );
    }
  }

  // Every provider failed. Search the question as typed: the same behaviour as
  // before rewriting existed, which for a dependent follow-up means an honest
  // refusal rather than an answer to a question nobody asked.
  return report(question, question, spent);
}
