import { describe, expect, it, vi } from "vitest";
import { MAX_QUERY_CHARS, acceptRewrite, buildRewriteInput, resolveQuery } from "./rewrite";
import type { ChatMessage, Rewriter } from "../providers/types";
import { REWRITE_MODEL_ID, getModel } from "../config";

// Module scope, not beforeAll: resolveChain() reads these while tests are collected.
process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.OPENAI_API_KEY = "test-key";

/**
 * Seam 2 — pure logic, no network.
 *
 * The rewriter's output is a model's and cannot be asserted on. What CAN be
 * asserted is everything around it: what context it is given, which outputs are
 * trusted, and that no failure mode reaches the user. That is what is tested here.
 */

const history: ChatMessage[] = [
  { role: "user", content: "what is relay?" },
  { role: "assistant", content: "Nimbus Relay is a managed API gateway [relay.md#overview]." },
];

const fake = (text: string): Rewriter =>
  vi.fn(async () => ({ text, usage: { inputTokens: 240, outputTokens: 11 }, finishReason: "stop" }));

describe("buildRewriteInput", () => {
  it("gives the model both roles — a reference can point at either", () => {
    const input = buildRewriteInput("how can i use it", history);
    expect(input).toContain("User: what is relay?");
    expect(input).toContain("Assistant: Nimbus Relay is a managed API gateway");
    expect(input).toContain("LATEST QUESTION: how can i use it");
  });

  it("truncates long replies instead of resending whole answers", () => {
    const long = [{ role: "assistant" as const, content: "x".repeat(2000) }];
    expect(buildRewriteInput("and the price?", long).length).toBeLessThan(700);
  });

  it("keeps only recent turns, so a long conversation does not grow this call", () => {
    const many: ChatMessage[] = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
    }));
    const input = buildRewriteInput("and now?", many);
    expect(input).toContain("message 39");
    expect(input).not.toContain("message 2\n");
  });
});

describe("acceptRewrite", () => {
  it("takes a clean single-line rewrite", () => {
    expect(acceptRewrite("how can i use it", "how can I use Nimbus Relay")).toBe(
      "how can I use Nimbus Relay",
    );
  });

  it("unwraps a quoted rewrite", () => {
    expect(acceptRewrite("how can i use it", '"how can I use Nimbus Relay"')).toBe(
      "how can I use Nimbus Relay",
    );
  });

  it("keeps the first line when the model adds commentary after it", () => {
    expect(acceptRewrite("and for vault?", "what is Vault's P1 SLA\n\nI resolved 'it' to Vault.")).toBe(
      "what is Vault's P1 SLA",
    );
  });

  it("falls back to the question when the model said nothing", () => {
    expect(acceptRewrite("how can i use it", "   \n  ")).toBe("how can i use it");
  });

  it("falls back to the question when the model wrote an essay instead of a query", () => {
    expect(acceptRewrite("how can i use it", "a".repeat(MAX_QUERY_CHARS + 1))).toBe(
      "how can i use it",
    );
  });
});

describe("resolveQuery", () => {
  it("makes no call on the first question — nothing to resolve against", async () => {
    const rewriter = fake("anything");
    const result = await resolveQuery({ question: "what is relay?", history: [], rewriter });

    expect(rewriter).not.toHaveBeenCalled();
    expect(result).toMatchObject({ query: "what is relay?", rewritten: false, usage: null });
  });

  it("makes no call when no rewriter is wired in", async () => {
    const result = await resolveQuery({ question: "how can i use it", history });
    expect(result.query).toBe("how can i use it");
  });

  it("reports the resolved query and what it cost", async () => {
    const result = await resolveQuery({
      question: "how can i use it",
      history,
      rewriter: fake("how can I use Nimbus Relay"),
    });

    expect(result.query).toBe("how can I use Nimbus Relay");
    expect(result.rewritten).toBe(true);
    expect(result.modelId).toBe(REWRITE_MODEL_ID);
    const pricing = getModel(REWRITE_MODEL_ID)!.pricing;
    expect(result.usage?.costUsd).toBeCloseTo(
      240 * pricing.inputPerMillion * 1e-6 + 11 * pricing.outputPerMillion * 1e-6,
      12,
    );
    expect(result.usage?.estimated).toBe(false);
  });

  it("reports cost even when the question needed no rewriting — the tokens were spent", async () => {
    const result = await resolveQuery({
      question: "what is Vault's P1 SLA?",
      history,
      rewriter: fake("what is Vault's P1 SLA?"),
    });

    expect(result.rewritten).toBe(false);
    expect(result.usage?.inputTokens).toBe(240);
  });

  it("tries the next provider when the rewrite model is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const flaky: Rewriter = async (model) => {
      if (model.id === REWRITE_MODEL_ID) throw new Error("503 service unavailable");
      return {
        text: "how can I use Nimbus Relay",
        usage: { inputTokens: 240, outputTokens: 11 },
        finishReason: "stop",
      };
    };

    const result = await resolveQuery({ question: "how can i use it", history, rewriter: flaky });

    expect(result.query).toBe("how can I use Nimbus Relay");
    expect(result.modelId).not.toBe(REWRITE_MODEL_ID);
    warn.mockRestore();
  });

  it("searches the question as typed when every provider is down", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dead: Rewriter = async () => {
      throw new Error("503 service unavailable");
    };

    const result = await resolveQuery({ question: "how can i use it", history, rewriter: dead });

    expect(result).toMatchObject({ query: "how can i use it", rewritten: false, usage: null });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
