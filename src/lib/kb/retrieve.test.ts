import { describe, expect, it } from "vitest";
import { KNOWLEDGE_BASE_DIR, getIndex, loadChunks } from "./index";
import {
  KnowledgeBaseIndex,
  MAX_CONFLICTS,
  MAX_PASSAGES,
  PASSAGE_TOKEN_BUDGET,
  comparable,
  findProduct,
  findProducts,
  resolveProduct,
  resolveProducts,
} from "./retrieve";
import { estimateTokens } from "../usage";
import { formatChunk } from "./chunk";

const index = getIndex();

/** The roster the corpus produced, derived rather than listed. */
const roster = index.products;

/** Any chunk of a given file, for the chunk-level product assertions. */
const corpus = loadChunks(KNOWLEDGE_BASE_DIR);
function chunkFor(file: string) {
  const found = corpus.find((c) => c.file === file);
  if (!found) throw new Error(`no chunk from ${file}`);
  return found;
}

/** Source files behind a query's passages. */
function files(query: string, history: string[] = []): string[] {
  return index.search(query, { history }).passages.map((p) => p.chunk.file);
}

/** Passage ids behind a query, in rank order. */
function ids(query: string, history: string[] = []): string[] {
  return index.search(query, { history }).passages.map((p) => p.chunk.id);
}

describe("corpus loading", () => {
  it("chunks every document in the knowledge base", () => {
    expect(index.size).toBeGreaterThan(30);
  });

  it("keeps a markdown table intact with its header row", () => {
    // E6 depends on this: a table split from its header loses which column is
    // "Pro" and which is "Enterprise".
    const sla = index
      .search("Relay support SLA priority")
      .passages.find((p) => p.chunk.id === "relay.md#support-sla");

    expect(sla).toBeDefined();
    expect(sla!.chunk.text).toContain("| Priority | Starter | Pro | Enterprise |");
    expect(sla!.chunk.text).toContain("P1 (service down)");
    expect(sla!.chunk.text).toContain("P4 (feature request)");
  });

  it("carries each document's updated date onto its chunks", () => {
    const passages = index.search("Vault pricing tiers").passages;
    const vault = passages.find((p) => p.chunk.file === "vault.md");
    expect(vault!.chunk.docDate).toBe("2026-07-03");
  });
});

describe("the six representative questions", () => {
  it("Q1: Pro vs Enterprise tiers reaches pricing tables", () => {
    const result = ids("What are the key differences between the Pro and Enterprise pricing tiers?");
    expect(result.some((id) => id.includes("#pricing"))).toBe(true);
  });

  it("Q2: Salesforce integration reaches the integration tables with versions", () => {
    const result = index.search("Does Vault integrate with Salesforce? What version is required?");
    const integrations = result.passages.find((p) => p.chunk.id === "vault.md#integrations");

    expect(integrations).toBeDefined();
    // The version requirement must be in the retrieved text, not inferred.
    expect(integrations!.chunk.text).toContain("Salesforce API v58 or later");
  });

  it("Q3: v4.2 release notes resolve to Relay, the only product with a 4.2", () => {
    const result = files("What new features were released in v4.2 of Relay?");
    expect(result).toContain("relay-release-notes.md");
  });

  it("Q4: a 403 question about Relay retrieves Relay's checklist, not Pulse's", () => {
    const result = ids("A client is getting a 403 on the Relay API. What should they check first?");
    expect(result).toContain("relay.md#troubleshooting");
    expect(result.indexOf("relay.md#troubleshooting")).toBeLessThan(
      result.indexOf("pulse.md#troubleshooting") === -1
        ? Number.MAX_SAFE_INTEGER
        : result.indexOf("pulse.md#troubleshooting"),
    );
  });

  it("Q4b: the same question about Pulse retrieves Pulse's checklist", () => {
    const result = ids("A client is getting a 403 on the Pulse API. What should they check first?");
    expect(result).toContain("pulse.md#troubleshooting");
  });

  it("Q5: SAML question reaches all four products and both sides of the conflict", () => {
    const result = index.search("Which of our products support SSO via SAML 2.0?");
    const sources = result.passages.map((p) => p.chunk.file);

    // The answer must be complete across the product line.
    expect(sources).toContain("relay.md");
    expect(sources).toContain("vault.md");
    expect(sources).toContain("ledger.md");
    // Pulse is the trap: it does OIDC, not SAML. It must still be retrieved so the
    // model can say so rather than silently omitting a product.
    expect(sources).toContain("pulse.md");
    // And the company-wide document that disagrees about Vault's SAML tier.
    expect(sources).toContain("security-overview.md");
  });

  it("Q6: a P1 SLA question reaches SLA tables", () => {
    const result = ids("What's the SLA for Priority 1 support tickets on Relay?");
    expect(result).toContain("relay.md#support-sla");
  });
});

