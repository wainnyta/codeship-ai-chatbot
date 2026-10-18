/**
 * BUCKET C — the product logic. Engine-agnostic on purpose.
 *
 * No search engine decides whether to refuse, which disagreements to surface, or
 * how much evidence a reader should have to scan. Those are judgments specific to
 * a tool whose entire promise is not inventing answers, and they stay hand-written
 * here. What they do NOT stay is hardcoded: every number comes from the client
 * config and is calibrated against a labelled query set (`npm run eval -- --sweep`).
 *
 * This module takes candidates and an `idf` function. It never touches SQLite,
 * never knows which engine produced the candidates, and contains no client
 * vocabulary — which is what lets the same gate sit on top of FTS5 today, Postgres
 * hybrid later, and a reranker after that.
 */

import { formatChunk, type Chunk } from "./chunk";
import { estimateTokens } from "../usage";
import type { ClientConfig, Ident } from "./clientConfig";
import { grounded, type Passage, type Retrieval } from "./retriever";

export interface Candidate {
  chunk: Chunk;
  score: number;
  /** Literal query terms this candidate matched. Never expansions. */
  matched: string[];
  /** Query identifiers this candidate carries. */
  matchedIdents: Ident[];
  /**
   * Literal terms PLUS matched expansions, for conflict detection only.
   *
   * The two consumers of "what did this passage match" need different things, and
   * the original design served both from one array — which is how an expansion
   * came to satisfy the evidence gate. The gate reads `matched` (literal only, so
   * it cannot be forged); conflict detection reads this (broad, because finding
   * two passages that cover the same ground wants every signal available).
   */
  matchedBroad: string[];
}

/** Document frequency lookup, supplied by whichever engine owns the index. */
export interface Stats {
  /** Number of documents (chunks) in the index. */
  size: number;
  /** Inverse document frequency of a term, maximal for a term absent entirely. */
  idf(term: string): number;
  /** The value `idf` returns for a term in no document. */
  maxIdf(): number;
}

/**
 * IDF-weighted coverage of the question the user actually asked: 0 to 1.
 *
 * This replaces `EVIDENCE_TERMS = 2`, and the three ways it is better are the
 * whole point of the rewrite:
 *
 * 1. SCALE-FREE. An absolute count of matched terms is not comparable across
 *    corpora or corpus sizes, and it drifts in the permissive direction as the
 *    corpus grows: at 38 chunks 92% of chunks cleared a two-term bar and by a
 *    thousand chunks essentially all of them do. A fraction does not move.
 *
 * 2. UNFORGEABLE. Only LITERAL query terms are counted. The old gate counted
 *    terms after synonym expansion, so 11 of 12 expansion patterns — each adding
 *    two or more terms against a bar of two — could satisfy the gate on their own.
 *    That is how "how much do I owe my landlord" came to return every pricing
 *    table in the corpus as the sources of its answer.
 *
 * 3. AN UNKNOWN WORD IS EXPENSIVE, NOT FREE. The old scorer did `if (!tf) continue`,
 *    discarding exactly the information the refusal decision needs most. A term in
 *    no document ("landlord") scores maximum IDF and lands in the DENOMINATOR, so
 *    it drags coverage toward zero instead of being silently ignored.
 *
 * Identifiers are weighted at maxIdf because a typed identifier is maximally
 * specific by nature: asking about "Vault 4.2" when no Vault document carries a
 * 4.2 is strong evidence the corpus cannot answer, and that is the correct result
 * — version 4.2 exists only for Relay.
 */
export function coverage(
  literalTerms: string[],
  queryIdents: Ident[],
  matchedTerms: Set<string>,
  matchedIdents: Set<string>,
  stats: Stats,
  credited: Map<string, number> = new Map(),
): number {
  let have = 0;
  let want = 0;

  for (const term of new Set(literalTerms)) {
    if (matchedTerms.has(term)) {
      const weight = stats.idf(term);
      want += weight;
      have += weight;
      continue;
    }
    const standIn = credited.get(term);
    if (standIn !== undefined) {
      // Covered by proxy: the term is worth what its stand-in is worth.
      want += standIn;
      have += standIn;
      continue;
    }
    want += stats.idf(term);
  }

  const identWeight = stats.maxIdf();
  for (const ident of queryIdents) {
    want += identWeight;
    if (matchedIdents.has(`${ident.kind}:${ident.value}`)) have += identWeight;
  }

  // A query of nothing but stopwords covers nothing. Refusing is correct.
  if (want <= 0) return 0;
  return have / want;
}

