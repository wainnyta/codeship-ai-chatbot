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

/** Marker the model emits when it is reporting a genuine contradiction. */
const CONFLICT_MARKER = /^\s*\[\[CONFLICT\]\]\s*/i;

/**
 * Whether the answer itself reports a disagreement.
 *
 * Retrieval can only find passages that cover the same ground; it cannot tell
 * agreement from disagreement, and the difference is semantic. A company-wide
 * policy defining "business hours" and a product's SLA table using them share
 * every meaningful term and contradict nothing — yet they scored as a candidate
 * pair, and the warning fired above an answer reporting no conflict at all.
 * Worse, it fired for one model and not another on the same question, because it
 * depended on which passages each happened to cite.
 *
 * Only something that has read both passages can judge this, so the model
 * declares it and the banner reports that judgement. Retrieval's candidates still
 * go into the prompt — that is what makes the model look — but they no longer
 * speak to the reader directly. If the model omits the marker we under-warn,
 * which is the safe direction: its prose still spells the disagreement out.
 */
export function declaresConflict(answer: string): boolean {
  return CONFLICT_MARKER.test(answer);
}

/** The answer as the reader should see it, with the marker removed. */
export function stripConflictMarker(answer: string): string {
  return answer.replace(CONFLICT_MARKER, "");
}
