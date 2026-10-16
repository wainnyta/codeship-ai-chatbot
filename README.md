# NimbusStack Product Assistant

An internal chatbot that answers questions about four NimbusStack products — Relay, Vault, Pulse and Ledger — using only NimbusStack's own documentation, and shows the passages each answer came from.

Built for the CodeShip technical assessment.

---

## Run it

Requires Node 22 or later.

```bash
npm install
```

```bash
cp .env.example .env.local
```

Add **at least one** provider key to `.env.local`. Any you leave blank are dropped from the model list and the fallback chain, so one key is enough to run everything:

| Variable | Where to get it |
|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — has a free tier |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com/api-keys) |

```bash
npm run dev
```

Open http://localhost:3000.

```bash
npm test
```

100 tests, no network and no API key required.

---

## How it works

```
question
   │
   ├─ empty?  ────────────────────────────────►  rejected, no provider called
   │
   ├─ retrieve (BM25 over heading-split chunks)
   │     │
   │     └─ nothing relevant?  ───────────────►  "not in the knowledge base",
   │                                              no provider called, zero cost
   ├─ flag candidate disagreements
   ├─ build prompt (passages + dates + rules)
   ├─ too long for the model's window?  ──────►  refused before dispatch
   │
   └─ stream through the provider chain
         meta → model → delta… → usage → done
```

### Answers come from the documents, or not at all

The corpus in `nimbusstack-knowledge-base/` is used exactly as supplied and never edited. At boot it is split at markdown heading boundaries into in-memory chunks. There is no index to build and nothing a fresh clone can have out of date.

**Citations are produced by the retriever, not by the model.** The model is told to cite passage ids, but the authoritative source list attached to every answer is the set that retrieval returned. A model physically cannot cite a document that was not retrieved, which is the structural defence against inventing an answer.

**Retrieval is lexical (BM25), not embeddings.** The corpus is ~15KB across ten files. An embedding index would add a provider dependency and a build step for no measurable recall benefit at this size, and would blur exactly the tokens these questions turn on — `P1`, `Pro`, `4.2`, `SAML`, `403`. Chunks are never split mid-table, so a tier lookup keeps the column headers that tell Pro from Enterprise.

A synonym map lets loosely worded questions land: "does it do single sign-on?" reaches material filed under SAML, OIDC and federated sign-in. When a question names no product, the most recently discussed one is carried over, so "what about its SLA?" works as a follow-up.

### Disagreements are surfaced, not resolved

The supplied corpus contains real contradictions. Two the app finds:

- **Vault's SAML tier.** `security-overview.md` (updated 2026-01-15) says Enterprise. `vault.md` (2026-07-03) and release note 3.1 say it reached Pro.
- **Relay's Pro price.** `relay.md` lists $49 per seat; release note 4.2 moves it to $59 for contracts signed on or after 1 August 2026.

Candidate disagreements are detected before the model writes, by finding passages from different documents that share *rare* terms — weighted by inverse document frequency, not by a raw count of shared words. A naive count flagged twenty pairs for a single question, which makes the warning worthless. Two passages are only comparable when they concern the same product or one of them is company-wide: Relay and Pulse publishing different 403 checklists is two products, not a contradiction.

Lexical overlap finds candidates; it cannot prove a contradiction. The model adjudicates, under an instruction to stay silent when the passages turn out to agree.

### Keys never reach the browser

Provider keys are read in exactly one module, `src/lib/providers/adapter.ts`, which runs on the server and is imported by no client component. No key is prefixed `NEXT_PUBLIC_`. `/api/models` serves a deliberately narrowed view of the config that omits the environment variable names entirely — the browser gets labels, prices and context windows, nothing about how the server is credentialed.

### Model switching and fallback

Everything the app knows about a model lives in `config/models.json`: id, provider, label, description, context window, max output tokens, prices per million tokens, and the fallback order. Nothing about a model is hard-coded. Adding a fourth provider is a config edit plus an adapter case.

Fallback is governed by a **first-flush latch**:

