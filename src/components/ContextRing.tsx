import type { ContextStatus } from "@/lib/usage";

/**
 * How full the model's context window is, as a ring.
 *
 * A labelled percentage and a progress bar spent a whole row of the footer on a
 * number that is 0.17% in ordinary use and only matters at the two moments it is
 * not. A ring says the same thing in the space of a character: nearly empty reads
 * as nearly empty at a glance, and the colour does the warning.
 *
 * Colour is not the only signal — the ring fills, and the exact figure is in the
 * title and in the session dialog — but it is the fastest one, and it uses the
 * same amber and rust this interface already uses for "check this" and "something
 * is wrong".
 */
export function ContextRing({ context, size = 15 }: { context: ContextStatus; size?: number }) {
  const r = 6;
  const circumference = 2 * Math.PI * r;
  // Clamped for the drawing only: an over-limit conversation still reports its
  // real percentage in the title, but a ring cannot be more than full.
  const filled = Math.min(context.percent, 100) / 100;

  return (
    <svg
      className={`ring ring-${context.level}`}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <circle className="ring-track" cx="8" cy="8" r={r} />
      <circle
        className="ring-fill"
        cx="8"
        cy="8"
        r={r}
        strokeDasharray={`${circumference * filled} ${circumference}`}
        // Start at twelve o'clock rather than three, which is where a dial starts.
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}
