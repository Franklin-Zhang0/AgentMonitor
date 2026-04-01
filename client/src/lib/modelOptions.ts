import type { AgentProvider, RuntimeCapabilities } from '../api/client';

export type ModelSelection = string | 'default';

const FALLBACK_MODELS: Record<AgentProvider, string[]> = {
  claude: ['sonnet', 'opus'],
  codex: ['gpt-5', 'gpt-5.4', 'gpt-5.4-mini'],
};

export function getSupportedModels(
  provider: AgentProvider,
  runtimeCapabilities?: RuntimeCapabilities | null,
): string[] {
  const detected = runtimeCapabilities?.providers?.[provider]?.models;
  return detected && detected.length > 0
    ? detected
    : FALLBACK_MODELS[provider];
}

export function isModelSupported(
  provider: AgentProvider,
  model: unknown,
  runtimeCapabilities?: RuntimeCapabilities | null,
): model is string {
  return typeof model === 'string' && getSupportedModels(provider, runtimeCapabilities).includes(model);
}

export function normalizeModelSelection(
  provider: AgentProvider,
  model: unknown,
  runtimeCapabilities?: RuntimeCapabilities | null,
  keepUnknown = false,
): ModelSelection {
  if (typeof model !== 'string' || !model.trim()) return 'default';
  const normalized = model.trim();
  if (isModelSupported(provider, normalized, runtimeCapabilities)) return normalized;
  return keepUnknown ? normalized : 'default';
}

export function getModelOptions(
  provider: AgentProvider,
  runtimeCapabilities?: RuntimeCapabilities | null,
  selectedModel?: string,
): Array<{ value: ModelSelection; label: string }> {
  const supported = getSupportedModels(provider, runtimeCapabilities);
  const options = ['default', ...supported] as ModelSelection[];

  if (selectedModel && !supported.includes(selectedModel)) {
    options.push(selectedModel);
  }

  return options.map((value) => ({
    value,
    label: value,
  }));
}
