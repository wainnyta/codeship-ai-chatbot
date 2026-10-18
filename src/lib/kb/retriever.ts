/**
 * THE RETRIEVAL PORT (bucket separation: this file defines the boundary).
 *
 * Retrieval is the layer most likely to be replaced — lexical today, hybrid or
 * reranked or bought-in later — and it was the one layer with no seam: handle.ts
 * typed its dependency as the concrete `KnowledgeBaseIndex`. This is the interface
 * that was missing. Two implementations ship against it:
 *
 *   - `legacyRetriever`  — the original hand-written BM25 (src/lib/kb/retrieve.ts)
 *   - `ftsRetriever`     — SQLite FTS5 (src/lib/kb/fts/)
 *
 * Two live implementations, not one and an intention: a seam you have never
 * exercised is not a seam.
 */

import type { Chunk } from "./chunk";

export interface Passage {
  chunk: Chunk;
  /** Engine-native relevance. Comparable WITHIN one query only, never across queries. */
  score: number;
  /**
   * The LITERAL query terms this passage matched — never synonym expansions.
   *
   * The distinction is load-bearing. The old evidence gate counted matched terms
   * after expansion, so the expansion supplied the evidence the gate demanded and
   * "how much do I owe my landlord" returned every pricing table in the corpus as
   * its sources. Expansions may influence ranking; they may never influence
   * whether the corpus is considered to have answered.
   */
  matched: string[];
}

/** Retrieval found evidence. Invariant: `passages` is non-empty. */
export interface Grounded {
  kind: "grounded";
  /** Cosine of the query against the best passage, when a dense arm ran. */
  semanticCoverage?: number;
  passages: Passage[];
  conflicts: Array<[string, string]>;
  product: string | null;
  /** IDF-weighted fraction of the user's literal terms the corpus covered, 0..1. */
  coverage: number;
  corpusVersion: string;
}

/** Retrieval found nothing worth answering from. The caller must refuse. */
export interface NoEvidence {
  kind: "no_evidence";
  semanticCoverage?: number;
  /**
   * A grounded, retriever-produced explanation of WHY nothing was found.
   *
   * The spec's trap note asks that a version question aimed at the wrong product
   * "must be reported as such", and "I can only answer questions pertaining to the
   * NimbusStack knowledge base" does not report anything. The index already knows
   * the answer — it knows Vault's release line is 3.x — and was throwing it away.
   *
   * Written by the retriever from the index, never by the model, and rendered
   * deterministically in the UI. That keeps it inside the same guarantee as a
   * citation: it is a fact about what the corpus contains, not a generated claim.
   */
  notice?: string;
  reason: "no_match" | "below_coverage" | "no_passage_earned" | "identifier_absent";
  product: string | null;
  coverage: number;
  corpusVersion: string;
}

/**
 * A discriminated union, so the bug cannot be written.
 *
 * The old shape was `{ passages, conflicts, empty, product }`, which let
 * `empty: false` coexist with `passages: []` — a state nobody designed, reachable
 * from an ordinary question ("what encryption does Nimbus Vault use at rest"), and
 * which routed past the restricted scope prompt into the grounded prompt carrying
 * no evidence at all. One representable-but-illegal state defeated the whole
 * grounding guarantee. A union makes it unrepresentable.
 */
export type Retrieval = Grounded | NoEvidence;

export interface SearchOptions {
  /** Earlier user messages, for the deterministic product carry. */
  history?: string[];
  /** Ceiling on the source list. Defaults to the client config's maxPassages. */
  limit?: number;
}

export interface Retriever {
  /** Every product the loaded corpus documents. Derived from the corpus. */
  readonly products: readonly string[];
  /** Hash of the source content this index was built from. Stamp it on answers. */
  readonly corpusVersion: string;
  readonly engine: string;
  search(query: string, options?: SearchOptions): Promise<Retrieval>;
}

/**
 * The single constructor for a Grounded result, enforcing the non-empty invariant.
 *
 * Nothing else in the codebase may build a `Grounded`. An empty passage list
 * degrades to NoEvidence here rather than three layers downstream in a prompt.
 */
export function grounded(
  passages: Passage[],
  rest: {
    conflicts: Array<[string, string]>;
    product: string | null;
    coverage: number;
    corpusVersion: string;
    semanticCoverage?: number;
  },
): Retrieval {
  if (passages.length === 0) {
    return {
      kind: "no_evidence",
      reason: "no_passage_earned",
      product: rest.product,
      coverage: rest.coverage,
      corpusVersion: rest.corpusVersion,
    };
  }
  return { kind: "grounded", passages, ...rest };
}

/* ------------------------------------------------------------------------- *
 * Boundary adapter.
 *
 * `buildPrompt` and `handle.ts` consume the original flat shape. Rather than
 * rewrite them (and the 169 tests that pin their behaviour) in the same change
 * that introduces a new engine, the port is adapted at the boundary. The illegal
 * state is already gone by this point: `empty` is derived from the union tag, so
 * `empty === false` now implies `passages.length > 0` by construction.
 * ------------------------------------------------------------------------- */

export interface LegacyRetrievalResult {
  passages: Passage[];
  conflicts: Array<[string, string]>;
  empty: boolean;
  product: string | null;
  notice?: string;
}

export function toLegacyResult(r: Retrieval): LegacyRetrievalResult {
  if (r.kind === "no_evidence") {
    return { passages: [], conflicts: [], empty: true, product: r.product, notice: r.notice };
  }
  return { passages: r.passages, conflicts: r.conflicts, empty: false, product: r.product };
}