describe("E5 — loosely worded questions still find the material", () => {
  it("'does it do single sign-on?' reaches SAML and OIDC material", () => {
    const result = index.search("Does Pulse do single sign-on?");
    const text = result.passages.map((p) => p.chunk.text).join("\n");

    expect(result.passages.map((p) => p.chunk.file)).toContain("pulse.md");
    // Pulse's sign-in material is filed under OIDC, never the words the user typed.
    expect(text).toMatch(/OpenID Connect|OIDC/);
  });
});

describe("E4 — documented disagreements are flagged structurally", () => {
  const pairsWith = (conflicts: Array<[string, string]>, a: RegExp, b: RegExp) =>
    conflicts.some(([x, y]) => (a.test(x) && b.test(y)) || (a.test(y) && b.test(x)));

  it("flags the Vault SAML conflict between a Vault document and the security overview", () => {
    const result = index.search("Which products support SSO via SAML 2.0?");

    // The overview (January) says Enterprise; Vault's own docs (July, and release
    // note 3.1) say it reached Pro. Either Vault document is a valid counterpart.
    expect(pairsWith(result.conflicts, /^security-overview\.md/, /^vault/)).toBe(true);
  });

  it("surfaces the Relay Pro pricing conflict between the table and release note 4.2", () => {
    // relay.md lists Pro at $49; release note 4.2 moves it to $59 for new contracts.
    const result = index.search("What are the key differences between Relay's Pro and Enterprise tiers?");
    expect(pairsWith(result.conflicts, /^relay\.md#pricing/, /^relay-release-notes\.md/)).toBe(true);
  });

  it("reports only a handful of candidates, so the warning stays meaningful", () => {
    // A naive shared-term count produced twenty pairs for this one question —
    // every cross-file combination — which makes the flag worthless.
    const result = index.search("Which of our products support SSO via SAML 2.0?");
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts.length).toBeLessThanOrEqual(MAX_CONFLICTS);
  });

  it("does not flag two different products as disagreeing with each other", () => {
    // Relay and Pulse publish different 403 checklists. That is two products, not
    // a contradiction, and flagging it trains the reader to ignore the warning.
    const result = index.search("A client is getting a 403 on the Relay API. What should they check first?");
    expect(pairsWith(result.conflicts, /^relay/, /^pulse/)).toBe(false);
  });

  it("treats same-product and company-wide documents as comparable, cross-product as not", () => {
    expect(comparable(chunkFor("vault.md"), chunkFor("vault-release-notes.md"))).toBe(true);
    expect(comparable(chunkFor("vault.md"), chunkFor("security-overview.md"))).toBe(true);
    expect(comparable(chunkFor("vault.md"), chunkFor("pulse.md"))).toBe(false);
  });
});

describe("the product roster comes from the corpus, not from source", () => {
  it("derives every product from the documents themselves", () => {
    expect([...index.products].sort()).toEqual(["ledger", "pulse", "relay", "vault"]);
  });

  it("does not mistake a company-wide document for a product", () => {
    // "NimbusStack support policy" has no space after Nimbus; "Nimbus Vault" does.
    expect(chunkFor("support-policy.md").product).toBeNull();
    expect(chunkFor("security-overview.md").product).toBeNull();
    expect(chunkFor("relay-release-notes.md").product).toBe("relay");
  });
});

describe("E1 — follow-ups inherit the product from earlier turns", () => {
  it("finds no product in a bare follow-up", () => {
    expect(findProduct("what about its SLA?", roster)).toBeNull();
  });

  it("inherits the product from conversation history", () => {
    expect(resolveProduct("what about its SLA?", ["Tell me about Nimbus Relay pricing"], roster)).toBe(
      "relay",
    );
  });

  it("prefers the most recently mentioned product", () => {
    const history = ["Tell me about Relay", "Now tell me about Vault pricing"];
    expect(resolveProduct("what about its SLA?", history, roster)).toBe("vault");
  });

  it("retrieves the inherited product's SLA table for a bare follow-up", () => {
    const result = ids("what about its SLA?", ["What does Nimbus Vault cost?"]);
    expect(result).toContain("vault.md#support-sla");
  });
});

describe("E2 — the relevance floor", () => {
  it("returns empty for a question the corpus knows nothing about", () => {
    const result = index.search("What is the capital of France?");
    expect(result.empty).toBe(true);
    expect(result.passages).toHaveLength(0);
  });

  it("returns empty for an unrelated technical question", () => {
    expect(index.search("How do I configure nginx reverse proxy headers?").empty).toBe(true);
  });

  it("answers a status code question that names no product", () => {
    // Every 403 test above names a product, and naming one drops the evidence bar
    // to a single term — so none of them exercised the way a support engineer
    // actually types the question. Unqualified, the only word the corpus could
    // match was "403", one term short, and the corpus refused a question it
    // documents twice over.
    const result = index.search("a client is getting 403. what should they do");
    expect(result.empty).toBe(false);
    expect(result.passages.map((p) => p.chunk.id).sort()).toEqual([
      "pulse.md#troubleshooting",
      "relay.md#troubleshooting",
    ]);
  });

  it("refuses a status code the corpus does not document", () => {
    // The guard on the rule above. Recognising a status code contributes exactly
    // one term, "troubleshooting", so a code the corpus has never heard of leaves
    // the question one term short of the bar — the same place it started.
    expect(index.search("we are getting 404 on our own website").empty).toBe(true);
    expect(index.search("i got a 418 teapot").empty).toBe(true);
  });

  it("still retrieves product context when only part of the question is unknown", () => {
    // "Kubernetes" is absent from the corpus, but the question is about a real
    // product — so passages are returned and the model reports the gap (E3),
    // rather than the floor swallowing the whole question.
    const result = index.search("Does Nimbus Relay support Kubernetes?");
    expect(result.empty).toBe(false);
    expect(result.passages.map((p) => p.chunk.file)).toContain("relay.md");
  });
});

describe("passage count follows the evidence, not a fixed slice", () => {
  it("returns only the handful of passages that are actually about a 403", () => {
    // This used to return eight passages every time, including Relay's pricing
    // table and SLA grid — neither of which has anything to do with a 403.
    const result = index.search("A client is getting a 403 on the Relay API. What should they check first?");

    expect(result.passages.length).toBeLessThan(5);
    expect(result.passages.map((p) => p.chunk.id)).toContain("relay.md#troubleshooting");
    expect(result.passages.map((p) => p.chunk.id)).not.toContain("relay.md#pricing");
    expect(result.passages.map((p) => p.chunk.id)).not.toContain("relay.md#support-sla");
  });

  it("drops a passage that matched only one incidental term", () => {
    // relay.md#pricing matches `api` and nothing else of a 403 question, and sat
    // comfortably above the score floor: a ratio cannot tell a weak match on the
    // right topic from a strong match on the wrong one. Every returned passage now
    // has to carry evidence of its own.
    const result = index.search("A client is getting a 403 on the Relay API. What should they check first?");

    for (const p of result.passages) {
      expect(p.matched).toContain("403");
    }
  });

  it("does not apply the evidence bar above the evidence available", () => {
    // "what is relay?" has one meaningful term once the stopwords and the product
    // name are gone. Requiring two would reject every passage that answers it.
    const result = index.search("what is relay?");

    expect(result.empty).toBe(false);
    expect(result.passages.length).toBeGreaterThan(1);
    expect(result.passages.map((p) => p.chunk.id)).toContain("relay.md#overview");
  });

  it("keeps the company-wide passage that defines a term the answer needs", () => {
    // The evidence bar must not cost breadth where breadth is the answer: P1 is
    // defined in the support policy, not in Vault's SLA table.
    const ids = index
      .search("What's the SLA for Priority 1 tickets on Nimbus Vault?")
      .passages.map((p) => p.chunk.id);

    expect(ids).toContain("vault.md#support-sla");
    expect(ids).toContain("support-policy.md#priority-definitions");
  });

  it("bounds the passages by prompt tokens, not by a count of chunks", () => {
    // A count means nothing across documents of different sizes. These six
    // questions return between one and twelve passages; what they share is that
    // none of them spends more of the prompt than the budget allows.
    const questions = [
      "what products do we have",
      "Which of our products support SSO via SAML 2.0?",
      "What are the key differences between the Pro and Enterprise pricing tiers?",
      "A client is getting a 403 on the Relay API. What should they check first?",
      "what is relay?",
    ];

    for (const q of questions) {
      const { passages } = index.search(q);
      const spent = estimateTokens(passages.map((p) => formatChunk(p.chunk)).join("\n"));
      expect(spent).toBeLessThanOrEqual(PASSAGE_TOKEN_BUDGET);
      expect(passages.length).toBeLessThanOrEqual(MAX_PASSAGES);
    }
  });

  it("always includes the best passage, however large it is", () => {
    // The answer to a tier comparison is one big table. A budget that could reject
    // it would make the question unanswerable rather than merely expensive.
    const oversized = new KnowledgeBaseIndex([
      {
        id: "huge.md#pricing",
        file: "huge.md",
        docTitle: "Nimbus Huge",
        docDate: null,
        product: "huge",
        heading: "Pricing",
        text: `pricing tier enterprise ${"filler ".repeat(PASSAGE_TOKEN_BUDGET)}`,
      },
    ]);

    expect(oversized.search("pricing tier").passages).toHaveLength(1);
  });

  it("still returns breadth for a question that spans the product line", () => {
    // The cutoff must not starve a "which products" question of products.
    const result = index.search("Which of our products support SSO via SAML 2.0?");
    const files = new Set(result.passages.map((p) => p.chunk.file));

    expect(result.passages.length).toBeGreaterThan(4);
    expect(files.size).toBeGreaterThanOrEqual(4);
  });

  it("asks for different numbers of passages for different questions", () => {
    const narrow = index.search("A client is getting a 403 on the Relay API. What should they check first?");
    const broad = index.search("Which of our products support SSO via SAML 2.0?");
    expect(narrow.passages.length).not.toBe(broad.passages.length);
  });
});

describe("a question about one product does not cite another product's documents", () => {
  it("answers a Vault SLA question from Vault and company-wide documents only", () => {
    // Pulse's, Ledger's and Relay's SLA tables are other products' numbers, not
    // sources for a question about Vault.
    const result = index.search("What's the SLA for Priority 1 tickets on Nimbus Vault?");
    const files = result.passages.map((p) => p.chunk.file);

    expect(files).toContain("vault.md");
    expect(files.some((f) => f.startsWith("pulse"))).toBe(false);
    expect(files.some((f) => f.startsWith("ledger"))).toBe(false);
    expect(files.some((f) => f.startsWith("relay"))).toBe(false);
  });

  it("keeps company-wide documents in scope", () => {
    const result = index.search("What's the SLA for Priority 1 tickets on Nimbus Vault?");
    expect(result.passages.map((p) => p.chunk.file)).toContain("support-policy.md");
  });

  it("does not narrow a question that names two products", () => {
    const result = index.search("How does Vault's SLA compare to Relay's?");
    const files = result.passages.map((p) => p.chunk.file);

    expect(files).toContain("vault.md");
    expect(files).toContain("relay.md");
  });

  it("finds every product named, not only the last one", () => {
    expect(findProducts("How does Vault compare to Relay?", roster).sort()).toEqual(["relay", "vault"]);
    expect(findProducts("Tell me about pricing", roster)).toEqual([]);
  });

  it("falls back to the carried product only when the question names none", () => {
    expect(resolveProducts("what about its SLA?", ["Tell me about Vault"], roster)).toEqual([
      "vault",
    ]);
    expect(
      resolveProducts("compare Vault and Relay", ["Tell me about Pulse"], roster).sort(),
    ).toEqual([
      "relay",
      "vault",
    ]);
  });
});

describe("questions about the corpus itself", () => {
  it("answers 'what products do we have' instead of refusing", () => {
    // This used to be refused with a message that itself named all four products:
    // every word of the question except "products" is a stopword, so the two-term
    // floor rejected it.
    const result = index.search("what are the products that nimbus have");

    expect(result.empty).toBe(false);
    expect(result.passages.map((p) => p.chunk.file)).toContain("security-overview.md");
  });

  it("answers the same question without the company name", () => {
    expect(index.search("what are the products that we have?").empty).toBe(false);
  });

  it("reaches documents covering every product", () => {
    const result = index.search("what products does NimbusStack sell?");
    const text = result.passages.map((p) => p.chunk.text + p.chunk.docTitle).join(" ").toLowerCase();

    for (const product of ["relay", "vault", "pulse", "ledger"]) {
      expect(text).toContain(product);
    }
  });

  it("still refuses questions the corpus genuinely cannot answer", () => {
    expect(index.search("What is the capital of France?").empty).toBe(true);
    expect(index.search("How do I configure nginx reverse proxy headers?").empty).toBe(true);
  });
});

describe("a question that is only its subject", () => {
  it("answers 'what is relay?' instead of refusing", () => {
    // Two guards combined to refuse this: stopwords removed "what" and "is", and
    // the product-double-count fix removed "relay", leaving nothing to search on.
    const result = index.search("what is relay?");

    expect(result.empty).toBe(false);
    expect(result.passages.map((p) => p.chunk.file)).toContain("relay.md");
  });

  it("answers a bare product name for every product", () => {
    for (const [query, file] of [
      ["what is vault", "vault.md"],
      ["what is pulse?", "pulse.md"],
      ["what is ledger?", "ledger.md"],
      ["Tell me about Nimbus Relay", "relay.md"],
    ] as const) {
      const result = index.search(query);
      expect(result.empty, `"${query}" should not be refused`).toBe(false);
      expect(result.passages.map((p) => p.chunk.file)).toContain(file);
    }
  });

  it("reaches the product's own overview, not only its incidental mentions", () => {
    const ids = index.search("what is relay?").passages.map((p) => p.chunk.id);
    expect(ids).toContain("relay.md#overview");
  });

  it("still drops the product term when the question has a real topic", () => {
    // The double-count fix must survive: a 403 question stays narrow.
    const result = index.search("A client is getting a 403 on the Relay API. What should they check first?");
    expect(result.passages.length).toBeLessThan(5);
    expect(result.passages.map((p) => p.chunk.id)).not.toContain("relay.md#pricing");
  });

  it("still refuses questions the corpus cannot answer", () => {
    expect(index.search("What is the capital of France?").empty).toBe(true);
    expect(index.search("How do I configure nginx reverse proxy headers?").empty).toBe(true);
  });
});
