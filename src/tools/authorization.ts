/**
 * Tool authorization (epic AIPP-6, subtask 6.6; FR-TOOLS-008).
 *
 * Deny-by-default tool routing with named scope packs, ported from the legacy
 * ToolRouter (src/tool-router.ts) but reshaped into a pure, injectable core with
 * no singletons, filesystem access, or rate-limit/schema machinery -- those are
 * separate concerns. This module owns only the authorization decision so it can
 * be shared by the Anthropic Messages surface (this epic) and the OpenAI and
 * passthrough surfaces (AIPP-7, AIPP-8).
 *
 * Authorization order (highest priority last wins):
 *   1. deny all (default when enabled)
 *   2. active packs (resolved from the X-Task-Type / X-Agent-Id headers)
 *   3. agent-level tool overrides
 *   4. explicit deny list (always wins)
 */

/** Effective per-tool policy after resolution. */
export type ToolPolicy = 'allow' | 'deny';

/** A single tool entry within a pack. `inherit` defers to the pack default. */
export interface ToolEntry {
  name: string;
  policy: 'allow' | 'deny' | 'inherit';
  requiresConfirmation?: boolean;
}

/** A named tool pack: an allow/deny set with a default for unlisted tools. */
export interface ToolPack {
  name: string;
  description: string;
  tools: ToolEntry[];
  /** Policy applied to tools not listed in this pack. */
  defaultPolicy: ToolPolicy;
  version: string;
  /** True for the built-in packs. */
  builtIn?: boolean;
}

/** Per-agent pack additions/removals and explicit tool overrides. */
export interface AgentAuthConfig {
  allowPacks: string[];
  denyPacks: string[];
  toolOverrides: Record<string, ToolPolicy>;
}

/** The resolved authorization context for a single request. */
export interface ToolAuthContext {
  sessionId: string;
  agentId?: string;
  taskType?: string;
  activePacks: string[];
  denyList: string[];
  requestedTools: string[];
}

/** The outcome of evaluating requested tools against the active policy. */
export interface ToolAuthResult {
  /** Tools allowed by the active packs / overrides. */
  allowed: string[];
  /** Tools denied (not in any active pack, or explicitly denied). */
  denied: string[];
  /** Sanitized comma-separated denied list, safe for an HTTP response header. */
  deniedHeader: string;
  /** Allowed tools that require user confirmation before being called. */
  requireConfirmation: string[];
}

/** Construction config for {@link ToolAuthorizer}. */
export interface ToolAuthorizerConfig {
  enabled: boolean;
  /** Custom packs; overlay (and may override) the built-ins by name. */
  packs?: ToolPack[];
  /** Agent auth configs keyed by agent id. */
  agents?: Record<string, AgentAuthConfig>;
  /** Global explicit deny list; always wins. */
  denyList?: string[];
}

/**
 * The three built-in packs. Names double as X-Task-Type values.
 * (Ported verbatim from the legacy ToolRouter built-ins.)
 */
export const BUILTIN_PACKS: readonly ToolPack[] = [
  {
    name: 'code',
    description:
      'Coding tools: editor, shell, and file I/O for code-generation agents',
    version: '1.0.0',
    defaultPolicy: 'deny',
    builtIn: true,
    tools: [
      { name: 'str_replace_editor', policy: 'allow' },
      { name: 'bash', policy: 'allow' },
      { name: 'read_file', policy: 'allow' },
      { name: 'write_file', policy: 'allow' },
      { name: 'list_directory', policy: 'allow' },
    ],
  },
  {
    name: 'search',
    description: 'Web retrieval tools',
    version: '1.0.0',
    defaultPolicy: 'deny',
    builtIn: true,
    tools: [
      { name: 'web_search', policy: 'allow' },
      { name: 'web_fetch', policy: 'allow' },
    ],
  },
  {
    name: 'file-ops',
    description: 'File system tools: read/write/list allowed, delete denied',
    version: '1.0.0',
    defaultPolicy: 'deny',
    builtIn: true,
    tools: [
      { name: 'read_file', policy: 'allow' },
      { name: 'write_file', policy: 'allow' },
      { name: 'list_directory', policy: 'allow' },
      { name: 'delete_file', policy: 'deny' },
    ],
  },
];

/** Strip anything outside printable ASCII to keep tool names header-safe. */
function sanitizeForHeader(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, '');
}

/**
 * Deny-by-default tool authorizer. Pure and injectable: all packs and agent
 * config are supplied at construction; there is no global state.
 */
export class ToolAuthorizer {
  private readonly enabled: boolean;
  private readonly packs: Map<string, ToolPack> = new Map();
  private readonly agents: Record<string, AgentAuthConfig>;
  private readonly denyList: readonly string[];

  constructor(config: ToolAuthorizerConfig) {
    this.enabled = config.enabled;
    this.agents = config.agents ?? {};
    this.denyList = config.denyList ?? [];
    for (const pack of BUILTIN_PACKS) {
      this.packs.set(pack.name, pack);
    }
    // Custom packs overlay built-ins by name; they are never marked built-in.
    for (const pack of config.packs ?? []) {
      this.packs.set(pack.name, { ...pack, builtIn: false });
    }
  }

  /** True when enforcement is active; when false, all tools are allowed. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** List every known pack (built-in + custom). */
  listPacks(): ToolPack[] {
    return [...this.packs.values()];
  }

