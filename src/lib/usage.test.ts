import { describe, expect, it, vi } from "vitest";
import {
  CRITICAL_AT,
  WARN_AT,
  contextStatus,
  costOf,
  estimateUsage,
  formatCost,
  sumUsage,
  type Usage,
} from "./usage";

const CLAUDE = { inputPerMillion: 4.0, outputPerMillion: 20.0 };
const GEMINI = { inputPerMillion: 0.75, outputPerMillion: 3.75 };

describe("cost", () => {
  it("prices input and output at their separate rates", () => {
    // 1M input at $4 + 1M output at $20
    expect(costOf(CLAUDE, 1_000_000, 1_000_000)).toBeCloseTo(24, 10);
  });

  it("prices a realistic single message", () => {
    // 3,000 input + 500 output on Claude: 0.012 + 0.010
    expect(costOf(CLAUDE, 3_000, 500)).toBeCloseTo(0.022, 10);
  });

  it("prices the same message differently per model, from config values", () => {
    expect(costOf(GEMINI, 3_000, 500)).toBeCloseTo(0.004125, 10);
  });

  it("is zero for a message that never called a provider", () => {
    expect(costOf(CLAUDE, 0, 0)).toBe(0);
  });
});

describe("estimated usage after an aborted stream", () => {
  it("keeps input exact, approximates output, and flags itself", () => {
    const partial = "x".repeat(400); // ~100 tokens at 4 chars/token
    const usage = estimateUsage(CLAUDE, 2_000, partial);

    expect(usage.inputTokens).toBe(2_000);
    expect(usage.outputTokens).toBe(100);
    expect(usage.estimated).toBe(true);
    expect(usage.costUsd).toBeCloseTo(costOf(CLAUDE, 2_000, 100), 10);
  });

  it("still reports the input cost when nothing was generated", () => {
    const usage = estimateUsage(CLAUDE, 2_000, "");
    expect(usage.outputTokens).toBe(0);
    expect(usage.costUsd).toBeGreaterThan(0);
  });
});

describe("session totals", () => {
  const exact = (i: number, o: number): Usage => ({
    inputTokens: i,
    outputTokens: o,
    costUsd: costOf(CLAUDE, i, o),
    estimated: false,
  });

  it("adds tokens and cost across messages", () => {
    const total = sumUsage([exact(1_000, 200), exact(2_000, 400)]);
    expect(total.inputTokens).toBe(3_000);
    expect(total.outputTokens).toBe(600);
    expect(total.costUsd).toBeCloseTo(costOf(CLAUDE, 3_000, 600), 10);
  });

  it("is exact when every message is exact", () => {
    expect(sumUsage([exact(10, 10), exact(20, 20)]).estimated).toBe(false);
  });

  it("marks the whole total estimated if any message was estimated", () => {
    const total = sumUsage([exact(10, 10), estimateUsage(CLAUDE, 50, "abcd")]);
    expect(total.estimated).toBe(true);
  });

  it("is zero for an empty session", () => {
    expect(sumUsage([])).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0, estimated: false });
  });
});

describe("context meter thresholds", () => {
  const WINDOW = 200_000;

  it("is ok below the warning threshold", () => {
    expect(contextStatus(WINDOW * 0.5, WINDOW).level).toBe("ok");
  });

  it("is ok just below 75%", () => {
    expect(contextStatus(WINDOW * 0.7499, WINDOW).level).toBe("ok");
  });

  it("turns amber exactly at 75%", () => {
    const status = contextStatus(WINDOW * (WARN_AT / 100), WINDOW);
    expect(status.percent).toBeCloseTo(75, 6);
    expect(status.level).toBe("warn");
  });

  it("stays amber just below 90%", () => {
    expect(contextStatus(WINDOW * 0.8999, WINDOW).level).toBe("warn");
  });

  it("turns red exactly at 90%", () => {
    const status = contextStatus(WINDOW * (CRITICAL_AT / 100), WINDOW);
    expect(status.percent).toBeCloseTo(90, 6);
    expect(status.level).toBe("critical");
  });

  it("reports over 100% rather than clamping, so an over-limit chat reads as one", () => {
    expect(contextStatus(WINDOW * 1.2, WINDOW).percent).toBeCloseTo(120, 6);
  });

  it("does not divide by zero on a misconfigured window", () => {
    expect(contextStatus(1_000, 0)).toMatchObject({ percent: 0, level: "ok" });
  });
});

describe("E7 — switching models recomputes the meter immediately", () => {
  it("the same conversation can be safe on one model and critical on a smaller one", () => {
    const used = 150_000;

    // Unchanged conversation, two different context windows from config.
    const onLargeWindow = contextStatus(used, 1_000_000);
    const onSmallWindow = contextStatus(used, 160_000);

    expect(onLargeWindow.level).toBe("ok");
    expect(onSmallWindow.level).toBe("critical");
  });

  it("crosses from ok to amber on a model switch alone", () => {
    const used = 120_000;
    expect(contextStatus(used, 1_000_000).level).toBe("ok");
    expect(contextStatus(used, 160_000).level).toBe("warn");
  });
});

describe("cost formatting", () => {
  it("keeps sub-cent costs visible instead of rounding them to $0.00", () => {
    expect(formatCost(0.000215)).toBe("$0.000215");
  });

  it("shows four decimals for larger costs", () => {
    expect(formatCost(0.0225)).toBe("$0.0225");
  });

  it("shows a plain zero when nothing was spent", () => {
    expect(formatCost(0)).toBe("$0");
  });
});

describe("the picker opens on a model the server can actually use", () => {
  /** Credentials are read when the config module loads, so each case loads it fresh. */
  async function withKeys(present: string[]) {
    const all = ["OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "ANTHROPIC_API_KEY"];
    const saved = Object.fromEntries(all.map((k) => [k, process.env[k]]));
    for (const k of all) {
      if (present.includes(k)) process.env[k] = "test-key";
      else delete process.env[k];
    }

    vi.resetModules();
    const config = await import("./config");
    const result = {
      configured: config.defaultConfiguredModelId(),
      declared: config.DEFAULT_MODEL_ID,
    };

    for (const k of all) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.resetModules();
    return result;
  }

  it("opens on the configured default when its key is present", async () => {
    const { configured, declared } = await withKeys(["OPENAI_API_KEY"]);
    expect(configured).toBe(declared);
  });

  it("falls past the configured default when its key is missing", async () => {
    // A clone holding one provider key should open on that provider, not on a
    // model the picker would immediately have to fall back from.
    const { configured, declared } = await withKeys(["GOOGLE_GENERATIVE_AI_API_KEY"]);
    expect(configured).not.toBe(declared);
    expect(configured).toBe("gemini-3.8-flash");
  });

  it("names the declared default when nothing at all is credentialed", async () => {
    // Nothing usable either way; the endpoint still has to answer with something,
    // and runChat reports "no provider configured" rather than this being silent.
    const { configured, declared } = await withKeys([]);
    expect(configured).toBe(declared);
  });
});
