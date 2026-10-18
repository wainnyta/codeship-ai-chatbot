/**
 * The original hand-written BM25, wrapped in the `Retriever` port.
 *
 * It exists so the port has two live implementations rather than one and an
 * intention, and so `npm run eval` can score old against new on the same labelled
 * set. Nothing in the running app changes: src/lib/kb/retrieve.ts is untouched and
 * its 49 tests still pin its behaviour exactly.
 *
 * One faithfulness note. The legacy engine can return `empty: false` with zero
 * passages — the state that routes an evidence-free grounded prompt to the model.
 * The adapter reports that as `no_passage_earned` rather than quietly repairing it,
 * so the eval MEASURES the defect instead of hiding it behind the new port's
 * invariant.
 */

import { loadChunks } from "./chunk";
import { corpusVersionOf } from "./fts/build";
import { KnowledgeBaseIndex } from "./retrieve";
import type { Retrieval, Retriever, SearchOptions } from "./retriever";

export class LegacyRetriever implements Retriever {
  readonly engine = "legacy-bm25";
  readonly corpusVersion: string;

  constructor(
    private readonly index: KnowledgeBaseIndex,
    corpusVersion: string,
  ) {
    this.corpusVersion = corpusVersion;
  }

  static fromCorpus(dir: string): LegacyRetriever {
    return new LegacyRetriever(new KnowledgeBaseIndex(loadChunks(dir)), corpusVersionOf(dir));
  }

  get products(): readonly string[] {
    return this.index.products;
  }

  async search(query: string, options: SearchOptions = {}): Promise<Retrieval> {
    const r = this.index.search(query, { history: options.history, limit: options.limit });

    if (r.empty) {
      return {
        kind: "no_evidence",
        reason: "no_match",
        product: r.product,
        coverage: 0,
        corpusVersion: this.corpusVersion,
      };
    }

    if (r.passages.length === 0) {
      // THE DEFECT, reported rather than repaired. In the running app this case
      // takes the grounded path with an empty passage block.
      return {
        kind: "no_evidence",
        reason: "no_passage_earned",
        product: r.product,
        coverage: 0,
        corpusVersion: this.corpusVersion,
      };
    }

    return {
      kind: "grounded",
      passages: r.passages,
      conflicts: r.conflicts,
      product: r.product,
      coverage: Number.NaN, // the legacy gate has no coverage notion
      corpusVersion: this.corpusVersion,
    };
  }
}
