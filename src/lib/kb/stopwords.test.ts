import { describe, expect, it } from "vitest";
import { ENGLISH_FUNCTION_WORDS, englishStopwords, NEVER_STOPWORDS } from "./stopwords";

describe("the stopword list is language-level, not corpus-level", () => {
  const words = englishStopwords();

  it("contains the comparison words that carry no topic", () => {
    // "is Vault cheaper than Pulse" matched on the single word `than`, because the
    // old hand-assembled list had that/then/there/they and not `than`.
    for (const w of ["than", "then", "that", "there", "they", "compare", "versus", "vs"]) {
      expect(words.has(w), `"${w}" should be a stopword`).toBe(true);
    }
  });

  it("contains contractions as people type them, without the apostrophe", () => {
    // "whats in vault 4.2" kept `whats` as a content word. Absent from every
    // document, it scored maximum IDF in the denominator and sank the question.
    for (const w of ["whats", "wheres", "hows", "dont", "doesnt", "cant", "isnt"]) {
      expect(words.has(w), `"${w}" should be a stopword`).toBe(true);
    }
  });

  it("does NOT drop words that are also ordinary or domain terms", () => {
    // The trap in the line above: a contraction without its apostrophe is only
    // safe to drop when the result is not also a real word. `id` is a term of art
    // wherever there are workspace, token or tenant IDs; `lets` is a verb ("Relay
    // lets you route events"); `well` and `first` carry meaning.
    // `well` is deliberately NOT in this list: it is a discourse marker far more
    // often than a content word ("well, what about…"), and "is it working well"
    // still matches on `working`. Judgment call, recorded rather than hidden.
    for (const w of ["id", "lets", "ill", "first", "new", "down", "free"]) {
      expect(words.has(w), `"${w}" must NOT be a stopword`).toBe(false);
    }
  });

  it("never drops anything on the NEVER list, however it is classified", () => {
    for (const w of NEVER_STOPWORDS) expect(words.has(w)).toBe(false);
  });

  it("is a list of words, not phrases or punctuation", () => {
    for (const w of ENGLISH_FUNCTION_WORDS) expect(w).toMatch(/^[a-z]+$/);
  });
});