/**
 * Whether two passages could contradict each other at all.
 *
 * Two products' SLA tables hold different numbers, but that is two products, not a
 * disagreement. Without this check every per-product question flags the parallel
 * section of every other product and the warning becomes noise a reader learns to
 * ignore.
 */
export function comparable(a: Chunk, b: Chunk): boolean {
  if (a.product && b.product) return a.product === b.product;
  return true; // at least one is company-wide
}

/**
 * Candidate disagreements: passages from different documents making claims about
 * the same specific thing, scored by the combined rarity of what they share.
 *
 * Carried over from the original design, which was sound and which does find both
 * documented corpus conflicts. Two cautions recorded rather than fixed, because
 * both are corpus-size problems and neither bites yet:
 *
 *  - Combined IDF over a small corpus is noisy. At 38 chunks idf("more") +
 *    idf("than") = 6.0, twice this threshold, from two words that mean nothing.
 *    Shared common-ish terms can therefore clear it. The noise is absorbed
 *    downstream — citations.ts raises the banner only when the model both emits
 *    the conflict marker AND cites both sides — so the cost is prompt tokens.
 *  - It can only ever see conflicts between two passages that BOTH survived the
 *    token budget. Past a few hundred chunks this wants replacing with an offline
 *    conflict registry carrying a human-adjudicated winner.
 */
export function detectConflicts(
  passages: Array<Passage & { broad: string[] }>,
  stats: Stats,
  thresholds: ClientConfig["thresholds"],
): Array<[string, string]> {
  const scored: Array<{ pair: [string, string]; weight: number }> = [];

  for (let i = 0; i < passages.length; i++) {
    for (let j = i + 1; j < passages.length; j++) {
      const a = passages[i];
      const b = passages[j];
      if (a.chunk.file === b.chunk.file) continue;
      if (!comparable(a.chunk, b.chunk)) continue;

      const shared = a.broad.filter((t) => b.broad.includes(t));
      if (shared.length < 2) continue;

      const weight = shared.reduce((sum, t) => sum + stats.idf(t), 0);
      if (weight >= thresholds.conflictIdfSum) scored.push({ pair: [a.chunk.id, b.chunk.id], weight });
    }
  }

  return scored
    .sort((x, y) => y.weight - x.weight)
    .slice(0, thresholds.maxConflicts)
    .map((s) => s.pair);
}

export interface GateInput {
  candidates: Candidate[];
  literalTerms: string[];
  queryIdents: Ident[];
  product: string | null;
  stats: Stats;
  config: ClientConfig;
  /**
   * Literal query terms that are absent from the corpus but whose synonym mapping
   * DID match. The corpus never contains "cheaper" or "cost" (df = 0 for both), so
   * without this a price comparison is refused however well the pricing tables
   * were retrieved. Crediting the SOURCE term once, at its own weight, is not the
   * old hole reopening: an expansion still cannot add evidence beyond the terms the
   * user actually typed, it can only vouch for one of them.
   */
  creditedTerms?: Map<string, number>;
  corpusVersion: string;
  semanticCoverage?: number;
  /** Builds the grounded 'why not' line when an identifier is absent. */
  absentNotice?: () => string | undefined;
  limit?: number;
}

/**
 * Everything between "the engine returned rows" and "this is what the model sees".
 *
 * Returns the discriminated union, so a caller cannot receive a grounded result
 * carrying no evidence. That state was reachable before — an ordinary question
 * ("what encryption does Nimbus Vault use at rest") cleared a one-term refusal bar
 * and then had every candidate evicted by a two-term passage bar, with nothing
 * re-checking — and it routed past the restricted prompt into the answering prompt
 * with an asserted topic and zero passages.
 */
