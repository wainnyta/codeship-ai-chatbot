/**
 * Nibo, the assistant's face.
 *
 * A cumulus cloud, because the products are Nimbus and the company is
 * NimbusStack — the character comes out of the subject matter rather than being
 * a mascot bolted onto it.
 *
 * Its states are not decoration. Each one corresponds to a stage the request is
 * genuinely in, and the pipeline has exactly these stages:
 *
 *   thinking   a follow-up is being resolved into a standalone question
 *   searching  the knowledge base has been searched and passages are being read
 *   idle       nothing is in flight
 *
 * There is deliberately no state for "writing the answer": the answer itself is
 * streaming word by word on screen at that point, and a second indicator saying
 * the same thing would be noise.
 *
 * So the animation is a status indicator that happens to have a face, and it
 * cannot drift out of sync with the thing it reports. The accompanying text says
 * the same thing in words, which is why this carries aria-hidden: a screen reader
 * should hear the sentence once, not twice.
 */
export type NiboState = "idle" | "thinking" | "searching";

interface NiboProps {
  state?: NiboState;
  /** Rendered width in px. The drawing keeps a 5:4 ratio. */
  size?: number;
  className?: string;
}

/**
 * The cloud, as overlapping circles on a flat base.
 *
 * Drawn twice: once in the edge colour with a wide stroke, then again in the fill
 * colour on top. A single outlined path would be tidier, but arcs that meet at a
 * tangent are fragile to hand-write and the first attempt rendered inside out. Two
 * passes give a clean outline around the union with no seams showing where the
 * circles overlap, and the shape stays easy to adjust by moving a centre.
 */
function CloudShape() {
  return (
    <>
      <circle cx="30" cy="42" r="16" />
      <circle cx="50" cy="32" r="20" />
      <circle cx="72" cy="44" r="14" />
      <rect x="14" y="42" width="72" height="16" rx="8" />
    </>
  );
}

export function Nibo({ state = "idle", size = 56, className = "" }: NiboProps) {
  return (
    <svg
      className={`nibo nibo-${state} ${className}`.trim()}
      viewBox="0 0 100 80"
      width={size}
      height={size * 0.8}
      aria-hidden="true"
      focusable="false"
    >
      <g className="nibo-body">
        <g className="nibo-edge">
          <CloudShape />
        </g>
        <g className="nibo-fill">
          <CloudShape />
        </g>
        {/* Set wide and low, which is what reads as friendly rather than watchful. */}
        <g className="nibo-eyes">
          <circle cx="44" cy="40" r="4.2" />
          <circle cx="62" cy="40" r="4.2" />
        </g>
      </g>

      {/* Resolving a reference: attention drifts upward, the way it does. */}
      <g className="nibo-thought">
        <circle cx="80" cy="16" r="2.2" />
        <circle cx="87" cy="9" r="3" />
        <circle cx="94" cy="3" r="3.6" />
      </g>

      {/* Reading the passages. Teal is the colour this interface already uses for
          cited evidence, so the glass is the same colour as what it is looking for. */}
      <g className="nibo-glass">
        <circle cx="74" cy="62" r="10" />
        <line x1="81" y1="69" x2="90" y2="78" />
      </g>
    </svg>
  );
}
