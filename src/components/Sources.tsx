"use client";

import { useState } from "react";
import type { PassageView } from "@/lib/providers/types";

/**
 * The passages an answer was built from (R2).
 *
 * Open by default and shown in full, because the reader is mid-call deciding
 * whether to repeat a number out loud — a disclosure triangle is one click too
 * many. Passages render in mono so the corpus's pipe tables stay aligned, and each
 * document's date is given real prominence: comparing dates is how a reader settles
 * a disagreement between two documents.
 */
export function Sources({
  passages,
  conflicts,
}: {
  passages: PassageView[];
  conflicts: Array<[string, string]>;
}) {
  const flagged = new Set(conflicts.flat());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  if (!passages.length) return null;

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="sources">
      <div className="sources-head">
        <strong>
          {passages.length} {passages.length === 1 ? "passage" : "passages"} used
        </strong>
        <span>every claim above should trace to one of these</span>
      </div>

      {passages.map((p) => {
        const isOpen = !collapsed.has(p.id);
        return (
          <div
            key={p.id}
            id={`passage-${p.id}`}
            className={flagged.has(p.id) ? "source flagged" : "source"}
          >
            <button
              type="button"
              className="source-head"
              onClick={() => toggle(p.id)}
              aria-expanded={isOpen}
            >
              <span className="source-id">{p.id}</span>
              <span className="source-where">
                {p.docTitle} — {p.heading}
              </span>
              {p.docDate ? <span className="source-date">updated {p.docDate}</span> : null}
            </button>
            {isOpen ? <pre className="source-text">{p.text}</pre> : null}
          </div>
        );
      })}
    </div>
  );
}
