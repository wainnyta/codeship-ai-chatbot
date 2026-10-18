/**
 * BUCKET A — the FTS5 implementation of the `Retriever` port.
 *
 * Reads a read-only index produced by build.ts. Contains no client vocabulary and
 * makes no refusal decision: it produces scored candidates and hands them to the
 * gate, which is where the product judgment lives.
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { Chunk } from "../chunk";
import { clientConfig, extractIdents, expansionTerms, type ClientConfig, type Ident } from "../clientConfig";
import { applyGate, type Candidate, type Stats } from "../gate";
import { cosine, embedQuery, rrf } from "../embeddings";
import { englishStopwords } from "../stopwords";
import type { Retrieval, Retriever, SearchOptions } from "../retriever";

/** Reader-facing names for identifier kinds, for the "why not" line. */
const LABELS: Record<string, string> = {
  product_version: "version",
  dependency_version: "version",
  code: "status code",
  priority: "priority",
  tier: "tier",
};

function listOf(values: string[]): string {
  if (values.length === 1) return values[0];
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

/** FTS5 phrase-quotes a term: the only safe way to put user text in a MATCH. */
function quote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/**
 * Blank out every typed identifier so it is not also counted as prose.
 *
 * "v4.2" must reach the identifier channel, not the term channel: unicode61 splits
 * it into "v4" and "2", neither of which appears in any document, so as literal
 * terms they would score as out-of-vocabulary and drag coverage down on a question
 * the corpus answers perfectly well.
 */
function maskIdents(query: string, rules: ClientConfig["identifiers"]): string {
  let masked = query;
  for (const rule of rules) {
    if (rule.values) {
      for (const v of rule.values) {
        masked = masked.replace(new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), " ");
      }
      continue;
    }
    // Blank only the CAPTURED VALUE, not the whole match. The dependency pattern
    // matches "TLS 1.2", and masking all of it threw away "tls" — the single most
    // discriminating word in "do you support TLS 1.2", leaving only "support".
    const re = new RegExp(rule.pattern!, "gi");
    masked = masked.replace(re, (whole, ...groups) => {
      const value = String(groups[(rule.captureGroup ?? 1) - 1] ?? whole);
      const at = whole.indexOf(value);
      return at < 0 ? " " : whole.slice(0, at) + " ".repeat(value.length) + whole.slice(at + value.length);
    });
  }
  return masked;
}

/**
 * Product names matched as WHOLE WORDS, not substrings.
 *
 * The previous implementation used `lower.includes(p)` over product names that are
 * ordinary English words, so "impulse" scoped a question to Pulse and "vaulted" to
 * Vault — and because naming a product relaxed the refusal bar, a single incidental
 * match was then enough to answer from. Word boundaries close that class. They do
 * not close the genuine homonym ("relay a message"), which eval/nimbusstack.jsonl
 * records as an open case rather than pretending otherwise.
 */
/** Levenshtein with an early exit once the budget is blown. */
function editDistance(a: string, b: string, budget: number): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      row.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > budget) return budget + 1;
    prev = row;
  }
  return prev[b.length];
}

function productsIn(text: string, roster: readonly string[]): string[] {
  return roster.filter((p) => new RegExp(`\\b${p}\\b`, "i").test(text));
}

export class FtsRetriever implements Retriever {
  readonly engine: string;
  readonly products: readonly string[];
  readonly corpusVersion: string;

  private readonly db: DatabaseSync;
  private readonly config: ClientConfig;
  private readonly stopwords: Set<string>;
  private readonly brand: Set<string>;
  private readonly size: number;
  private readonly dfCache = new Map<string, number>();
  private readonly hitCache = new Map<string, Set<number>>();
  /** rowid -> vector. Held in memory and scanned brute-force; see the note in search(). */
  private readonly vectors = new Map<number, number[]>();

