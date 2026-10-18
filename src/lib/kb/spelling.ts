/**
 * Accepting a model's spelling repair, without accepting a model's opinion.
 *
 * A second pass that may rewrite the question is the design this codebase has paid
 * for once: if coverage is then computed over the rewritten terms, the rewrite
 * supplies the evidence the gate demands, and "how much do I owe my landlord"
 * comes back as every pricing table in the corpus.
 *
 * A SPELLING repair is a different thing from a semantic rewrite, and the
 * difference is measurable rather than a matter of trust. Repairing "wr" to "we"
 * changes the surface form of a word the reader typed. Replacing "landlord" with
 * "pricing" introduces a subject they did not. Edit distance separates the two
 * exactly:
 *
 *     wr       -> we        1 edit    accepted
 *     thn      -> than      1 edit    accepted
 *     pricng   -> pricing   1 edit    accepted
 *     landlord -> pricing   8 edits   REJECTED
 *     weather  -> sla       7 edits   REJECTED
 *
 * So the model proposes and this verifies. The guarantee is structural: every
 * token of a retried query is either unchanged or within the budget below of the
 * token the reader actually typed, which makes introducing a subject arithmetically
 * impossible rather than merely discouraged by a prompt.
 *
 * This is the piece the hand-written rules could not do. A rule comparing short
 * words to the stopword list cannot tell "wr" in "do wr have" from "os" in "what
 * os does Pulse need" — both are two letters, both absent from the corpus, both
 * one edit from a function word. Only the sentence says which is a typo, and only
 * a reader of the sentence can say so.
 */

/** Levenshtein distance, stopping once it cannot come in under `budget`. */
export function editDistance(a: string, b: string, budget: number): number {
  if (Math.abs(a.length - b.length) > budget) return budget + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const d = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      row.push(d);
      if (d < best) best = d;
    }
    if (best > budget) return budget + 1;
    prev = row;
  }
  return prev[b.length];
}

/**
 * How far a repair may travel from the word it repairs.
 *
 * Scaled by length, because one edit in a two-letter word is half of it while one
 * edit in "integraton" is noise. Deliberately tight: a repair that needs three
 * edits is not a repair.
 */
export function repairBudget(word: string): number {
  if (word.length <= 4) return 1;
  if (word.length <= 8) return 2;
  return 3;
}

/** Whether `to` is a plausible SPELLING repair of `from`, rather than a different word. */
export function isRepair(from: string, to: string): boolean {
  const a = from.toLowerCase();
  const b = to.toLowerCase();
  if (a === b || !b) return false;
  if (!/^[a-z0-9][a-z0-9.'-]*$/.test(b)) return false;
  // A repair is one word. "sla" -> "service level agreement" is an expansion, and
  // expansions go through the synonym path where they are weighted, not here.
  if (/\s/.test(b)) return false;
  const budget = repairBudget(a);
  return editDistance(a, b, budget) <= budget;
}

/**
 * Apply accepted repairs to the question, preserving everything else verbatim.
 *
 * Token-wise and case-insensitive, so the retried question is the reader's own
 * sentence with misspellings fixed — not a model's paraphrase of it.
 */
export function applyRepairs(question: string, repairs: Record<string, string>): string {
  if (!Object.keys(repairs).length) return question;
  return question.replace(/[a-zA-Z0-9][a-zA-Z0-9'-]*/g, (token) => {
    const fix = repairs[token.toLowerCase()];
    return fix ?? token;
  });
}
