import raw from "../../config/models.json";

export type ProviderName = "anthropic" | "openai" | "google";

export interface ModelConfig {
  id: string;
  provider: ProviderName;
  label: string;
  description: string;
  contextWindow: number;
  maxOutputTokens: number;
  pricing: { inputPerMillion: number; outputPerMillion: number };
  apiKeyEnvVar: string;
  providerOptions?: Record<string, Record<string, unknown>>;
}

interface ModelsFile {
  defaultModelId: string;
  fallbackOrder: string[];
  /** Model used for the pre-retrieval query rewrite. Defaults to defaultModelId. */
  rewriteModelId?: string;
  models: ModelConfig[];
}

const config = raw as unknown as ModelsFile;

/** Fail at boot on a malformed config rather than at the first user request. */
function validate(c: ModelsFile): ModelsFile {
  if (!c.models?.length) throw new Error("config/models.json: no models defined");

  const ids = new Set<string>();
  for (const m of c.models) {
    if (ids.has(m.id)) throw new Error(`config/models.json: duplicate model id "${m.id}"`);
    ids.add(m.id);

    if (!m.pricing || typeof m.pricing.inputPerMillion !== "number" || typeof m.pricing.outputPerMillion !== "number") {
      throw new Error(`config/models.json: model "${m.id}" is missing pricing`);
    }
    if (!m.contextWindow || !m.maxOutputTokens) {
      throw new Error(`config/models.json: model "${m.id}" is missing token limits`);
    }
  }

  if (!ids.has(c.defaultModelId)) {
    throw new Error(`config/models.json: defaultModelId "${c.defaultModelId}" is not a defined model`);
  }
  for (const id of c.fallbackOrder) {
    if (!ids.has(id)) throw new Error(`config/models.json: fallbackOrder references unknown model "${id}"`);
  }
  if (c.rewriteModelId && !ids.has(c.rewriteModelId)) {
    throw new Error(`config/models.json: rewriteModelId "${c.rewriteModelId}" is not a defined model`);
  }

  return c;
}

const validated = validate(config);

export const DEFAULT_MODEL_ID = validated.defaultModelId;

/**
 * The model that rewrites follow-up questions into standalone search queries.
 * Configured rather than hard-coded for the same reason as everything else here
 * (R3), and separate from the answering model because the job is different: it is
 * throwaway utility output, so it should always run on the cheapest fast model
 * regardless of which model the user picked to answer with.
 */
export const REWRITE_MODEL_ID = validated.rewriteModelId ?? validated.defaultModelId;

export function listModels(): ModelConfig[] {
  return validated.models;
}

export function getModel(id: string): ModelConfig | undefined {
  return validated.models.find((m) => m.id === id);
}

/** A model is only usable if its key is present in the server environment. */
export function hasCredentials(model: ModelConfig): boolean {
  return Boolean(process.env[model.apiKeyEnvVar]);
}

/**
 * The order to try: the selected model first, then the configured fallback order
 * with the selected one removed. Models without credentials are dropped, so a
 * placeholder provider never becomes a dead end mid-conversation.
 */
export function resolveChain(selectedId: string): ModelConfig[] {
  const ordered = [selectedId, ...validated.fallbackOrder.filter((id) => id !== selectedId)];

  const chain: ModelConfig[] = [];
  for (const id of ordered) {
    const model = getModel(id);
    if (model && hasCredentials(model)) chain.push(model);
  }
  return chain;
}

/**
 * What the browser is allowed to know about a model. Deliberately excludes
 * `apiKeyEnvVar` and anything else that hints at server configuration — the client
 * needs labels, prices and context windows to render the usage panel, nothing more.
 */
export interface PublicModel {
  id: string;
  provider: ProviderName;
  label: string;
  description: string;
  contextWindow: number;
  pricing: { inputPerMillion: number; outputPerMillion: number };
  configured: boolean;
}

export function publicModels(): PublicModel[] {
  return validated.models.map((m) => ({
    id: m.id,
    provider: m.provider,
    label: m.label,
    description: m.description,
    contextWindow: m.contextWindow,
    pricing: m.pricing,
    configured: hasCredentials(m),
  }));
}
