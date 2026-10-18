/**
 * BUCKET B loader: client-specific content, validated at boot.
 *
 * Nothing in src/lib/kb/fts or src/lib/kb/gate.ts knows the word "Nimbus". What
 * varies per client lives in config/clients/<client>.json and is loaded here.
 */

import { readFileSync } from "node:fs";
import type { EmbeddingConfig } from "./embeddings";
import { join } from "node:path";

export interface IdentifierRule {
  kind: string;
  /** Either a regex with one capture group, or a closed value list. */
  pattern?: string;
  /**
   * Optional INDEX-side pattern, when documents and readers write the same value
   * differently. A document says "403 Forbidden on an API call"; a reader says
   * "they receive 403". Matching documents loosely indexed "400 days" of audit
   * retention and "500" secrets as HTTP status codes — harmless as a ranking
   * bonus, dangerous once a matched identifier vouches for the whole query.
   */
  indexPattern?: string;
  /** Which capture group holds the value. Defaults to 1. */
  captureGroup?: number;
  values?: string[];
  normalize?: "lower" | "upper" | "title";
}

export interface ClientConfig {
  client: string;
  corpus: { dir: string; productTitlePattern: string; requireProduct: boolean; brandTerms?: string[] };
  fieldWeights: { heading: number; body: number };
  stopwords: { mode: "derived" | "list"; dfRatio: number; extra: string[] };
  identifiers: IdentifierRule[];
  identBonus: number;
  embeddings: EmbeddingConfig;
  synonyms: {
    phrase: Array<{ match: string; add: string[] }>;
    term: Record<string, string[]>;
  };
  thresholds: {
    coverage: number;
    relevanceFloor: number;
    passageTokenBudget: number;
    maxPassages: number;
    candidateLimit: number;
    conflictIdfSum: number;
    maxConflicts: number;
    rrfK: number;
    denseFloor: number;
    /** How many corpus-derived topic terms a matched identifier contributes. */
    identTopicTerms?: number;
    identVouches?: boolean;
    identVetoes?: boolean;
  };
}

/** Marker in a synonym expansion, substituted with the corpus's product roster. */
export const ROSTER_MARKER = "$ROSTER";

const REQUIRED_THRESHOLDS = [
  "coverage",
  "relevanceFloor",
  "passageTokenBudget",
  "maxPassages",
  "candidateLimit",
  "conflictIdfSum",
  "maxConflicts",
] as const;

/** Fail at boot on a malformed client config rather than at the first question. */
export function validateClientConfig(raw: unknown, label: string): ClientConfig {
  const c = raw as ClientConfig;
  const fail = (why: string): never => {
    throw new Error(`${label}: ${why}`);
  };

  if (!c?.client) fail("missing `client`");
  if (!c.corpus?.dir) fail("missing `corpus.dir`");
  if (!c.corpus.productTitlePattern) fail("missing `corpus.productTitlePattern`");
  if (typeof c.fieldWeights?.heading !== "number" || typeof c.fieldWeights?.body !== "number") {
    fail("`fieldWeights` needs numeric `heading` and `body`");
  }
  for (const key of REQUIRED_THRESHOLDS) {
    if (typeof c.thresholds?.[key] !== "number") fail(`missing numeric threshold \`${key}\``);
  }
  if (c.thresholds.coverage < 0 || c.thresholds.coverage > 1) {
    fail("`thresholds.coverage` is a fraction and must be between 0 and 1");
  }

  // Compile every regex here, so a typo is a boot error with a name attached
  // rather than a silent non-match that looks like a retrieval quality problem.
  for (const rule of c.identifiers ?? []) {
    if (!rule.kind) fail("an `identifiers` entry has no `kind`");
    if (!rule.pattern && !rule.values?.length) {
      fail(`identifier \`${rule.kind}\` needs either \`pattern\` or \`values\``);
    }
    if (rule.pattern) {
      try {
        new RegExp(rule.pattern, "gi");
      } catch (e) {
        fail(`identifier \`${rule.kind}\` has an invalid pattern: ${(e as Error).message}`);
      }
    }
  }
  for (const entry of c.synonyms?.phrase ?? []) {
    try {
      new RegExp(entry.match, "i");
    } catch (e) {
      fail(`synonym pattern \`${entry.match}\` is invalid: ${(e as Error).message}`);
    }
  }

  return c;
}

