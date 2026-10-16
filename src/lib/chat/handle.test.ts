import { describe, expect, it, vi } from "vitest";
import { handleChatRequest } from "./handle";
import { REWRITE_MODEL_ID, resolveChain } from "../config";
import type {
  Adapter,
  ChatMessage,
  ProviderUsage,
  Rewriter,
  StreamEvent,
} from "../providers/types";
import { NOT_IN_KB_MESSAGE, SCOPE_PROMPT, type BuiltPrompt } from "../prompt";
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
  /** The prompts those models were given, so what the model saw can be asserted. */
  prompts: BuiltPrompt[];
  /** The conversation history forwarded with each call. */
  histories: ChatMessage[][];
}

function makeFake(behaviors: Record<string, Behavior>): Fake {
  const calls: string[] = [];
  const prompts: BuiltPrompt[] = [];
  const histories: ChatMessage[][] = [];

  const adapter: Adapter = async (model, prompt, history) => {
    calls.push(model.id);
    prompts.push(prompt);
    histories.push(history);
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

  return { adapter, calls, prompts, histories };
}

/** A rewriter that always returns the same standalone query, and counts its calls. */
function makeRewriter(text: string): { rewriter: Rewriter; calls: number } {
  const state = {
    rewriter: (async () => {
      state.calls += 1;
      return { text, usage: { inputTokens: 240, outputTokens: 11 }, finishReason: "stop" };
    }) as Rewriter,
    calls: 0,
  };
  return state;
}

async function post(
  messages: ChatMessage[],
  modelId: string,
  fake: Fake,
  rewriter?: Rewriter,
): Promise<{ status: number; events: StreamEvent[] }> {
  const request = new Request("http://localhost/api/chat", {
    method: "POST",
    body: JSON.stringify({ messages, modelId }),
  });

  const response = await handleChatRequest(request, { adapter: fake.adapter, rewriter });

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

describe("E2 — off-corpus questions get no passages to answer from", () => {
  it("hands the model nothing to cite", async () => {
    const fake = makeFake({});
    const { events } = await post(ask("What is the capital of France?"), GEMINI, fake);

    // The grounding guarantee is structural rather than procedural: a model that
    // was given no passages has nothing to quote and no document to misattribute,
    // whatever it decides to say.
    expect(find(events, "meta")!.passages).toEqual([]);
    expect(find(events, "meta")!.conflicts).toEqual([]);
    expect(fake.prompts[0].userContent).toBe("What is the capital of France?");
  });

  it("restricts the model to describing itself or refusing, in fixed words", async () => {
    const fake = makeFake({});
    await post(ask("What is the capital of France?"), GEMINI, fake);

    const system = fake.prompts[0].system;
    expect(system).toBe(SCOPE_PROMPT);
    // The refusal is text to copy, not text to compose.
    expect(system).toContain(NOT_IN_KB_MESSAGE);
    expect(system).toMatch(/exactly two permitted replies/i);
    expect(system).toMatch(/not certain which case applies, use case 2/i);
  });

  it("forbids the assistant from vouching for itself", () => {
    // "Are you doing a good job?" is about the assistant, so it is not refused —
    // but the only honest answer is that it cannot know. A tool whose whole value
    // is that it does not make things up must not make up that it is accurate.
    const fake = makeFake({});
    void post(ask("are you sure you're doing good job"), GEMINI, fake);

    expect(SCOPE_PROMPT).toMatch(/NEVER claim to be accurate, helpful, reliable or correct/);
    expect(SCOPE_PROMPT).toMatch(/Decline in one short clause/);
  });

  it("still reports which model answered, and what it cost", async () => {
    const fake = makeFake({ [GEMINI]: { usage: { inputTokens: 300, outputTokens: 40 } } });
    const { events } = await post(ask("What is the capital of France?"), GEMINI, fake);

    expect(find(events, "model")?.model.id).toBe(GEMINI);
    expect(find(events, "usage")?.usage.inputTokens).toBe(300);
    expect(find(events, "done")).toBeDefined();
  });

  it("answers a question about the assistant rather than refusing it", async () => {
    const fake = makeFake({
      [GEMINI]: { deltas: ["I'm the ", "NimbusStack ", "product assistant."] },
    });
    const { events } = await post(ask("hi, who are you"), GEMINI, fake);

    // This retrieves nothing, exactly like the France question. The difference is
    // semantic, so the model is what tells them apart — the endpoint does not
    // decide the answer here, it only withholds the documents.
    expect(find(events, "meta")!.passages).toEqual([]);
    expect(fake.calls).toEqual([GEMINI]);
    expect(textOf(events)).toBe("I'm the NimbusStack product assistant.");
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

  it("E1: a bare follow-up does not inherit a product the assistant merely mentioned", async () => {
    // An answer listing every product would otherwise hand the follow-up whichever
    // one it named last, turning "what about its SLA?" into a Ledger question.
    const fake = makeFake({});
    const { events } = await post(
      [
        { role: "user", content: "What does Nimbus Vault cost?" },
        {
          role: "assistant",
          content: "NimbusStack has four products: Nimbus Relay, Nimbus Vault, Nimbus Pulse and Nimbus Ledger.",
        },
        { role: "user", content: "what about its SLA?" },
      ],
      GEMINI,
      fake,
    );

    const files = find(events, "meta")!.passages.map((p) => p.file);
    expect(files).toContain("vault.md");
    expect(files.some((f) => f.startsWith("ledger"))).toBe(false);
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

describe("follow-up questions are resolved before retrieval", () => {
  const followUp: ChatMessage[] = [
    { role: "user", content: "what is relay?" },
    { role: "assistant", content: "Nimbus Relay is a managed API gateway [relay.md#overview]." },
    { role: "user", content: "how can i use it" },
  ];

  it("answers a follow-up that names neither its product nor its topic", async () => {
    const fake = makeFake({});
    const { rewriter } = makeRewriter("how do I use Nimbus Relay authentication and endpoints");

    const { events } = await post(followUp, GEMINI, fake, rewriter);

    // Without the rewrite this question reaches the index as `use`, matches
    // nothing, and is refused as off-corpus.
    expect(textOf(events)).not.toBe(NOT_IN_KB_MESSAGE);
    expect(find(events, "meta")?.passages.length).toBeGreaterThan(0);
    expect(fake.calls).toEqual([GEMINI]);
  });

  it("asks the model the question the user typed, not the rewritten one", async () => {
    const fake = makeFake({});
    const { rewriter } = makeRewriter("how do I use Nimbus Relay authentication and endpoints");

    await post(followUp, GEMINI, fake, rewriter);

    // The safety property: the rewrite steers retrieval only. A wrong rewrite can
    // cost us the right passages; it must never change what was asked.
    expect(fake.prompts[0].userContent).toContain("QUESTION: how can i use it");
    expect(fake.prompts[0].userContent).not.toContain("QUESTION: how do I use Nimbus Relay");
  });

  it("tells the model what retrieval was given, so a bad resolution is visible to it", async () => {
    const fake = makeFake({});
    const { rewriter } = makeRewriter("how do I use Nimbus Ledger");

    await post(followUp, GEMINI, fake, rewriter);

    expect(fake.prompts[0].userContent).toContain('resolved question "how do I use Nimbus Ledger"');
  });

  it("reports the resolved query and its cost, separately from the answer's", async () => {
    const fake = makeFake({ [GEMINI]: { usage: { inputTokens: 1800, outputTokens: 90 } } });
    const { rewriter } = makeRewriter("how do I use Nimbus Relay");

    const { events } = await post(followUp, GEMINI, fake, rewriter);

    const rewrite = find(events, "meta")?.rewrite;
    expect(rewrite?.query).toBe("how do I use Nimbus Relay");
    expect(rewrite?.modelId).toBe(REWRITE_MODEL_ID);
    expect(rewrite?.usage.inputTokens).toBe(240);

    // The answering model's own numbers stay its own — R4 stays attributable.
    expect(find(events, "usage")?.usage.inputTokens).toBe(1800);
  });

  it("spends nothing resolving the first question of a conversation", async () => {
    const fake = makeFake({});
    const rewriter = makeRewriter("rewritten");

    const { events } = await post(ask("what is relay?"), GEMINI, fake, rewriter.rewriter);

    expect(rewriter.calls).toBe(0);
    expect(find(events, "meta")?.rewrite).toBeUndefined();
  });

  it("falls back to another provider when the rewrite model is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = makeFake({});

    let attempts = 0;
    const flaky: Rewriter = async (model) => {
      attempts += 1;
      if (model.id === REWRITE_MODEL_ID) throw new Error("503 service unavailable");
      return {
        text: "how do I use Nimbus Relay",
        usage: { inputTokens: 240, outputTokens: 11 },
        finishReason: "stop",
      };
    };

    const { events } = await post(followUp, GEMINI, fake, flaky);

    expect(attempts).toBe(2);
    expect(find(events, "meta")?.rewrite?.modelId).not.toBe(REWRITE_MODEL_ID);
    expect(find(events, "meta")!.passages.length).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it("rejects a rewrite the model was cut off mid-way through", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = makeFake({});

    const cutOff: Rewriter = async (model) =>
      model.id === REWRITE_MODEL_ID
        ? // What this actually looked like in production: thinking tokens spent the
          // output budget and the query arrived as its first word.
          { text: "What", usage: { inputTokens: 240, outputTokens: 512 }, finishReason: "length" }
        : {
            text: "what is Nimbus Relay's Priority 1 support SLA",
            usage: { inputTokens: 240, outputTokens: 14 },
            finishReason: "stop",
          };

    const { events } = await post(followUp, GEMINI, fake, cutOff);
    const rewrite = find(events, "meta")?.rewrite;

    expect(rewrite?.query).toBe("what is Nimbus Relay's Priority 1 support SLA");
    // Both attempts are billed, so both are reported.
    expect(rewrite?.usage.outputTokens).toBe(526);
    warn.mockRestore();
  });

  it("ignores a rewrite with nothing searchable in it", async () => {
    const fake = makeFake({});
    const { rewriter } = makeRewriter("what is it");

    const { events } = await post(followUp, GEMINI, fake, rewriter);

    // "what is it" finishes cleanly and is short enough to look like a query, but
    // carries no searchable term — so the question as typed is used instead. That
    // question is itself unsearchable, so the model is handed no passages rather
    // than passages retrieved against noise.
    expect(find(events, "meta")?.rewrite?.query).toBe("how can i use it");
    expect(find(events, "meta")!.passages).toEqual([]);
    expect(fake.prompts[0].system).toBe(SCOPE_PROMPT);
  });

  it("refuses rather than invents when every rewrite provider is down", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = makeFake({});
    const dead: Rewriter = async () => {
      throw new Error("503 service unavailable");
    };

    const { events } = await post(followUp, GEMINI, fake, dead);

    // The honest outcome. Searching `use` matches nothing, exactly as before
    // rewriting existed, so the model is handed no passages and is restricted to
    // describing itself or refusing. Nothing is retrieved for it to misquote.
    expect(find(events, "meta")?.rewrite).toBeUndefined();
    expect(find(events, "meta")!.passages).toEqual([]);
    expect(fake.prompts[0].system).toBe(SCOPE_PROMPT);
    expect(find(events, "error")).toBeUndefined();
    warn.mockRestore();
  });

  it("does not call the rewriter for an empty message (E10 still holds)", async () => {
    const fake = makeFake({});
    const rewriter = makeRewriter("rewritten");

    const { status } = await post(
      [{ role: "user", content: "what is relay?" }, { role: "user", content: "  " }],
      GEMINI,
      fake,
      rewriter.rewriter,
    );

    expect(status).toBe(400);
    expect(rewriter.calls).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it("reports the rewrite cost even on an off-corpus follow-up (E2)", async () => {
    const fake = makeFake({});
    const { rewriter } = makeRewriter("what is the capital of France");

    const { events } = await post(
      [...followUp.slice(0, 2), { role: "user", content: "and its capital?" }],
      GEMINI,
      fake,
      rewriter,
    );

    expect(find(events, "meta")!.passages).toEqual([]);
    expect(fake.prompts[0].system).toBe(SCOPE_PROMPT);
    // Resolving the question is billed separately from answering it, so an
    // off-corpus follow-up still shows what the rewrite cost rather than hiding
    // it — otherwise session spend silently drifts.
    expect(find(events, "meta")?.rewrite?.usage.inputTokens).toBe(240);
    expect(find(events, "usage")?.usage.inputTokens).toBe(1000);
  });
});
