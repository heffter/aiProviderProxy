/**
 * Prompt complexity classifier (epic AIPP-10, subtask 10.1; FR-ROUTE-002).
 *
 * A faithful port of the legacy heuristic (standalone-proxy.ts:1429-1481) onto
 * canonical messages. Scoring is deliberately last-user-message-scoped for the
 * keyword signals -- system prompts (AGENTS.md, SOUL.md) are huge for agent
 * workloads and would otherwise force every request to "complex" -- while the
 * whole-conversation token/message floor still captures the large-context case
 * where the last user turn is tiny but the real work lives in a 100K+ context.
 *
 * The classifier is pure and content-only: it takes already-extracted message
 * text so no protocol-specific parsing leaks in, and it never emits the text
 * anywhere (it returns a label and a score, not the prompt).
 */

/** Complexity band a request is classified into. */
export type Complexity = 'simple' | 'moderate' | 'complex';

/** A message reduced to the fields the classifier scores. */
export interface ClassifierMessage {
  role: string;
  /** Concatenated text content of the message (non-text parts dropped). */
  text: string;
}

/** Result of {@link classifyComplexity}: the band plus the raw signals. */
export interface ComplexityResult {
  complexity: Complexity;
  score: number;
  /** Estimated tokens of the last user message (the keyword-scored text). */
  lastUserTokens: number;
  /** Estimated tokens across every message. */
  totalTokens: number;
}

/** Rough token estimate: ~4 characters per token (legacy convention). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Classify the complexity of a request from its messages.
 *
 * Keyword signals are scored against the last `user` message only (falling back
 * to the whole set when there is no user message); the context-size and
 * message-count floors are computed across all messages. Thresholds: score >= 4
 * is `complex`, >= 2 is `moderate`, else `simple`.
 */
export function classifyComplexity(
  messages: ClassifierMessage[],
): ComplexityResult {
  const userMessages = messages.filter((m) => m.role === 'user');
  const scored =
    userMessages.length > 0
      ? [userMessages[userMessages.length - 1]]
      : messages;
  const text = scored
    .map((m) => m.text)
    .join(' ')
    .toLowerCase();
  const lastUserTokens = estimateTokens(text);

  let score = 0;

  // Code indicators.
  if (/```/.test(text) || /function |class |const |let |import /.test(text)) {
    score += 2;
  }
  // Analytical tasks.
  if (/analyze|compare|evaluate|assess|review|audit/.test(text)) {
    score += 2;
  }
  // Math / logic.
  if (/calculate|compute|solve|equation|prove|derive/.test(text)) {
    score += 2;
  }
  // Multi-step reasoning.
  if (/first.*then|step \d|1\).*2\)|phase \d/.test(text)) {
    score += 2;
  }
  // Architecture / design (inherently complex).
  if (
    /architect|infrastructure|distributed|microservice|system design|scalab/i.test(
      text,
    )
  ) {
    score += 3;
  }
  // Creative / generative with substance.
  if (
    /write a (story|essay|article|report)|create a|design a|build a/.test(text)
  ) {
    score += 2;
  }
  // Implementation requests.
  if (/implement|refactor|debug|optimize|migrate/.test(text)) {
    score += 2;
  }
  // Planning / strategy.
  if (
    /strategy|roadmap|plan for|how (would|should|can) (we|i|you)/.test(text)
  ) {
    score += 1;
  }
  // Token-based scaling of the scored text (cumulative).
  if (lastUserTokens > 500) score += 1;
  if (lastUserTokens > 2000) score += 2;
  if (lastUserTokens > 5000) score += 2;
  // Multiple concepts / requirements.
  const andCount = (text.match(/\band\b/g) || []).length;
  if (andCount >= 3) score += 1;
  if (andCount >= 5) score += 1;

  // Whole-conversation context-size floor: a hard signal regardless of the
  // last-message keyword score (agent workloads carry the complexity in context).
  const totalTokens = estimateTokens(messages.map((m) => m.text).join(' '));
  if (totalTokens > 100000) score += 5;
  else if (totalTokens > 50000) score += 3;
  else if (totalTokens > 20000) score += 2;
  // Message-count signal: long conversations imply multi-step reasoning.
  if (messages.length > 50) score += 2;
  else if (messages.length > 20) score += 1;

  const complexity: Complexity =
    score >= 4 ? 'complex' : score >= 2 ? 'moderate' : 'simple';
  return { complexity, score, lastUserTokens, totalTokens };
}

/**
 * Reduce arbitrary message content (a string, or an array of content parts) to
 * the plain text the classifier scores. Non-text parts (images, tool blocks)
 * contribute nothing. Handlers use this to build {@link ClassifierMessage}s from
 * their surface-specific request shapes.
 */
export function messageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        const p = part as { type?: string; text?: string };
        return p && p.type === 'text' ? (p.text ?? '') : '';
      })
      .filter((s) => s.length > 0)
      .join(' ');
  }
  return '';
}

/**
 * Normalize a list of `{ role, content }` messages into
 * {@link ClassifierMessage}s using {@link messageText}.
 */
export function normalizeMessages(
  messages: Array<{ role?: string; content?: unknown }>,
): ClassifierMessage[] {
  return messages.map((m) => ({
    role: m.role ?? '',
    text: messageText(m.content),
  }));
}
