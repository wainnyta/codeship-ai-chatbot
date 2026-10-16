"use client";

import { Fragment, type ReactNode } from "react";

/**
 * A deliberately small markdown renderer: paragraphs, ordered and unordered lists,
 * tables, headings, bold, italic, inline code, links, and citation chips.
 *
 * It exists rather than a markdown dependency because both things it renders need
 * tables to be real tables. Answers compare pricing tiers and SLA rows, and the
 * source passages come from a corpus made largely of pipe tables —
 * `| Starter | Pro | Enterprise |` is far slower to read than a rendered grid when
 * someone is checking a figure mid-call.
 *
 * Anything it fails to handle leaks as raw syntax into the answer, so the inline
 * and block grammars below cover what the models actually emit, not a minimum.
 */

export type CiteHandler = (id: string) => void;

/**
 * Order matters: `**bold**` must be tried before `*italic*`, or the italic branch
 * eats the first two asterisks of a bold run. Underscore italics require a
 * non-word character on each side so `secretsmanager:PutSecretValue` and
 * `clear_tool_uses_20250919` survive intact.
 */
const INLINE = new RegExp(
  [
    // First, so that a backslash claims the character after it before any other
    // branch can. A model writing \*Pro pricing change\* to mean literal asterisks
    // otherwise rendered as a stray backslash followed by italic text. The class is
    // every ASCII punctuation mark, as CommonMark specifies — \$59 matters here as
    // much as \*, because the corpus is full of prices and models escape them.
    "\\\\[!-\\/:-@\\[-`{-~]", // escaped punctuation: every ASCII punctuation mark
    "\\*\\*[^*]+\\*\\*", // bold
    "\\*[^*\\n]+\\*", // italic
    "(?<![A-Za-z0-9])_[^_\\n]+_(?![A-Za-z0-9])", // italic, underscore form
    "`[^`]+`", // inline code
    "\\[[a-z0-9][a-z0-9-]*\\.md#[a-z0-9-]+\\]", // citation
    "\\[[^\\]]+\\]\\([^)\\s]+\\)", // link
  ]
    .map((p) => `(?:${p})`)
    .join("|"),
  "gi",
);