  constructor(path: string, config: ClientConfig = clientConfig()) {
    if (!existsSync(path)) {
      throw new Error(
        `No search index at ${path}. Run \`npm run build:index\` — it is gitignored on purpose, so that it cannot be stale.`,
      );
    }
    this.config = config;
    this.db = new DatabaseSync(path, { readOnly: true });
    this.engine = config.embeddings?.enabled ? "fts5+dense" : "fts5";

    const meta = this.db.prepare(`SELECT value FROM meta WHERE key = ?`);
    this.corpusVersion = String((meta.get("corpus_version") as { value: string } | undefined)?.value ?? "unknown");
    this.size = Number((meta.get("chunk_count") as { value: string } | undefined)?.value ?? 0);

    this.products = (
      this.db.prepare(`SELECT DISTINCT product FROM chunks WHERE product IS NOT NULL ORDER BY rowid`).all() as Array<{
        product: string;
      }>
    ).map((r) => r.product);

    // Language-level, not corpus-derived. See the measurement in stopwords.ts:
    // df/N cannot separate function words from subject matter on this corpus —
    // at the ratio that catches "the" it has already removed "pro", "enterprise"
    // and "saml". The index still records its df-derived list as a diagnostic.
    this.stopwords = englishStopwords(config.stopwords.extra);
    this.brand = new Set((config.corpus.brandTerms ?? []).map((b) => b.toLowerCase()));

    if (config.embeddings?.enabled) {
      for (const row of this.db.prepare(`SELECT chunk_rowid, vec FROM vectors`).all() as Array<{
        chunk_rowid: number;
        vec: string;
      }>) {
        this.vectors.set(Number(row.chunk_rowid), JSON.parse(row.vec) as number[]);
      }
    }
  }

  close(): void {
    this.db.close();
  }

  /** Rowids matching a single term; its size is that term's document frequency. */
  private hits(term: string): Set<number> {
    const cached = this.hitCache.get(term);
    if (cached) return cached;
    let set: Set<number>;
    try {
      const rows = this.db
        .prepare(`SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?`)
        .all(quote(term)) as Array<{ rowid: number }>;
      set = new Set(rows.map((r) => Number(r.rowid)));
    } catch {
      set = new Set();
    }
    this.hitCache.set(term, set);
    this.dfCache.set(term, set.size);
    return set;
  }

  private df(term: string): number {
    const hit = this.dfCache.get(term);
    return hit !== undefined ? hit : this.hits(term).size;
  }

  /**
   * What the corpus says an identifier is ABOUT.
   *
   * An identifier retrieves with surgical precision and no breadth: "a client
   * receives 429" has no word in common with any document, so `code:429` pulls the
   * one chunk carrying that string and the answer is whatever that chunk happens
   * to say. Measured, on exactly that question: ONE passage, zero matched terms,
   * answered only because identVouches overrode a coverage of 0.250. Correct, and
   * missing both the per-tier limits in relay.md#pricing and the fact that
   * `X-RateLimit-*` only exists since Relay 4.1 — neither chunk contains "429".
   *
   * The documented line is the bridge. "The rate limit for the tier was reached,
   * read X-RateLimit-Reset for the retry time" is the subject's vocabulary, written
   * by the same hand as the rest of the corpus, so the terms it yields are terms
   * the corpus actually uses.
   *
   * WHY THIS IS DERIVED AND NOT CONFIGURED
   *
   * The alternative is a table mapping 429 -> ["rate","limit"], which is the
   * defect class this build keeps removing: a per-client artifact that silently
   * goes stale the day a new code is documented. Here a new code works the moment
   * someone writes a line about it, for this client and every later one.
   *
   * These are EXPANSIONS and nothing else. They never enter `literal`, so they
   * cannot move coverage, and they never enter `credited`, which is built per-term
   * from a term's own synonyms. The gate's arithmetic is untouched: the 429
   * question still has coverage 0.250 and still answers only because the
   * identifier vouched for it. All this can do is widen what gets retrieved, which
   * is why its one knob is a cap, measured against false grounding.
   */
  private identTopics(idents: Ident[], exclude: Set<string>, max: number): string[] {
    if (!idents.length || max <= 0) return [];

    const where = idents.map(() => "(kind = ? AND value = ?)").join(" OR ");
    const params = idents.flatMap((i) => [i.kind, i.value]);
    const rows = this.db
      .prepare(`SELECT DISTINCT context FROM idents WHERE (${where}) AND context IS NOT NULL`)
      .all(...params) as Array<{ context: string }>;

    const values = new Set(idents.map((i) => String(i.value).toLowerCase()));
    const seen = new Set<string>();
    for (const row of rows) {
      for (const token of row.context.toLowerCase().match(/[a-z][a-z0-9-]*/g) ?? []) {
        if (token.length < 3) continue;
        if (this.stopwords.has(token) || exclude.has(token)) continue;
        // The identifier's own value, and the roster and brand names, are scope —
        // the same rule the ranking query applies.
        if (values.has(token) || this.products.includes(token) || this.brand.has(token)) continue;
        seen.add(token);
      }
    }

    // Rarest first. A line's distinctive words are the ones that name its subject;
    // its common ones ("check", "order") are shared with every other line and would
    // spend the cap on noise.
    const stats = this.stats();
    return [...seen]
      .filter((t) => this.df(t) > 0)
      .sort((a, b) => stats.idf(b) - stats.idf(a))
      .slice(0, max);
  }

