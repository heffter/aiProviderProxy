/**
 * Model alias resolution (epic AIPP-4, subtask 4.2; FR-CHAT-005, FR-MODEL-012).
 *
 * Faithful migration of the legacy resolution tables so every legacy alias maps
 * to the same provider/native-model as before: MODEL_MAPPING, RELAYPLANE_ALIASES,
 * the rp:* smart aliases (rebuilt from available keys), and the prefix rules.
 * The `rp:` and `relayplane:` prefixes still work but emit a deprecation warning;
 * `aipp:` is the preferred equivalent.
 */

/** Resolved provider + native model id. */
export interface ResolvedModel {
  provider: string;
  model: string;
}

/** Static friendly-name -> provider/native-model map (ported verbatim). */
export const MODEL_MAPPING: Record<string, ResolvedModel> = {
  'claude-opus-4-5': { provider: 'anthropic', model: 'claude-opus-4-6' },
  'claude-sonnet-4': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  'claude-3-5-sonnet': {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
  },
  'claude-3-5-haiku': { provider: 'anthropic', model: 'claude-haiku-4-5' },
  'claude-haiku-4-5': { provider: 'anthropic', model: 'claude-haiku-4-5' },
  haiku: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  opus: { provider: 'anthropic', model: 'claude-opus-4-6' },
  'gpt-4o': { provider: 'openai', model: 'gpt-4o' },
  'gpt-4o-mini': { provider: 'openai', model: 'gpt-4o-mini' },
  'gpt-4.1': { provider: 'openai', model: 'gpt-4.1' },
  'gpt-5.4': { provider: 'openai', model: 'gpt-5.4' },
  'gpt-5.4-pro': { provider: 'openai', model: 'gpt-5.4-pro' },
  'gpt-5.3': { provider: 'openai', model: 'gpt-5.3-chat' },
  'gpt-5.2': { provider: 'openai', model: 'gpt-5.2' },
  'gpt-5.1': { provider: 'openai', model: 'gpt-5.1' },
  'gpt-5': { provider: 'openai', model: 'gpt-5.4' },
  'gpt-5-mini': { provider: 'openai', model: 'gpt-5-mini' },
  'gpt-5-nano': { provider: 'openai', model: 'gpt-5-nano' },
  'gpt-4.1-mini': { provider: 'openai', model: 'gpt-4.1-mini' },
  'gpt-4.1-nano': { provider: 'openai', model: 'gpt-4.1-nano' },
  o3: { provider: 'openai', model: 'o3' },
  'o3-pro': { provider: 'openai', model: 'o3-pro' },
  'o3-mini': { provider: 'openai', model: 'o3-mini' },
  'o4-mini': { provider: 'openai', model: 'o4-mini' },
  'gemini-3.1-pro': { provider: 'google', model: 'gemini-3.1-pro-preview' },
  'gemini-3-pro': { provider: 'google', model: 'gemini-3-pro-preview' },
  'gemini-3-flash': { provider: 'google', model: 'gemini-3-flash-preview' },
  'gemini-2.5-pro': { provider: 'google', model: 'gemini-2.5-pro' },
  'gemini-2.5-flash': { provider: 'google', model: 'gemini-2.5-flash' },
  'gemini-2.5-flash-lite': {
    provider: 'google',
    model: 'gemini-2.5-flash-lite',
  },
  'gemini-2.0-flash': { provider: 'google', model: 'gemini-2.0-flash' },
  'grok-4.20': { provider: 'xai', model: 'grok-4.20-beta' },
  'grok-4': { provider: 'xai', model: 'grok-4' },
  'grok-4-fast': { provider: 'xai', model: 'grok-4-fast' },
  'grok-4.1-fast': { provider: 'xai', model: 'grok-4.1-fast' },
  'grok-3': { provider: 'xai', model: 'grok-3' },
  'grok-3-mini': { provider: 'xai', model: 'grok-3-mini' },
  deepseek: { provider: 'deepseek', model: 'deepseek-chat' },
  'deepseek-r1': { provider: 'deepseek', model: 'deepseek-reasoner' },
};

/** Routing-mode aliases resolved before smart aliases (ported). */
export const RELAYPLANE_ALIASES: Record<string, string> = {
  'rp:auto': 'rp:balanced',
};

/** Default smart aliases (Anthropic passthrough) when no keys are configured. */
export const DEFAULT_SMART_ALIASES: Record<string, ResolvedModel> = {
  'rp:best': { provider: 'anthropic', model: 'claude-opus-4-6' },
  'rp:fast': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  'rp:cheap': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  'rp:balanced': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
};

/**
 * Build provider-aware smart aliases from available API keys (ported priority:
 * OpenRouter > Anthropic > OpenAI > Anthropic passthrough default).
 */