const CITATION = /^\[([a-z0-9][a-z0-9-]*\.md#[a-z0-9-]+)\]$/i;
const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/;

function Inline({ text, onCite }: { text: string; onCite?: CiteHandler }): ReactNode {
  // A capture-free pattern wrapped in one group so split() keeps the delimiters.
  return text.split(new RegExp(`(${INLINE.source})`, "gi")).map((part, i) => {
    if (!part) return null;

    // Emphasis renders its contents recursively. Rendering the inner text as a
    // raw string silently dropped anything nested inside it — a citation written
    // as *(... [relay.md#troubleshooting].)* lost its chip and appeared as
    // literal brackets, which is exactly the link a reader wants to follow.
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={i}>
          <Inline text={part.slice(2, -2)} onCite={onCite} />
        </strong>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return (
        <em key={i}>
          <Inline text={part.slice(1, -1)} onCite={onCite} />
        </em>
      );
    }
    if (part.startsWith("_") && part.endsWith("_") && part.length > 2) {
      return (
        <em key={i}>
          <Inline text={part.slice(1, -1)} onCite={onCite} />
        </em>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={i}>{part.slice(1, -1)}</code>;
    }

    const cite = CITATION.exec(part);
    if (cite) {
      // Without a handler (inside a source passage) the id is just text — there is
      // nowhere to jump to from the evidence itself.
      if (!onCite) return <Fragment key={i}>{part}</Fragment>;
      return (
        <button
          key={i}
          type="button"
          className="cite-chip"
          onClick={() => onCite(cite[1])}
          title={`Jump to ${cite[1]}`}
        >
          {cite[1]}
        </button>
      );
    }

    const link = LINK.exec(part);
    if (link) {
      return (
        <a key={i} href={link[2]} target="_blank" rel="noreferrer noopener">
          {link[1]}
        </a>
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

const BULLET = /^\s*[-*+]\s+/;
const ORDERED = /^\s*(\d+)[.)]\s+/;
const HEADING = /^\s*(#{1,6})\s+(.*)$/;
const TABLE_ROW = /^\s*\|/;
const DIVIDER_ROW = /^[\s|:-]+$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

/** Exposed for tests: the inline tokens a line splits into, delimiters kept. */
export function inlineTokens(text: string): string[] {
  return text.split(new RegExp(`(${INLINE.source})`, "gi")).filter(Boolean);
}

export type Node =
  | { kind: "p"; lines: string[] }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[]; start: number }
  | { kind: "table"; rows: string[] }
  | { kind: "h"; level: number; text: string }
  | { kind: "hr" };

/**
 * Line-oriented rather than block-oriented. Splitting on blank lines first meant a
 * list that followed a lead-in sentence without an intervening blank line — which
 * models emit constantly — rendered as a paragraph full of literal hyphens.
 */
export function parse(text: string): Node[] {
  const nodes: Node[] = [];
  let open: Node | null = null;

  const flush = () => {
    if (open) nodes.push(open);
    open = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();

    if (!line.trim()) {
      flush();
      continue;
    }

    if (RULE.test(line)) {
      flush();
      nodes.push({ kind: "hr" });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      nodes.push({ kind: "h", level: heading[1].length, text: heading[2] });
      continue;
    }

    if (TABLE_ROW.test(line)) {
      if (open?.kind !== "table") {
        flush();
        open = { kind: "table", rows: [] };
      }
      open.rows.push(line.trim());
      continue;
    }

    const ordered = ORDERED.exec(line);
    if (ordered) {
      if (open?.kind !== "ol") {
        flush();
        open = { kind: "ol", items: [], start: Number(ordered[1]) };
      }
      open.items.push(line.replace(ORDERED, ""));
      continue;
    }

    if (BULLET.test(line)) {
      if (open?.kind !== "ul") {
        flush();
        open = { kind: "ul", items: [] };
      }
      open.items.push(line.replace(BULLET, ""));
      continue;
    }

    // A plain line continuing a list is that item's wrapped text, not a new block.
    if (open?.kind === "ul" || open?.kind === "ol") {
      open.items[open.items.length - 1] += ` ${line.trim()}`;
      continue;
    }

    if (open?.kind !== "p") {
      flush();
      open = { kind: "p", lines: [] };
    }
    open.lines.push(line.trim());
  }

  flush();
  return nodes;
}

export function Markdown({
  text,
  onCite,
  trailing,
}: {
  text: string;
  onCite?: CiteHandler;
  /** Appended to the final node — used for the streaming caret. */
  trailing?: ReactNode;
}) {
  const nodes = parse(text);

  return (
    <>
      {nodes.map((node, i) => {
        const tail = i === nodes.length - 1 ? trailing : null;

        switch (node.kind) {
          case "hr":
            return <hr key={i} className="md-rule" />;

          case "h":
            return (
              <h4 key={i} className="md-heading">
                <Inline text={node.text} onCite={onCite} />
                {tail}
              </h4>
            );

          case "table": {
            const [header, ...rest] = node.rows;
            const body = rest.filter((r) => !DIVIDER_ROW.test(r));
            return (
              <Fragment key={i}>
                <div className="md-table-wrap">
                  <table className="md-table">
                    <thead>
                      <tr>
                        {cells(header).map((c, n) => (
                          <th key={n}>
                            <Inline text={c} onCite={onCite} />
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {body.map((row, r) => (
                        <tr key={r}>
                          {cells(row).map((c, n) => (
                            <td key={n}>
                              <Inline text={c} onCite={onCite} />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {tail}
              </Fragment>
            );
          }

          case "ul":
            return (
              <ul key={i}>
                {node.items.map((item, n) => (
                  <li key={n}>
                    <Inline text={item} onCite={onCite} />
                    {tail && n === node.items.length - 1 ? tail : null}
                  </li>
                ))}
              </ul>
            );

          case "ol":
            return (
              <ol key={i} start={node.start}>
                {node.items.map((item, n) => (
                  <li key={n}>
                    <Inline text={item} onCite={onCite} />
                    {tail && n === node.items.length - 1 ? tail : null}
                  </li>
                ))}
              </ol>
            );

          case "p":
            return (
              <p key={i}>
                <Inline text={node.lines.join(" ")} onCite={onCite} />
                {tail}
              </p>
            );
        }
      })}
      {!nodes.length ? trailing : null}
    </>
  );
}
