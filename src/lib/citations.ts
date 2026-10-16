/** Passage ids an answer cited, e.g. [vault.md#pricing]. */
const CITATION = /\[([a-z0-9][a-z0-9-]*\.md#[a-z0-9-]+)\]/gi;

export function citedIds(answer: string): Set<string> {
  return new Set(Array.from(answer.matchAll(CITATION)).map((m) => m[1].toLowerCase()));
}

/**
 * Conflicts worth warning about: those where the answer cited BOTH sides.
 *
 * Retrieval flags *candidate* disagreements — passages that cover the same ground
 * and might differ — and that is the right input for the model, which needs to see
 * both before it writes. It is the wrong thing to show the reader. A question like
 * "what products do we have?" retrieves passages from several documents that share
 * the product names, so candidates appear where no disagreement exists, and the
 * banner fires above an answer that reports none. A warning that cries wolf is
 * worse than no warning, because the reader stops believing the real ones.
 *
 * If the answer leaned on both halves of a flagged pair, it is genuinely working
 * across two sources that cover the same ground, and the reader should check them.
 * If it cited one or neither, there is nothing to warn about.
 */
export function activeConflicts(
  conflicts: Array<[string, string]>,
  answer: string,
): Array<[string, string]> {
  const cited = citedIds(answer);
  return conflicts.filter(([a, b]) => cited.has(a.toLowerCase()) && cited.has(b.toLowerCase()));
}
