import { DEFAULT_MODEL_ID, getModel, resolveChain } from "../config";
import { getIndex } from "../kb";
import type { KnowledgeBaseIndex } from "../kb/retrieve";
import { NOT_IN_KB_MESSAGE, buildPrompt } from "../prompt";
import { runChat } from "../providers/stream";
import type { Adapter, ChatMessage, StreamEvent } from "../providers/types";
import { estimateTokens } from "../usage";

export interface ChatRequestBody {
  messages: ChatMessage[];
  modelId?: string;
}

export interface ChatDeps {
  adapter: Adapter;
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

  // Topic carry reads the user's own earlier questions, not the assistant's
  // replies. An answer that lists all four products would otherwise hand the next
  // follow-up whichever product it happened to mention last — so "what about its
  // SLA?" after "we sell Relay, Vault, Pulse and Ledger" would silently become a
  // question about Ledger.
  const retrieval = index.search(question, {
    history: history.filter((m) => m.role === "user").map((m) => m.content),
  });

  // E2. Nothing in the corpus is relevant, so the honest answer is produced here —
  // no provider call, no tokens, no cost, and no opportunity to invent anything.
  if (retrieval.empty) {
    return sse([
      { type: "meta", passages: [], conflicts: [] },
      {
        type: "model",
        model: {
          id: "none",
          label: "No model needed",
          provider: "none",
          contextWindow: selected.contextWindow,
          fallback: false,
          selectedId,
        },
      },
      { type: "delta", text: NOT_IN_KB_MESSAGE },
      {
        type: "usage",
        modelId: "none",
        truncated: false,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, estimated: false },
      },
      { type: "done" },
    ]);
  }

  const prompt = buildPrompt(question, retrieval);

  // Refuse before dispatch rather than letting the provider reject it, so the user
  // gets an instruction instead of a provider error.
  const projected = estimateTokens(
    `${prompt.system}\n${prompt.userContent}\n${history.map((m) => m.content).join("\n")}`,
  );
  if (projected + selected.maxOutputTokens > selected.contextWindow) {
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
      signal: request.signal,
    }),
  );
}
