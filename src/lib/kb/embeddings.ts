/**
 * The dense arm: embeddings, with a committed cache.
 *
 * WHY A CACHE FILE EXISTS, AND WHY IT IS COMMITTED
 *
 * Adding embeddings threatens the property this repo is built around — "a fresh
 * clone has nothing that can be out of date, and `npm test` needs no API key".
 * An index build that calls a provider is a build that needs a key, needs the
 * network, costs money, and is non-deterministic.
 *
 * So vectors are cached by CONTENT HASH in a committed JSON file. A clone with no
 * key still builds a complete index, because every chunk's vector is already
 * there. Only genuinely NEW or CHANGED text needs a provider call — which is also
 * what makes re-embedding cost nothing in steady state. Content-addressing means
 * the cache cannot go stale: edit a chunk and its hash changes, so the stale
 * vector is simply never looked up again.
 *
 * If a chunk is missing from the cache and no key is configured, the build says so
 * and produces a lexical-only index rather than failing. Degrading loudly beats
 * either crashing or silently shipping a half-dense index.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { embedMany } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

export interface EmbeddingConfig {
  enabled: boolean;
  provider: "openai" | "google";
  model: string;
  /** Shortened vectors: 256 dims keeps the committed cache ~120KB instead of ~700KB. */
  dimensions: number;
  apiKeyEnvVar: string;
}

export function vectorCachePath(client: string): string {
  return join(process.cwd(), "config", "clients", `${client}.vectors.json`);
}

/** Stable key for a piece of text. Changing the text changes the key. */
export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

type Cache = Record<string, number[]>;

export function loadVectorCache(client: string): Cache {
  const path = vectorCachePath(client);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Cache;
  } catch {
    return {};
  }
}

export function saveVectorCache(client: string, cache: Cache): void {
  // Sorted keys and fixed precision so the file has a stable diff. A cache that
  // reorders itself on every build is a cache nobody will keep committed.
  const sorted: Cache = {};
  for (const key of Object.keys(cache).sort()) sorted[key] = cache[key];
  writeFileSync(vectorCachePath(client), JSON.stringify(sorted) + "\n");
}

function embeddingModel(config: EmbeddingConfig) {
  const apiKey = process.env[config.apiKeyEnvVar];
  if (!apiKey) return null;

  if (config.provider === "google") {
    return createGoogleGenerativeAI({ apiKey }).textEmbeddingModel(config.model);
  }
  return createOpenAI({ apiKey }).textEmbeddingModel(config.model);
}

export interface EmbedReport {
  vectors: Map<string, number[]>;
  fromCache: number;
  embedded: number;
  missing: number;
  note?: string;
}

/**
 * Vectors for every text, from the cache where possible and the provider where not.
 */
export async function embedTexts(
  client: string,
  texts: string[],
  config: EmbeddingConfig,
): Promise<EmbedReport> {
  const cache = loadVectorCache(client);
  const vectors = new Map<string, number[]>();
  const needed: string[] = [];

  for (const text of texts) {
    const key = textHash(text);
    const hit = cache[key];
    if (hit) vectors.set(key, hit);
    else if (!needed.includes(text)) needed.push(text);
  }

  const fromCache = vectors.size;
  if (needed.length === 0) return { vectors, fromCache, embedded: 0, missing: 0 };

  const model = embeddingModel(config);
  if (!model) {
    return {
      vectors,
      fromCache,
      embedded: 0,
      missing: needed.length,
      note:
        `${needed.length} chunk(s) have no cached vector and ${config.apiKeyEnvVar} is not set. ` +
        `Building a LEXICAL-ONLY index. Set the key and re-run to complete the dense arm.`,
    };
  }

  const { embeddings } = await embedMany({
    model,
    values: needed,
    providerOptions:
      config.provider === "openai" ? { openai: { dimensions: config.dimensions } } : undefined,
  });

  needed.forEach((text, i) => {
    const key = textHash(text);
    // Round hard: 6 decimals is far below the noise floor of cosine similarity and
    // roughly halves the committed file.
    const vec = embeddings[i].map((v) => Number(v.toFixed(6)));
    vectors.set(key, vec);
    cache[key] = vec;
  });

  saveVectorCache(client, cache);
  return { vectors, fromCache, embedded: needed.length, missing: 0 };
}

/** One query vector, never cached — the query is new every time. */
export async function embedQuery(text: string, config: EmbeddingConfig): Promise<number[] | null> {
  const model = embeddingModel(config);
  if (!model) return null;
  const { embeddings } = await embedMany({
    model,
    values: [text],
    providerOptions:
      config.provider === "openai" ? { openai: { dimensions: config.dimensions } } : undefined,
  });
  return embeddings[0].map((v) => Number(v.toFixed(6)));
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Reciprocal Rank Fusion.
 *
 * Lexical scores and cosine similarities are not commensurable — BM25 is unbounded
 * and corpus-relative, cosine is [-1, 1] and model-relative — so they cannot be
 * added or averaged. Ranks can. This is the same lesson as the old RELEVANCE_FLOOR,
 * which compared uncalibrated scores and so measured spread rather than relevance.
 */
export function rrf<T>(rankings: Array<T[]>, k = 60): Map<T, number> {
  const scores = new Map<T, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return scores;
}
