import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Chunk {
  /** Stable citation id, e.g. "vault.md#pricing". Shown to the user and to the model. */
  id: string;
  file: string;
  /** First `# heading` of the document, e.g. "Nimbus Vault". */
  docTitle: string;
  /**
   * The "updated YYYY-MM-DD" date declared in the document. Load-bearing, not
   * decoration: it is what lets a conflicting answer be reported as "the January
   * document says X, the July one says Y" rather than silently averaged.
   */
  docDate: string | null;
  /** The `## heading` this chunk sits under, or "Overview" for the preamble. */
  heading: string;
  text: string;
}

const DATE_RE = /updated\s+(\d{4}-\d{2}-\d{2})/i;

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Split one markdown document at its level-2 headings.
 *
 * Sections are never split further. That is deliberate: several of the questions
 * this has to answer are single-cell lookups in a markdown table, and a table
 * separated from its header row cannot be read correctly — you lose which column
 * is "Pro" and which is "Enterprise".
 */
export function chunkDocument(file: string, source: string): Chunk[] {
  const lines = source.split("\n");

  const docTitle = lines.find((l) => l.startsWith("# "))?.slice(2).trim() ?? file;
  const docDate = source.match(DATE_RE)?.[1] ?? null;

  const chunks: Chunk[] = [];
  let heading = "Overview";
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (!text) return;
    chunks.push({
      id: `${file}#${slug(heading)}`,
      file,
      docTitle,
      docDate,
      heading,
      text,
    });
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      heading = line.slice(3).trim();
      continue;
    }
    // Drop the document's own H1; docTitle already carries it.
    if (line.startsWith("# ")) continue;
    buffer.push(line);
  }
  flush();

  return chunks;
}

/** Read and chunk every markdown file in the knowledge base directory. */
export function loadChunks(dir: string): Chunk[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .flatMap((f) => chunkDocument(f, readFileSync(join(dir, f), "utf8")));
}

/**
 * How a chunk is presented to the model. The file, heading and date travel with
 * every passage so the model can attribute and date-compare its sources, and the
 * id is what it is told to cite.
 */
export function formatChunk(c: Chunk): string {
  const dated = c.docDate ? `, updated ${c.docDate}` : "";
  return `[${c.id}] ${c.docTitle} — ${c.heading} (source: ${c.file}${dated})\n${c.text}`;
}
