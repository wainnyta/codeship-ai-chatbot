import { describe, expect, it } from "vitest";
import { activeConflicts, citedIds, declaresConflict, stripConflictMarker } from "./citations";

const VAULT_CONFLICT: Array<[string, string]> = [
  ["security-overview.md#identity", "vault.md#pricing"],
];

describe("citedIds", () => {
  it("picks out the passages an answer cited", () => {
    const ids = citedIds("Pro and Enterprise [vault.md#pricing], but see [security-overview.md#identity].");
    expect(ids).toEqual(new Set(["vault.md#pricing", "security-overview.md#identity"]));
  });

  it("is empty for an answer that cited nothing", () => {
    expect(citedIds("NimbusStack has four products.").size).toBe(0);
  });
});

describe("activeConflicts", () => {
  it("warns when the answer cited both sides of a flagged pair", () => {
    const answer =
      "Vault is Pro and Enterprise [vault.md#pricing], though the security overview says Enterprise only [security-overview.md#identity].";
    expect(activeConflicts(VAULT_CONFLICT, answer)).toHaveLength(1);
  });

  it("stays silent when the answer cited only one side", () => {
    // The reported case: "what products do we have?" cited a single passage and
    // reported no disagreement, but the banner fired anyway because retrieval had
    // flagged candidates.
    const answer = "NimbusStack has four products [security-overview.md#identity].";
    expect(activeConflicts(VAULT_CONFLICT, answer)).toHaveLength(0);
  });

  it("stays silent when the answer cited neither side", () => {
    expect(activeConflicts(VAULT_CONFLICT, "Relay is an API gateway [relay.md#overview].")).toHaveLength(0);
  });

  it("stays silent while the reply is still streaming and has cited nothing", () => {
    expect(activeConflicts(VAULT_CONFLICT, "Vault support")).toHaveLength(0);
  });

  it("keeps only the pairs that were fully cited", () => {
    const conflicts: Array<[string, string]> = [
      ["security-overview.md#identity", "vault.md#pricing"],
      ["security-overview.md#identity", "ledger.md#pricing"],
    ];
    const answer = "[security-overview.md#identity] and [vault.md#pricing]";
    expect(activeConflicts(conflicts, answer)).toEqual([
      ["security-overview.md#identity", "vault.md#pricing"],
    ]);
  });
});

describe("the answer declares whether a disagreement is real", () => {
  it("recognises the marker at the start of a reply", () => {
    expect(declaresConflict("[[CONFLICT]]\nVault's SAML tier is stated two ways.")).toBe(true);
  });

  it("is false for an answer that reports no disagreement", () => {
    // The reported case: a company-wide policy defining "business hours" and a
    // product's SLA table using them share every meaningful term and contradict
    // nothing, but scored as a conflict candidate.
    expect(declaresConflict("Vault's P1 SLA is 1 hour on Pro [vault.md#support-sla].")).toBe(false);
  });

  it("is false while a reply is still empty", () => {
    expect(declaresConflict("")).toBe(false);
  });

  it("does not fire on the word conflict in ordinary prose", () => {
    expect(declaresConflict("There is no conflict between these documents.")).toBe(false);
  });

  it("removes the marker before the reader sees it", () => {
    expect(stripConflictMarker("[[CONFLICT]]\nBoth documents differ.")).toBe("Both documents differ.");
  });

  it("leaves an unmarked answer untouched", () => {
    const answer = "Vault costs $12 on Starter.";
    expect(stripConflictMarker(answer)).toBe(answer);
  });
});
