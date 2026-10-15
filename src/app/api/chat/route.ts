import { handleChatRequest } from "@/lib/chat/handle";
import { liveAdapter } from "@/lib/providers/adapter";

// Streaming needs the Node runtime; the knowledge base is read from disk at boot.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleChatRequest(request, { adapter: liveAdapter });
}
