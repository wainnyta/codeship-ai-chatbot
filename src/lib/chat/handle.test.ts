import { describe, expect, it } from "vitest";
import { handleChatRequest } from "./handle";
import { resolveChain } from "../config";
import type { Adapter, ChatMessage, ProviderUsage, StreamEvent } from "../providers/types";
import { ProviderError } from "../providers/types";

/**
 * Seam 1 — the chat endpoint.
 *
 * Every test here drives the real HTTP contract with a fake provider injected at
 * the registry boundary (not by patching modules), so the seam stays a genuine
 * boundary. Nothing below touches the network, needs an API key, or depends on what
 * a model happens to say.
 */

// Set at module scope, not in beforeAll: resolveChain() reads these, and the
// describe bodies below call it while collecting tests — which happens before any
// beforeAll hook runs.
process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.OPENAI_API_KEY = "test-key";

const GEMINI = "gemini-3.8-flash";
const CLAUDE = "claude-opus-5-5";
const GPT = "gpt-6.1-sol";

interface Behavior {
  deltas?: string[];
  /** Throw before producing anything — the pre-latch case. */
  failBefore?: unknown;
  /** Throw after emitting this many deltas. */
  failAfter?: number;
  usage?: ProviderUsage;
  finishReason?: string;
}

interface Fake {
  adapter: Adapter;
  /** Model ids actually asked to generate, in order. */
  calls: string[];
}

function makeFake(behaviors: Record<string, Behavior>): Fake {
  const calls: string[] = [];

  const adapter: Adapter = async (model) => {
    calls.push(model.id);
    const b = behaviors[model.id] ?? { deltas: ["Answer ", "from ", model.label] };

    if (b.failBefore) throw b.failBefore;

    const deltas = b.deltas ?? ["Answer ", "from ", model.label];
    const failAfter = b.failAfter;

    async function* textStream() {
      for (let i = 0; i < deltas.length; i++) {
        if (failAfter !== undefined && i === failAfter) {
          throw new ProviderError("unavailable", "Connection dropped mid-stream.");
        }
        yield deltas[i];
      }
      if (failAfter !== undefined && failAfter >= deltas.length) {
        throw new ProviderError("unavailable", "Connection dropped mid-stream.");
      }
    }

    return {
      textStream: textStream(),
      usage: Promise.resolve(b.usage ?? { inputTokens: 1000, outputTokens: 200 }),
      finishReason: Promise.resolve(b.finishReason ?? "stop"),
    };
  };

  return { adapter, calls };
}

async function post(
  messages: ChatMessage[],
  modelId: string,
  fake: Fake,
): Promise<{ status: number; events: StreamEvent[] }> {
  const request = new Request("http://localhost/api/chat", {
    method: "POST",
    body: JSON.stringify({ messages, modelId }),
  });

  const response = await handleChatRequest(request, { adapter: fake.adapter });

  if (!response.headers.get("Content-Type")?.includes("event-stream")) {
    return { status: response.status, events: [JSON.parse(await response.text())] };
  }

  const body = await response.text();
  const events = body
    .split("\n\n")
    .filter((b) => b.startsWith("data: "))
    .map((b) => JSON.parse(b.slice(6)) as StreamEvent);

  return { status: response.status, events };
}

function ask(question: string): ChatMessage[] {
  return [{ role: "user", content: question }];
}

const textOf = (events: StreamEvent[]): string =>
  events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");

const find = <T extends StreamEvent["type"]>(events: StreamEvent[], type: T) =>
  events.find((e) => e.type === type) as Extract<StreamEvent, { type: T }> | undefined;

