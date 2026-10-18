/**
 * The second pass: an LLM deciding, for each word that matched nothing, whether
 * the reader MISSPELLED it or the documentation simply calls it something else.
 *
 * WHY THIS IS NOT A QUERY REWRITE
 *
 * The obvious design — on a miss, ask a model for a better query and search again
 * — has a hole this codebase has already paid for once. If coverage is then
 * computed over the REWRITTEN terms, the expansion supplies the evidence the gate
 * demands, and "how much do I owe my landlord" comes back as every pricing table
 * in the corpus. That is the exact defect the literal-terms gate was built to
 * close, reintroduced one layer up.
 *
 * So the model never gets to say what was asked. It gets two narrower powers, and
 * is trusted with neither:
 *
 *   SPELLING   { "wr": "we" }   — the reader's own word, spelled right. Verified
 *     against an edit budget in kb/spelling.ts, so "landlord" -> "pricing" is
 *     rejected at 8 edits however the model labels it. Checked again inside the
 *     retriever, where the repair is actually applied, because a guard that lives
 *     only at the parse site protects only the callers that go through it.
 *
 *   VOCABULARY { "cheaper": ["price","pricing"] } — what the documentation might
 *     CALL the thing asked about. Feeds the same `credited` path as the
 *     hand-written synonym table, so a mapping can only vouch for a word the
 *     reader typed, weighted at its stand-in's IDF rather than its own.
 *
 * WHY THE SPLIT IS NOT COSMETIC
 *
 * The two failures want opposite treatment. A vocabulary gap means the word is
 * absent but its meaning is not, so the word stays and is credited. A misspelling
 * means the word was never the one intended, so it is REPLACED in the sentence and
 * everything downstream sees what the reader meant — the stopword filter above
 * all. Credit "wr" and it sits in the coverage denominator at maximum idf; repair
 * it to "we" and it leaves the denominator entirely, which is the difference
 * between refusing at 0.259 and answering at 1.000.
 *
 * WHY A MODEL AND NOT A RULE
 *
 * A rule was written first and deleted. Comparing short out-of-vocabulary words to
 * the stopword list by edit distance fixes "wr" and also deletes "os" from "what
 * os does Pulse need", turning a correct refusal into a false grounding — both are
 * two letters, df 0, one edit from a function word, and arithmetically identical.
 * It deletes "sso" for the same reason. Only the sentence says which is a typo,
 * and only a reader of the sentence can say so. The guards (guard-acronym-absent,
 * guard-sso-not-typo) are kept as standing checks against reinventing it.
 *
 * In effect this is the synonym table and a spell-checker, both generated per
 * query instead of maintained by hand — which is the honest answer to "we can't
 * just keep adding words".
 */

import { REWRITE_MODEL_ID, resolveChain } from "../config";
import { isRepair } from "../kb/spelling";
import type { Rewriter } from "../providers/types";
import { costOf, type Usage } from "../usage";

export const EXPAND_SYSTEM = `You map words onto the vocabulary of a documentation set.

A search over NimbusStack's product documentation found nothing for the user's question. You are given the words from that question which appear in NO document. For each one, suggest words the documentation would plausibly use instead.

NimbusStack documents four products — Nimbus Relay, Nimbus Vault, Nimbus Pulse and Nimbus Ledger — covering features, pricing tiers, integrations, support SLAs and troubleshooting.

Each word is either MISSPELLED or simply absent from these documents, and you decide which.

RULES
- Reply with JSON only, no prose and no code fence, shaped:
  {"spelling": {"word": "correction"}, "vocabulary": {"word": ["term","term"]}}
- Use ONLY the words you were given as keys, in either object. Do not add keys.
- "spelling" is for a word the reader MISTYPED. Give the word they meant, judged from the sentence. Include function words: "do wr have" is "we", "cheaper thn Pulse" is "than". A correction must be the same word correctly spelled, never a different word — corrections more than a character or two away are discarded.
- "vocabulary" is for a correctly spelled word the documentation expresses differently. "cheaper" means price, so ["price","pricing"]. "sso" means federated sign-in, so ["saml","oidc","federated"].
- Put a word in NEITHER object when it is spelled correctly and simply is not what these documents are about — "landlord", "weather", "dentist" — or when you would only be guessing. That is the correct and expected answer for most words. Guessing produces a confident answer to a question these documents cannot answer, which is the worst outcome this system can produce.
- An unfamiliar short word is usually an acronym, not a typo. "what os does Pulse need" asks about an operating system; leave "os" alone rather than making it "of".
- Never map a word to a product name. Scope is decided elsewhere.

The sentence is given so you can tell these apart. Read it.

Example input:  {"question":"how many products do wr have","unmatched":["wr"]}
Example output: {"spelling":{"wr":"we"},"vocabulary":{}}

Example input:  {"question":"how much do I owe my landlord","unmatched":["owe","landlord"]}
Example output: {"spelling":{},"vocabulary":{}}`;