  private stats(): Stats {
    const idfOf = (df: number) => Math.log(1 + (this.size - df + 0.5) / (df + 0.5));
    return {
      size: this.size,
      idf: (term) => idfOf(this.df(term)),
      maxIdf: () => idfOf(0),
    };
  }

  private vocabCache: string[] | null = null;

  /**
   * Surface word forms as written in the documents.
   *
   * NOT fts5vocab, which holds stems: "pricing" is indexed as "price" and
   * "integration" as "integr", so a typo of the real word ("pricng",
   * "integraton") measures 2+ edits from the stem and 1 from the word. Correcting
   * against stems silently failed on exactly the typos a reader makes.
   */
  private vocab(): string[] {
    if (!this.vocabCache) {
      this.vocabCache = (
        this.db.prepare(`SELECT term FROM surface_terms`).all() as Array<{ term: string }>
      ).map((r) => String(r.term));
    }
    return this.vocabCache;
  }

  /**
   * Nearest indexed term to a word the corpus does not contain.
   *
   * A typo and a foreign word look identical to the gate — both are simply absent,
   * both score maximum IDF in the denominator, and both sink the query. Observed:
   * "saleforce" (one missing letter) refused a question the corpus answers on the
   * line above it.
   *
   * This is a GENERAL mechanism, not a synonym entry: no per-client vocabulary, no
   * list to maintain. The distance budget scales with length and short words are
   * excluded, because at 4 characters an edit distance of 1 reaches real unrelated
   * words — which would turn a typo fix into a false-grounding machine.
   */
  private nearestTerm(word: string): string | null {
    if (word.length < 5) return null;
    const budget = word.length >= 8 ? 2 : 1;
    let best: { term: string; d: number } | null = null;
    for (const term of this.vocab()) {
      if (Math.abs(term.length - word.length) > budget) continue;
      if (term[0] !== word[0]) continue; // typos rarely change the first letter
      const d = editDistance(word, term, budget);
      if (d <= budget && (!best || d < best.d)) best = { term, d };
    }
    return best?.term ?? null;
  }

  private scopeCache = new Map<number, string | null>();

  private inScope(rowid: number, products: string[]): boolean {
    if (!this.scopeCache.size) {
      for (const r of this.db.prepare(`SELECT rowid, product FROM chunks`).all() as Array<{
        rowid: number;
        product: string | null;
      }>) {
        this.scopeCache.set(Number(r.rowid), r.product);
      }
    }
    const p = this.scopeCache.get(rowid) ?? null;
    return p === null || products.includes(p);
  }

  private literalTerms(query: string): string[] {
    const masked = maskIdents(query, this.config.identifiers);
    const tokens = masked.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const roster = new Set(this.products);
    return [
      ...new Set(
        tokens.filter(
          (t) =>
            t.length > 1 &&
            !this.stopwords.has(t) &&
            // Product names are enforced by the scope filter, not scored as topic.
            !roster.has(t) &&
            // Nor is the company's own name topical evidence.
            !this.brand.has(t),
        ),
      ),
    ];
  }

