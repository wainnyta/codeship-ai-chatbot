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

142 tests, no network and no API key required.

---

## How it works

```
question
   │
   ├─ empty?  ────────────────────────────────►  rejected, no provider called
   │
   ├─ follow-up? rewrite into a standalone query  (one cheap model call)
   │
   ├─ retrieve (BM25 over heading-split chunks)
   │     │
   │     └─ nothing relevant?  ───────────────►  no passages sent; the model may
   │                                              only describe itself or refuse
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

**When retrieval finds nothing, the model is sent no passages at all.** "Nothing retrieved" covers two different situations: a product question the documentation does not cover, and a question about the assistant itself. `hi, who are you` retrieves nothing, and refusing it made the assistant look broken on the first thing anyone types — yet its answer comes from the assistant's own prompt, not from general knowledge, so answering it is not an ungrounded claim.

Telling the two apart is semantic, so the model does it under a restricted prompt offering exactly two replies: describe yourself, naming no feature, price, tier, version or date — or reply with the refusal text verbatim. The grounding guarantee is unchanged and structural, because no passages are supplied: there is nothing to cite and no document to misquote, whatever it decides. Verified live across all three providers on greetings, "what can you do", a non-English greeting, world-knowledge questions, a write-me-a-poem request, arithmetic, and a prompt injection.

This costs one short call on a path that used to be free. The exchange is an assistant that answers the first thing anyone types.

**Retrieval is lexical (BM25), not embeddings.** The corpus is ~15KB across ten files. An embedding index would add a provider dependency and a build step for no measurable recall benefit at this size, and would blur exactly the tokens these questions turn on — `P1`, `Pro`, `4.2`, `SAML`, `403`. Chunks are never split mid-table, so a tier lookup keeps the column headers that tell Pro from Enterprise.

A synonym map lets loosely worded questions land: "does it do single sign-on?" reaches material filed under SAML, OIDC and federated sign-in.

### Follow-up questions are resolved before they are searched

"How can I use it" is not a searchable query. The subject lives in the previous turn, and so does the topic — the index receives `use`, matches nothing, and the question is honestly but uselessly refused.

Coreference is semantic, so a model resolves it and string matching cannot. Before retrieval, one cheap non-streaming call rewrites the follow-up into a standalone query against the recent conversation — the standard pre-retrieval step in conversational RAG, and what a tool-calling assistant does implicitly when it writes its own search query. Retrieval then sees `how can I use Nimbus Relay`, and "and for relay?" after a Vault SLA question becomes `what's the SLA for Priority 1 tickets on Nimbus Relay?` — the product *and* the topic carried, where the old heuristic carried only the product.

**The rewrite feeds retrieval and nothing else.** The answering model still receives the question verbatim and the real conversation history, and is told what retrieval was given so it can object if the resolution looks wrong. A bad rewrite therefore costs passage quality; it cannot change what was asked or what may be claimed. Every failure path — provider down, empty output, a reply cut off mid-query, a rewrite with no searchable word in it — falls back to the question as typed, which is the behaviour that existed before this step did.

The resolved query is shown above the sources, and the call is billed separately in the usage strip rather than folded into the answer's numbers, so per-message cost stays attributable to the model that wrote the answer.

**The rewrite model is chosen on measurement, not on list price.** Over three real follow-ups: GPT-6.1 Sol 2519ms / 24 output tokens / $0.00076, Claude Opus 5.5 2855ms / 37 / $0.00247, Gemini 3.8 Flash 4129ms / 412 / $0.00174. Gemini has the lowest token price and the highest bill, because thinking tokens are billed as output and it spends ~400 of them on a one-line rewrite. All three resolve correctly, so `rewriteModelId` in `config/models.json` points at the fastest and cheapest. Changing it is a config edit.

The honest cost: a follow-up waits ~2.5s longer before its first token, and the UI says what it is doing during that wait.

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

Two seams, 142 tests, no network access or API key needed.

**The chat endpoint** is driven over its real HTTP contract with a fake provider injected at the registry boundary — configuration, not module patching, so the seam stays a genuine boundary. Tests assert what a caller can observe rather than how the internals are arranged, which means the retriever can be rewritten without rewriting the tests. Covered: the six representative questions' retrieval, conflict flagging, empty input reaching no provider, off-corpus questions reaching the model with no passages and under the restricted prompt, silent pre-latch fallback, no fallback after flush and no mixing of two models' text, estimated usage on an aborted stream, truncation, rate-limit messaging, per-model cost, and follow-up resolution — that a rewrite reaches retrieval but never the question the model is asked, that a cut-off or unsearchable rewrite is rejected, that both attempts are billed when one is, and that no rewrite call is made on a first question or an empty one.

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
src/lib/chat/rewrite.ts     follow-up resolution (the pre-retrieval rewrite)
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
- **Conflict detection is a candidate finder, and the model is the judge.** Retrieval finds passages covering the same ground; it cannot tell agreement from disagreement, because that is semantic. Those candidates go into the prompt — that is what makes the model look — but the amber banner is raised only when the answer itself declares a contradiction. If a model omits the declaration the UI under-warns while the prose still spells the disagreement out, which is the safe direction.
- **The relevance floor is a heuristic** — two distinct meaningful terms on one passage, relaxed to one when the question names a product. It is tuned against the representative questions and could still be wrong at the margins. False refusals are the failure mode to watch: a confidently wrong answer is worse, but refusing a question the documents do answer erodes trust just as fast.
- **An off-corpus question now costs a model call.** It used to be answered deterministically for nothing, which was a nice property and also why the assistant could not say hello. The structural defence — no passages, so nothing citable — is what actually prevents invention, and that is unchanged; the free short-circuit was never what guaranteed it.

- **The rewrite is load-bearing for dependent follow-ups.** It falls back across providers like every other call, but if all three are unreachable, "how can I use it" degrades to the honest refusal rather than to a worse answer. That is the right direction to fail in, and it is a real availability dependency that did not exist before.

- **Nothing is persisted.** Conversation state lives in the browser; a refresh clears it. Saving chats between sessions is out of scope per the brief.

- **Topic carry still exists underneath, and inherits the most recently mentioned product.** It is now the degradation path for when the rewrite call fails, not the primary mechanism. A conversation ranging across two products could inherit the wrong one.
- **No "continue" for truncated replies**, only resend.
