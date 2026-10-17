"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Answer } from "./Answer";
import { ModelPicker } from "./ModelPicker";
import { Nimbo, type NimboState } from "./Nimbo";
import { SessionChip, SessionDialog, SessionMenu, type SessionRow } from "./SessionPanel";
import { Sources } from "./Sources";
import type { PublicModel } from "@/lib/config";
import type { AnsweringModel, PassageView, RewriteView, StreamEvent } from "@/lib/providers/types";
import { activeConflicts, declaresConflict, stripConflictMarker } from "@/lib/citations";
import { type Usage, contextStatus, estimateTokens, formatCost, sumUsage } from "@/lib/usage";

interface Turn {
  id: string;
  question: string;
  answer: string;
  passages: PassageView[];
  conflicts: Array<[string, string]>;
  model: AnsweringModel | null;
  usage: Usage | null;
  /** Set when a follow-up was resolved into a standalone query before retrieval. */
  rewrite: RewriteView | null;
  truncated: boolean;
  error: { message: string; partial: boolean } | null;
  streaming: boolean;
}

/**
 * Opening questions. Each names the product it depends on, so a starter is hidden
 * rather than offered and broken if that product leaves the corpus.
 */
const STARTERS: Array<{ q: string; product?: string }> = [
  { q: "Which of our products support SSO via SAML 2.0?", product: "vault" },
  { q: "What are the key differences between Relay's Pro and Enterprise tiers?", product: "relay" },
  { q: "A client is getting a 403 on the Relay API. What should they check first?", product: "relay" },
  { q: "What's the SLA for Priority 1 tickets on Nimbus Vault?", product: "vault" },
];

/**
 * What Nimbo is doing, and what it says it is doing.
 *
 * One character, in one place, reporting the single thing in flight — rather than
 * an avatar beside every answer, which by the fifth turn is wallpaper. Idle is a
 * real state here and needs a line of its own, so the bar never sits blank.
 */
/**
 * What Nimbo says between questions.
 *
 * The "did you know" lines are about the tool rather than about the products.
 * Facts about the corpus would have to be written here by hand and would quietly
 * go stale the first time a document changed — the same trap the hard-coded
 * product roster was. Every line below is true of the application itself, so each
 * one teaches something usable and none of them can be outdated by an edit to the
 * knowledge base.
 */
const IDLE_LINES = [
  "Waiting for a question.",
  "Ready when you are.",
  "Standing by, documents open.",
  "Nothing in flight.",
  "Did you know? You can switch model mid-conversation and keep the thread.",
  "Did you know? Every answer shows the passages it was built from.",
  "Did you know? I'll flag it when two documents disagree with each other.",
  "Did you know? Follow-ups work — just ask \"and for Relay?\" next.",
  "Did you know? The token count and cost of every answer are shown below.",
  "Did you know? You can export the whole session as CSV or JSON.",
  "Did you know? If the documents don't cover it, I say so instead of guessing.",
];

function activity(
  turns: Turn[],
  idleLine: string,
): { state: NimboState; line: string } {
  const live = turns.at(-1);
  if (!live?.streaming) return { state: "idle", line: idleLine };

  // Said here rather than beside the answer: the bar is not adjacent to the text,
  // so it is reporting rather than repeating.
  if (live.answer) return { state: "answering", line: "Writing the answer…" };

  if (live.passages.length) {
    const n = live.passages.length;
    return { state: "searching", line: `Reading ${n} passage${n === 1 ? "" : "s"}…` };
  }
  return turns.length > 1
    ? { state: "thinking", line: "Working out what you mean…" }
    : { state: "searching", line: "Looking through the knowledge base…" };
}

function newTurn(question: string): Turn {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    question,
    answer: "",
    passages: [],
    conflicts: [],
    model: null,
    usage: null,
    rewrite: null,
    truncated: false,
    error: null,
    streaming: true,
  };
}

