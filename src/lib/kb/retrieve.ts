import type { Chunk } from "./chunk";

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
  /** Which query terms this chunk actually matched. Drives conflict detection. */
  matched: string[];
}

export interface RetrievalResult {
  passages: ScoredChunk[];
  /**
   * Pairs of passage ids from *different* documents that match the same meaningful
   * query terms. Detected structurally rather than left to the model to notice,
   * because a model asked to "mention any conflicts" frequently does not.
   */
  conflicts: Array<[string, string]>;
  /** True when nothing in the corpus matched a meaningful word of the question. */
  empty: boolean;
  /** The product the query was resolved to, including one carried from earlier turns. */
  product: string | null;
}

export const PRODUCTS = ["relay", "vault", "pulse", "ledger"] as const;

const STOPWORDS = new Set([
  "a","an","and","any","are","as","at","be","but","by","can","do","does","for","from",
  "get","getting","has","have","how","i","if","in","is","it","its","me","my","of","on",
  "or","our","should","so","that","the","their","them","then","there","they","this",
  "to","us","was","we","what","when","where","which","who","why","will","with","you",
  "your","first","check","tell","need","want","about","please","question","nimbus",
]);

/**
 * Colloquial phrasing mapped onto document vocabulary. This is what lets "does it
 * do single sign-on?" reach material filed under SAML, OIDC and federated sign-in.
 */
const PHRASE_SYNONYMS: Array<[RegExp, string[]]> = [
  [/single sign[- ]?on|\bsso\b|sign[- ]?in|log ?in|authenticat/i,
   ["sso", "saml", "oidc", "openid", "connect", "federated", "sign-in", "identity"]],
  [/\bprice|pricing|cost|how much|tier|plan\b/i, ["price", "pricing", "tier"]],
  [/response time|how (fast|quickly)|turnaround/i, ["sla", "response", "priority", "hours"]],
  [/support ticket|severity|\bp1\b|priority 1/i, ["sla", "priority", "p1", "support"]],
  [/integrat|connect(s|or)? (to|with)|work with/i, ["integration", "minimum", "version"]],
  [/new features?|what'?s new|release|changelog|version/i, ["release", "notes", "new"]],
  [/not working|error|fail|broken|issue|troubleshoot/i, ["troubleshooting", "check"]],
  [/\bsecret|credential|certificate\b/i, ["secrets", "credentials"]],
  [/\baudit\b/i, ["audit", "log", "retention"]],
  [/\brate limit|throttl|429\b/i, ["rate", "limit", "429"]],
];

const TERM_SYNONYMS: Record<string, string[]> = {
  forbidden: ["403"],
  unauthorized: ["403"],
  denied: ["403"],
  sso: ["saml", "oidc", "federated"],
  saml: ["sso", "federated"],
  oidc: ["openid", "sso"],
  sla: ["response", "priority"],
  enterprise: ["enterprise"],
  docs: ["documentation"],
};

/** Keeps "4.2", "403", "p1" and "x-ratelimit-reset" intact instead of shredding them. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+(?:[.\-][a-z0-9]+)*/g) ?? [];
}

export function expandQuery(raw: string): string[] {
  const terms = new Set<string>();

  for (const t of tokenize(raw)) {
    terms.add(t);
    for (const extra of TERM_SYNONYMS[t] ?? []) terms.add(extra);
    // "2.0" should also match a document that writes "2". Index both halves.
    if (t.includes(".")) for (const part of t.split(".")) if (part) terms.add(part);
  }

  for (const [pattern, extras] of PHRASE_SYNONYMS) {
    if (pattern.test(raw)) for (const e of extras) terms.add(e);
  }

  return [...terms];
}

export function findProduct(text: string): string | null {
  const lower = text.toLowerCase();
  let best: { product: string; at: number } | null = null;
  for (const p of PRODUCTS) {
    const at = lower.lastIndexOf(p);
    if (at !== -1 && (!best || at > best.at)) best = { product: p, at };
  }
  return best?.product ?? null;
}

/**
 * Resolve the product a question is about, inheriting from earlier turns when the
 * question itself names none — so "what about its SLA?" after a Relay question
 * still retrieves Relay. Deterministic, and costs no extra model call.
 */
export function resolveProduct(query: string, history: string[]): string | null {
  const direct = findProduct(query);
  if (direct) return direct;
  for (let i = history.length - 1; i >= 0; i--) {
    const carried = findProduct(history[i]);
    if (carried) return carried;
  }
  return null;
}

