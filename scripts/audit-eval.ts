/**
 * Print each eval case next to the TEXT of the chunks it expects, so a human can
 * check the labels by reading rather than by trusting them.
 *
 * This is the step that decides whether the eval set is worth anything: if the
 * expected ids are wrong, every metric derived from them is wrong, and a label
 * that is merely too STRICT is just as damaging as one that is too loose — it
 * manufactures a failure and sends you optimising retrieval for no reason.
 *
 *   npm run eval:audit                  every case
 *   npm run eval:audit -- --tag=trap    one group at a time (recommended)
 *   npm run eval:audit -- --id=us6      one case
 *   npm run eval:audit -- --check       ids only: verify every id actually exists
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { chunkDocument, type Chunk } from "../src/lib/kb/chunk";
import { clientConfig } from "../src/lib/kb/clientConfig";
import { readdirSync } from "node:fs";

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
  tags?: string[];
  note?: string;
  skip?: boolean;
}

const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const has = (n: string) => args.some((a) => a === `--${n}`);

const config = clientConfig();
const dir = join(process.cwd(), config.corpus.dir);

const chunks = new Map<string, Chunk>();
for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
  for (const c of chunkDocument(file, readFileSync(join(dir, file), "utf8"))) chunks.set(c.id, c);
}

const cases = readFileSync(join(process.cwd(), "eval", `${config.client}.jsonl`), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Case)
  .filter((c) => !c.skip);

const tag = flag("tag");
const id = flag("id");
const selected = cases.filter((c) => (!tag || c.tags?.includes(tag)) && (!id || c.id === id));

const out = process.stdout;

/* --check: every referenced id must exist. A typo in an expected id is a silent
   permanent failure that looks like a retrieval problem. */
if (has("check")) {
  let bad = 0;
  for (const c of cases) {
    const all = [
      ...(c.must_include ?? []),
      ...(c.must_include_any ?? []),
      ...(c.must_not_include ?? []),
      ...(c.must_rank_first ? [c.must_rank_first] : []),
    ];
    for (const ref of all) {
      if (!chunks.has(ref)) {
        out.write(`UNKNOWN ID  ${c.id}: ${ref}\n`);
        bad++;
      }
    }
  }
  out.write(bad === 0 ? `all referenced ids exist (${chunks.size} chunks in the corpus)\n` : `${bad} bad reference(s)\n`);
  process.exit(bad === 0 ? 0 : 1);
}

function excerpt(c: Chunk, lines = 4): string {
  return c.text
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, lines)
    .map((l) => `        ${l.length > 110 ? l.slice(0, 110) + "…" : l}`)
    .join("\n");
}

function show(label: string, refs: string[]): void {
  if (!refs.length) return;
  out.write(`    ${label}\n`);
  for (const ref of refs) {
    const c = chunks.get(ref);
    if (!c) {
      out.write(`      ✗ ${ref}  — NO SUCH CHUNK\n`);
      continue;
    }
    out.write(`      • ${ref}   [${c.docTitle} › ${c.heading}${c.docDate ? `, ${c.docDate}` : ", no date"}]\n`);
    out.write(excerpt(c) + "\n");
  }
}

for (const c of selected) {
  out.write(`\n${"─".repeat(100)}\n`);
  out.write(`${c.id}  [${(c.tags ?? []).join(",")}]  expect: ${c.expect ?? "answer"}\n`);
  if (c.history?.length) out.write(`  history: ${c.history.map((h) => `"${h}"`).join(" → ")}\n`);
  out.write(`  QUESTION: "${c.q}"\n`);
  if (c.note) out.write(`  why: ${c.note}\n`);
  out.write("\n  READ THESE AND DECIDE: does this text answer that question?\n");
  show("must include ALL of:", c.must_include ?? []);
  show("must include AT LEAST ONE of:", c.must_include_any ?? []);
  show("must NOT include:", c.must_not_include ?? []);
  if (c.must_rank_first) show("must be the TOP passage:", [c.must_rank_first]);
  if (c.expect_conflict) out.write("    must flag a conflict candidate\n");
  if ((c.expect ?? "answer") === "refuse" && !(c.must_include ?? []).length) {
    out.write("    (refusal case — nothing in the corpus should answer this)\n");
  }
}

out.write(`\n${selected.length} case(s). Tags: ${[...new Set(cases.flatMap((c) => c.tags ?? []))].sort().join(" ")}\n`);
