import { defaultConfiguredModelId, publicModels } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Model metadata for the dropdown and the usage panel (R3). Serves `publicModels()`,
 * which deliberately omits the env var names — the browser gets labels, prices and
 * context windows, never anything about how the server is credentialed.
 */
export async function GET(): Promise<Response> {
  return Response.json({ models: publicModels(), defaultModelId: defaultConfiguredModelId() });
}
