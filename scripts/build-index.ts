/**
 * Builds the search index from the corpus. `npm run build:index`.
 *
 * Deterministic: identical corpus content produces an identical `corpusVersion`,
 * which is asserted by `npm run eval` and is what lets an answer be attributed to
 * a corpus state after the fact.
 */

import { join } from "node:path";

import { clientConfig } from "../src/lib/kb/clientConfig";
import { buildIndex } from "../src/lib/kb/fts/build";
import { INDEX_PATH } from "../src/lib/kb/paths";

async function main(): Promise<void> {
  const config = clientConfig();
  const dir = join(process.cwd(), config.corpus.dir);

  const report = await buildIndex({ dir, out: INDEX_PATH, config });

  process.stdout.write(
    [
      `built ${report.path}`,
      `  client          ${config.client}`,
      `  corpus          ${config.corpus.dir}`,
      `  corpus version  ${report.corpusVersion}`,
      `  chunks          ${report.chunks}`,
      `  products        ${report.products.join(", ") || "(none)"}`,
      `  identifiers     ${report.idents}`,
      `  stopwords       ${report.stopwords.length} derived (df/N >= ${config.stopwords.dfRatio}, diagnostic only)`,
      `                  ${report.stopwords.slice(0, 24).join(" ")}${report.stopwords.length > 24 ? " …" : ""}`,
      `  dense arm       ${report.dense.enabled ? `${report.dense.fromCache} cached + ${report.dense.embedded} embedded${report.dense.missing ? `, ${report.dense.missing} MISSING` : ""}` : "disabled"}`,
      "",
    ].join("\n"),
  );

  if (report.dense.note) process.stdout.write(`  ${report.dense.note}\n`);

  if (report.quarantined.length) {
    process.stdout.write(
      `  QUARANTINED ${report.quarantined.length} chunk(s) — not indexed, metadata unresolved:\n` +
        report.quarantined.map((q) => `    ${q.id}: ${q.reason}\n`).join(""),
    );
  }

}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});
