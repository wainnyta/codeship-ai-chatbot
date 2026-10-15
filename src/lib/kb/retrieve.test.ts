import { describe, expect, it } from "vitest";
import { getIndex } from "./index";
import { findProduct, resolveProduct } from "./retrieve";

const index = getIndex();

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
  it("flags the Vault SAML conflict between the product doc and the security overview", () => {
    const result = index.search("Which products support SSO via SAML 2.0?");

    const flagged = new Set(result.conflicts.flat());
    const hasVaultSide = [...flagged].some((id) => id.startsWith("vault.md"));
    const hasOverviewSide = [...flagged].some((id) => id.startsWith("security-overview.md"));

    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(hasVaultSide && hasOverviewSide).toBe(true);
  });
});

describe("E1 — follow-ups inherit the product from earlier turns", () => {
  it("finds no product in a bare follow-up", () => {
    expect(findProduct("what about its SLA?")).toBeNull();
  });

  it("inherits the product from conversation history", () => {
    expect(resolveProduct("what about its SLA?", ["Tell me about Nimbus Relay pricing"])).toBe("relay");
  });

  it("prefers the most recently mentioned product", () => {
    const history = ["Tell me about Relay", "Now tell me about Vault pricing"];
    expect(resolveProduct("what about its SLA?", history)).toBe("vault");
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

  it("still retrieves product context when only part of the question is unknown", () => {
    // "Kubernetes" is absent from the corpus, but the question is about a real
    // product — so passages are returned and the model reports the gap (E3),
    // rather than the floor swallowing the whole question.
    const result = index.search("Does Nimbus Relay support Kubernetes?");
    expect(result.empty).toBe(false);
    expect(result.passages.map((p) => p.chunk.file)).toContain("relay.md");
  });
});
