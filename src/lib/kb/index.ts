import { join } from "node:path";
import { loadChunks } from "./chunk";
import { clientConfig } from "./clientConfig";
import { FtsRetriever } from "./fts/ftsRetriever";
import { LegacyRetriever } from "./legacyRetriever";
import { INDEX_PATH } from "./paths";
import { KnowledgeBaseIndex } from "./retrieve";
import type { Retriever } from "./retriever";

export * from "./chunk";
export * from "./retrieve";
export * from "./retriever";
export { INDEX_PATH } from "./paths";

export const KNOWLEDGE_BASE_DIR = join(process.cwd(), clientConfig().corpus.dir);

let cachedIndex: KnowledgeBaseIndex | null = null;

/**
 * The original in-memory BM25 index. Still used by `page.tsx` for nothing but the
 * product roster, and by the eval harness as the comparison baseline.
 */
export function getIndex(): KnowledgeBaseIndex {
  if (!cachedIndex) cachedIndex = new KnowledgeBaseIndex(loadChunks(KNOWLEDGE_BASE_DIR));
  return cachedIndex;
}

let cachedRetriever: Retriever | null = null;

/**
 * The retriever the request path uses, held for the life of the process.
 *
 * Which engine runs is configuration, not a code change — `KB_RETRIEVER=legacy`
 * reverts to the hand-written BM25 without a deploy, which is what makes this a
 * reversible decision. The default is the measured winner: on the 82 labelled
 * cases in eval/nimbusstack.jsonl, fts5 scores 76/82 against legacy's 62/82, with
 * recall 0.976 vs 0.786, zero false refusals vs 7/57, 5 false groundings vs 10/25,
 * and zero reachable evidence-free grounded prompts vs 3.
 *
 * A missing index is a hard error rather than a silent fallback: falling back
 * would mean a deploy that forgot to build the index serves measurably worse
 * answers and says nothing about it.
 */
export function getRetriever(): Retriever {
  if (cachedRetriever) return cachedRetriever;

  const engine = process.env.KB_RETRIEVER ?? "fts";
  cachedRetriever =
    engine === "legacy"
      ? new LegacyRetriever(getIndex(), "legacy")
      : new FtsRetriever(INDEX_PATH);

  return cachedRetriever;
}

/** Test seam: drop the cached retriever so the next call rebuilds it. */
export function resetRetriever(): void {
  cachedRetriever = null;
}
