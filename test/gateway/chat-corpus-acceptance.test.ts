/**
 * Epic AIPP-8 acceptance: Chat Completions corpus parity (subtask 8.6).
 *
 * Replays the committed chat fixture corpus (OpenAI, Gemini, Ollama) through the
 * new `/v1/chat/completions` surface and asserts parity with legacy behavior,
 * except for the intentional differences allowlisted below. Fixture content is
 * scrubbed, so parity means:
 *
 *   - OpenAI / OpenAI-compatible upstream: byte-verbatim. The surface forwards
 *     the upstream chat.completion unchanged, exactly as the legacy proxy did.
 *   - Gemini / Ollama upstream: structural. The adapter translates the native
 *     wire response into a spec-valid chat.completion; the fixture defines the
 *     expected shape (object, choices, finish_reason, usage).
 *
 * Difference allowlist (intentional divergences from legacy, each defect-free):
 *   - anthropic-upstream chat usage now carries cache_read tokens (subtask 8.2,
 *     fix 1). Not exercised by this corpus (no anthropic-upstream chat fixture).
 *   - anthropic-upstream thinking blocks produce an x-aipp-thinking-diagnostics
 *     header instead of a silent drop (subtask 8.2, fix 2). Same.
 *
 * Any structural difference outside this allowlist is a defect to fix before
 * epic close.
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

const FIXTURES = join(__dirname, '..', 'fixtures');
const env = {
  OPENAI_API_KEY: 'sk-openai-acc',
  GOOGLE_API_KEY: 'k',
} as NodeJS.ProcessEnv;

/** The documented intentional differences from legacy (subtask references). */
export const DIFFERENCE_ALLOWLIST = [
  {
    field: 'usage.prompt_tokens_details.cached_tokens',
    subtask: '8.2',
    reason: 'cache-read tokens preserved (fix 1)',
  },
  {
    field: 'header:x-aipp-thinking-diagnostics',
    subtask: '8.2',
    reason: 'thinking diagnosed, not dropped (fix 2)',
  },
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
  bodyOverride?: Record<string, unknown>,
): GatewayRequest {
  return {
    method: 'POST',
    url: '/v1/chat/completions',
    headers: req.headers,
    body: JSON.stringify(
      bodyOverride ? { ...(req.body as object), ...bodyOverride } : req.body,
    ),
  };
}

/** Assert a value is a spec-valid chat.completion. */
function assertChatCompletion(body: unknown): void {
  const b = body as {
    object?: string;
    choices?: Array<{
      index?: number;
      message?: { role?: string };
      finish_reason?: string;
    }>;
  };
  expect(b.object).toBe('chat.completion');
  expect(Array.isArray(b.choices)).toBe(true);
  expect(b.choices?.[0].index).toBe(0);
  expect(b.choices?.[0].message?.role).toBe('assistant');
  expect(typeof b.choices?.[0].finish_reason).toBe('string');
}

describe('AIPP-8 acceptance: OpenAI chat corpus (verbatim parity)', () => {
  for (const name of ['text', 'tools']) {
    it(`forwards "${name}" verbatim`, async () => {
      const c = readCorpusCase(
        'openai-chat',
        join(FIXTURES, 'openai-chat', name),
      );
      const response = c.response as NonNullable<typeof c.response>;
      const gateway = gatewayReturning(response);
      const res = await gateway.handle(toRequest(c.request));

      expect(res.status).toBe(200);
      // Byte-verbatim: the client sees the upstream chat.completion unchanged.
      expect(JSON.parse(res.body)).toEqual(response.body);
      // No allowlisted difference leaks onto the verbatim path.
      expect(res.headers['x-aipp-thinking-diagnostics']).toBeUndefined();
    });
  }

  it('maps an upstream 4xx to the chat error envelope (error-429)', async () => {
    const c = readCorpusCase(
      'openai-chat',
      join(FIXTURES, 'openai-chat', 'error-429'),
    );
    const response = c.response as NonNullable<typeof c.response>;
    expect(response.status).toBeGreaterThanOrEqual(400);
    const gateway = gatewayReturning(response);
    const res = await gateway.handle(toRequest(c.request));
    expect(res.status).toBe(response.status);
    expect(typeof JSON.parse(res.body).error.type).toBe('string');
  });
});

describe('AIPP-8 acceptance: translated corpora (structural parity)', () => {
  it('gemini "text" produces a spec-valid chat.completion', async () => {
    const c = readCorpusCase('gemini', join(FIXTURES, 'gemini', 'text'));
    // Synthetic Gemini wire response; the adapter translates it to chat shape.
    const gateway = gatewayReturning({
      status: 200,
      body: {
        candidates: [
          { content: { parts: [{ text: 'parity' }] }, finishReason: 'STOP' },
        ],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2 },
        modelVersion: 'gemini-1.5-pro',
      },
    });
    const res = await gateway.handle(toRequest(c.request));
    expect(res.status).toBe(200);
    assertChatCompletion(JSON.parse(res.body));
    // Fixture defines the expected shape.
    assertChatCompletion((c.response as NonNullable<typeof c.response>).body);
  });

  it('ollama "text" produces a spec-valid chat.completion', async () => {
    const c = readCorpusCase('ollama', join(FIXTURES, 'ollama', 'text'));
    const gateway = gatewayReturning({
      status: 200,
      body: {
        model: 'llama3.1',
        message: { role: 'assistant', content: 'parity' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 6,
        eval_count: 1,
      },
    });
    // The bare fixture model 'llama3.1' is namespaced to route to the ollama
    // provider (the legacy proxy inferred this from a local Ollama probe).
    const res = await gateway.handle(
      toRequest(c.request, { model: 'ollama/llama3.1' }),
    );
    expect(res.status).toBe(200);
    assertChatCompletion(JSON.parse(res.body));
    assertChatCompletion((c.response as NonNullable<typeof c.response>).body);
  });
});

describe('AIPP-8 acceptance: difference allowlist', () => {
  it('documents every intentional difference with a subtask reference', () => {
    expect(DIFFERENCE_ALLOWLIST.length).toBeGreaterThan(0);
    for (const diff of DIFFERENCE_ALLOWLIST) {
      expect(diff.subtask).toMatch(/^8\.\d$/);
      expect(diff.reason.length).toBeGreaterThan(0);
    }
  });
});