- **Before any bytes reach the browser**, a provider failure walks quietly to the next model in the chain. This covers nearly every real failure — bad credentials, rate limits at request time, model unavailable, overloaded, quota exhausted.
- **After text has been shown**, there is no fallback. Switching providers mid-reply would produce one answer written half by each model, which is incoherent and a lie about attribution. The partial text is kept, marked incomplete, and the user decides whether to resend.

The latch trips on first *flush*, not first *token* — the opening delta is held back — so a provider that dies one token in is still recoverable, and the held token costs nothing perceptible.

Every reply reports which model actually answered, and says so explicitly when that differs from the one selected.

### Usage and cost

Per message: input tokens, output tokens, and cost computed from the config prices, with session running totals and CSV/JSON export.

Three different "ran out of tokens" situations are handled separately:

| Situation | Behaviour |
|---|---|
| Hit the output cap | Clean stop. Text kept, marked truncated, usage exact. No fallback — the provider is healthy. |
| Prompt exceeds the context window | Refused before dispatch with an instruction, so the user gets guidance rather than a provider error. |
| Stream dies mid-generation | Partial text kept and marked. Usage is **estimated** and flagged as such — input tokens are known exactly because the prompt was built locally, output is approximated from the partial text. |

A dropped message would understate session spend and a guess presented as fact would be dishonest; visibly approximate is the third option.

The context meter warns at 75% (amber) and 90% (red), and recomputes the moment you switch models, since the window comes from config. In practice **these thresholds will not be reached by conversation** — the models here have context windows around a million tokens and the whole corpus is 15KB. The meter is correct and tested, but it is proved by unit tests rather than by using the app.

---

## Testing

Two seams, 100 tests, no network access or API key needed.

**The chat endpoint** is driven over its real HTTP contract with a fake provider injected at the registry boundary — configuration, not module patching, so the seam stays a genuine boundary. Tests assert what a caller can observe rather than how the internals are arranged, which means the retriever can be rewritten without rewriting the tests. Covered: the six representative questions' retrieval, conflict flagging, empty input reaching no provider, off-corpus questions reaching no provider, silent pre-latch fallback, no fallback after flush and no mixing of two models' text, estimated usage on an aborted stream, truncation, rate-limit messaging, and per-model cost.

**Token, cost and context arithmetic** is tested as pure functions. This second seam earns its place because the 75%/90% thresholds are unreachable against million-token context windows — synthetic inputs are the only way to exercise them.

Not covered by automated tests: the real Anthropic, OpenAI and Google adapters, which are verified by hand. Live-provider tests would be slow, non-deterministic, cost money per run and fail on a machine without keys.

---

## Deploying

Deploys to Vercel with no configuration beyond the environment variables. The knowledge base is read from disk at runtime, so `next.config.ts` traces `nimbusstack-knowledge-base/**` into the serverless bundle; without that the deployed app boots with an empty corpus.

```bash
npx vercel --prod
```

Set the same provider keys in the Vercel project's environment variables.

---

## Layout

```
config/models.json          every model's metadata and the fallback order
nimbusstack-knowledge-base/ the corpus, exactly as supplied
src/lib/kb/                 chunking and BM25 retrieval
src/lib/providers/          adapters, the latch, error classification
src/lib/chat/handle.ts      the chat endpoint
src/lib/usage.ts            token, cost and context arithmetic
src/components/             chat UI, sources, answer renderer
docs/specs/                 the design spec this was built from
```

---

## Decisions worth questioning

Left deliberately, and worth arguing about:

- **No conversation persistence.** Out of scope per the brief. Refreshing loses the session.
- **Conflict detection is a candidate finder.** It can flag passages that turn out to agree. The prompt instructs the model to stay quiet in that case, and the amber banner only appears when the answer cited *both* sides of a flagged pair — so a candidate the answer never used stays silent. Residual false positives are still possible when an answer legitimately cites two documents covering the same ground that do in fact agree.
- **The relevance floor is a heuristic** — two distinct meaningful terms on one passage. It is tuned against the six representative questions and could be wrong at the margins in both directions.
- **Topic carry inherits the most recently mentioned product.** Clean for a follow-up about one product; a conversation ranging across two could inherit the wrong one.
- **No "continue" for truncated replies**, only resend.
