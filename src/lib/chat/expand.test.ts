import { describe, expect, it } from "vitest";
import { acceptExpansion, shouldRetry } from "./expand";
import { isRepair } from "../kb/spelling";

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
    expect(
      acceptExpansion('{"vocabulary":{"cheaper":["price","pricing"],"landlord":[]}}', unmatched)
        .synonyms,
    ).toEqual({ cheaper: ["price", "pricing"] });
  });

  it("drops keys the reader never typed", () => {
    // The one thing this call must not be able to do is introduce a subject.
    const got = acceptExpansion(
      '{"vocabulary":{"vault":["pricing"],"invoice":["ledger"]},"spelling":{"vault":"vaults"}}',
      unmatched,
    );
    expect(got.synonyms).toEqual({});
    expect(got.repairs).toEqual({});
  });

  it("survives a model that answered in prose or fenced the JSON", () => {
    expect(acceptExpansion("I think cheaper means price.", unmatched).synonyms).toEqual({});
    expect(
      acceptExpansion('```json\n{"vocabulary":{"cheaper":["price"]}}\n```', unmatched).synonyms,
    ).toEqual({ cheaper: ["price"] });
  });

  it("rejects values that are not usable index terms", () => {
    expect(
      acceptExpansion('{"vocabulary":{"cheaper":["", "two words", 7, "price"]}}', unmatched)
        .synonyms,
    ).toEqual({ cheaper: ["price"] });
  });

  it("caps how much one word may be mapped onto", () => {
    expect(
      acceptExpansion('{"vocabulary":{"cheaper":["a","b","c","d","e"]}}', unmatched).synonyms
        .cheaper,
    ).toHaveLength(3);
  });
});

describe("a spelling repair cannot become a substitution", () => {
  it("accepts a correction a character or two from the word typed", () => {
    expect(acceptExpansion('{"spelling":{"wr":"we"}}', ["wr"]).repairs).toEqual({ wr: "we" });
    expect(acceptExpansion('{"spelling":{"thn":"than"}}', ["thn"]).repairs).toEqual({
      thn: "than",
    });
    expect(acceptExpansion('{"spelling":{"pricng":"pricing"}}', ["pricng"]).repairs).toEqual({
      pricng: "pricing",
    });
  });

  it("REJECTS a different word wearing the label of a correction", () => {
    // The whole safety property. The model may call anything a misspelling; the
    // edit budget decides. Without this the second pass is the query rewrite that
    // answered "how much do I owe my landlord" with every pricing table.
    expect(acceptExpansion('{"spelling":{"landlord":"pricing"}}', ["landlord"]).repairs).toEqual(
      {},
    );
    expect(acceptExpansion('{"spelling":{"weather":"sla"}}', ["weather"]).repairs).toEqual({});
    expect(isRepair("landlord", "pricing")).toBe(false);
    expect(isRepair("weather", "sla")).toBe(false);
  });

  it("rejects a repair that is really an expansion", () => {
    // "sla" -> "service level agreement" is a vocabulary mapping, and vocabulary
    // mappings are weighted. Letting it in here would dodge that weighting.
    expect(acceptExpansion('{"spelling":{"sla":"service level agreement"}}', ["sla"]).repairs)
      .toEqual({});
  });

  it("lets spelling win over vocabulary for the same word", () => {
    // A misspelling is not a vocabulary gap, and crediting it would leave the
    // typo in the coverage denominator at maximum idf.
    const got = acceptExpansion(
      '{"spelling":{"thn":"than"},"vocabulary":{"thn":["price"]}}',
      ["thn"],
    );
    expect(got.repairs).toEqual({ thn: "than" });
    expect(got.synonyms).toEqual({});
  });

  it("scales the budget with word length", () => {
    expect(isRepair("wr", "we")).toBe(true);
    expect(isRepair("wr", "api")).toBe(false); // 2 edits on a 2-letter word
    expect(isRepair("integraton", "integration")).toBe(true);
  });
});
