/**
 * The retrieval eval harness.
 *
 * Deterministic: no provider call, no API key, no network. It can therefore gate a
 * pull request, which is the whole point — the existing 169 unit tests assert that
 * the six representative questions SUCCEED and nothing asserts that junk questions
 * REFUSE, which is why five off-corpus questions came back with cited sources.
 *
 *   npm run eval                      both engines, full report
 *   npm run eval -- --engine=fts      one engine
 *   npm run eval -- --sweep           the coverage-threshold tradeoff table
 *   npm run eval -- --tag=regression  only the pinned defect cases
 *   npm run eval -- --gate            exit non-zero on a regression (for CI)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { clientConfig } from "../src/lib/kb/clientConfig";
import { FtsRetriever } from "../src/lib/kb/fts/ftsRetriever";
import { LegacyRetriever } from "../src/lib/kb/legacyRetriever";
import type { Retrieval, Retriever } from "../src/lib/kb/retriever";
import { INDEX_PATH } from "../src/lib/kb/paths";

interface Case {
  id: string;
  q: string;
  history?: string[];
  expect?: "answer" | "refuse";
  must_include?: string[];
  must_include_any?: string[];
  must_not_include?: string[];
  must_rank_first?: string;
  expect_conflict?: boolean;
  /** Mappings a second pass would propose, to exercise the retry deterministically. */
  synonyms?: Record<string, string[]>;
  tags?: string[];
  note?: string;
  skip?: boolean;
}

interface CaseResult {
  c: Case;
  passed: boolean;
  failures: string[];
  retrieval: Retrieval;
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const has = (name: string): boolean => args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));

const config = clientConfig();
const CORPUS_DIR = join(process.cwd(), config.corpus.dir);
const SET_PATH = join(process.cwd(), "eval", `${config.client}.jsonl`);

function loadCases(): Case[] {
  const tag = flag("tag");
  const cases = readFileSync(SET_PATH, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l) as Case;
      } catch (e) {
        throw new Error(`${SET_PATH}: line ${i + 1} is not valid JSON — ${(e as Error).message}`);
      }
    })
    .filter((c) => !c.skip);
  return tag ? cases.filter((c) => c.tags?.includes(tag)) : cases;
}

function ids(r: Retrieval): string[] {
  return r.kind === "grounded" ? r.passages.map((p) => p.chunk.id) : [];
}

function score(c: Case, r: Retrieval): CaseResult {
  const failures: string[] = [];
  const got = ids(r);
  const expectAnswer = (c.expect ?? "answer") === "answer";

  if (expectAnswer && r.kind === "no_evidence") {
    failures.push(`FALSE REFUSAL (${r.reason}, coverage ${fmt(r.coverage)})`);
  }
  if (!expectAnswer && r.kind === "grounded") {
    failures.push(`FALSE GROUNDING — returned ${got.length}: ${got.slice(0, 4).join(", ")}`);
  }

  if (r.kind === "grounded") {
    for (const id of c.must_include ?? []) {
      if (!got.includes(id)) failures.push(`missing required ${id}`);
    }
    if (c.must_include_any?.length && !c.must_include_any.some((id) => got.includes(id))) {
      failures.push(`none of ${c.must_include_any.join(" | ")}`);
    }
    for (const id of c.must_not_include ?? []) {
      if (got.includes(id)) failures.push(`forbidden ${id} present`);
    }
    if (c.must_rank_first && got[0] !== c.must_rank_first) {
      failures.push(`rank 1 is ${got[0] ?? "(none)"}, expected ${c.must_rank_first}`);
    }
    if (c.expect_conflict && r.conflicts.length === 0) failures.push("expected a conflict candidate, got none");
  }

  return { c, passed: failures.length === 0, failures, retrieval: r };
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(3) : "n/a";
}

interface Metrics {
  cases: number;
  passed: number;
  requiredIdsFound: number;
  requiredIdsTotal: number;
  mrrSum: number;
  mrrN: number;
  answerable: number;
  falseRefusals: number;
  refusable: number;
  falseGroundings: number;
  forbiddenHits: number;
  rankFirstFails: number;
  conflictWanted: number;
  conflictFound: number;
  illegalState: number;
  passageCount: number;
  grounded: number;
}

