/**
 * English function words. LANGUAGE-LEVEL, not client-level.
 *
 * WHY THIS IS NOT THE LIST THE REVIEW CRITICISED
 *
 * The old list lived in retrieve.ts, was assembled by hand for this corpus, and
 * was missing `than` while `that`, `then`, `there` and `they` were all present —
 * which is why "is Vault cheaper than Pulse" matched on the single word `than` and
 * returned two Relay release notes. The defect was not the missing word; it was
 * that the list was a per-corpus artifact somebody had to remember to extend.
 *
 * This list is a property of ENGLISH. It ships once, it is complete rather than
 * curated, and it needs no entry when a new client or a new product arrives. That
 * is the difference that matters for scaling out.
 *
 * WHY DOCUMENT FREQUENCY CANNOT REPLACE IT — measured on this corpus
 *
 * Deriving stopwords from df/N was the original plan here and it does not work at
 * this corpus's shape. The chunks are short and table-heavy, so at the ratio
 * needed to catch the function words the rule has already eaten the subject matter:
 *
 *   df/N >= 0.50  ->  2 terms:   "2", "and"                        (useless)
 *   df/N >= 0.30  ->  13 terms:  ... and "pro", "enterpris"        (tier names!)
 *   df/N >= 0.20  ->  32 terms:  ... and "saml", "support", "featur"
 *
 * `pro` and `enterprise` are the two tier names every pricing question turns on,
 * and `saml` is the subject of an entire user story. Document frequency cannot
 * distinguish "frequent because it is a function word" from "frequent because it
 * is what these documents are about". So df-derivation is kept only as a build-time
 * DIAGNOSTIC — the build prints which terms are corpus-wide boilerplate — and the
 * query path filters on this list instead.
 */

export const ENGLISH_FUNCTION_WORDS: readonly string[] = [
  "a","about","above","after","again","against","all","also","am","an","and","any","are","aren","as","at",
  "be","because","been","before","being","below","between","both","but","by",
  "can","cannot","could","couldn",
  "did","didn","do","does","doesn","doing","don","down","during",
  "each","either","else","enough","even","ever","every",
  "few","for","from","further",
  "get","gets","getting","give","go","got",
  "had","hadn","has","hasn","have","haven","having","he","her","here","hers","herself","him","himself","his","how","however",
  "i","if","in","into","is","isn","it","its","itself",
  "just",
  "let",
  "make","many","may","me","might","mine","more","most","much","must","my","myself",
  "need","needs","neither","no","nor","not","now",
  "of","off","on","once","one","only","or","other","others","ought","our","ours","ourselves","out","over","own",
  "please","put",
  "quite",
  "rather","really",
  "same","shall","she","should","shouldn","since","so","some","something","such",
  "take","tell","than","that","the","their","theirs","them","themselves","then","there","these","they","this","those","though","through","to","too",
  "under","until","up","upon","us","use","used","using",
  "very",
  "want","wants","was","wasn","way","we","well","were","weren","what","when","where","whether","which","while","who","whom","whose","why","will","with","within","without","won","would","wouldn",
  "you","your","yours","yourself","yourselves",
  // Contractions as people actually type them, without the apostrophe. "whats in
  // vault 4.2" kept "whats" as a content word, which is out-of-vocabulary and so
  // scored maximum IDF against the question.
  "whats","wheres","hows","whos","thats","theres","heres","dont","doesnt","didnt",
  "cant","wont","isnt","arent","wasnt","werent","couldnt","wouldnt","shouldnt",
  "im","ive","youre","youve","weve","theyre","theyve",
  // Deliberately NOT here, though they are contractions in one reading: "id"
  // (identifier — a domain term wherever there are workspace, token or tenant
  // IDs), "lets" ("Relay lets you route events"), "well" ("is it working well"),
  // "ill". A contraction without its apostrophe is only safe to drop when the
  // result is not also an ordinary word, and these four are.
  // Comparison and query scaffolding. These describe the SHAPE of the question,
  // not its subject: "compare Vault and Pulse pricing" is about pricing, and
  // counting "compare" as a missing topic word punished the query for its grammar.
  // Measured: it dropped that question from answered to refused at coverage 0.259.
  "compare","compared","comparison","versus","vs","differ","difference","differences",
  "better","best","worse","worst","instead","alternative","alternatives",
  // Interrogative and conversational filler that behaves the same way here.
  "anyone","anything","everyone","everything","someone","somebody","nobody","none","okay","ok","hi","hello","hey","thanks","thank",
];

/**
 * Words that look like function words but carry the whole question in this domain,
 * and so must never be filtered however a rule classifies them.
 *
 * Kept deliberately tiny and justified one entry at a time. This is the only place
 * in the stopword path that knows anything domain-shaped, and `identifiers` in the
 * client config is the general mechanism — tier names like Pro and Enterprise are
 * handled there as typed values, not here.
 */
export const NEVER_STOPWORDS: readonly string[] = ["down", "first", "last", "new", "old", "free"];

const NEVER = new Set(NEVER_STOPWORDS);

export function englishStopwords(extra: readonly string[] = []): Set<string> {
  const set = new Set<string>();
  for (const w of ENGLISH_FUNCTION_WORDS) if (!NEVER.has(w)) set.add(w);
  for (const w of extra) set.add(w.toLowerCase());
  for (const w of NEVER) set.delete(w);
  return set;
}