export interface ExpansionResult {
  /** Validated mappings: every key was in `unmatched`, every value non-empty. */
  synonyms: Record<string, string[]>;
  /**
   * Validated spelling repairs: every key was in `unmatched`, and every value is
   * within an edit budget of its key. See src/lib/kb/spelling.ts — the budget is
   * what separates a repair from a substitution, and it is checked here rather
   * than asked for in the prompt.
   */
  repairs: Record<string, string>;
  modelId: string | null;
  usage: Usage | null;
}

const EMPTY: ExpansionResult = { synonyms: {}, repairs: {}, modelId: null, usage: null };

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
export function acceptExpansion(
  raw: string,
  unmatched: string[],
): { synonyms: Record<string, string[]>; repairs: Record<string, string> } {
  const allowed = new Set(unmatched.map((t) => t.toLowerCase()));
  const none = { synonyms: {}, repairs: {} };
  const text = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A model that answered in prose has told us nothing usable. Searching on it
    // would be worse than the refusal we already have.
    return none;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return none;
  const body = parsed as Record<string, unknown>;

  const synonyms: Record<string, string[]> = {};
  const vocab = body.vocabulary;
  if (vocab && typeof vocab === "object" && !Array.isArray(vocab)) {
    for (const [key, value] of Object.entries(vocab as Record<string, unknown>)) {
      const term = key.toLowerCase();
      if (!allowed.has(term)) continue; // invented key
      if (!Array.isArray(value)) continue;

      const mapped = value
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.toLowerCase().trim())
        .filter((v) => /^[a-z0-9][a-z0-9.-]*$/.test(v) && v !== term)
        .slice(0, 3);

      if (mapped.length) synonyms[term] = mapped;
    }
  }

  /**
   * A repair is accepted on ARITHMETIC, not on the model having been told the rule.
   * `isRepair` rejects anything further than an edit budget from the word it
   * claims to repair, so "landlord" -> "pricing" cannot pass however the model
   * labels it. A word cannot be both repaired and mapped; spelling wins, because
   * a misspelling is not a vocabulary gap.
   */
  const repairs: Record<string, string> = {};
  const spelling = body.spelling;
  if (spelling && typeof spelling === "object" && !Array.isArray(spelling)) {
    for (const [key, value] of Object.entries(spelling as Record<string, unknown>)) {
      const term = key.toLowerCase();
      if (!allowed.has(term) || typeof value !== "string") continue;
      const fix = value.toLowerCase().trim();
      if (!isRepair(term, fix)) continue;
      repairs[term] = fix;
      delete synonyms[term];
    }
  }

  return { synonyms, repairs };
}

export interface ExpandOptions {
  /** The question as typed. The model needs it to tell a typo from an acronym. */
  question: string;
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
  const { question, unmatched, rewriter, signal } = options;
  if (!rewriter || unmatched.length === 0) return EMPTY;

  for (const model of resolveChain(REWRITE_MODEL_ID)) {
    try {
      const { text, usage, finishReason } = await rewriter(
        model,
        EXPAND_SYSTEM,
        JSON.stringify({ question, unmatched }),
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
        return { synonyms: {}, repairs: {}, modelId: model.id, usage: spend };
      }

      return { ...acceptExpansion(text, unmatched), modelId: model.id, usage: spend };
    } catch (error) {
      console.warn(
        `[expand] ${model.id} could not propose vocabulary (${(error as Error)?.message ?? "unknown error"}).`,
      );
    }
  }

  return EMPTY;
}