function measure(results: CaseResult[]): Metrics {
  const m: Metrics = {
    cases: results.length,
    passed: 0,
    requiredIdsFound: 0,
    requiredIdsTotal: 0,
    mrrSum: 0,
    mrrN: 0,
    answerable: 0,
    falseRefusals: 0,
    refusable: 0,
    falseGroundings: 0,
    forbiddenHits: 0,
    rankFirstFails: 0,
    conflictWanted: 0,
    conflictFound: 0,
    illegalState: 0,
    passageCount: 0,
    grounded: 0,
  };

  for (const res of results) {
    const { c, retrieval: r } = res;
    if (res.passed) m.passed++;
    const got = ids(r);
    const expectAnswer = (c.expect ?? "answer") === "answer";

    if (expectAnswer) {
      m.answerable++;
      if (r.kind === "no_evidence") m.falseRefusals++;
    } else {
      m.refusable++;
      if (r.kind === "grounded") m.falseGroundings++;
    }

    // `no_passage_earned` only reachable from the legacy adapter: the state where
    // the old engine said "not empty" and handed back nothing.
    if (r.kind === "no_evidence" && r.reason === "no_passage_earned") m.illegalState++;

    if (r.kind === "grounded") {
      m.grounded++;
      m.passageCount += r.passages.length;
    }

    for (const id of c.must_include ?? []) {
      m.requiredIdsTotal++;
      if (got.includes(id)) m.requiredIdsFound++;
    }
    for (const id of c.must_not_include ?? []) if (got.includes(id)) m.forbiddenHits++;
    if (c.must_rank_first && got[0] !== c.must_rank_first) m.rankFirstFails++;
    if (c.expect_conflict) {
      m.conflictWanted++;
      if (r.kind === "grounded" && r.conflicts.length > 0) m.conflictFound++;
    }

    const target = c.must_include?.[0] ?? c.must_include_any?.find((id) => got.includes(id));
    if (target) {
      const rank = got.indexOf(target);
      m.mrrN++;
      if (rank >= 0) m.mrrSum += 1 / (rank + 1);
    }
  }

  return m;
}

function report(engine: string, results: CaseResult[]): Metrics {
  const m = measure(results);
  const recall = m.requiredIdsTotal ? m.requiredIdsFound / m.requiredIdsTotal : 1;
  const mrr = m.mrrN ? m.mrrSum / m.mrrN : 0;

  const lines = [
    "",
    `━━━ ${engine} ━━━ ${m.passed}/${m.cases} cases pass`,
    `  recall (required ids)  ${fmt(recall)}   (${m.requiredIdsFound}/${m.requiredIdsTotal})`,
    `  MRR                    ${fmt(mrr)}`,
    `  false refusals         ${m.falseRefusals}/${m.answerable}`,
    `  false groundings       ${m.falseGroundings}/${m.refusable}`,
    `  forbidden passages     ${m.forbiddenHits}`,
    `  wrong top passage      ${m.rankFirstFails}`,
    `  conflicts found        ${m.conflictFound}/${m.conflictWanted}`,
    `  mean passages/answer   ${m.grounded ? (m.passageCount / m.grounded).toFixed(1) : "0"}`,
  ];
  if (m.illegalState) {
    lines.push(
      `  ILLEGAL STATE          ${m.illegalState}  (not-empty with zero passages — an evidence-free grounded prompt)`,
    );
  }
  process.stdout.write(lines.join("\n") + "\n");

  const failed = results.filter((r) => !r.passed);
  if (failed.length) {
    process.stdout.write("\n  failures:\n");
    for (const f of failed) {
      const tags = f.c.tags?.length ? ` [${f.c.tags.join(",")}]` : "";
      process.stdout.write(`    ✗ ${f.c.id}${tags}  "${f.c.q}"\n`);
      for (const why of f.failures) process.stdout.write(`        ${why}\n`);
    }
  }
  return m;
}

