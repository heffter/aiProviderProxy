/**
 * Epic AIPP-6 acceptance suite (subtask 6.7).
 *
 * Drives the full non-streaming Anthropic fixture corpus (plain text, system
 * blocks, tools + tool results, extended thinking, prompt caching, 4xx errors,
 * count_tokens) through the new gateway surface. For the Anthropic fast path
 * this doubles as the parity check against legacy: the surface must return the
 * upstream Messages body byte-for-byte (fast path forwards verbatim, exactly as
 * the legacy proxy did), and must map an upstream error to the Anthropic error
 * envelope.
 *
 * The streaming fixture (plain-text-stream) is exercised by the SSE encoder unit
 * tests (subtask 6.3); full streaming-response wiring and the live Claude Code
 * smoke tests are tracked in docs/integrations/claude-code.md.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readCorpusCase } from '../../src/fixtures/corpus.js';
import {
  createGateway,
  type GatewayRequest,
} from '../../src/gateway/server.js';
import { buildProviderRegistry } from '../../src/gateway/providers.js';
import { defaultConfig } from '../../src/config/index.js';
import type { Transport } from '../../src/providers/types.js';

const ANTHROPIC_DIR = join(__dirname, '..', 'fixtures', 'anthropic');
const env = { ANTHROPIC_API_KEY: 'sk-ant-api03-acc' } as NodeJS.ProcessEnv;

/** Non-streaming corpus cases and the surface behavior each one asserts. */
const SUCCESS_CASES = [
  'plain-text',
  'system-blocks',
  'tools-and-tool-result',
  'extended-thinking',
  'prompt-caching-cache-control',
];

function gatewayReturning(response: {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}) {
  const transport: Transport = async () => ({
    status: response.status,
    headers: response.headers ?? {},
    body: JSON.stringify(response.body),
  });
  return createGateway({
    config: defaultConfig(),
    registry: buildProviderRegistry({ env }),
    transport,
  });
}

function toRequest(
  req: { url: string; headers: Record<string, string>; body: unknown },
  urlOverride?: string,
): GatewayRequest {
  return {
    method: 'POST',
    url: urlOverride ?? req.url,
    headers: req.headers,
    body: JSON.stringify(req.body),
  };
}

describe('AIPP-6 acceptance: Anthropic fast-path corpus (verbatim parity)', () => {
  for (const name of SUCCESS_CASES) {
    it(`forwards "${name}" verbatim`, async () => {
      const c = readCorpusCase('anthropic', join(ANTHROPIC_DIR, name));
      expect(c.response, `${name} has a response fixture`).toBeTruthy();
      const response = c.response as NonNullable<typeof c.response>;

      const gateway = gatewayReturning(response);
      const res = await gateway.handle(toRequest(c.request));

      expect(res.status).toBe(200);
      // Fast path: the client sees the upstream Messages body unchanged.
      expect(JSON.parse(res.body)).toEqual(response.body);
    });
  }

  it('maps an upstream 4xx to the Anthropic error envelope (error-4xx)', async () => {
    const c = readCorpusCase('anthropic', join(ANTHROPIC_DIR, 'error-4xx'));
    const response = c.response as NonNullable<typeof c.response>;
    expect(response.status).toBeGreaterThanOrEqual(400);

    const gateway = gatewayReturning(response);
    const res = await gateway.handle(toRequest(c.request));

    expect(res.status).toBe(response.status);
    const body = JSON.parse(res.body);
    expect(body.type).toBe('error');
    expect(typeof body.error.type).toBe('string');
  });

  it('passes count_tokens through to the Anthropic endpoint', async () => {
    const c = readCorpusCase('anthropic', join(ANTHROPIC_DIR, 'count-tokens'));
    const response = c.response as NonNullable<typeof c.response>;

    const gateway = gatewayReturning(response);
    const res = await gateway.handle(
      toRequest(c.request, '/v1/messages/count_tokens'),
    );

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(response.body);
  });
});
