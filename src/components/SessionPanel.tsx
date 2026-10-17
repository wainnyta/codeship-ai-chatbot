"use client";

import { useEffect, useRef, useState } from "react";
import { ContextRing } from "./ContextRing";
import { useDismiss } from "./useDismiss";
import { type ContextStatus, type Usage, formatCost } from "@/lib/usage";

/** One answered question, as the session dialog lists it. */
export interface SessionRow {
  id: string;
  question: string;
  model: string;
  usage: Usage;
  /** What resolving a follow-up cost, where one was resolved. */
  rewrite: Usage | null;
}

/**
 * The session's numbers, and what can be done with them.
 *
 * All of this used to be a strip across the bottom of the page: session totals,
 * two export buttons, a labelled percentage and a progress bar. Four controls and
 * a sentence of chrome, permanently occupying a row above the composer, to carry
 * figures that are glanced at rather than read.
 *
 * The running total stays on screen because R4 asks for it after every message,
 * but as one chip — the ring and the cost — and everything behind it moves into
 * this dialog, which is where someone goes when they actually want the breakdown.
 */
export function SessionPanel({
  usage,
  context,
  rows,
  contextWindow,
  onExport,
}: {
  usage: Usage;
  context: ContextStatus;
  rows: SessionRow[];
  contextWindow: number;
  onExport: (format: "csv" | "json") => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const menuRoot = useRef<HTMLDivElement>(null);
  const dialogRoot = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useDismiss(menuOpen, () => setMenuOpen(false), menuRoot);
  useDismiss(detailsOpen, () => setDetailsOpen(false), dialogRoot);

  // Focus moves into the dialog on open, or a keyboard reader is left behind the
  // page it can no longer see.
  useEffect(() => {
    if (detailsOpen) closeRef.current?.focus();
  }, [detailsOpen]);

  const empty = !rows.length;
  const percent = context.percent.toFixed(context.percent < 1 ? 2 : 0);

  return (
    <>
      <button
        type="button"
        className="usage-chip"
        onClick={() => setDetailsOpen(true)}
        title={`Session: ${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out. Context ${percent}% of ${contextWindow.toLocaleString()} tokens.`}
      >
        <ContextRing context={context} />
        <span>
          {formatCost(usage.costUsd)}
          {usage.estimated ? "*" : ""}
        </span>
      </button>

      <div className="menu" ref={menuRoot}>
        <button
          type="button"
          className="icon-button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Session menu"
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <circle cx="8" cy="3" r="1.5" />
            <circle cx="8" cy="8" r="1.5" />
            <circle cx="8" cy="13" r="1.5" />
          </svg>
        </button>

        {menuOpen ? (
          <div className="menu-pop" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                setDetailsOpen(true);
              }}
            >
              Session details
            </button>
            <div className="menu-rule" />
            <button
              type="button"
              role="menuitem"
              disabled={empty}
              onClick={() => {
                setMenuOpen(false);
                onExport("csv");
              }}
            >
              Export CSV
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={empty}
              onClick={() => {
                setMenuOpen(false);
                onExport("json");
              }}
            >
              Export JSON
            </button>
          </div>
        ) : null}
      </div>

      {detailsOpen ? (
        <div className="scrim">
          <div className="dialog" ref={dialogRoot} role="dialog" aria-modal="true" aria-label="Session details">
            <div className="dialog-head">
              <h2>This session</h2>
              <button
                type="button"
                ref={closeRef}
                className="icon-button"
                onClick={() => setDetailsOpen(false)}
                aria-label="Close"
              >
                <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" fill="none" />
                </svg>
              </button>
            </div>

            <div className="totals">
              <div>
                <b>{usage.inputTokens.toLocaleString()}</b>
                <span>tokens in</span>
              </div>
              <div>
                <b>{usage.outputTokens.toLocaleString()}</b>
                <span>tokens out</span>
              </div>
              <div>
                <b>
                  {formatCost(usage.costUsd)}
                  {usage.estimated ? "*" : ""}
                </b>
                <span>{usage.estimated ? "cost, includes an estimate" : "cost"}</span>
              </div>
              <div>
                <b className={`ctx ctx-${context.level}`}>{percent}%</b>
                <span>of {contextWindow.toLocaleString()} context</span>
              </div>
            </div>

            {empty ? (
              <p className="dialog-empty">Nothing asked yet. Numbers appear here per message.</p>
            ) : (
              <table className="ledger">
                <thead>
                  <tr>
                    <th>Question</th>
                    <th>Answered by</th>
                    <th>Tokens</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="ledger-q">{r.question}</td>
                      <td>{r.model}</td>
                      <td>
                        {r.usage.inputTokens.toLocaleString()} / {r.usage.outputTokens.toLocaleString()}
                        {/* Resolving a follow-up is a separate provider call, so it
                            is listed separately rather than folded into the answer's
                            own numbers. */}
                        {r.rewrite ? (
                          <small>
                            + {r.rewrite.inputTokens.toLocaleString()} /{" "}
                            {r.rewrite.outputTokens.toLocaleString()} resolving
                          </small>
                        ) : null}
                      </td>
                      <td>
                        {formatCost(r.usage.costUsd)}
                        {r.rewrite ? <small>+ {formatCost(r.rewrite.costUsd)}</small> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="dialog-foot">
              <button type="button" onClick={() => onExport("csv")} disabled={empty}>
                Export CSV
              </button>
              <button type="button" onClick={() => onExport("json")} disabled={empty}>
                Export JSON
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
