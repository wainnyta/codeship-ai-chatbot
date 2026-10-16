"use client";

import { useEffect, useState } from "react";
import type { PassageView } from "@/lib/providers/types";
import { Markdown } from "./Markdown";

/**
 * The passages an answer was built from (R2).
 *
 * Collapsed to a single summary line by default. Showing eight passages in full
 * pushed the answer itself off screen, which defeats the point — the reader is
 * mid-call and needs the answer first, with the evidence one click away rather
 * than in front of it. Three levels: a summary line, the list of passages, then
 * each passage's verbatim text.
 *
 * Passages render in mono so the corpus's pipe tables stay aligned, and each
 * document's date is given real prominence: comparing dates is how a reader
 * settles a disagreement between two documents.
 */
export function Sources({
  passages,
  conflicts,
  focusId,
  focusNonce = 0,
}: {
  passages: PassageView[];
  conflicts: Array<[string, string]>;
  /** A citation the reader clicked in the answer; opens straight to that passage. */
  focusId?: string | null;
  /** Bumped on every click, so clicking the same citation twice jumps again. */
  focusNonce?: number;
}) {
  const flagged = new Set(conflicts.flat());
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Passages the reader switched back to verbatim markdown source. */
  const [raw, setRaw] = useState<Set<string>>(new Set());

  // A citation chip in the answer should land on the passage itself, not on a
  // closed drawer the reader then has to go hunting through.
  useEffect(() => {
    if (!focusId) return;
    if (!passages.some((p) => p.id === focusId)) return;

    setOpen(true);
    setExpanded((prev) => new Set(prev).add(focusId));

    const timer = setTimeout(() => {
      document.getElementById(`passage-${focusId}`)?.scrollIntoView({ block: "center" });
    }, 60);
    return () => clearTimeout(timer);
  }, [focusId, focusNonce, passages]);

  if (!passages.length) return null;

  const documents = new Set(passages.map((p) => p.file));
  const flaggedCount = passages.filter((p) => flagged.has(p.id)).length;

  const toggleRaw = (id: string) =>
    setRaw((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="sources">
      <button
        type="button"
        className="sources-summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={open ? "chev open" : "chev"} aria-hidden="true" />
        <strong>
          {passages.length} {passages.length === 1 ? "passage" : "passages"}
        </strong>
        <span className="sources-from">
          from {documents.size} {documents.size === 1 ? "document" : "documents"}
        </span>
        {flaggedCount ? <span className="sources-flagged">{flaggedCount} flagged</span> : null}
        <span className="sources-hint">{open ? "hide" : "show"}</span>
      </button>

      {open ? (
        <div className="sources-list">
          {passages.map((p) => {
            const isOpen = expanded.has(p.id);
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
                  {p.docDate ? <span className="source-date">{p.docDate}</span> : null}
                </button>
                {isOpen ? (
                  <div className="source-body">
                    {raw.has(p.id) ? (
                      <pre className="source-raw">{p.text}</pre>
                    ) : (
                      <div className="md source-md">
                        <Markdown text={p.text} />
                      </div>
                    )}
                    <button type="button" className="raw-toggle" onClick={() => toggleRaw(p.id)}>
                      {raw.has(p.id) ? "rendered" : "raw markdown"}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
