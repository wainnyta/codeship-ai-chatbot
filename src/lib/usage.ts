/**
 * Token and cost arithmetic (R4), plus the context-window meter.
 *
 * These are pure functions on purpose. The 75%/90% thresholds cannot be reached
 * through real conversation — current models have context windows around a million
 * tokens, and this corpus is 15KB — so they are only reachable with synthetic
 * inputs. That makes unit tests the only practical way to prove the meter is right.
 */

export interface Pricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** True when the stream died before the provider reported usage (see estimateUsage). */
  estimated: boolean;
}

export function costOf(pricing: Pricing, inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}

/**
 * Rough token count for text, used only where an exact count is unavailable.
 * Four characters per token is the usual English approximation; it is never used
 * where a provider has reported real numbers.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * The fewest tokens a string could plausibly become — never more than the truth.
 *
 * `estimateTokens` is a middling guess and is right for what it does: costing a
 * reply whose stream died, and spending the passage budget. It is the wrong tool
 * for refusing a request before it is sent, because it is wrong in both directions
 * and badly. Measured against the real OpenAI tokenizer, chars/4 under-counts a
 * log dump of UUIDs by 2.0x, base64 by 2.7x, Japanese by 2.4x and emoji by 4.0x —
 * and over-counts ordinary prose by 1.5x, a thousand spaces by a factor of 28.
 *
 * Which direction it errs in matters, because the two mistakes do not cost the
 * same. Refuse a conversation that would have fitted and the reader is told to
 * start again for no reason, with no way to find out it was wrong. Let an
 * oversized one through and the provider rejects it unbilled, the chain tries the
 * next model — which may well have a larger window and simply answer — and the
 * same error code surfaces either way. Only one of those is recoverable, so the
 * estimate used to refuse must never exceed reality.
 *
 * Whitespace is what makes a plain chars/N bound impossible: tiktoken packs a run
 * of spaces into one token, so indented code reaches 11 characters per token and a
 * line of blank space 111. Collapsing runs first removes that entirely, and across
 * every sample measured — corpus prose, markdown tables, JSON, stack traces,
 * base64, CJK, emoji, repeated filler — the most token-efficient text left is
 * ordinary repeated prose at 6.0 characters per token. Hence six.
 *
 * A bound measured on samples is not a proof, so it is not asked to be one: this
 * only decides whether refusing is certainly right, and the provider decides the
 * rest.
 */
export const FAVOURABLE_CHARS_PER_TOKEN = 6;

export function minimumTokens(text: string): number {
  return Math.floor(text.replace(/\s+/g, " ").trim().length / FAVOURABLE_CHARS_PER_TOKEN);
}

/**
 * Usage for a reply whose stream died mid-generation. No usage event ever arrives,
 * so the choice is between dropping the message from session totals (understating
 * spend) and reporting a guess as fact. Neither is acceptable: input tokens are
 * known exactly because the prompt was built locally, output is approximated from
 * the partial text, and the result is flagged so the UI can show it as approximate.
 */
export function estimateUsage(
  pricing: Pricing,
  inputTokens: number,
  partialText: string,
): Usage {
  const outputTokens = estimateTokens(partialText);
  return {
    inputTokens,
    outputTokens,
    costUsd: costOf(pricing, inputTokens, outputTokens),
    estimated: true,
  };
}

export type ContextLevel = "ok" | "warn" | "critical";

export interface ContextStatus {
  usedTokens: number;
  contextWindow: number;
  /** 0-100, not clamped above 100 — an over-limit conversation should read as such. */
  percent: number;
  level: ContextLevel;
}

export const WARN_AT = 75;
export const CRITICAL_AT = 90;

export function contextStatus(usedTokens: number, contextWindow: number): ContextStatus {
  const percent = contextWindow > 0 ? (usedTokens / contextWindow) * 100 : 0;
  return {
    usedTokens,
    contextWindow,
    percent,
    level: percent >= CRITICAL_AT ? "critical" : percent >= WARN_AT ? "warn" : "ok",
  };
}

export function sumUsage(entries: Usage[]): Usage {
  return entries.reduce<Usage>(
    (total, u) => ({
      inputTokens: total.inputTokens + u.inputTokens,
      outputTokens: total.outputTokens + u.outputTokens,
      costUsd: total.costUsd + u.costUsd,
      // A session total containing any estimate is itself an estimate.
      estimated: total.estimated || u.estimated,
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0, estimated: false },
  );
}

/** Costs here run to millionths of a dollar; "$0.00" would hide every small number. */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}