  /**
   * Determine which packs are active for a request.
   *
   * X-Task-Type: a built-in/custom pack name, or `custom:{name}`; undefined
   * activates no packs (deny all). Agent config may add or remove packs.
   */
  resolveActivePacks(taskType?: string, agentId?: string): string[] {
    const active: string[] = [];
    if (taskType) {
      const name = taskType.startsWith('custom:')
        ? taskType.slice('custom:'.length).trim()
        : taskType;
      if (name && this.packs.has(name)) {
        active.push(name);
      }
    }
    const agentCfg = agentId ? this.agents[agentId] : undefined;
    if (agentCfg) {
      for (const p of agentCfg.allowPacks) {
        if (this.packs.has(p) && !active.includes(p)) {
          active.push(p);
        }
      }
      for (const p of agentCfg.denyPacks) {
        const idx = active.indexOf(p);
        if (idx !== -1) {
          active.splice(idx, 1);
        }
      }
    }
    return active;
  }

  /** Evaluate the requested tools against the active policy. */
  checkTools(ctx: ToolAuthContext): ToolAuthResult {
    if (!this.enabled) {
      return {
        allowed: [...ctx.requestedTools],
        denied: [],
        deniedHeader: '',
        requireConfirmation: [],
      };
    }
    const policies = this.resolveEffectivePolicies(
      ctx.activePacks,
      ctx.agentId,
      ctx.denyList,
    );
    const allowed: string[] = [];
    const denied: string[] = [];
    const requireConfirmation: string[] = [];
    for (const tool of ctx.requestedTools) {
      if ((policies.get(tool) ?? 'deny') === 'allow') {
        allowed.push(tool);
        if (this.findToolEntry(tool, ctx.activePacks)?.requiresConfirmation) {
          requireConfirmation.push(tool);
        }
      } else {
        denied.push(tool);
      }
    }
    return {
      allowed,
      denied,
      deniedHeader: denied.map(sanitizeForHeader).join(', '),
      requireConfirmation,
    };
  }

  /** Resolve the effective policy for every tool named by the active packs. */
  private resolveEffectivePolicies(
    activePacks: string[],
    agentId: string | undefined,
    denyList: string[],
  ): Map<string, ToolPolicy> {
    const policies = new Map<string, ToolPolicy>();
    // Active packs, in order; the first pack to name a tool wins.
    for (const packName of activePacks) {
      const pack = this.packs.get(packName);
      if (!pack) continue;
      for (const entry of pack.tools) {
        const resolved =
          entry.policy === 'inherit' ? pack.defaultPolicy : entry.policy;
        if (!policies.has(entry.name)) {
          policies.set(entry.name, resolved);
        }
      }
    }
    // Agent-level overrides.
    const agentCfg = agentId ? this.agents[agentId] : undefined;
    if (agentCfg) {
      for (const [tool, policy] of Object.entries(agentCfg.toolOverrides)) {
        policies.set(tool, policy);
      }
    }
    // Explicit deny lists (global + per-request) always win.
    for (const tool of [...this.denyList, ...denyList]) {
      policies.set(tool, 'deny');
    }
    return policies;
  }

  private findToolEntry(
    toolName: string,
    activePacks: string[],
  ): ToolEntry | undefined {
    for (const packName of activePacks) {
      const entry = this.packs
        .get(packName)
        ?.tools.find((t) => t.name === toolName);
      if (entry) return entry;
    }
    return undefined;
  }
}

/** A single header value, taking the first if multiple were sent. */
function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

/**
 * Build a {@link ToolAuthContext} from request headers (X-Task-Type,
 * X-Agent-Id), the session id, and the requested tool names.
 */
export function extractToolContext(
  headers: Record<string, string | string[] | undefined>,
  sessionId: string,
  requestedTools: string[],
  authorizer: ToolAuthorizer,
): ToolAuthContext {
  const taskType = headerValue(headers, 'x-task-type');
  const agentId = headerValue(headers, 'x-agent-id');
  return {
    sessionId,
    agentId,
    taskType,
    activePacks: authorizer.resolveActivePacks(taskType, agentId),
    denyList: [],
    requestedTools,
  };
}

/** What the caller should do with a request after authorization. */
export type ToolEnforcementAction = 'allow' | 'strip' | 'reject';

/** A tool-authorization enforcement decision for one request. */
export interface ToolEnforcementDecision {
  /** `allow`: forward unchanged; `strip`: drop denied tools; `reject`: 403. */
  action: ToolEnforcementAction;
  result: ToolAuthResult;
}

/**
 * The shared enforcement decision used by every protocol surface: evaluate the
 * requested tools and classify the outcome. `reject` when every requested tool
 * is denied, `strip` when some are, `allow` when none are.
 */
export function decideToolEnforcement(
  authorizer: ToolAuthorizer,
  headers: Record<string, string | string[] | undefined>,
  sessionId: string,
  requestedTools: string[],
): ToolEnforcementDecision {
  const ctx = extractToolContext(
    headers,
    sessionId,
    requestedTools,
    authorizer,
  );
  const result = authorizer.checkTools(ctx);
  if (result.denied.length === 0) {
    return { action: 'allow', result };
  }
  if (result.allowed.length === 0) {
    return { action: 'reject', result };
  }
  return { action: 'strip', result };
}
