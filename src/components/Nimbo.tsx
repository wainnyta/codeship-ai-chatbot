/**
 * Nimbo, the assistant's face.
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
 *   answering  a model is streaming the reply
 *   idle       nothing is in flight
 *
 * So the animation is a status indicator that happens to have a face, and it
 * cannot drift out of sync with the thing it reports. The accompanying text says
 * the same thing in words, which is why this carries aria-hidden: a screen reader
 * should hear the sentence once, not twice.
 */
export type NimboState = "idle" | "thinking" | "searching" | "answering";

interface NimboProps {
  state?: NimboState;
  /** Rendered width in px. The drawing keeps a 5:4 ratio. */
  size?: number;
  className?: string;
  /**
   * Hold the magnifying glass permanently, without the sweep.
   *
   * For the header, where Nimbo is a mark rather than a status: a cloud that reads
   * the documents is what this application is, and the glass says that at a glance.
   * Everywhere else the glass appears only while passages are genuinely being read,
   * and this prop does not animate, so the two never get confused.
   */
  glass?: boolean;
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

export function Nimbo({ state = "idle", size = 56, className = "", glass = false }: NimboProps) {
  return (
    <svg
      className={`nimbo nimbo-${state}${glass ? " nimbo-holding" : ""} ${className}`.trim()}
      viewBox="0 0 100 80"
      width={size}
      height={size * 0.8}
      aria-hidden="true"
      focusable="false"
    >
      <g className="nimbo-body">
        <g className="nimbo-edge">
          <CloudShape />
        </g>
        <g className="nimbo-fill">
          <CloudShape />
        </g>
        {/* Set wide and low, which is what reads as friendly rather than watchful. */}
        <g className="nimbo-eyes">
          <circle cx="44" cy="40" r="4.2" />
          <circle cx="62" cy="40" r="4.2" />
        </g>
      </g>

      {/* Resolving a reference: attention drifts upward, the way it does. */}
      <g className="nimbo-thought">
        <circle cx="80" cy="16" r="2.2" />
        <circle cx="87" cy="9" r="3" />
        <circle cx="94" cy="3" r="3.6" />
      </g>

      {/* Reading the passages. Teal is the colour this interface already uses for
          cited evidence, so the glass is the same colour as what it is looking for. */}
      <g className="nimbo-glass">
        <circle cx="74" cy="62" r="10" />
        <line x1="81" y1="69" x2="90" y2="78" />
      </g>
    </svg>
  );
}
