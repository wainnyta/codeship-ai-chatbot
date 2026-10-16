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
  /**
   * The product this document belongs to, lowercased, or null for a company-wide
   * document. Derived from the document's own title rather than from a list in
   * source, so adding a fifth product is a matter of dropping its markdown into
   * the corpus — there is nothing to remember to update.
   */
  product: string | null;
  /** The `## heading` this chunk sits under, or "Overview" for the preamble. */
  heading: string;
  text: string;
}

const DATE_RE = /updated\s+(\d{4}-\d{2}-\d{2})/i;

/**
 * A product document names its product in its own H1: "Nimbus Vault", "Nimbus
 * Relay release notes". A company-wide document is titled "NimbusStack support
 * policy" — one word, no space — so the required whitespace excludes it without
 * needing a list of exceptions.
 *
 * Filenames would have been the obvious source, but `security-overview.md` is
 * indistinguishable from a product file by its name alone, and the only way to
 * tell them apart would be the hard-coded roster this replaces.
 */
const PRODUCT_TITLE = /^Nimbus\s+([A-Za-z][A-Za-z0-9-]*)/;

export function productInTitle(docTitle: string): string | null {
  return PRODUCT_TITLE.exec(docTitle)?.[1].toLowerCase() ?? null;
}

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
  const product = productInTitle(docTitle);

  const chunks: Chunk[] = [];
  let heading = "Overview";
  let buffer: string[] = [];
  // Citation ids must be unique: they are how the model refers to a passage, how
  // the UI scrolls to it, and how a cited source is matched back to what was
  // retrieved. A document carrying both a preamble and its own "## Overview"
  // heading produced two chunks called `file.md#overview`, and every one of those
  // lookups silently resolved to whichever came first.
  const used = new Set<string>();

  const flush = () => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (!text) return;

    const base = `${file}#${slug(heading)}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);

    chunks.push({
      id,
      file,
      docTitle,
      docDate,
      product,
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
