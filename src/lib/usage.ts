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