  async search(query: string, options: SearchOptions = {}): Promise<Retrieval> {
    const { history = [], limit, extraSynonyms } = options;
    const config = this.config;

    const named = productsIn(query, this.products);
    const products = named.length
      ? named
      : (() => {
          for (let i = history.length - 1; i >= 0; i--) {
            const found = productsIn(history[i], this.products);
            if (found.length) return [found[found.length - 1]];
          }
          return [];
        })();
    const product = products.length === 1 ? products[0] : null;

    let literal = this.literalTerms(query);
    const idents = extractIdents(query, config.identifiers);

    /**
     * When a question is only its subject, the subject IS the topic.
     *
     * "What is Relay?" has nothing left once the stopwords go and the product name
     * is handed to the scope filter, so scoring on topic alone found zero terms and
     * refused a question the corpus answers on its first page. The same applies to
     * a bare follow-up like "and for Relay?".
     *
     * Gated on NAMED, not on the carry. A product inherited from an earlier turn is
     * not this question's subject, and treating it as one made "how can I use it"
     * retrieve five Relay passages when every rewrite provider was down — where the
     * honest outcome is the refusal that existed before rewriting did.
     */
    const subjectOnly = literal.length === 0 && named.length > 0;
    if (subjectOnly) literal = [...products];

    const proposedAll = Object.values(extraSynonyms ?? {}).flat();
    const topics = this.identTopics(
      idents,
      new Set(literal),
      config.thresholds.identTopicTerms ?? 0,
    );
    const expansions = [
      ...expansionTerms(query, config, this.products),
      ...proposedAll,
      ...topics,
    ].filter((t) => !literal.includes(t) && !this.stopwords.has(t));

    const stats = this.stats();

    // Which rows each LITERAL term hit. Expansions are tracked separately and can
    // never reach the gate's evidence count as independent terms.
    const literalHits = new Map<string, Set<number>>();
    for (const term of literal) literalHits.set(term, this.hits(term));

    const expansionHits = new Map<string, Set<number>>();
    for (const term of expansions) expansionHits.set(term, this.hits(term));

    /**
     * A literal term absent from the corpus, but whose OWN synonym mapping matched.
     *
     * The corpus never contains "cheaper", "cost" or "sso" (df = 0 for all three),
     * so coverage over literal terms alone refuses a price comparison however well
     * the pricing tables were retrieved — measured, on four questions. Crediting
     * the source term once, at its own weight, is a different thing from the hole
     * this gate was built to close: an expansion still cannot add evidence beyond
     * the words the user typed, it can only vouch for one of them.
     */
    const credited = new Map<string, number>();
    const corrections = new Map<string, string>();
    const roster = new Set(this.products);

    /**
     * Is this question demonstrably about the corpus, before any model proposal is
     * consulted? A NAMED PRODUCT or a DOCUMENTED IDENTIFIER — nothing weaker.
     *
     * "any matched literal word" was tried first and is too cheap: "what is the
     * weather today" anchors on `today`, which appears in Pulse's sign-in section
     * ("not available today"), and the proposal then rescued a question about the
     * weather. A model proposal is the least trustworthy input in the system —
     * generated per query, unreviewed, unlike the curated table — so it gets the
     * strongest anchor requirement, not the most convenient one.
     */
    const anchored = products.length > 0 || idents.length > 0;
    for (const term of literal) {
      if ((literalHits.get(term)?.size ?? 0) > 0) continue;

      // A near-miss on an indexed term is a typo, not a foreign word. Credit it at
      // the real term's weight — the same mechanism as a synonym stand-in, because
      // it is the same situation: the reader's word is absent but its meaning is not.
      const near = this.nearestTerm(term);
      if (near && this.hits(near).size > 0) {
        corrections.set(term, near);
        credited.set(term, stats.idf(near));
        literalHits.set(term, this.hits(near));
        continue;
      }

      /**
       * The hand-written table first, then anything a second pass proposed for
       * this query — but a PROPOSAL ONLY APPLIES TO AN ANCHORED QUERY.
       *
       * Measured, after I argued the opposite: when every unmatched term gets
       * credited, the denominator shrinks with the numerator and coverage reaches
       * 1.0 however weak the stand-ins are. "Weighted at the stand-in's IDF" only
       * protects a query that still has an uncredited word in it. So a proposal
       * mapping "landlord" onto "pricing" rescued a question about rent.
       *
       * The asymmetry that actually matters is not the weighting, it is the
       * ANCHOR: "what does Vault charge" names a product; "how much do I owe my
       * landlord" names nothing, matches nothing and carries no identifier. A
       * proposal is a bridge, not a foundation — it may connect a question that is
       * demonstrably about this corpus to the documentation's own words, and it may
       * not establish that the question is about this corpus in the first place.
       *
       * The curated table in the client config is deliberately NOT subject to this:
       * it is reviewed, and it is what lets "what products do we have" work.
       */
      const proposed = anchored ? (extraSynonyms?.[term] ?? []).filter((e) => !roster.has(e)) : [];
      const own = [...expansionTerms(term, config, this.products), ...proposed].filter(
        (e) => this.hits(e).size > 0,
      );
      if (!own.length) continue;
      // Weighted at the STAND-IN's idf, not the absent term's. An absent word
      // scores maximum idf by definition, so crediting it at its own weight made
      // "how much does a flight to Tokyo cost" look well covered on the strength
      // of one mapped word. The evidence actually in hand is the common word
      // "pricing", so that is what the term is worth — in the numerator AND the
      // denominator, which is what lets "what does Vault cost?" reach 1.0.
      credited.set(term, Math.min(...own.map((e) => stats.idf(e))));
    }

    /**
     * THE DENSE ARM.
     *
     * Brute-force cosine over every in-scope vector. At 38 chunks that is roughly
     * 10,000 multiply-adds and costs nothing; an ANN index (sqlite-vec, pgvector
     * HNSW) is the >10,000-chunk move and changes none of the logic below.
     *
     * One honest cost: this adds a provider call per question (~$0.00001 and
     * ~150ms). If the key is absent at runtime the arm is simply skipped and the
     * engine degrades to lexical — the same behaviour the build already has.
     */
    let denseRanked: number[] = [];
    const denseSim = new Map<number, number>();
    let semanticCoverage: number | undefined;
    if (config.embeddings?.enabled && this.vectors.size > 0) {
      const qv = await embedQuery(query, config.embeddings).catch(() => null);
      if (qv) {
        const scored: Array<{ rowid: number; sim: number }> = [];
        for (const [rowid, vec] of this.vectors) {
          if (products.length && !this.inScope(rowid, products)) continue;
          scored.push({ rowid, sim: cosine(qv, vec) });
        }
        scored.sort((a, b) => b.sim - a.sim);
        denseRanked = scored.slice(0, config.thresholds.candidateLimit).map((r) => r.rowid);
        for (const r of scored) denseSim.set(r.rowid, r.sim);
        semanticCoverage = scored[0]?.sim;
      }
    }

    /**
     * The roster is a SCOPE signal, and scope must not accumulate as topical evidence.
     *
     * `literalTerms` already drops product and brand names for exactly this reason,
     * and the conflict signal drops them again. The one place the rule was not
     * applied was the ranking query, where the `$ROSTER` expansion put all four
     * product names plus the company name into MATCH — so BM25 scored a chunk for
     * NAMING the products rather than for answering about them.
     *
     * Measured, on "what product offers the cheapest pricing tier":
     *
     *   with roster     security-overview#identity 14.69 (rank 1), pulse#pricing rank 11
     *   without roster  security-overview#identity  2.81 (rank 9), pulse#pricing rank  7
     *
     * security-overview#identity contains no price. It won because it mentions
     * Relay, Vault, Pulse and Ledger in one paragraph, and five low-IDF terms
     * repeated beat one high-IDF term in a table. Pulse's and Ledger's pricing
     * tables fell past the passage budget, and the answer said Pulse's pricing was
     * not in the knowledge base while citing the other three.
     *
     * The roster still retrieves when it is the only signal there is — "what
     * products do you sell" has no other word that means anything — but it can no
     * longer outrank the documents that carry the answer.
     */
    const scoped = (t: string) => roster.has(t) || this.brand.has(t);
    const corrected = literal.map((t) => corrections.get(t) ?? t);
    const topical = [...corrected, ...expansions.filter((t) => !scoped(t))];
    const matchTerms = topical.length ? topical : [...corrected, ...expansions];
    if (matchTerms.length === 0 && idents.length === 0 && denseRanked.length === 0) {
      return { kind: "no_evidence", reason: "no_match", product, coverage: 0, corpusVersion: this.corpusVersion, semanticCoverage };
    }

    const identKeys = idents.map((i) => `${i.kind}:${i.value}`);
    const identPlaceholders = idents.map(() => "(kind = ? AND value = ?)").join(" OR ") || "0";
    const identParams = idents.flatMap((i) => [i.kind, i.value]);

    // One ranking query. bm25() is negated so higher is better for the rest of the
    // pipeline; FTS5 returns a score where more negative is better.
    const sql = `
      SELECT c.rowid, c.id, c.file, c.doc_title, c.doc_date, c.product, c.heading, c.body,
             -bm25(chunks_fts, ?, ?) AS relevance,
             (SELECT count(*) FROM idents i WHERE i.chunk_rowid = c.rowid AND (${identPlaceholders})) AS ident_hits
      FROM chunks_fts
      JOIN chunks c ON c.rowid = chunks_fts.rowid
      WHERE chunks_fts MATCH ?
        ${products.length ? `AND (c.product IS NULL OR c.product IN (${products.map(() => "?").join(",")}))` : ""}
      ORDER BY rank
      LIMIT ?
    `;

    const params: Array<string | number> = [config.fieldWeights.heading, config.fieldWeights.body, ...identParams];
    params.push(matchTerms.map(quote).join(" OR "));
    // Scope to EVERY product named, not just a single one. "is Vault cheaper than
    // Pulse" was leaking Relay's release notes in on the word "price": two products
    // named meant no filter at all, when what a comparison needs is a filter to
    // exactly those two plus company-wide material.
    for (const p of products) params.push(p);
    params.push(config.thresholds.candidateLimit);

    type Row = {
      rowid: number;
      id: string;
      file: string;
      doc_title: string;
      doc_date: string | null;
      product: string | null;
      heading: string;
      body: string;
      relevance: number;
      ident_hits: number;
    };

    let rows: Row[];
    try {
      rows = matchTerms.length ? (this.db.prepare(sql).all(...params) as Row[]) : [];
    } catch {
      // A MATCH expression FTS5 refuses is a bug in our quoting, not a user error.
      // Refusing beats a 500, and the gate reports it as no match.
      return { kind: "no_evidence", reason: "no_match", product, coverage: 0, corpusVersion: this.corpusVersion };
    }

    /**
     * Fuse by RANK, not score. BM25 is unbounded and corpus-relative; cosine is
     * [-1,1] and model-relative. They cannot be added. This is the same lesson as
     * the old RELEVANCE_FLOOR, which compared uncalibrated scores across queries
     * and so measured spread rather than relevance.
     */
    const lexicalRanked = rows.map((r) => Number(r.rowid));
    const fused = rrf([lexicalRanked, denseRanked], config.thresholds.rrfK);

    // Dense may surface a chunk lexical never saw — that is the entire point — so
    // its rows have to be fetched rather than filtered out of the lexical result.
    /**
     * A matched identifier retrieves on its own.
     *
     * It used to be a bonus applied to rows the lexical arm had already found, so
     * a question whose only real signal was the error code found nothing at all:
     * "a client said they receive 403" has no word in common with any document —
     * `client`, `said` and `receive` appear nowhere — while `code=403` is
     * documented twice. The highest-precision signal in the system was the one
     * that could not reach the index.
     */
    const identRows = idents.length
      ? (this.db
          .prepare(
            `SELECT DISTINCT chunk_rowid AS rowid FROM idents WHERE ${identPlaceholders}`,
          )
          .all(...identParams) as Array<{ rowid: number }>)
          .map((r) => Number(r.rowid))
          .filter((id) => !products.length || this.inScope(id, products))
      : [];

    const seen = new Set(lexicalRanked);
    /**
     * A dense-only candidate matched NONE of the words the reader typed. Shown as
     * a source it is weak evidence, and letting the whole top-k through tripled the
     * citation list (4.6 -> 10.1 passages per answer, measured). So it has to clear
     * the semantic floor on its own, not merely rank inside the window.
     */
    const extra = [
      ...identRows.filter((id) => !seen.has(id)),
      ...denseRanked.filter(
        (id) => !seen.has(id) && !identRows.includes(id) && (denseSim.get(id) ?? 0) >= config.thresholds.denseFloor,
      ),
    ].slice(0, config.thresholds.candidateLimit);
    if (extra.length) {
      const more = this.db
        .prepare(
          `SELECT rowid, id, file, doc_title, doc_date, product, heading, body,
                  0 AS relevance, 0 AS ident_hits
           FROM chunks WHERE rowid IN (${extra.map(() => "?").join(",")})`,
        )
        .all(...extra) as Row[];
      rows = [...rows, ...more];
    }

    const candidates: Candidate[] = rows.map((r) => {
      const rowid = Number(r.rowid);
      const chunk: Chunk = {
        id: r.id,
        file: r.file,
        docTitle: r.doc_title,
        docDate: r.doc_date,
        product: r.product,
        heading: r.heading,
        text: r.body,
      };

      const matched = literal.filter((t) => literalHits.get(t)?.has(rowid));
      // Product names are excluded from the conflict signal. The roster expansion
      // injects every product name, and two documents both containing "ledger" are
      // not two documents disagreeing about a fact — they were outranking the real
      // Vault SAML contradiction and pushing it past MAX_CONFLICTS.
      const roster = new Set(this.products);
      const matchedBroad = [
        ...matched,
        ...expansions.filter((t) => !roster.has(t) && expansionHits.get(t)?.has(rowid)),
      ].filter((t) => !roster.has(t));
      const matchedIdents: Ident[] = idents.length
        ? (this.db
            .prepare(`SELECT kind, value FROM idents WHERE chunk_rowid = ? AND (${identPlaceholders})`)
            .all(rowid, ...identParams) as unknown as Ident[])
        : [];

      return {
        chunk,
        // Fused rank is the ordering signal when a dense arm ran; the lexical
        // score and identifier bonus break ties within it.
        score:
          (fused.get(rowid) ?? 0) * 1000 +
          Number(r.relevance) +
          config.identBonus * matchedIdents.length,
        matched,
        matchedBroad,
        matchedIdents: matchedIdents.filter((i) => identKeys.includes(`${i.kind}:${i.value}`)),
      };
    });

    /**
     * What the corpus DOES have for an identifier kind the reader named, in scope.
     * Straight out of the index, so it is as grounded as a citation.
     */
    const absentNotice = (): string | undefined => {
      const parts: string[] = [];
      for (const ident of idents) {
        const rows = this.db
          .prepare(
            `SELECT DISTINCT i.value FROM idents i JOIN chunks c ON c.rowid = i.chunk_rowid
             WHERE i.kind = ?${products.length ? ` AND c.product IN (${products.map(() => "?").join(",")})` : ""}
             ORDER BY i.value`,
          )
          .all(ident.kind, ...products) as Array<{ value: string }>;
        const have = rows.map((r) => String(r.value));
        const label = LABELS[ident.kind] ?? ident.kind.replace(/_/g, " ");
        const scope = product ? `Nimbus ${product[0].toUpperCase()}${product.slice(1)}` : "the knowledge base";
        parts.push(
          have.length
            ? `The documentation has no ${label} ${ident.value} for ${scope}. It covers ${listOf(have)}.`
            : `The documentation has no ${label} ${ident.value} for ${scope}.`,
        );
      }
      return parts.length ? parts.join(" ") : undefined;
    };

    return applyGate({
      candidates,
      literalTerms: literal,
      queryIdents: idents,
      product,
      stats,
      config,
      creditedTerms: credited,
      corpusVersion: this.corpusVersion,
      semanticCoverage,
      absentNotice,
      limit,
    });
  }
}
