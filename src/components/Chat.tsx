"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Answer } from "./Answer";
import { ModelPicker } from "./ModelPicker";
import { Sources } from "./Sources";
import type { PublicModel } from "@/lib/config";
import type { AnsweringModel, PassageView, StreamEvent } from "@/lib/providers/types";
import { type Usage, contextStatus, estimateTokens, formatCost, sumUsage } from "@/lib/usage";

interface Turn {
  id: string;
  question: string;
  answer: string;
  passages: PassageView[];
  conflicts: Array<[string, string]>;
  model: AnsweringModel | null;
  usage: Usage | null;
  truncated: boolean;
  error: { message: string; partial: boolean } | null;
  streaming: boolean;
}

const STARTERS = [
  {
    q: "Which of our products support SSO via SAML 2.0?",
    why: "Spans all four products — and two documents disagree about Vault",
  },
  {
    q: "What are the key differences between Relay's Pro and Enterprise tiers?",
    why: "Tier comparison from the pricing table",
  },
  {
    q: "A client is getting a 403 on the Relay API. What should they check first?",
    why: "Troubleshooting steps in order, for the right product",
  },
  {
    q: "What's the SLA for Priority 1 tickets on Nimbus Vault?",
    why: "A single row of a table, per tier",
  },
];

function newTurn(question: string): Turn {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    question,
    answer: "",
    passages: [],
    conflicts: [],
    model: null,
    usage: null,
    truncated: false,
    error: null,
    streaming: true,
  };
}

export function Chat() {
  const [models, setModels] = useState<PublicModel[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

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
                patch(turn.id, { passages: event.passages, conflicts: event.conflicts });
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

  const sessionUsage = useMemo(
    () => sumUsage(turns.map((t) => t.usage).filter((u): u is Usage => Boolean(u))),
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
        sources: t.passages.map((p) => p.id).join(" "),
      }));

    const body =
      format === "json"
        ? JSON.stringify({ messages: rows, total: sessionUsage }, null, 2)
        : [
            "question,model,model_id,fallback_used,input_tokens,output_tokens,cost_usd,estimated,sources",
            ...rows.map((r) =>
              [
                `"${r.question.replace(/"/g, '""')}"`,
                r.model,
                r.modelId,
                r.fallbackUsed,
                r.inputTokens,
                r.outputTokens,
                r.costUsd.toFixed(8),
                r.estimated,
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
          <h1>NimbusStack Product Assistant</h1>
          <p>Answers from NimbusStack&rsquo;s own documentation, with the passages they came from.</p>
        </div>

        <button
          type="button"
          className="ghost-button"
          onClick={() => setTurns([])}
          disabled={busy || !turns.length}
        >
          New conversation
        </button>
      </header>

      <div className="transcript" ref={transcriptRef}>
        {!turns.length ? (
          <div className="empty">
            <h1>Ask about Relay, Vault, Pulse or Ledger.</h1>
            <p>
              Every answer is built from NimbusStack&rsquo;s own documentation and shows the
              passages it came from. If the documents don&rsquo;t cover something, it says so
              rather than guessing.
            </p>
            <div className="starters">
              {STARTERS.map((s) => (
                <button
                  key={s.q}
                  type="button"
                  className="starter"
                  onClick={() => send(s.q)}
                  disabled={busy}
                >
                  {s.q}
                  <small>{s.why}</small>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {turns.map((turn) => (
          <article className="turn" key={turn.id}>
            <h2 className="question">{turn.question}</h2>

            <div className="answer">
              {turn.conflicts.length ? (
                <div className="banner conflict">
                  <h4>These documents don&rsquo;t agree</h4>
                  <p>
                    More than one document covers this and they differ. The answer gives both
                    versions with their dates — check the flagged passages before quoting a
                    figure.
                  </p>
                </div>
              ) : null}

              <Answer
                text={turn.answer}
                streaming={turn.streaming}
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
                conflicts={turn.conflicts}
                answer={turn.answer}
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
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </div>

      <div className="usage">
        <span>
          session <b>{sessionUsage.inputTokens.toLocaleString()}</b> in /{" "}
          <b>{sessionUsage.outputTokens.toLocaleString()}</b> out
        </span>
        <span>
          <b>
            {formatCost(sessionUsage.costUsd)}
            {sessionUsage.estimated ? "*" : ""}
          </b>
          {sessionUsage.estimated ? " includes an estimate" : ""}
        </span>

        <div className="export">
          <button type="button" onClick={() => exportSession("csv")} disabled={!sessionUsage.inputTokens}>
            CSV
          </button>
          <button type="button" onClick={() => exportSession("json")} disabled={!sessionUsage.inputTokens}>
            JSON
          </button>
        </div>

        <div className={`meter ${context.level === "ok" ? "" : context.level}`}>
          <span>context {context.percent.toFixed(context.percent < 1 ? 2 : 0)}%</span>
          <div className="meter-track">
            <div className="meter-fill" style={{ width: `${Math.min(context.percent, 100)}%` }} />
          </div>
        </div>
      </div>

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

          <div className="composer-foot">
            <ModelPicker
              models={models}
              selectedId={selectedId}
              onSelect={setSelectedId}
              disabled={busy}
            />
            <button type="submit" className="send" disabled={busy || !draft.trim()}>
              {busy ? "Answering" : "Ask"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
