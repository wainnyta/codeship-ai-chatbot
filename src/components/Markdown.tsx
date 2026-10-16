"use client";

import { Fragment, type ReactNode } from "react";

/**
 * A deliberately small markdown renderer: paragraphs, bullets, tables, headings,
 * bold and inline code, plus optional citation chips.
 *
 * It exists rather than a markdown dependency because both things it renders need
 * tables to be real tables. Answers compare pricing tiers and SLA rows, and the
 * source passages are lifted straight out of a corpus made largely of pipe tables —
 * `| Starter | Pro | Enterprise |` is far slower to read than a rendered grid when
 * someone is checking a figure mid-call.
 *
 * Citations like [vault.md#pricing] become interactive chips that open the passage
 * they name. The link between a claim and its evidence is the product, not a detail.
 */

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[a-z0-9][a-z0-9-]*\.md#[a-z0-9-]+\])/gi;
const CITATION = /^\[([a-z0-9][a-z0-9-]*\.md#[a-z0-9-]+)\]$/i;

export type CiteHandler = (id: string) => void;

function Inline({ text, onCite }: { text: string; onCite?: CiteHandler }): ReactNode {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null;

    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={i}>{part.slice(1, -1)}</code>;
    }

    const cite = CITATION.exec(part);
    if (cite) {
      const id = cite[1];
      // Without a handler (inside a source passage) the id is just text — there is
      // nowhere to jump to from the evidence itself.
      if (!onCite) return <Fragment key={i}>{part}</Fragment>;
      return (
        <button
          key={i}
          type="button"
          className="cite-chip"
          onClick={() => onCite(id)}
          title={`Jump to ${id}`}
        >
          {id}
        </button>
      );
    }

    return <Fragment key={i}>{part}</Fragment>;
  });
}

function cells(row: string): string[] {
  return row
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

const isDivider = (row: string) => /^[\s|:-]+$/.test(row);

function Table({ rows, onCite }: { rows: string[]; onCite?: CiteHandler }) {
  const [header, ...rest] = rows;
  const body = rest.filter((r) => !isDivider(r));

  return (
    <div className="md-table-wrap">
      <table className="md-table">
        <thead>
          <tr>
            {cells(header).map((c, i) => (
              <th key={i}>
                <Inline text={c} onCite={onCite} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {cells(row).map((c, i) => (
                <td key={i}>
                  <Inline text={c} onCite={onCite} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Markdown({
  text,
  onCite,
  trailing,
}: {
  text: string;
  onCite?: CiteHandler;
  /** Appended to the final block — used for the streaming caret. */
  trailing?: ReactNode;
}) {
  const blocks = text.split(/\n{2,}/);

  return (
    <>
      {blocks.map((block, b) => {
        const lines = block.split("\n").filter((l) => l.trim());
        if (!lines.length) return null;

        const last = b === blocks.length - 1;
        const tail = last ? trailing : null;

        if (lines.every((l) => l.trim().startsWith("|"))) {
          return (
            <Fragment key={b}>
              <Table rows={lines.map((l) => l.trim())} onCite={onCite} />
              {tail}
            </Fragment>
          );
        }

        if (lines.some((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <ul key={b}>
              {lines.map((line, i) => (
                <li key={i}>
                  <Inline text={line.replace(/^\s*[-*]\s+/, "")} onCite={onCite} />
                  {tail && i === lines.length - 1 ? tail : null}
                </li>
              ))}
            </ul>
          );
        }

        // Corpus passages carry their own sub-headings (### and deeper survive the
        // chunker, which only splits on ##).
        if (lines.length === 1 && /^#{1,6}\s+/.test(lines[0])) {
          return (
            <h4 key={b} className="md-heading">
              <Inline text={lines[0].replace(/^#{1,6}\s+/, "")} onCite={onCite} />
              {tail}
            </h4>
          );
        }

        return (
          <p key={b}>
            <Inline text={lines.join(" ")} onCite={onCite} />
            {tail}
          </p>
        );
      })}
      {!text ? trailing : null}
    </>
  );
}
