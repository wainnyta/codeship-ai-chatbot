"use client";

import { Fragment, type ReactNode } from "react";

/**
 * A deliberately small markdown renderer: paragraphs, bullets, tables, bold and
 * inline code, plus citation chips.
 *
 * It exists rather than a markdown dependency for two reasons. Answers compare
 * pricing tiers and SLA rows, so tables have to render as tables or the comparison
 * is unreadable. And citations like [vault.md#pricing] need to become interactive
 * chips that scroll to the passage they name — the link between a claim and its
 * evidence is the point of the product, not an afterthought.
 */

const CITATION = /\[([a-z0-9][a-z0-9-]*\.md#[a-z0-9-]+)\]/gi;
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[a-z0-9][a-z0-9-]*\.md#[a-z0-9-]+\])/gi;

function Inline({ text, onCite }: { text: string; onCite: (id: string) => void }): ReactNode {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null;

    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={i}>{part.slice(1, -1)}</code>;
    }

    CITATION.lastIndex = 0;
    const cite = CITATION.exec(part);
    if (cite) {
      const id = cite[1];
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

function Table({ rows, onCite }: { rows: string[]; onCite: (id: string) => void }) {
  const cells = (row: string) =>
    row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

  const [header, ...rest] = rows;
  const body = rest.filter((r) => !/^[\s|:-]+$/.test(r));

  return (
    <table className="answer-table">
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
  );
}

export function Answer({
  text,
  streaming,
  onCite,
}: {
  text: string;
  streaming?: boolean;
  onCite: (id: string) => void;
}) {
  const blocks = text.split(/\n{2,}/);

  return (
    <div className="answer-body">
      {blocks.map((block, b) => {
        const lines = block.split("\n").filter((l) => l.trim());
        if (!lines.length) return null;

        const last = b === blocks.length - 1;
        const caret = streaming && last ? <span className="caret" aria-hidden="true" /> : null;

        if (lines.every((l) => l.trim().startsWith("|"))) {
          return (
            <Fragment key={b}>
              <Table rows={lines.map((l) => l.trim())} onCite={onCite} />
              {caret}
            </Fragment>
          );
        }

        if (lines.some((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <ul key={b}>
              {lines.map((line, i) => (
                <li key={i}>
                  <Inline text={line.replace(/^\s*[-*]\s+/, "")} onCite={onCite} />
                  {caret && i === lines.length - 1 ? caret : null}
                </li>
              ))}
            </ul>
          );
        }

        return (
          <p key={b}>
            <Inline text={lines.join(" ")} onCite={onCite} />
            {caret}
          </p>
        );
      })}
      {streaming && !text ? <span className="caret" aria-hidden="true" /> : null}
    </div>
  );
}
