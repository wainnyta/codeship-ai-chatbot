import { DEFAULT_MODEL_ID, getModel, resolveChain } from "../config";
import { getIndex } from "../kb";
import type { KnowledgeBaseIndex } from "../kb/retrieve";
import { buildPrompt, buildScopePrompt } from "../prompt";
import { runChat } from "../providers/stream";
import type { Adapter, ChatMessage, Rewriter, StreamEvent } from "../providers/types";
import { resolveQuery } from "./rewrite";
import { minimumTokens } from "../usage";

export interface ChatRequestBody {
  messages: ChatMessage[];
  modelId?: string;
}

export interface ChatDeps {
  adapter: Adapter;
  /** Omitted disables query rewriting; the question is searched as typed. */
  rewriter?: Rewriter;
  index?: KnowledgeBaseIndex;
}

function sse(events: AsyncIterable<StreamEvent> | Iterable<StreamEvent>): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events as AsyncIterable<StreamEvent>) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      } catch (error) {
        // A throw here means a bug in our own pipeline rather than a provider
        // failure. Close the stream with a usable message instead of leaving the
        // browser hanging on a half-open connection.
        const event: StreamEvent = {
          type: "error",
          code: "all_failed",
          message: `The server failed while answering: ${(error as Error)?.message ?? "unknown error"}`,
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Vercel/nginx must not buffer, or word-by-word streaming becomes one lump.
      "X-Accel-Buffering": "no",
    },
  });
}

function errorResponse(event: StreamEvent, status: number): Response {
  return new Response(JSON.stringify(event), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleChatRequest(request: Request, deps: ChatDeps): Promise<Response> {
  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return errorResponse(
      { type: "error", code: "empty_input", message: "Malformed request body." },
      400,
    );
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const question = messages.at(-1)?.role === "user" ? (messages.at(-1)!.content ?? "") : "";

  // E10. Checked here as well as in the UI, so the guarantee holds for a direct
  // call to this endpoint and not merely for the happy path through the browser.
  // Nothing below this line runs, so no provider is contacted.
  if (!question.trim()) {
    return errorResponse(
      {
        type: "error",
        code: "empty_input",
        message: "Ask a question first — an empty message isn't sent to any AI provider.",
      },
      400,
    );
  }

  const selectedId = body.modelId && getModel(body.modelId) ? body.modelId : DEFAULT_MODEL_ID;
  const selected = getModel(selectedId)!;

  const index = deps.index ?? getIndex();
  const history = messages.slice(0, -1);

  /**
   * Resolve the question before retrieving. A follow-up like "how can I use it"
   * is not a searchable query; this turns it into one. The call is skipped on the
   * first question of a conversation, and any failure searches the question as
   * typed — so this can slow a follow-up down, but it cannot break one.
   */
  const resolved = await resolveQuery({
    question,
    history,
    rewriter: deps.rewriter,
    signal: request.signal,
  });

  /**
   * The heuristic product carry is now strictly the fallback for when the rewrite
   * call could not be made, and history is withheld from retrieval whenever it
   * could.
   *
   * The carry assumes that a question naming no product inherits the last one
   * discussed. That is right for "what about its SLA?" and wrong for "what time is
   * it", which inherited Vault, and an inherited product lowers the evidence bar
   * from two matched terms to one — so the single word `time` was enough to
   * retrieve the support policy's business hours and turn a clean refusal into a
   * paragraph about office hours.
   *
   * A successful rewrite settles this without guessing. If the question referred
   * back, the rewrite now names what it referred to and `resolveProducts` finds it
   * in the query itself. If the rewrite returned the question unchanged, that is
   * positive evidence there was no reference to resolve — and inheriting a topic
   * anyway is exactly the mistake. Only when no rewrite happened at all is there
   * nothing better than the guess.
   *
   * The carry still reads the user's own earlier questions, never the assistant's
   * replies: an answer listing all four products would otherwise hand the next
   * follow-up whichever product it mentioned last.
   */
  const retrieval = index.search(resolved.query, {
    history: resolved.modelId
      ? []
      : history.filter((m) => m.role === "user").map((m) => m.content),
  });

  // Reported whenever a call was made, including when it returned the question
  // unchanged — those tokens were still spent, and R4 says so.
  const rewrite =
    resolved.modelId && resolved.usage
      ? { query: resolved.query, modelId: resolved.modelId, usage: resolved.usage }
      : undefined;

  /**
   * E2. Nothing in the corpus matched, so no passages go to the model and nothing
   * can be cited. The model's only remaining job is to tell apart a product
   * question the documentation does not cover — which it must refuse in fixed
   * words — from a question about the assistant itself, which it may answer
   * because the answer is in its own prompt rather than in any document.
   *
   * This used to be answered here without contacting a provider, which was free
   * and fast and also meant "hi, who are you" was refused. The exchange is one
   * short call on a path that is rare in real use, against an assistant that
   * answers the first thing anyone types.
   */
  const prompt = retrieval.empty
    ? buildScopePrompt(question)
    : buildPrompt(question, retrieval, resolved.query);

  /**
   * Refuse before dispatch, but only when refusing is certainly right.
   *
   * This used to ask `estimateTokens` whether the prompt would fit, which is a
   * coin-flip dressed as a check: chars/4 under-counts a pasted log dump by half
   * and over-counts plain prose by half again, so it both waved through requests
   * that overflowed and would have blocked conversations that fitted.
   *
   * `minimumTokens` is deliberately an under-estimate, so this fires only when
   * even the most token-efficient reading of the conversation overflows. Anything
   * it lets past is caught by the provider, which does not estimate — and a
   * pre-latch rejection falls through to the next model in the chain, which may
   * have a larger window and simply answer. Guessing here would pre-empt that with
   * a refusal telling the reader to do by hand what the chain already does.
   */
  const floor = minimumTokens(
    `${prompt.system}\n${prompt.userContent}\n${history.map((m) => m.content).join("\n")}`,
  );
  if (floor + selected.maxOutputTokens > selected.contextWindow) {
    return errorResponse(
      {
        type: "error",
        code: "context_too_long",
        message: `This conversation no longer fits in ${selected.label}'s context window. Start a New Conversation, or switch to a model with a larger window.`,
        modelId: selectedId,
      },
      413,
    );
  }

  return sse(
    runChat({
      chain: resolveChain(selectedId),
      selectedId,
      prompt,
      history,
      retrieval,
      adapter: deps.adapter,
      rewrite,
      signal: request.signal,
    }),
  );
}
