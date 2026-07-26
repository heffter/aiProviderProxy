/**
 * End-to-end Codex smoke test (epic AIPP-7, subtask 7.6; FR-RESP-015/016).
 *
 * Boots the real gateway on an ephemeral socket and drives a representative
 * Codex workflow through `POST /v1/responses` against a mock OpenAI upstream:
 * a first turn that returns a function call, a second turn that carries the
 * function-call output and returns the final answer. This exercises the whole
 * Responses pipeline (parse -> route -> native passthrough -> emit) over real
 * HTTP, the same shape Codex uses with `wire_api = "responses"`.
 *
 * It requires no credentials: the OpenAI upstream is a mock transport. The
 * manual checklist for a run against real Codex + a real OpenAI key lives in
 * docs/integrations/codex.md.
 */

import { describe, it, expect } from 'vitest';
import { createGateway } from '../../src/gateway/server.js';
import { buildProviderRegistry } from '../../src/gateway/providers.js';
import { defaultConfig } from '../../src/config/index.js';
import { EventSinkRegistry } from '../../src/lifecycle/index.js';
import type { CanonicalUsageEvent } from '../../src/lifecycle/usage-event.js';
import type { Transport, TransportRequest } from '../../src/providers/types.js';

const env = { OPENAI_API_KEY: 'sk-openai-smoke' } as NodeJS.ProcessEnv;

/** A mock OpenAI /responses upstream scripted to a two-turn tool workflow. */
function scriptedUpstream(seen: TransportRequest[]): Transport {
  return async (req) => {
    seen.push(req);
    const body = JSON.parse(req.body ?? '{}') as {
      input: Array<{ type?: string }>;
    };
    const hasToolOutput = body.input.some(
      (item) => item.type === 'function_call_output',
    );
    if (!hasToolOutput) {
      // Turn 1: ask to call the editor tool.
      return {
        status: 200,
        headers: { 'x-request-id': 'req_codex_1' },
        body: JSON.stringify({
          id: 'resp_1',
          object: 'response',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              id: 'fc_1',
              status: 'completed',
              call_id: 'call_edit_1',
              name: 'apply_patch',
              arguments: '{"path":"README.md","patch":"+hello"}',
            },
          ],
          usage: { input_tokens: 30, output_tokens: 12 },
        }),
      };
    }
    // Turn 2: after the tool output, return the final answer.
    return {
      status: 200,
      headers: { 'x-request-id': 'req_codex_2' },
      body: JSON.stringify({
        id: 'resp_2',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'msg_1',
            status: 'completed',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Patched README.md.',
                annotations: [],
              },
            ],
          },
        ],
        usage: { input_tokens: 48, output_tokens: 8 },
      }),
    };
  };
}

describe('Codex end-to-end smoke (real socket, mock OpenAI upstream)', () => {
  it('completes a two-turn tool-call workflow via /v1/responses', async () => {
    const seen: TransportRequest[] = [];
    const events: CanonicalUsageEvent[] = [];
    const sinks = new EventSinkRegistry();
    sinks.register({
      name: 'capture',
      onLogicalRequestFinal: (e) => {
        events.push(e);
      },
    });
    const gateway = createGateway({
      config: {
        ...defaultConfig(),
        server: { ...defaultConfig().server, port: 0 },
      },
      registry: buildProviderRegistry({ env }),
      transport: scriptedUpstream(seen),
      sinks,
    });
    const { host, port } = await gateway.listen();
    const url = `http://${host}:${port}/v1/responses`;
    const tools = [
      {
        type: 'function',
        name: 'apply_patch',
        description: 'Apply a patch to a file',
        parameters: { type: 'object' },
      },
    ];

    try {
      // Health check first (Codex users verify the gateway is up).
      const health = await fetch(`http://${host}:${port}/health`);
      expect(health.status).toBe(200);

      // Turn 1: initial instruction; expect a function call back.
      const first = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5-codex',
          instructions: 'You are a coding agent.',
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: 'Add a hello line to README' },
              ],
            },
          ],
          tools,
        }),
      });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as {
        output: Array<{
          type: string;
          call_id?: string;
          name?: string;
          arguments?: string;
        }>;
      };
      const call = firstBody.output.find((o) => o.type === 'function_call');
      expect(call).toMatchObject({
        name: 'apply_patch',
        call_id: 'call_edit_1',
      });

      // Turn 2: send the function-call output; expect the final message.
      const second = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5-codex',
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: 'Add a hello line to README' },
              ],
            },
            {
              type: 'function_call',
              call_id: call?.call_id,
              name: call?.name,
              arguments: call?.arguments,
            },
            {
              type: 'function_call_output',
              call_id: call?.call_id,
              output: 'patched',
            },
          ],
          tools,
        }),
      });
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as {
        status: string;
        output: Array<{
          type: string;
          content?: Array<{ type: string; text?: string }>;
        }>;
      };
      expect(secondBody.status).toBe('completed');
      expect(secondBody.output[0].type).toBe('message');
      // Native passthrough forwards the upstream body verbatim; read the message.
      expect(secondBody.output[0].content?.[0].text).toBe('Patched README.md.');
    } finally {
      gateway.close();
    }

    // Both turns hit the native OpenAI /responses endpoint.
    expect(seen.map((r) => r.url)).toEqual([
      'https://api.openai.com/v1/responses',
      'https://api.openai.com/v1/responses',
    ]);
    // Content-free usage events reached the sink for both turns.
    await sinks.drain();
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.eventId)).toEqual([
      'req_codex_1',
      'req_codex_2',
    ]);
    expect(events[0]).toMatchObject({ provider: 'openai', success: true });
  });
});
