/**
 * Agent-aware routing policy (epic AIPP-10, subtask 10.5; FR-ROUTE-007/015/016).
 *
 * A YAML policy at `<home>/policy.yaml` maps agents and task types to preferred
 * models. Resolution (ported from the legacy agent-policy engine) has a fixed
 * priority -- agent-task override, then global task rule, then agent rule, then
 * pass-through -- with a complexity-based escalation hook. Enforcement is gated
 * behind `routing.policy.enforce` (default off), and the same pure resolver
 * powers the offline replay/simulation tool against routing-log v2.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { configHome } from '../config/index.js';
import type { Complexity } from './complexity.js';

/** A per-task routing rule. */
export interface TaskPolicy {
  preferred: string;
  neverDowngrade?: boolean;
  escalateTo?: string;
  escalateOn?: Array<'complexity_high' | 'rate_limit' | 'error'>;
}

/** A per-agent routing rule (optionally with per-task overrides). */
export interface AgentPolicy {
  fingerprint?: string;
  preferred: string;
  escalateTo?: string;
  escalateOn?: Array<'complexity_high' | 'rate_limit' | 'error'>;
  fallback?: string;
  neverDowngrade?: boolean;
  budgetPerDay?: number;
  tasks?: Record<string, TaskPolicy>;
}

/** The full routing policy document. */
export interface RoutingPolicy {
  version: number;
  agents?: Record<string, AgentPolicy>;
  tasks?: Record<string, TaskPolicy>;
}

/** Which rule produced a resolution. */
export type ResolvedBy =
  | 'agent_task_override'
  | 'task_rule'
  | 'agent_rule'
  | 'complexity_routing'
  | 'default_routing'
  | 'passthrough';

/** The outcome of {@link resolvePolicy}. */
export interface PolicyResolution {
  model: string;
  resolvedBy: ResolvedBy;
  neverDowngrade: boolean;
  reason: string;
  candidateModel?: string;
}

/** The policy file version this engine understands. */
export const POLICY_VERSION = 1 as const;

/** Absolute path to the policy file (`<home>/policy.yaml`). */
export function policyFilePath(): string {
  return join(configHome(), 'policy.yaml');
}

/**
 * Load and version-check the policy file. Returns null when the file is missing,
 * unparseable, or a version this engine does not understand -- enforcement then
 * simply does nothing rather than failing the request path.
 */
export function loadPolicyFile(
  path: string = policyFilePath(),
): RoutingPolicy | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = yamlLoad(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const policy = parsed as RoutingPolicy;
    if (policy.version !== POLICY_VERSION) {
      return null;
    }
    return policy;
  } catch {
    return null;
  }
}

function resolveEscalation(
  rule: TaskPolicy,
  complexity: Complexity,
): string | null {
  if (
    rule.escalateTo &&
    rule.escalateOn?.includes('complexity_high') &&
    complexity === 'complex'
  ) {
    return rule.escalateTo;
  }
  return null;
}

function resolveAgentEscalation(
  agent: AgentPolicy,
  complexity: Complexity,
): string | null {
  if (
    agent.escalateTo &&
    agent.escalateOn?.includes('complexity_high') &&
    complexity === 'complex'
  ) {
    return agent.escalateTo;
  }
  return null;
}

/**
 * Resolve which model a request should use under the policy. Priority:
 * 1. agent.tasks[taskType] override, 2. global tasks[taskType] rule,
 * 3. agent-level rule, 4. pass-through (returns `candidateModel`).
 */
export function resolvePolicy(
  policy: RoutingPolicy,
  agentFingerprint: string | undefined,
  agentName: string | undefined,
  taskType: string,
  complexity: Complexity,
  candidateModel: string,
): PolicyResolution {
  const emptyPolicy = !policy.agents && !policy.tasks;

  let matchedName: string | null = null;
  let matched: AgentPolicy | null = null;
  if (policy.agents) {
    for (const [name, agent] of Object.entries(policy.agents)) {
      if (
        agent.fingerprint &&
        agentFingerprint &&
        agent.fingerprint === agentFingerprint
      ) {
        matchedName = name;
        matched = agent;
        break;
      }
    }
    if (!matched && agentName && policy.agents[agentName]) {
      matchedName = agentName;
      matched = policy.agents[agentName];
    }
  }

  // 1. Agent-task override.
  const agentTask = matched?.tasks?.[taskType];
  if (agentTask) {
    const model =
      resolveEscalation(agentTask, complexity) ?? agentTask.preferred;
    return {
      model,
      resolvedBy: 'agent_task_override',
      neverDowngrade: agentTask.neverDowngrade === true,
      reason: `Agent "${matchedName}" task override for "${taskType}": ${model}`,
      candidateModel,
    };
  }

  // 2. Global task rule.
  const taskRule = policy.tasks?.[taskType];
  if (taskRule) {
    const model = resolveEscalation(taskRule, complexity) ?? taskRule.preferred;
    return {
      model,
      resolvedBy: 'task_rule',
      neverDowngrade: taskRule.neverDowngrade === true,
      reason: `Task rule for "${taskType}": ${model}`,
      candidateModel,
    };
  }

  // 3. Agent-level rule.
  if (matched) {
    const model =
      resolveAgentEscalation(matched, complexity) ?? matched.preferred;
    return {
      model,
      resolvedBy: 'agent_rule',
      neverDowngrade: matched.neverDowngrade === true,
      reason: `Agent rule for "${matchedName}": ${model}`,
      candidateModel,
    };
  }

  // 4. Pass-through.
  return {
    model: candidateModel,
    resolvedBy: emptyPolicy ? 'default_routing' : 'complexity_routing',
    neverDowngrade: false,
    reason: 'No policy rule matched; using the routed model',
    candidateModel,
  };
}

/** One record replayed by the simulation tool. */
export interface ReplayRecord {
  agentName?: string;
  agentFingerprint?: string;
  taskType: string;
  complexity: Complexity;
  candidateModel: string;
}

/** A single would-be routing change from a replay. */
export interface ReplayChange {
  from: string;
  to: string;
  resolvedBy: ResolvedBy;
  reason: string;
}

/** The summary of a policy replay over historical records. */
export interface ReplaySummary {
  total: number;
  changed: number;
  unchanged: number;
  changes: ReplayChange[];
}

/**
 * Replay a candidate policy over historical records and report which routing
 * decisions it would have changed. Pure and side-effect free (FR-ROUTE-016).
 */
export function replayPolicy(
  records: ReplayRecord[],
  policy: RoutingPolicy,
): ReplaySummary {
  const changes: ReplayChange[] = [];
  for (const record of records) {
    const resolution = resolvePolicy(
      policy,
      record.agentFingerprint,
      record.agentName,
      record.taskType,
      record.complexity,
      record.candidateModel,
    );
    if (resolution.model !== record.candidateModel) {
      changes.push({
        from: record.candidateModel,
        to: resolution.model,
        resolvedBy: resolution.resolvedBy,
        reason: resolution.reason,
      });
    }
  }
  return {
    total: records.length,
    changed: changes.length,
    unchanged: records.length - changes.length,
    changes,
  };
}
