/**
 * Anthropic auth header construction (epic AIPP-4, subtask 4.4;
 * port of standalone-proxy.ts:1519-1654).
 *
 * OAuth access tokens (`sk-ant-oat*`) use `Authorization: Bearer` plus the
 * `anthropic-beta: oauth-2025-04-20` header, and beta flags unsupported by OAT
 * are stripped. Standard API keys use `x-api-key`. Auth resolution priority is:
 * incoming client auth (passthrough) > configured/pooled key.
 */

const OAUTH_BETA = 'oauth-2025-04-20';

/** Beta flags OAT tokens do not support (stripped from anthropic-beta). */
export const OAT_UNSUPPORTED_BETA_FLAGS: ReadonlySet<string> = new Set([
  'max-tokens-3-5-sonnet-2025-04-14',
]);

/** True if `token` is an Anthropic OAuth access token. */
export function isOatToken(token: string): boolean {
  return token.startsWith('sk-ant-oat');
}

/** Set the correct auth header for `token` (OAT bearer + oauth beta, or x-api-key). */
export function setAnthropicAuth(
  headers: Record<string, string>,
  token: string,
): void {
  if (isOatToken(token)) {
    headers['authorization'] = `Bearer ${token}`;
    const existing = headers['anthropic-beta'];
    if (!existing) {
      headers['anthropic-beta'] = OAUTH_BETA;
    } else if (!existing.includes(OAUTH_BETA)) {
      headers['anthropic-beta'] = `${existing},${OAUTH_BETA}`;
    }
  } else {
    headers['x-api-key'] = token;
  }
}

/** Incoming request context relevant to Anthropic auth/headers. */
export interface AnthropicAuthContext {
  /** Incoming Authorization header value (may include "Bearer "). */
  authHeader?: string;
  /** Incoming x-api-key header value. */
  apiKeyHeader?: string;
  /** Incoming anthropic-beta header value. */
  betaHeaders?: string;
  /** Incoming anthropic-version header value. */
  versionHeader?: string;
  userAgent?: string;
  xApp?: string;
}

function stripOatUnsupportedBetas(
  headers: Record<string, string>,
  token: string,
): void {
  if (!headers['anthropic-beta'] || !isOatToken(token)) {
    return;
  }
  const cleaned = headers['anthropic-beta']
    .split(',')
    .map((b) => b.trim())
    .filter((b) => b.length > 0 && !OAT_UNSUPPORTED_BETA_FLAGS.has(b))
    .join(',');
  if (cleaned) {
    headers['anthropic-beta'] = cleaned;
  } else {
    delete headers['anthropic-beta'];
  }
}

/**
 * Build Anthropic request headers with hybrid auth. `fallbackKey` is the
 * configured/pooled key used when the client did not pass its own auth.
 */
export function buildAnthropicHeaders(
  ctx: AnthropicAuthContext,
  fallbackKey?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': ctx.versionHeader || '2023-06-01',
  };

  // Auth priority: incoming auth > x-api-key header > fallback (config/pool/env).
  let token = '';
  if (ctx.authHeader) {
    token = ctx.authHeader.replace(/^Bearer\s+/i, '');
    setAnthropicAuth(headers, token);
  } else if (ctx.apiKeyHeader) {
    token = ctx.apiKeyHeader;
    setAnthropicAuth(headers, token);
  } else if (fallbackKey) {
    token = fallbackKey;
    setAnthropicAuth(headers, token);
  }

  // Pass through client beta headers.
  if (ctx.betaHeaders) {
    const existing = headers['anthropic-beta'];
    if (!existing) {
      headers['anthropic-beta'] = ctx.betaHeaders;
    } else if (!existing.includes(ctx.betaHeaders)) {
      headers['anthropic-beta'] = `${existing},${ctx.betaHeaders}`;
    }
  }

  stripOatUnsupportedBetas(headers, token);

  if (ctx.userAgent) {
    headers['user-agent'] = ctx.userAgent;
  }
  if (ctx.xApp) {
    headers['x-app'] = ctx.xApp;
  }
  return headers;
}