describe("E10 — an empty message never reaches a provider", () => {
  it("rejects an empty message without calling any provider", async () => {
    const fake = makeFake({});
    const { status } = await post(ask(""), GEMINI, fake);

    expect(status).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it("rejects a whitespace-only message without calling any provider", async () => {
    const fake = makeFake({});
    const { status, events } = await post(ask("   \n  \t "), GEMINI, fake);

    expect(status).toBe(400);
    expect(find(events, "error")?.code).toBe("empty_input");
    expect(fake.calls).toEqual([]);
  });
});

describe("E2 — off-corpus questions are answered without a provider", () => {
  it("says it is not in the knowledge base, calls nothing, and costs nothing", async () => {
    const fake = makeFake({});
    const { events } = await post(ask("What is the capital of France?"), GEMINI, fake);

    expect(fake.calls).toEqual([]);
    expect(textOf(events)).toMatch(/isn't covered in the NimbusStack knowledge base/i);

    const usage = find(events, "usage");
    expect(usage?.usage.costUsd).toBe(0);
    expect(usage?.usage.inputTokens).toBe(0);
    expect(find(events, "done")).toBeDefined();
  });
});

describe("R2 — retrieved sources travel with every answer", () => {
  it("emits passages before any answer text", async () => {
    const fake = makeFake({});
    const { events } = await post(ask("What does Nimbus Vault cost?"), GEMINI, fake);

    const metaIndex = events.findIndex((e) => e.type === "meta");
    const firstDelta = events.findIndex((e) => e.type === "delta");

    expect(metaIndex).toBe(0);
    expect(metaIndex).toBeLessThan(firstDelta);
    expect(find(events, "meta")!.passages.length).toBeGreaterThan(0);
  });

  it("Q5: the SAML question carries all four products and the conflicting document", async () => {
    const fake = makeFake({});
    const { events } = await post(ask("Which of our products support SSO via SAML 2.0?"), GEMINI, fake);

    const files = new Set(find(events, "meta")!.passages.map((p) => p.file));

    expect(files).toContain("relay.md");
    expect(files).toContain("vault.md");
    expect(files).toContain("ledger.md");
    expect(files).toContain("pulse.md"); // the OIDC trap must be answerable
    expect(files).toContain("security-overview.md"); // the document that disagrees
  });

  it("E4: the Vault SAML disagreement is flagged to the model, not left to chance", async () => {
    const fake = makeFake({});
    const { events } = await post(ask("Which products support SSO via SAML 2.0?"), GEMINI, fake);

    const conflicts = find(events, "meta")!.conflicts;
    const flagged = new Set(conflicts.flat());

    expect(conflicts.length).toBeGreaterThan(0);
    expect([...flagged].some((id) => id.startsWith("vault"))).toBe(true);
    expect([...flagged].some((id) => id.startsWith("security-overview.md"))).toBe(true);
  });

  it("Q4: a 403 question about Relay carries Relay's checklist", async () => {
    const fake = makeFake({});
    const { events } = await post(
      ask("A client is getting a 403 on the Relay API. What should they check first?"),
      GEMINI,
      fake,
    );

    const ids = find(events, "meta")!.passages.map((p) => p.id);
    expect(ids).toContain("relay.md#troubleshooting");
  });

  it("E1: a bare follow-up inherits the product from earlier turns", async () => {
    const fake = makeFake({});
    const { events } = await post(
      [
        { role: "user", content: "What does Nimbus Vault cost?" },
        { role: "assistant", content: "Vault is $12 on Starter." },
        { role: "user", content: "what about its SLA?" },
      ],
      GEMINI,
      fake,
    );

    const ids = find(events, "meta")!.passages.map((p) => p.id);
    expect(ids).toContain("vault.md#support-sla");
  });

  it("passes each passage's document date through, so answers can compare them", async () => {
    const fake = makeFake({});
    const { events } = await post(ask("Which products support SAML 2.0?"), GEMINI, fake);

    const vault = find(events, "meta")!.passages.find((p) => p.file === "vault.md");
    const overview = find(events, "meta")!.passages.find((p) => p.file === "security-overview.md");

    expect(vault?.docDate).toBe("2026-07-03");
    expect(overview?.docDate).toBe("2026-01-15");
  });
});

describe("R4/R5 — the answering model and its usage", () => {
  it("reports the selected model and its cost from config pricing", async () => {
    const fake = makeFake({ [CLAUDE]: { usage: { inputTokens: 3000, outputTokens: 500 } } });
    const { events } = await post(ask("What does Nimbus Vault cost?"), CLAUDE, fake);

    expect(find(events, "model")?.model.id).toBe(CLAUDE);
    expect(find(events, "model")?.model.fallback).toBe(false);

    // Claude at $4/$20 per million: 3000 in + 500 out = 0.012 + 0.010
    expect(find(events, "usage")?.usage.costUsd).toBeCloseTo(0.022, 10);
    expect(find(events, "usage")?.usage.estimated).toBe(false);
  });

  it("prices the identical message differently on a cheaper model", async () => {
    const fake = makeFake({ [GEMINI]: { usage: { inputTokens: 3000, outputTokens: 500 } } });
    const { events } = await post(ask("What does Nimbus Vault cost?"), GEMINI, fake);

    // Gemini at $0.75/$3.75 per million
    expect(find(events, "usage")?.usage.costUsd).toBeCloseTo(0.004125, 10);
  });

  it("marks a reply that hit the output cap as truncated rather than failed", async () => {
    const fake = makeFake({ [GEMINI]: { finishReason: "length" } });
    const { events } = await post(ask("What does Nimbus Vault cost?"), GEMINI, fake);

    expect(find(events, "usage")?.truncated).toBe(true);
    expect(find(events, "done")).toBeDefined(); // a cap is a clean stop, not an error
    expect(find(events, "error")).toBeUndefined();
  });
});

describe("R3/E8 — fallback and the first-flush latch", () => {
  // Derived from the config rather than hardcoded. The behaviour under test is
  // "falls back to the next configured model", not "falls back to one named model",
  // so reordering config/models.json must not break these.
  const NEXT_AFTER_CLAUDE = resolveChain(CLAUDE)[1].id;

  it("falls back silently when the selected provider fails before producing text", async () => {
    const fake = makeFake({
      [CLAUDE]: { failBefore: new ProviderError("unavailable", "Anthropic is down.") },
      [NEXT_AFTER_CLAUDE]: { deltas: ["Vault ", "costs ", "$12."] },
    });
    const { events } = await post(ask("What does Nimbus Vault cost?"), CLAUDE, fake);

    expect(fake.calls).toEqual([CLAUDE, NEXT_AFTER_CLAUDE]);

    const model = find(events, "model")!.model;
    expect(model.id).toBe(NEXT_AFTER_CLAUDE);
    expect(model.fallback).toBe(true);
    expect(model.selectedId).toBe(CLAUDE);

    // The user sees one coherent reply, entirely from the model that answered.
    expect(textOf(events)).toBe("Vault costs $12.");
    expect(find(events, "error")).toBeUndefined();
  });

  it("still falls back when the provider dies after a single token, because nothing was flushed", async () => {
    // The latch trips on first *flush*, not first token: the opening delta is held.
    // A provider that dies one token in is therefore still recoverable.
    const fake = makeFake({
      [CLAUDE]: { deltas: ["Vau"], failAfter: 1 },
      [NEXT_AFTER_CLAUDE]: { deltas: ["Vault ", "costs ", "$12."] },
    });
    const { events } = await post(ask("What does Nimbus Vault cost?"), CLAUDE, fake);

    expect(fake.calls).toEqual([CLAUDE, NEXT_AFTER_CLAUDE]);
    // Critically, the abandoned "Vau" never reached the user.
    expect(textOf(events)).toBe("Vault costs $12.");
    expect(find(events, "model")!.model.id).toBe(NEXT_AFTER_CLAUDE);
  });

  it("does NOT fall back once text has been shown, and never mixes two models", async () => {
    const fake = makeFake({
      [CLAUDE]: { deltas: ["Vault ", "costs ", "twelve ", "dollars"], failAfter: 3 },
      [GEMINI]: { deltas: ["GEMINI-TEXT-SHOULD-NEVER-APPEAR"] },
    });
    const { events } = await post(ask("What does Nimbus Vault cost?"), CLAUDE, fake);

    // Only the first model was ever asked; no fallback was attempted post-latch.
    expect(fake.calls).toEqual([CLAUDE]);

    const text = textOf(events);
    expect(text).toBe("Vault costs twelve ");
    expect(text).not.toContain("GEMINI");

    const error = find(events, "error")!;
    expect(error.partial).toBe(true);
    expect(error.modelId).toBe(CLAUDE);
    expect(error.message).toMatch(/stopped partway/i);
  });

  it("estimates usage for an aborted reply and flags it as an estimate", async () => {
    const fake = makeFake({
      [CLAUDE]: { deltas: ["Vault ", "costs ", "twelve ", "dollars"], failAfter: 3 },
    });
    const { events } = await post(ask("What does Nimbus Vault cost?"), CLAUDE, fake);

    const usage = find(events, "error")!.usage!;
    expect(usage.estimated).toBe(true);
    expect(usage.inputTokens).toBeGreaterThan(0); // known exactly: we built the prompt
    expect(usage.outputTokens).toBeGreaterThan(0); // approximated from partial text
    expect(usage.costUsd).toBeGreaterThan(0);
  });

  it("walks the whole chain and reports clearly when every provider fails", async () => {
    const fake = makeFake({
      [GEMINI]: { failBefore: new ProviderError("unavailable", "down") },
      [CLAUDE]: { failBefore: new ProviderError("unavailable", "down") },
      [GPT]: { failBefore: new ProviderError("unavailable", "down") },
    });
    const { events } = await post(ask("What does Nimbus Vault cost?"), GEMINI, fake);

    expect(fake.calls).toHaveLength(3);
    expect(find(events, "error")?.code).toBe("all_failed");
  });
});

describe("E9 — a rate-limited provider produces an actionable message", () => {
  it("explains what to do instead of surfacing a stack trace", async () => {
    const rateLimited = Object.assign(new Error("Rate limit reached. retry-after: 30"), {
      statusCode: 429,
    });
    const fake = makeFake({
      [GEMINI]: { failBefore: rateLimited },
      [CLAUDE]: { failBefore: rateLimited },
      [GPT]: { failBefore: rateLimited },
    });
    const { events } = await post(ask("What does Nimbus Vault cost?"), GEMINI, fake);

    const message = find(events, "error")!.message;
    expect(message).toMatch(/rate-limited/i);
    expect(message).toMatch(/30 seconds|switch to another model/i);
    expect(message).not.toMatch(/stack|at Object|\.js:\d+/);
  });
});
