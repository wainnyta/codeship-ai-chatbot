"use client";

import { useEffect, useRef, useState } from "react";
import type { PublicModel } from "@/lib/config";

/**
 * Model switcher (R3).
 *
 * A popover rather than a native <select> because the requirement is that each
 * option shows the provider and a short description, and a native option can only
 * render a single line of plain text. It also carries what the reader needs to
 * choose: price per million tokens, and whether the server has a key for it at all.
 */
export function ModelPicker({
  models,
  selectedId,
  onSelect,
  disabled,
}: {
  models: PublicModel[];
  selectedId: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointer = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected = models.find((m) => m.id === selectedId);

  return (
    <div className="picker" ref={root}>
      <button
        type="button"
        className="picker-button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || !models.length}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{selected?.label ?? "Choose a model"}</span>
        {selected && !selected.configured ? <span className="picker-nokey">no key</span> : null}
        <span className={open ? "chev up" : "chev down"} aria-hidden="true" />
      </button>

      {open ? (
        <div className="picker-menu" role="listbox" aria-label="AI model">
          {models.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={m.id === selectedId}
              className={m.id === selectedId ? "picker-option selected" : "picker-option"}
              onClick={() => {
                onSelect(m.id);
                setOpen(false);
              }}
            >
              <span className="picker-option-head">
                <span className="picker-option-label">{m.label}</span>
                {!m.configured ? <span className="picker-nokey">no key</span> : null}
                <span className="picker-option-price">
                  ${m.pricing.inputPerMillion}/${m.pricing.outputPerMillion} per Mtok
                </span>
              </span>
              <span className="picker-option-desc">{m.description}</span>
            </button>
          ))}
          <p className="picker-foot">
            Switching keeps the conversation. If a provider is down, the next one
            answers and the reply says which.
          </p>
        </div>
      ) : null}
    </div>
  );
}
