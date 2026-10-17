"use client";

import { useEffect, type RefObject } from "react";

/**
 * Close an open overlay on Escape, or on a click outside it.
 *
 * Three things in this interface open over the page — the model picker, the
 * session menu and the session dialog — and all three have to be dismissible the
 * same way, because a reader mid-call who hits Escape expects it to work wherever
 * they are. Written once so the behaviour cannot drift between them.
 */
export function useDismiss(
  open: boolean,
  close: () => void,
  root: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;

    const onPointer = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };

    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close, root]);
}