export function buildSmartAliases(env: NodeJS.ProcessEnv = process.env): {
  aliases: Record<string, ResolvedModel>;
  via: string;
} {
  if (env.OPENROUTER_API_KEY) {
    return {
      via: 'openrouter',
      aliases: {
        'rp:best': {
          provider: 'openrouter',
          model: 'anthropic/claude-sonnet-4-6',
        },
        'rp:fast': {
          provider: 'openrouter',
          model: 'anthropic/claude-3-5-haiku',
        },
        'rp:cheap': {
          provider: 'openrouter',
          model: 'google/gemini-2.5-flash-lite',
        },
        'rp:balanced': {
          provider: 'openrouter',
          model: 'anthropic/claude-3-5-haiku',
        },
      },
    };
  }
  if (env.ANTHROPIC_API_KEY) {
    return {
      via: 'anthropic',
      aliases: {
        'rp:best': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        'rp:fast': { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
        'rp:cheap': { provider: 'anthropic', model: 'claude-3-5-haiku-latest' },
        'rp:balanced': {
          provider: 'anthropic',
          model: 'claude-3-5-haiku-latest',
        },
      },
    };
  }
  if (env.OPENAI_API_KEY) {
    return {
      via: 'openai',
      aliases: {
        'rp:best': { provider: 'openai', model: 'gpt-4o' },
        'rp:fast': { provider: 'openai', model: 'gpt-4o-mini' },
        'rp:cheap': { provider: 'openai', model: 'gpt-4o-mini' },
        'rp:balanced': { provider: 'openai', model: 'gpt-4o-mini' },
      },
    };
  }
  return {
    via: 'anthropic (passthrough)',
    aliases: { ...DEFAULT_SMART_ALIASES },
  };
}

const VALID_SLASH_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'google',
  'xai',
  'openrouter',
  'deepseek',
  'groq',
  'local',
  'ollama',
]);

/** Options for {@link resolveModel}. */
export interface ResolveModelOptions {
  defaultProvider?: string;
  smartAliases?: Record<string, ResolvedModel>;
  /** config models.overrides: alias -> replacement model name. */
  overrides?: Record<string, string>;
  warn?: (message: string) => void;
}

/**
 * Normalize the `aipp:`/`rp:`/`relayplane:` prefixes to a canonical `rp:*` key,
 * warning when a deprecated prefix is used. Then apply RELAYPLANE_ALIASES.
 */
export function normalizeAlias(
  modelName: string,
  warn?: (message: string) => void,
): string {
  let key = modelName;
  if (key.startsWith('aipp:')) {
    key = `rp:${key.slice('aipp:'.length)}`;
  } else if (key.startsWith('relayplane:')) {
    warn?.(
      `Model prefix "relayplane:" is deprecated; use "aipp:" (in "${modelName}").`,
    );
    key = `rp:${key.slice('relayplane:'.length)}`;
  } else if (key.startsWith('rp:')) {
    warn?.(
      `Model prefix "rp:" is deprecated; use "aipp:" (in "${modelName}").`,
    );
  }
  return RELAYPLANE_ALIASES[key] ?? key;
}

/**
 * Resolve a model name to a provider + native model, or null if unresolvable.
 * Migrates the legacy resolution order exactly: overrides -> alias normalization
 * -> smart aliases -> MODEL_MAPPING -> prefix rules -> provider/model slash.
 */
export function resolveModel(
  modelName: string,
  options: ResolveModelOptions = {},
): ResolvedModel | null {
  if (options.defaultProvider) {
    return { provider: options.defaultProvider, model: modelName };
  }

  const overridden = options.overrides?.[modelName];
  const name = overridden ?? modelName;

  const smart = options.smartAliases ?? DEFAULT_SMART_ALIASES;
  const alias = normalizeAlias(name, options.warn);

  if (smart[alias]) {
    return smart[alias];
  }
  if (MODEL_MAPPING[alias]) {
    return MODEL_MAPPING[alias];
  }
  if (alias !== name && MODEL_MAPPING[name]) {
    return MODEL_MAPPING[name];
  }

  if (name.startsWith('claude-')) {
    return { provider: 'anthropic', model: name };
  }
  if (
    name.startsWith('gpt-') ||
    name.startsWith('o1-') ||
    name.startsWith('o3-') ||
    name.startsWith('chatgpt-') ||
    name.startsWith('text-') ||
    name.startsWith('dall-e') ||
    name.startsWith('whisper') ||
    name.startsWith('tts-')
  ) {
    return { provider: 'openai', model: name };
  }
  if (name.startsWith('gemini-') || name.startsWith('palm-')) {
    return { provider: 'google', model: name };
  }
  if (name.startsWith('grok-')) {
    return { provider: 'xai', model: name };
  }
  if (name.startsWith('openrouter/')) {
    return { provider: 'openrouter', model: name.slice('openrouter/'.length) };
  }
  if (name.startsWith('deepseek-') || name.startsWith('groq-')) {
    return { provider: 'openrouter', model: name };
  }
  if (name.startsWith('ollama/')) {
    return { provider: 'ollama', model: name.slice('ollama/'.length) };
  }
  if (name.includes('/')) {
    const [provider, model] = name.split('/');
    if (provider && model && VALID_SLASH_PROVIDERS.has(provider)) {
      return { provider, model };
    }
  }
  return null;
}