export const CLIENTS_DIR = join(process.cwd(), "config", "clients");

export function loadClientConfig(client = process.env.KB_CLIENT ?? "nimbusstack"): ClientConfig {
  const path = join(CLIENTS_DIR, `${client}.json`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return validateClientConfig(raw, `config/clients/${client}.json`);
}

let cached: ClientConfig | null = null;

export function clientConfig(): ClientConfig {
  if (!cached) cached = loadClientConfig();
  return cached;
}

/* --------------------------- query-side helpers --------------------------- *
 * These are shared by the index builder and the retriever on purpose. An
 * identifier extracted at index time and one extracted at query time MUST come
 * from the same rule, or the two sides drift and nothing matches — the failure
 * mode is invisible from outside, which is exactly how "v4.2" got lost.
 * -------------------------------------------------------------------------- */

function applyNormalize(value: string, how: IdentifierRule["normalize"]): string {
  if (how === "upper") return value.toUpperCase();
  if (how === "title") return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
  return value.toLowerCase();
}

export interface Ident {
  kind: string;
  value: string;
  /**
   * The line the identifier was found on, captured at INDEX time only.
   *
   * This is what lets the corpus say what an identifier is ABOUT. "429" on its own
   * retrieves the one chunk that carries it and nothing else; the line it sits on —
   * "the rate limit for the tier was reached, read X-RateLimit-Reset" — is the
   * documented vocabulary of its subject, written by the same people who wrote the
   * rest of the corpus. Deriving it beats a hand-kept table mapping each code to
   * its topic, which is a per-client artifact somebody has to extend every time a
   * new code is documented.
   */
  context?: string;
}

/**
 * The line a match sits on.
 *
 * A line, not a sentence or a fixed window: these are markdown documents, where a
 * line is already the unit the author chose — one bullet, one table row, one
 * troubleshooting entry. "**429 Too Many Requests.** The rate limit for the tier
 * was reached. Read `X-RateLimit-Reset` for the retry time." is exactly one line,
 * and a sentence split would have cut it in half at the fact that matters.
 */
function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? undefined : end).trim();
}

/** Every typed identifier in a piece of text, per the client's rules. */
export function extractIdents(text: string, rules: IdentifierRule[], side: "query" | "index" = "query"): Ident[] {
  const out = new Map<string, Ident>();

  for (const rule of rules) {
    if (rule.values) {
      for (const v of rule.values) {
        const hit = new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").exec(text);
        if (hit) {
          const value = applyNormalize(v, rule.normalize);
          out.set(`${rule.kind}:${value}`, {
            kind: rule.kind,
            value,
            context: side === "index" ? lineAt(text, hit.index) : undefined,
          });
        }
      }
      continue;
    }

    const source = side === "index" && rule.indexPattern ? rule.indexPattern : rule.pattern!;
    const re = new RegExp(source, "gi");
    for (const m of text.matchAll(re)) {
      const captured = m[rule.captureGroup ?? 1] ?? m[0];
      if (!captured) continue;
      const value = applyNormalize(captured, rule.normalize);
      out.set(`${rule.kind}:${value}`, {
        kind: rule.kind,
        value,
        context: side === "index" ? lineAt(text, m.index ?? 0) : undefined,
      });
    }
  }

  return [...out.values()];
}

/**
 * Terms added for RANKING only.
 *
 * Deliberately a separate function from anything the gate calls, and the result
 * is deliberately never merged back into the literal term list. The old design
 * had one `terms` array serving both ranking and the evidence count, which is how
 * a synonym expansion came to satisfy the gate that was meant to police it.
 */
export function expansionTerms(query: string, config: ClientConfig, roster: readonly string[]): string[] {
  const terms = new Set<string>();

  for (const token of query.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    for (const extra of config.synonyms.term[token] ?? []) terms.add(extra);
  }

  for (const { match, add } of config.synonyms.phrase) {
    if (!new RegExp(match, "i").test(query)) continue;
    for (const a of add) {
      if (a === ROSTER_MARKER) for (const p of roster) terms.add(p);
      else terms.add(a);
    }
  }

  return [...terms];
}
