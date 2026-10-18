import { describe, expect, it } from "vitest";
import { acceptExpansion, shouldRetry } from "./expand";

describe("which failures earn a second pass", () => {
  it("retries the failures that are about words", () => {
    expect(shouldRetry("no_match")).toBe(true);
    expect(shouldRetry("below_coverage")).toBe(true);
  });

  it("NEVER retries an absent identifier", () => {
    // The reader named a version or status code no document carries. That is a
    // fact about the corpus, not a problem with their wording, and searching
    // around it until something turns up is how an honest refusal becomes a
    // confident wrong answer.
    expect(shouldRetry("identifier_absent")).toBe(false);
  });
});

describe("accepting what the model was entitled to say", () => {
  const unmatched = ["cheaper", "landlord"];

  it("keeps mappings for words the reader actually typed", () => {
    expect(acceptExpansion('{"cheaper":["price","pricing"],"landlord":[]}', unmatched)).toEqual({
      cheaper: ["price", "pricing"],
    });
  });

  it("drops keys the reader never typed", () => {
    // The one thing this call must not be able to do is introduce a subject.
    expect(acceptExpansion('{"vault":["pricing"],"invoice":["ledger"]}', unmatched)).toEqual({});
  });

  it("survives a model that answered in prose or fenced the JSON", () => {
    expect(acceptExpansion("I think cheaper means price.", unmatched)).toEqual({});
    expect(acceptExpansion('```json\n{"cheaper":["price"]}\n```', unmatched)).toEqual({
      cheaper: ["price"],
    });
  });

  it("rejects values that are not usable index terms", () => {
    expect(acceptExpansion('{"cheaper":["", "two words", 7, "price"]}', unmatched)).toEqual({
      cheaper: ["price"],
    });
  });

  it("caps how much one word may be mapped onto", () => {
    expect(
      acceptExpansion('{"cheaper":["a","b","c","d","e"]}', unmatched).cheaper,
    ).toHaveLength(3);
  });
});