export function applyGate(input: GateInput): Retrieval {
  const { candidates, literalTerms, queryIdents, product, stats, config, corpusVersion, semanticCoverage } = input;
  const { thresholds } = config;
  const limit = input.limit ?? thresholds.maxPassages;

  const matchedTerms = new Set(candidates.flatMap((c) => c.matched));
  // Terms whose own synonym mapping matched, credited at the term's own weight.
  const credited = input.creditedTerms ?? new Map<string, number>();
  const matchedIdents = new Set(
    candidates.flatMap((c) => c.matchedIdents.map((i) => `${i.kind}:${i.value}`)),
  );
  const cover = coverage(literalTerms, queryIdents, matchedTerms, matchedIdents, stats, credited);

  const identVetoedEarly =
    thresholds.identVetoes !== false && queryIdents.length > 0 && matchedIdents.size === 0;

  if (candidates.length === 0) {
    // An absent identifier is precisely the case that retrieves nothing at all, so
    // the "why not" line has to be attached here too — not only on the veto path
    // below, which is only reached when something was retrieved.
    return {
      kind: "no_evidence",
      reason: identVetoedEarly ? "identifier_absent" : "no_match",
      product,
      coverage: cover,
      corpusVersion,
      semanticCoverage,
      notice: identVetoedEarly ? input.absentNotice?.() : undefined,
    };
  }

  // THE REFUSAL DECISION. One number, one threshold, calibrated against a
  // labelled set rather than chosen. Everything else below is presentation.
  /**
   * THE DENSE ARM'S REASON FOR EXISTING.
   *
   * Lexical coverage asks "does the corpus contain the words you typed". It
   * cannot answer "sell" or "cheaper" or "SSO", because those words appear in no
   * document — which is why a hand-written synonym table existed to patch them one
   * at a time. Semantic coverage asks "is the best passage ABOUT what you asked",
   * which an embedding answers without being told. When it vouches, the lexical
   * gate is overridden.
   */
  /**
   * A matched typed identifier vouches for the query.
   *
   * Identifiers are high-precision by construction — they exist as a channel
   * precisely because they are the values questions turn on. An exact match on
   * `code=403` is proof the corpus documents that error, and conversational
   * filler ("a client said they") should not be able to veto it: that question
   * scored coverage 0.25 on one matched identifier against three absent words.
   *
   * It vouches only when it MATCHES. "What's in Vault 4.2?" extracts version=4.2,
   * finds no Vault document carrying it, and is still correctly refused — which is
   * what stops this becoming a way to answer anything containing a number.
   */
  const identVouched = thresholds.identVouches !== false && matchedIdents.size > 0;

  /**
   * ...and the symmetric case: a typed identifier the corpus does NOT contain
   * VETOES the query.
   *
   * Identifiers are high-precision in both directions. If a reader names a
   * specific error code, version or priority and no document carries it, that is
   * stronger evidence than whatever prose words happened to match. Without this,
   * two equally undocumented codes get opposite verdicts on the reader's choice of
   * filler: "a client receive error 401" was refused (coverage 0.174) while "a user
   * is seeing 404 errors" was answered (coverage 0.652), for no better reason than
   * that "user" appears in a troubleshooting section and "client" appears nowhere.
   *
   * It fires only when NOTHING the reader named was found. A query naming both a
   * documented and an undocumented identifier still answers the documented part,
   * which is rule 4's "answer the part you can".
   */
  const identVetoed =
    thresholds.identVetoes !== false && queryIdents.length > 0 && matchedIdents.size === 0;

  const vouched =
    identVouched || (semanticCoverage !== undefined && semanticCoverage >= thresholds.denseFloor);
  if (identVetoed || (cover < thresholds.coverage && !vouched)) {
    return {
      kind: "no_evidence",
      reason: identVetoed ? "identifier_absent" : "below_coverage",
      product,
      coverage: cover,
      corpusVersion,
      semanticCoverage,
      notice: identVetoed ? input.absentNotice?.() : undefined,
    };
  }

  const ranked = [...candidates].sort((a, b) => b.score - a.score);
  const best = ranked[0].score;
  const aboveFloor = best > 0 ? ranked.filter((r) => r.score >= best * thresholds.relevanceFloor) : ranked;

  const passages: Passage[] = [];
  const broad: string[][] = [];
  let spent = 0;
  for (const candidate of aboveFloor) {
    // A hard cap on the source list: break, because nothing further can qualify.
    if (passages.length >= limit) break;

    const cost = estimateTokens(formatChunk(candidate.chunk));
    // The budget: `continue`, not `break`. One oversized candidate used to end the
    // loop and discard every smaller qualifying passage ranked behind it. The top
    // passage is always admitted however large, so a question whose answer is one
    // big table stays answerable.
    if (passages.length && spent + cost > thresholds.passageTokenBudget) continue;

    passages.push({ chunk: candidate.chunk, score: candidate.score, matched: candidate.matched });
    broad.push(candidate.matchedBroad);
    spent += cost;
  }

  return grounded(passages, {
    semanticCoverage,
    conflicts: detectConflicts(
      passages.map((p, i) => ({ ...p, broad: broad[i] ?? p.matched })),
      stats,
      thresholds,
    ),
    product,
    coverage: cover,
    corpusVersion,
  });
}