function meaningfulTerms(terms: string[]): string[] {
  return terms.filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

/**
 * Once the product is known, its own documents outrank everything else.
 *
 * Without this, a 403 question about Relay retrieves *Pulse's* troubleshooting
 * checklist first: the two products document the failure in near-identical words,
 * and Pulse's section is shorter, so BM25 length normalisation prefers it. Shared
 * wording across products is exactly the case where getting the product right
 * matters most, so the resolved product gets an explicit multiplier rather than the
 * weak lexical nudge of appending its name to the query.
 *
 * Company-wide documents are left unboosted but not penalised, so cross-product
 * material still surfaces alongside.
 */
function productBoost(chunk: Chunk, product: string | null): number {
  if (!product) return 1;
  return chunk.file.startsWith(product) ? 2.5 : 1;
}

interface IndexedChunk {
  chunk: Chunk;
  counts: Map<string, number>;
  length: number;
}

export class KnowledgeBaseIndex {
  private readonly docs: IndexedChunk[];
  private readonly df = new Map<string, number>();
  private readonly avgLength: number;

  constructor(chunks: Chunk[]) {
    this.docs = chunks.map((chunk) => {
      // Heading and document title are weighted by repetition: a question naming
      // "Vault" or "pricing" should prefer the section actually called that.
      const weighted = [
        chunk.docTitle,
        chunk.docTitle,
        chunk.heading,
        chunk.heading,
        chunk.heading,
        chunk.text,
      ].join("\n");

      const tokens = tokenize(weighted);
      const counts = new Map<string, number>();
      for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
      for (const t of counts.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);

      return { chunk, counts, length: tokens.length };
    });

    this.avgLength =
      this.docs.reduce((sum, d) => sum + d.length, 0) / Math.max(this.docs.length, 1);
  }

  get size(): number {
    return this.docs.length;
  }

  /** Okapi BM25. */
  private score(doc: IndexedChunk, terms: string[]): { score: number; matched: string[] } {
    const k1 = 1.5;
    const b = 0.75;

    let score = 0;
    const matched: string[] = [];

    for (const term of terms) {
      const tf = doc.counts.get(term);
      if (!tf) continue;
      matched.push(term);

      const idf = this.idf(term);
      const norm = tf * (k1 + 1);
      const denom = tf + k1 * (1 - b + (b * doc.length) / this.avgLength);
      score += idf * (norm / denom);
    }

    return { score, matched };
  }

  search(
    query: string,
    options: { history?: string[]; limit?: number } = {},
  ): RetrievalResult {
    const { history = [], limit = 8 } = options;

    const product = resolveProduct(query, history);
    // A carried-over product is appended so retrieval sees it even though the user
    // never typed it in this message.
    const effectiveQuery = product ? `${query} ${product}` : query;
    const terms = expandQuery(effectiveQuery);

    const ranked = this.docs
      .map((doc) => {
        const { score, matched } = this.score(doc, terms);
        return { chunk: doc.chunk, score: score * productBoost(doc.chunk, product), matched };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);

    // The floor. Relay and Pulse both document a "403 Forbidden" checklist in nearly
    // the same words, so a single incidental term matching is not evidence the corpus
    // can answer anything — "nginx reverse proxy headers" matches `headers` against
    // Relay's rate-limit section and means nothing. Requiring two distinct meaningful
    // terms on one passage separates a real question from a coincidence. Below the
    // floor the caller answers "not in the knowledge base" without calling a provider,
    // so the honest answer is also the cheapest path.
    const clearsFloor = ranked.some((r) => meaningfulTerms(r.matched).length >= 2);
    if (!clearsFloor) {
      return { passages: [], conflicts: [], empty: true, product };
    }

    const passages = ranked.slice(0, limit);
    return {
      passages,
      conflicts: detectConflicts(passages, (t) => this.idf(t)),
      empty: false,
      product,
    };
  }

  /** Inverse document frequency across chunks. Rare terms carry more signal. */
  idf(term: string): number {
    const N = this.docs.length;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (N - df + 0.5) / (df + 0.5));
  }
}

/** The product a document belongs to, or null for a company-wide document. */
export function productOf(file: string): string | null {
  return PRODUCTS.find((p) => file.startsWith(p)) ?? null;
}

/**
 * Whether two documents could contradict each other at all.
 *
 * Two different products' SLA tables hold different values, but that is not a
 * disagreement — it is two products. Without this check, every per-product question
 * flags the parallel section of all three other products, and the warning becomes
 * noise the reader learns to ignore. Passages can only conflict when they describe
 * the same product, or when one of them is a company-wide document making a claim
 * about that product — which is exactly where the corpus's real drift lives.
 */
export function comparable(fileA: string, fileB: string): boolean {
  const a = productOf(fileA);
  const b = productOf(fileB);
  if (a && b) return a === b;
  return true; // at least one is company-wide
}

/** Most specific candidate pairs to report. Beyond a handful, a flag is noise. */
export const MAX_CONFLICTS = 3;

/** Minimum combined rarity before two passages count as covering the same ground. */
export const CONFLICT_THRESHOLD = 3.0;

/**
 * Candidate disagreements: passages from *different* documents that make claims
 * about the same specific thing.
 *
 * Pairs are scored by the combined rarity (IDF) of the terms they share, not by how
 * many they share. Counting matches alone flags everything — a question like "which
 * products support SSO via SAML 2.0" expands to a dozen terms, and nearly every
 * passage in the corpus matches two of them, so a naive count produced twenty pairs
 * for one question. Rarity is the signal: two passages both mentioning "enterprise"
 * means nothing, both mentioning "vault" and "saml" means they are talking about the
 * same fact and could contradict each other.
 *
 * This finds *candidates*, not proven contradictions — lexical overlap cannot tell
 * agreement from disagreement. The model adjudicates, under an instruction to stay
 * silent when the passages turn out to agree.
 */
export function detectConflicts(
  passages: ScoredChunk[],
  idf: (term: string) => number,
): Array<[string, string]> {
  const scored: Array<{ pair: [string, string]; weight: number }> = [];

  for (let i = 0; i < passages.length; i++) {
    for (let j = i + 1; j < passages.length; j++) {
      const a = passages[i];
      const b = passages[j];
      if (a.chunk.file === b.chunk.file) continue;
      if (!comparable(a.chunk.file, b.chunk.file)) continue;

      const shared = meaningfulTerms(a.matched).filter((t) => b.matched.includes(t));
      if (shared.length < 2) continue;

      const weight = shared.reduce((sum, t) => sum + idf(t), 0);
      if (weight >= CONFLICT_THRESHOLD) {
        scored.push({ pair: [a.chunk.id, b.chunk.id], weight });
      }
    }
  }

  return scored
    .sort((x, y) => y.weight - x.weight)
    .slice(0, MAX_CONFLICTS)
    .map((s) => s.pair);
}
