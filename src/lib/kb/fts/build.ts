/**
 * BUCKET A — the index, built by an engine rather than by hand.
 *
 * SQLite FTS5 via node:sqlite. No dependency to install, no native build, so the
 * "a fresh clone has nothing that can be out of date" property survives: the
 * index does not exist until `npm run build:index` makes it, deterministically,
 * from the corpus sitting next to it. It is gitignored for the same reason — a
 * committed index is a thing that can be stale.
 *
 * What the engine now owns, which was 190 hand-written lines before:
 *   - tokenization                      (unicode61)
 *   - stemming                          (porter) — "prices" finds "Pricing"
 *   - per-field BM25F weighting         bm25(fts, wHeading, wBody)
 *   - document frequency                fts5vocab, so stopwords are DERIVED
 *
 * What it deliberately does not own: typed identifiers. Versions, status codes,
 * priorities and header names go in their own table and are matched exactly,
 * because unicode61 splits "4.2" into "4" and "2" and the previous hand-rolled
 * tokenizer kept "v4.2" whole and so never matched the heading "4.2" at all.
 * Identifiers are structured data; the text tokenizer never sees them.
 */

import { createHash } from "node:crypto";
import { renameSync, rmSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { chunkDocument, type Chunk } from "../chunk";
import { extractIdents, type ClientConfig } from "../clientConfig";
import { embedTexts, textHash } from "../embeddings";

const SCHEMA = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE chunks(
  rowid     INTEGER PRIMARY KEY,
  id        TEXT NOT NULL UNIQUE,
  file      TEXT NOT NULL,
  doc_title TEXT NOT NULL,
  doc_date  TEXT,
  product   TEXT,
  heading   TEXT NOT NULL,
  body      TEXT NOT NULL
);

-- External-content FTS5: the text is not duplicated, chunks stays the source of
-- truth. Kept in sync by a full rebuild rather than by triggers, deliberately —
-- a missed delete in a retrieval index means a retracted document keeps being
-- cited with confidence, which is the worst outcome this product can produce.
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  heading, body,
  content='chunks', content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE chunks_vocab USING fts5vocab(chunks_fts, 'row');

CREATE TABLE idents(
  chunk_rowid INTEGER NOT NULL REFERENCES chunks(rowid),
  kind        TEXT NOT NULL,
  value       TEXT NOT NULL
);
CREATE INDEX idents_lookup ON idents(kind, value);
CREATE INDEX idents_chunk  ON idents(chunk_rowid);

CREATE TABLE stopwords(term TEXT PRIMARY KEY);

-- Surface word forms as they appear in the documents, for typo correction.
-- fts5vocab holds STEMS ("price", "integr"), and a reader's typo is of the real
-- word ("pricng", "integraton") — so edit distance has to be measured against
-- what was actually written, not against what the stemmer reduced it to.
CREATE TABLE surface_terms(term TEXT PRIMARY KEY);

-- The dense arm. Brute-force cosine at this size; an ANN index (sqlite-vec,
-- pgvector HNSW) is the >10,000-chunk move, not this one.
CREATE TABLE vectors(chunk_rowid INTEGER PRIMARY KEY, hash TEXT NOT NULL, vec TEXT NOT NULL);
`;

export interface BuildReport {
  path: string;
  corpusVersion: string;
  chunks: number;
  products: string[];
  idents: number;
  /** Corpus-wide boilerplate by document frequency. DIAGNOSTIC ONLY — the query
   *  path filters on the language-level list in stopwords.ts. See the measurement
   *  there for why df cannot separate function words from subject matter here. */
  stopwords: string[];
  quarantined: Array<{ id: string; reason: string }>;
  dense: { enabled: boolean; fromCache: number; embedded: number; missing: number; note?: string };
}

/** Hash of the source content. Identical content gives an identical version. */
export function corpusVersionOf(dir: string): string {
  const hash = createHash("sha256");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(dir, file)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

function loadForBuild(dir: string, config: ClientConfig): Chunk[] {
  const productRe = new RegExp(config.corpus.productTitlePattern);

  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .flatMap((f) => chunkDocument(f, readFileSync(join(dir, f), "utf8")))
    .map((chunk) => ({
      ...chunk,
      // Re-derived from the CLIENT CONFIG rather than from the pattern baked into
      // chunk.ts, so that the convention is data. It is still inferred from an H1,
      // which is the thing that breaks first on a real source: see the note on
      // corpus.productTitlePattern in the client config.
      product: productRe.exec(chunk.docTitle)?.[1]?.toLowerCase() ?? null,
    }));
}

export async function buildIndex(options: {
  dir: string;
  out: string;
  config: ClientConfig;
}): Promise<BuildReport> {
  const { dir, out, config } = options;

  const chunks = loadForBuild(dir, config);
  if (chunks.length === 0) throw new Error(`no markdown chunks found in ${dir}`);

  const quarantined: Array<{ id: string; reason: string }> = [];
  const indexable = chunks.filter((c) => {
    // Fail CLOSED and loudly. The previous design let a chunk with no resolvable
    // product through as `product: null`, which silently disabled both the scope
    // filter and the product boost — so a Vault question became answerable from
    // Pulse's documents, with nothing in any log to say so.
    if (config.corpus.requireProduct && c.product === null) {
      quarantined.push({ id: c.id, reason: "no product resolved from the document title" });
      return false;
    }
    return true;
  });

  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.building`;
  rmSync(tmp, { force: true });

  const db = new DatabaseSync(tmp);
  try {
    db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;");
    db.exec(SCHEMA);

    const insertChunk = db.prepare(
      `INSERT INTO chunks(id, file, doc_title, doc_date, product, heading, body)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertIdent = db.prepare(`INSERT INTO idents(chunk_rowid, kind, value) VALUES (?, ?, ?)`);

    let identCount = 0;
    db.exec("BEGIN");
    for (const chunk of indexable) {
      const info = insertChunk.run(
        chunk.id,
        chunk.file,
        chunk.docTitle,
        chunk.docDate,
        chunk.product,
        chunk.heading,
        chunk.text,
      );
      const rowid = Number(info.lastInsertRowid);

      // Identifiers come from the heading AND the body, and from the same rule the
      // retriever will use on the query. Index-time and query-time extraction
      // sharing one definition is the point: two copies drift, and the drift is
      // invisible from outside.
      for (const ident of extractIdents(`${chunk.heading}\n${chunk.text}`, config.identifiers, "index")) {
        insertIdent.run(rowid, ident.kind, ident.value);
        identCount++;
      }
    }
    db.exec(
      `INSERT INTO chunks_fts(rowid, heading, body) SELECT rowid, heading, body FROM chunks`,
    );
    db.exec("COMMIT");

    // Stopwords DERIVED from this corpus's own document frequency. A hand-written
    // list is the defect class: "than" was missing while that/then/there/they were
    // all present, which is how a price comparison came to match on "than" alone.
    const n = indexable.length;
    const stopwords: string[] = [];
    {
      const rows = db
        .prepare(`SELECT term, doc FROM chunks_vocab WHERE doc * 1.0 / ? >= ? ORDER BY doc DESC`)
        .all(n, config.stopwords.dfRatio) as Array<{ term: string; doc: number }>;
      for (const r of rows) stopwords.push(String(r.term));
    }
    for (const extra of config.stopwords.extra ?? []) stopwords.push(extra.toLowerCase());

    const insertStop = db.prepare(`INSERT OR IGNORE INTO stopwords(term) VALUES (?)`);
    db.exec("BEGIN");
    for (const term of stopwords) insertStop.run(term);
    db.exec("COMMIT");

    // The dense arm. Embedded from the committed cache where possible; a chunk
    // with no cached vector and no API key leaves the index lexical-only.
    const dense = { enabled: config.embeddings?.enabled ?? false, fromCache: 0, embedded: 0, missing: 0 } as BuildReport["dense"];
    if (config.embeddings?.enabled) {
      const texts = indexable.map((c) => `${c.heading}\n${c.text}`);
      const report = await embedTexts(config.client, texts, config.embeddings);
      dense.fromCache = report.fromCache;
      dense.embedded = report.embedded;
      dense.missing = report.missing;
      dense.note = report.note;

      const insertVec = db.prepare(`INSERT INTO vectors(chunk_rowid, hash, vec) VALUES (?, ?, ?)`);
      db.exec("BEGIN");
      indexable.forEach((chunk, i) => {
        const key = textHash(texts[i]);
        const vec = report.vectors.get(key);
        if (vec) insertVec.run(i + 1, key, JSON.stringify(vec));
      });
      db.exec("COMMIT");
    }

    const surface = new Set<string>();
    for (const chunk of indexable) {
      for (const w of `${chunk.heading} ${chunk.text}`.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []) {
        surface.add(w);
      }
    }
    const insertSurface = db.prepare(`INSERT OR IGNORE INTO surface_terms(term) VALUES (?)`);
    db.exec("BEGIN");
    for (const w of surface) insertSurface.run(w);
    db.exec("COMMIT");

    const corpusVersion = corpusVersionOf(dir);
    const setMeta = db.prepare(`INSERT INTO meta(key, value) VALUES (?, ?)`);
    setMeta.run("corpus_version", corpusVersion);
    setMeta.run("client", config.client);
    setMeta.run("chunk_count", String(n));
    setMeta.run("schema_version", "1");

    db.exec("PRAGMA optimize");
    db.close();

    // Atomic publish: build beside the live index and move it into place, so no
    // request can observe a half-written index and a bad build is one `mv` to undo.
    renameSync(tmp, out);

    const products = [...new Set(indexable.map((c) => c.product).filter((p): p is string => !!p))];
    return {
      path: out,
      corpusVersion,
      chunks: n,
      products,
      idents: identCount,
      stopwords,
      quarantined,
      dense,
    };
  } catch (error) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    rmSync(tmp, { force: true });
    throw error;
  }
}