export function Chat({ products }: { products: string[] }) {
  const [models, setModels] = useState<PublicModel[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [idleLine, setIdleLine] = useState(IDLE_LINES[0]);
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    if (busy) return;
    const pick = () => setIdleLine(IDLE_LINES[Math.floor(Math.random() * IDLE_LINES.length)]);
    pick();
    const timer = setInterval(pick, 9000);
    return () => clearInterval(timer);
  }, [busy]);

  /**
   * Grow the field to fit what is in it, then stop and scroll.
   *
   * The ceiling is lines rather than pixels, and smaller on a phone: twelve lines
   * is a comfortable paragraph on a desktop and most of the screen on a handset,
   * where the thing being pushed off the top is the answer you are asking about.
   */
  const autosize = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;

    const style = getComputedStyle(el);
    const line = parseFloat(style.lineHeight) || 22;
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const maxLines = window.matchMedia("(max-width: 680px)").matches ? 5 : 12;

    el.style.height = "auto";
    const height = Math.min(el.scrollHeight, Math.round(line * maxLines + padding));
    el.style.height = `${height}px`;
    el.style.overflowY = el.scrollHeight > height ? "auto" : "hidden";
  }, []);

  useEffect(autosize, [draft, autosize]);

  // Crossing the breakpoint changes the ceiling, so the field is re-measured.
  useEffect(() => {
    window.addEventListener("resize", autosize);
    return () => window.removeEventListener("resize", autosize);
  }, [autosize]);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((data: { models: PublicModel[]; defaultModelId: string }) => {
        setModels(data.models);
        setSelectedId(data.defaultModelId);
      })
      .catch(() => undefined);
  }, []);

  const selected = models.find((m) => m.id === selectedId);

  const patch = useCallback((id: string, change: Partial<Turn>) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...change } : t)));
  }, []);

  const send = useCallback(
    async (question: string) => {
      // E10, enforced here as well as on the server: nothing is sent at all.
      if (!question.trim() || busy) return;

      const turn = newTurn(question.trim());
      const history = turns.flatMap((t) =>
        t.answer
          ? [
              { role: "user" as const, content: t.question },
              { role: "assistant" as const, content: t.answer },
            ]
          : [{ role: "user" as const, content: t.question }],
      );

      setTurns((prev) => [...prev, turn]);
      setDraft("");
      setBusy(true);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [...history, { role: "user", content: turn.question }],
            modelId: selectedId,
          }),
        });

        if (!response.body) {
          const fallback = (await response.json().catch(() => null)) as StreamEvent | null;
          patch(turn.id, {
            streaming: false,
            error: {
              message:
                fallback && fallback.type === "error"
                  ? fallback.message
                  : "The server did not return a reply.",
              partial: false,
            },
          });
          return;
        }

        if (!response.headers.get("Content-Type")?.includes("event-stream")) {
          const event = (await response.json()) as StreamEvent;
          patch(turn.id, {
            streaming: false,
            error: {
              message: event.type === "error" ? event.message : "Something went wrong.",
              partial: false,
            },
          });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let answer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            if (!frame.startsWith("data: ")) continue;
            const event = JSON.parse(frame.slice(6)) as StreamEvent;

            switch (event.type) {
              case "meta":
                patch(turn.id, {
                  passages: event.passages,
                  conflicts: event.conflicts,
                  rewrite: event.rewrite ?? null,
                });
                break;
              case "model":
                patch(turn.id, { model: event.model });
                break;
              case "delta":
                answer += event.text;
                patch(turn.id, { answer });
                break;
              case "usage":
                patch(turn.id, { usage: event.usage, truncated: event.truncated });
                break;
              case "error":
                patch(turn.id, {
                  error: { message: event.message, partial: Boolean(event.partial) },
                  usage: event.usage ?? null,
                  streaming: false,
                });
                break;
              case "done":
                patch(turn.id, { streaming: false });
                break;
            }
          }
        }
        patch(turn.id, { streaming: false });
      } catch {
        patch(turn.id, {
          streaming: false,
          error: { message: "Lost the connection to the server. Resend to try again.", partial: false },
        });
      } finally {
        setBusy(false);
        composerRef.current?.focus();
      }
    },
    [busy, patch, selectedId, turns],
  );

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [turns]);

  /**
   * Session spend includes the rewrite calls. They are real provider calls with
   * real tokens, so leaving them out would make the running total quietly wrong —
   * and a cost panel that undercounts is worse than no cost panel.
   */
  const sessionUsage = useMemo(
    () =>
      sumUsage(
        turns
          .flatMap((t) => [t.usage, t.rewrite?.usage ?? null])
          .filter((u): u is Usage => Boolean(u)),
      ),
    [turns],
  );

  /**
   * Context load. Uses the input tokens the provider actually charged for on the
   * most recent reply where that is known, rather than a guess. Because the window
   * comes from config, switching models recomputes this immediately (E7).
   */
  const contextTokens = useMemo(() => {
    const lastKnown = [...turns].reverse().find((t) => t.usage && t.usage.inputTokens > 0);
    if (lastKnown?.usage) {
      return lastKnown.usage.inputTokens + estimateTokens(lastKnown.answer);
    }
    return estimateTokens(turns.map((t) => `${t.question}${t.answer}`).join(""));
  }, [turns]);

  const context = contextStatus(contextTokens, selected?.contextWindow ?? 0);
  const live = activity(turns, idleLine);

  const sessionRows: SessionRow[] = turns
    .filter((t) => t.usage)
    .map((t) => ({
      id: t.id,
      question: t.question,
      model: t.model?.label ?? "none",
      usage: t.usage!,
      rewrite: t.rewrite?.usage ?? null,
    }));

  const exportSession = (format: "csv" | "json") => {
    const rows = turns
      .filter((t) => t.usage)
      .map((t) => ({
        question: t.question,
        model: t.model?.label ?? "none",
        modelId: t.model?.id ?? "none",
        fallbackUsed: t.model?.fallback ?? false,
        inputTokens: t.usage!.inputTokens,
        outputTokens: t.usage!.outputTokens,
        costUsd: t.usage!.costUsd,
        estimated: t.usage!.estimated,
        searchQuery: t.rewrite?.query ?? t.question,
        rewriteInputTokens: t.rewrite?.usage.inputTokens ?? 0,
        rewriteOutputTokens: t.rewrite?.usage.outputTokens ?? 0,
        rewriteCostUsd: t.rewrite?.usage.costUsd ?? 0,
        sources: t.passages.map((p) => p.id).join(" "),
      }));

    const body =
      format === "json"
        ? JSON.stringify({ messages: rows, total: sessionUsage }, null, 2)
        : [
            "question,search_query,model,model_id,fallback_used,input_tokens,output_tokens,cost_usd,estimated,rewrite_input_tokens,rewrite_output_tokens,rewrite_cost_usd,sources",
            ...rows.map((r) =>
              [
                `"${r.question.replace(/"/g, '""')}"`,
                `"${r.searchQuery.replace(/"/g, '""')}"`,
                r.model,
                r.modelId,
                r.fallbackUsed,
                r.inputTokens,
                r.outputTokens,
                r.costUsd.toFixed(8),
                r.estimated,
                r.rewriteInputTokens,
                r.rewriteOutputTokens,
                r.rewriteCostUsd.toFixed(8),
                `"${r.sources}"`,
              ].join(","),
            ),
          ].join("\n");

    const url = URL.createObjectURL(
      new Blob([body], { type: format === "json" ? "application/json" : "text/csv" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `nimbusstack-session.${format}`;
    link.click();
    URL.revokeObjectURL(url);
  };

  /**
   * Which citation the reader last clicked, and a nonce so clicking the same chip
   * twice re-triggers the jump. Scoped to a turn, because the same passage id can
   * appear in several answers in one conversation.
   */
  const [focus, setFocus] = useState<{ turnId: string; passageId: string; nonce: number } | null>(
    null,
  );

  const jumpToPassage = (turnId: string, passageId: string) =>
    setFocus((prev) => ({ turnId, passageId, nonce: (prev?.nonce ?? 0) + 1 }));

  return (
    <div className="app">
      <header className="topbar">
        <div className="titles">
          <Nimbo size={42} glass />
          <div>
            <h1>Nimbo</h1>
            <p>NimbusStack Product Assistant</p>
          </div>
        </div>

        {/*
          * Absent rather than disabled when there is nothing to clear. A greyed
          * control on an empty screen reads as broken, and this one is unusable
          * for precisely as long as the screen it sits above is empty.
          */}
        {turns.length ? (
          <button
            type="button"
            className="ghost-button"
            onClick={() => setTurns([])}
            disabled={busy}
          >
            + New
          </button>
        ) : null}

        <SessionMenu
          empty={!sessionRows.length}
          onDetails={() => setDetailsOpen(true)}
          onExport={exportSession}
        />
      </header>

      <div className="transcript" ref={transcriptRef}>
        {!turns.length ? (
          <div className="empty">
            <div className="greeting">
              <h2>
                Hi! I&rsquo;m Nimbo — the NimbusStack product assistant. Ask me anything and
                I&rsquo;ll look it up in the knowledge base and give you the best answer I can
                find. I&rsquo;m honest and straightforward, and I&rsquo;ll never make up an
                answer.
              </h2>
            </div>

            <p className="sample-label">Sample questions you can ask me</p>
            <div className="starters">
              {STARTERS.filter((s) => !s.product || products.includes(s.product)).map((s) => (
                <button
                  key={s.q}
                  type="button"
                  className="starter"
                  onClick={() => send(s.q)}
                  disabled={busy}
                >
                  {s.q}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {turns.map((turn, index) => {
          // The answer decides whether a disagreement is real; retrieval only ever
          // produced candidates, and candidates differ run to run depending on
          // which passages a generation happens to cite.
          const declared = declaresConflict(turn.answer);
          const answerText = stripConflictMarker(turn.answer);
          const conflicts = declared ? activeConflicts(turn.conflicts, turn.answer) : [];

          return (
          <article className="turn" key={turn.id}>
            <h2 className="question">{turn.question}</h2>

            <div className="answer">
              {declared ? (
                <div className="banner conflict">
                  <h4>These documents don&rsquo;t agree</h4>
                  <p>
                    More than one document covers this and they differ. The answer gives both
                    versions with their dates — check the flagged passages before quoting a
                    figure.
                  </p>
                </div>
              ) : null}

              {turn.rewrite && turn.rewrite.query !== turn.question ? (
                <p className="resolved-query">
                  Searched for <code>{turn.rewrite.query}</code>
                </p>
              ) : null}

              <Answer
                text={answerText}
                // The caret trails text being written, so it waits for there to be
                // some. Before that the status line above already says what is
                // happening, and a blinking block under it says it a second time.
                streaming={turn.streaming && Boolean(answerText)}
                onCite={(id) => jumpToPassage(turn.id, id)}
              />

              {turn.truncated ? (
                <div className="banner fault">
                  <h4>Cut off at the length limit</h4>
                  <p>This answer reached the output cap and stops early. Resend for the rest.</p>
                </div>
              ) : null}

              {turn.error ? (
                <div className="banner fault">
                  <h4>{turn.error.partial ? "This answer is incomplete" : "Couldn't answer"}</h4>
                  <p>{turn.error.message}</p>
                </div>
              ) : null}

              <Sources
                passages={turn.passages}
                conflicts={conflicts}
                answer={answerText}
                focusId={focus?.turnId === turn.id ? focus.passageId : null}
                focusNonce={focus?.turnId === turn.id ? focus.nonce : 0}
              />

              {turn.model || turn.usage ? (
                <div className="answer-meta">
                  {turn.model ? (
                    <span className="answered-by">
                      answered by {turn.model.label}
                      {turn.model.fallback ? (
                        <span className="badge"> fallback from {turn.model.selectedId}</span>
                      ) : null}
                    </span>
                  ) : null}
                  {turn.usage ? (
                    <>
                      <span>
                        {turn.usage.inputTokens.toLocaleString()} in /{" "}
                        {turn.usage.outputTokens.toLocaleString()} out
                      </span>
                      <span>
                        {formatCost(turn.usage.costUsd)}
                        {turn.usage.estimated ? " (estimated)" : ""}
                      </span>
                    </>
                  ) : null}
                  {turn.rewrite ? (
                    <span className="rewrite-cost">
                      + {turn.rewrite.usage.inputTokens.toLocaleString()} in /{" "}
                      {turn.rewrite.usage.outputTokens.toLocaleString()} out ·{" "}
                      {formatCost(turn.rewrite.usage.costUsd)} resolving the question
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </article>
          );
        })}
      </div>

      {busy || !draft.trim() ? (
        <div className="nimbo-perch">
          <Nimbo state={live.state} size={38} />
          <span className="nimbo-says">{live.line}</span>
        </div>
      ) : null}


      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <div className="composer-box">
          <textarea
            ref={composerRef}
            rows={1}
            value={draft}
            placeholder="Ask about pricing, integrations, SLAs, releases or troubleshooting…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(draft);
              }
            }}
          />
        </div>

        {/* Out of the text field, which is now only a text field. */}
        <div className="composer-tools">
          <ModelPicker
            models={models}
            selectedId={selectedId}
            onSelect={setSelectedId}
            disabled={busy}
          />
          <SessionChip
            usage={sessionUsage}
            context={context}
            contextWindow={selected?.contextWindow ?? 0}
            onOpen={() => setDetailsOpen(true)}
          />
          <button type="submit" className="send" disabled={busy || !draft.trim()}>
            {busy ? "Answering" : "Send"}
          </button>
        </div>
      </form>

      {detailsOpen ? (
        <SessionDialog
          usage={sessionUsage}
          context={context}
          contextWindow={selected?.contextWindow ?? 0}
          rows={sessionRows}
          onExport={exportSession}
          onClose={() => setDetailsOpen(false)}
        />
      ) : null}
    </div>
  );
}
