import { describe, expect, it } from "vitest";
import { inlineTokens, parse } from "./Markdown";

describe("inline grammar", () => {
  it("keeps italic as a single token instead of leaking asterisks", () => {
    // The reported bug: *(If that is valid, ...)* rendered with visible asterisks.
    expect(inlineTokens("*(If that is valid, the next checks are:)*")).toContain(
      "*(If that is valid, the next checks are:)*",
    );
  });

  it("does not let italic eat the asterisks of a bold run", () => {
    expect(inlineTokens("the **token's scope** matters")).toContain("**token's scope**");
  });

  it("handles bold and italic in the same line", () => {
    const tokens = inlineTokens("**Pro** is *not* Enterprise");
    expect(tokens).toContain("**Pro**");
    expect(tokens).toContain("*not*");
  });

  it("treats underscore italics as italics", () => {
    expect(inlineTokens("this is _emphasised_ text")).toContain("_emphasised_");
  });

  it("leaves snake_case identifiers alone", () => {
    // An underscore flanked by word characters is part of a name, not emphasis.
    const tokens = inlineTokens("grant secretsmanager:PutSecretValue and clear_tool_uses_20250919");
    expect(tokens.every((t) => !t.startsWith("_"))).toBe(true);
  });

  it("keeps inline code and citations as their own tokens", () => {
    const tokens = inlineTokens("a token for `/orders` [relay.md#troubleshooting]");
    expect(tokens).toContain("`/orders`");
    expect(tokens).toContain("[relay.md#troubleshooting]");
  });
});

describe("nesting inside emphasis", () => {
  it("keeps a citation inside an italic run as its own token", () => {
    // Reported: *(If that is valid ... [relay.md#troubleshooting].)* rendered the
    // citation as literal brackets, because emphasis used to swallow its contents
    // as a raw string.
    const italic = "*(the next checks are: [relay.md#troubleshooting].)*";
    expect(inlineTokens(italic)).toContain(italic);

    const inner = italic.slice(1, -1);
    expect(inlineTokens(inner)).toContain("[relay.md#troubleshooting]");
  });

  it("keeps inline code inside bold", () => {
    const inner = "a token for `/orders`";
    expect(inlineTokens(inner)).toContain("`/orders`");
  });
});

describe("block grammar", () => {
  it("parses an ordered list, preserving its starting number", () => {
    const nodes = parse("1. token scope\n2. IP allowlist\n3. seat suspended");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: "ol", start: 1 });
    expect((nodes[0] as { items: string[] }).items).toHaveLength(3);
  });

  it("keeps a list that starts partway through its numbering", () => {
    const nodes = parse("2. caller's IP\n3. seat suspended");
    expect(nodes[0]).toMatchObject({ kind: "ol", start: 2 });
  });

  it("separates a lead-in sentence from the list that follows it", () => {
    // No blank line between them — which is how models usually write it. Block
    // splitting on blank lines rendered this as one paragraph of literal hyphens.
    const nodes = parse("Check these in order:\n- token scope\n- IP allowlist");
    expect(nodes.map((n) => n.kind)).toEqual(["p", "ul"]);
    expect((nodes[1] as { items: string[] }).items).toEqual(["token scope", "IP allowlist"]);
  });

  it("joins a wrapped continuation line onto the item above it", () => {
    const nodes = parse("- scopes are per route since Relay 4.0\n  and cannot be shared");
    expect((nodes[0] as { items: string[] }).items).toEqual([
      "scopes are per route since Relay 4.0 and cannot be shared",
    ]);
  });

  it("groups contiguous table rows into one table", () => {
    const nodes = parse("| Tier | Price |\n|---|---|\n| Pro | $35 |\n| Enterprise | Custom |");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: "table" });
    expect((nodes[0] as { rows: string[] }).rows).toHaveLength(4);
  });

  it("reads a table that follows a sentence without a blank line", () => {
    const nodes = parse("Vault pricing per seat:\n| Tier | Price |\n|---|---|\n| Pro | $35 |");
    expect(nodes.map((n) => n.kind)).toEqual(["p", "table"]);
  });

  it("parses headings that survive the chunker", () => {
    const nodes = parse("### Troubleshooting\n\nCheck the scope.");
    expect(nodes[0]).toMatchObject({ kind: "h", level: 3, text: "Troubleshooting" });
  });

  it("returns nothing for empty text, so a streaming caret has somewhere to go", () => {
    expect(parse("")).toEqual([]);
  });

  it("does not mistake a table divider row for a horizontal rule", () => {
    const nodes = parse("| A | B |\n|---|---|\n| 1 | 2 |");
    expect(nodes.every((n) => n.kind !== "hr")).toBe(true);
  });
});
