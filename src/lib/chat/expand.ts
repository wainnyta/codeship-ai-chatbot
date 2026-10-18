/**
 * The second pass: an LLM proposing vocabulary for words the corpus does not have.
 *
 * WHY THIS IS NOT A QUERY REWRITE
 *
 * The obvious design — on a miss, ask a model for a better query and search again —
 * has a hole that this codebase has already paid for once. If coverage is then
 * computed over the REWRITTEN terms, the expansion supplies the evidence the gate
 * demands, and "how much do I owe my landlord" comes back as every pricing table
 * in the corpus. That is the exact defect the literal-terms gate was built to close,
 * reintroduced one layer up.
 *
 * So the model does not get to say what was asked. It gets to say what the
 * documentation might CALL the things that were asked about:
 *
 *     { "cheaper": ["price", "pricing"], "landlord": [] }
 *
 * Those mappings feed the same `credited` path as the hand-written synonym table,
 * which has two structural consequences:
 *
 *   1. A mapping can only credit a term THE USER ACTUALLY TYPED. The model cannot
 *      introduce a subject, so it cannot turn a question about a landlord into a
 *      question about pricing.
 *   2. A credited term is weighted at its STAND-IN's IDF, not its own. An absent
 *      word scores maximum IDF by definition, so crediting at face value would
 *      make one lucky mapping look like overwhelming evidence.
 *
 * In effect this is the synonym table, generated per query instead of maintained
 * by hand — which is the honest answer to "we can't just keep adding words".
 */

import { REWRITE_MODEL_ID, resolveChain } from "../config";
import type { Rewriter } from "../providers/types";
import { costOf, type Usage } from "../usage";

export const EXPAND_SYSTEM = `You map words onto the vocabulary of a documentation set.

A search over NimbusStack's product documentation found nothing for the user's question. You are given the words from that question which appear in NO document. For each one, suggest words the documentation would plausibly use instead.

NimbusStack documents four products — Nimbus Relay, Nimbus Vault, Nimbus Pulse and Nimbus Ledger — covering features, pricing tiers, integrations, support SLAs and troubleshooting.

RULES
- Reply with JSON only: an object mapping each given word to an array of up to 3 lowercase single words. No prose, no code fence.
- Use ONLY the words you were given as keys. Do not add keys.
- Map a word only when you are confident the documentation expresses the SAME idea in different words. "cheaper" means price, so ["price","pricing"]. "sso" means federated sign-in, so ["saml","oidc","federated"].
- Map a word to [] when it is not about software product documentation at all — "landlord", "weather", "dentist" — or when you would only be guessing. An empty array is the correct and expected answer for most words. Guessing here produces a confident answer to a question these documents cannot answer, which is the worst outcome this system can produce.
- Never map a word to a product name. Scope is decided elsewhere.

Example input:  ["cheaper","landlord"]
Example output: {"cheaper":["price","pricing"],"landlord":[]}`;

export interface ExpansionResult {
  /** Validated mappings: every key was in `unmatched`, every value non-empty. */
  synonyms: Record<string, string[]>;
  modelId: string | null;
  usage: Usage | null;
}

const EMPTY: ExpansionResult = { synonyms: {}, modelId: null, usage: null };

/** The reasons a second pass can possibly help. */
export const RETRYABLE_REASONS = new Set(["no_match", "below_coverage"]);

/**
 * Whether a failed retrieval is worth a second pass.
 *
 * `identifier_absent` is deliberately excluded and must stay so. It means the
 * reader named a version, status code or priority that no document carries —
 * a fact about the corpus, not a problem with their wording. Retrying there would
 * search around a thing that provably is not documented until something turned up,
 * which is how an honest refusal becomes a confident wrong answer.
 */
export function shouldRetry(reason: string): boolean {
  return RETRYABLE_REASONS.has(reason);
}

/**
 * Accept only what the model was entitled to say.
 *
 * Keys outside `unmatched` are dropped rather than trusted: the one thing this
 * call must not be able to do is introduce a word the user never typed.
 */
export function acceptExpansion(raw: string, unmatched: string[]): Record<string, string[]> {
  const allowed = new Set(unmatched.map((t) => t.toLowerCase()));
  const text = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A model that answered in prose has told us nothing usable. Searching on it
    // would be worse than the refusal we already have.
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const term = key.toLowerCase();
    if (!allowed.has(term)) continue; // invented key
    if (!Array.isArray(value)) continue;

    const mapped = value
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.toLowerCase().trim())
      .filter((v) => /^[a-z0-9][a-z0-9.-]*$/.test(v) && v !== term)
      .slice(0, 3);

    if (mapped.length) out[term] = mapped;
  }
  return out;
}

export interface ExpandOptions {
  unmatched: string[];
  rewriter?: Rewriter;
  signal?: AbortSignal;
}

/**
 * One short call, on a path that has already failed.
 *
 * Costs nothing on the common case because it only runs after a refusal, and the
 * worst case is the refusal we would have given anyway.
 */
export async function proposeVocabulary(options: ExpandOptions): Promise<ExpansionResult> {
  const { unmatched, rewriter, signal } = options;
  if (!rewriter || unmatched.length === 0) return EMPTY;

  for (const model of resolveChain(REWRITE_MODEL_ID)) {
    try {
      const { text, usage, finishReason } = await rewriter(
        model,
        EXPAND_SYSTEM,
        JSON.stringify(unmatched),
        signal,
      );

      const spend: Usage = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: costOf(model.pricing, usage.inputTokens, usage.outputTokens),
        estimated: false,
      };

      // Truncated JSON is unparseable anyway, but say so rather than discovering
      // it as an empty object.
      if (finishReason === "length") {
        console.warn(`[expand] ${model.id} was cut off before finishing the mapping.`);
        return { synonyms: {}, modelId: model.id, usage: spend };
      }

      return { synonyms: acceptExpansion(text, unmatched), modelId: model.id, usage: spend };
    } catch (error) {
      console.warn(
        `[expand] ${model.id} could not propose vocabulary (${(error as Error)?.message ?? "unknown error"}).`,
      );
    }
  }

  return EMPTY;
}
