import { join } from "node:path";
import { loadChunks } from "./chunk";
import { KnowledgeBaseIndex } from "./retrieve";

export * from "./chunk";
export * from "./retrieve";

export const KNOWLEDGE_BASE_DIR = join(process.cwd(), "nimbusstack-knowledge-base");

let cached: KnowledgeBaseIndex | null = null;

/**
 * Built once per process and held in memory. The corpus is ~15KB, so there is no
 * index file to generate and nothing a fresh clone can have out of date.
 */
export function getIndex(): KnowledgeBaseIndex {
  if (!cached) cached = new KnowledgeBaseIndex(loadChunks(KNOWLEDGE_BASE_DIR));
  return cached;
}
