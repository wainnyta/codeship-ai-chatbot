"use client";

import { Markdown, type CiteHandler } from "./Markdown";

/** The generated answer. Markdown rendering is shared with the source passages. */
export function Answer({
  text,
  streaming,
  onCite,
}: {
  text: string;
  streaming?: boolean;
  onCite: CiteHandler;
}) {
  return (
    <div className="answer-body md">
      <Markdown
        text={text}
        onCite={onCite}
        trailing={streaming ? <span className="caret" aria-hidden="true" /> : null}
      />
    </div>
  );
}