async function sweep(cases: Case[], build: () => Retriever): Promise<void> {
  process.stdout.write(
    "\n━━━ coverage threshold sweep ━━━\n" +
      "  θ is the refusal gate in config/clients/*.json (thresholds.coverage).\n" +
      "  false groundings are the dangerous failure; false refusals are the annoying one.\n\n" +
      "     θ    false refusals   false groundings   cases passing\n",
  );

  const original = config.thresholds.coverage;
  for (const theta of [0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6]) {
    config.thresholds.coverage = theta;
    const r = build();
    const rs: CaseResult[] = [];
    for (const c of cases) rs.push(score(c, await r.search(c.q, { history: c.history, extraSynonyms: c.synonyms })));
    const m = measure(rs);
    process.stdout.write(
      `  ${theta.toFixed(2)}        ${String(m.falseRefusals).padStart(2)}/${m.answerable}` +
        `              ${String(m.falseGroundings).padStart(2)}/${m.refusable}` +
        `            ${m.passed}/${m.cases}\n`,
    );
    if ("close" in r && typeof r.close === "function") (r as { close(): void }).close();
  }
  config.thresholds.coverage = original;
}

async function main(): Promise<void> {
  const cases = loadCases();
  const which = flag("engine") ?? "both";

  process.stdout.write(
    `eval/${config.client}.jsonl — ${cases.length} cases, corpus ${config.corpus.dir}\n`,
  );

  const engines: Array<{ name: string; make: () => Retriever }> = [];
  if (which === "legacy" || which === "both") {
    engines.push({ name: "legacy-bm25 (src/lib/kb/retrieve.ts)", make: () => LegacyRetriever.fromCorpus(CORPUS_DIR) });
  }
  if (which === "fts" || which === "both") {
    engines.push({ name: "fts5 (src/lib/kb/fts)", make: () => new FtsRetriever(INDEX_PATH) });
  }

  let gateFailed = false;

  for (const engine of engines) {
    let retriever: Retriever;
    try {
      retriever = engine.make();
    } catch (e) {
      process.stdout.write(`\n━━━ ${engine.name} ━━━ UNAVAILABLE: ${(e as Error).message}\n`);
      continue;
    }

    const results: CaseResult[] = [];
    for (const c of cases) results.push(score(c, await retriever.search(c.q, { history: c.history, extraSynonyms: c.synonyms })));
    const m = report(engine.name, results);
    if ("close" in retriever && typeof retriever.close === "function") {
      (retriever as { close(): void }).close();
    }

    // The CI gate is deliberately narrow: a pinned regression coming back, or a
    // forbidden passage appearing. Aggregate recall is for reading, not gating —
    // gating on a mean invites tuning to the mean.
    const regressions = results.filter((r) => !r.passed && r.c.tags?.includes("regression"));
    const open = new Set(results.filter((r) => r.c.tags?.includes("open")).map((r) => r.c.id));
    const hard = regressions.filter((r) => !open.has(r.c.id));
    if (has("gate") && (hard.length > 0 || m.forbiddenHits > 0 || m.illegalState > 0)) gateFailed = true;
  }

  if (has("sweep")) {
    await sweep(cases, () => new FtsRetriever(INDEX_PATH));
  }

  if (has("sweep-dense")) {
    process.stdout.write(
      "\n━━━ semantic floor sweep ━━━\n" +
        "  denseFloor is the cosine at which the dense arm overrides a lexical refusal,\n" +
        "  and the bar a dense-only passage must clear to be cited at all.\n\n" +
        "  floor   false refusals   false groundings   passages/answer   passing\n",
    );
    const keep = config.thresholds.denseFloor;
    for (const f of [0.4, 0.45, 0.5, 0.55, 0.58, 0.6, 0.65, 0.7, 99]) {
      config.thresholds.denseFloor = f;
      const r = new FtsRetriever(INDEX_PATH);
      const rs: CaseResult[] = [];
      for (const c of cases) rs.push(score(c, await r.search(c.q, { history: c.history, extraSynonyms: c.synonyms })));
      const m = measure(rs);
      process.stdout.write(
        `  ${f === 99 ? " off" : f.toFixed(2)}        ${String(m.falseRefusals).padStart(2)}/${m.answerable}` +
          `              ${String(m.falseGroundings).padStart(2)}/${m.refusable}` +
          `               ${(m.grounded ? m.passageCount / m.grounded : 0).toFixed(1)}` +
          `              ${m.passed}/${m.cases}\n`,
      );
      (r as unknown as { close(): void }).close();
    }
    config.thresholds.denseFloor = keep;
  }

  process.stdout.write("\n");
  if (gateFailed) {
    process.stdout.write("GATE FAILED — a pinned regression or a forbidden passage is present.\n");
    process.exit(1);
  }
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});
