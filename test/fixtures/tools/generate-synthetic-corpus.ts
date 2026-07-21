/**
 * Synthetic fixture corpus generator (epic AIPP-1, subtask 1.3).
 *
 * Emits a LABELED SYNTHETIC corpus covering the coverage matrix so the parity
 * harness and CI gate have data to run against before real-traffic capture is
 * possible. These fixtures are hand-authored representative shapes, not recorded
 * from real providers -- see test/fixtures/SYNTHETIC.md. Every payload is run
 * through the real scrubber, so committed files contain no raw content.
 *
 * Regenerate (with a TypeScript-aware runtime, or compiled):
 *   node --import tsx test/fixtures/tools/generate-synthetic-corpus.ts
 */

import { join } from 'node:path';
import { writeCorpusCase } from '../../../src/fixtures/corpus.js';
import type { RawCapture } from '../../../src/fixtures/recorder.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

interface SyntheticCase {
  provider: string;
  name: string;
  capture: RawCapture;
}

function anthropicUnary(name: string, body: unknown, respBody: unknown, status = 200): SyntheticCase {
  return {
    provider: 'anthropic',
    name,
    capture: {
      route: '/v1/messages',
      provider: 'anthropic',
      request: { method: 'POST', url: '/v1/messages', headers: JSON_HEADERS, body },
      response: { status, headers: JSON_HEADERS, body: respBody },
      usage: (respBody as { usage?: unknown }).usage,
    },
  };
}

const CASES: SyntheticCase[] = [
  // --- anthropic /v1/messages ---
  anthropicUnary(
    'plain-text',
    { model: 'claude-sonnet-4-20250514', max_tokens: 1024, messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarize the rollout plan for the new service.' }] }] },
    { id: 'msg_01AAA', type: 'message', role: 'assistant', model: 'claude-sonnet-4-20250514', content: [{ type: 'text', text: 'Here is a concise summary of the rollout plan.' }], stop_reason: 'end_turn', usage: { input_tokens: 42, output_tokens: 18 } },
  ),
  anthropicUnary(
    'system-blocks',
    { model: 'claude-sonnet-4-20250514', max_tokens: 512, system: [{ type: 'text', text: 'You are a terse assistant.' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'Define idempotency.' }] }] },
    { id: 'msg_01BBB', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'An operation is idempotent when repeating it has no additional effect.' }], stop_reason: 'end_turn', usage: { input_tokens: 30, output_tokens: 22 } },
  ),
  anthropicUnary(
    'tools-and-tool-result',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      tools: [{ name: 'get_weather', description: 'Get current weather', input_schema: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'What is the weather in Paris?' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { location: 'Paris' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Sunny, 24C' }] },
      ],
    },
    { id: 'msg_01CCC', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'It is sunny and 24C in Paris.' }], stop_reason: 'end_turn', usage: { input_tokens: 88, output_tokens: 14 } },
  ),
  anthropicUnary(
    'extended-thinking',
    { model: 'claude-sonnet-4-20250514', max_tokens: 2048, thinking: { type: 'enabled', budget_tokens: 1024 }, messages: [{ role: 'user', content: [{ type: 'text', text: 'Prove sqrt(2) is irrational.' }] }] },
    { id: 'msg_01DDD', type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: 'Assume sqrt(2)=a/b in lowest terms...' }, { type: 'text', text: 'By contradiction, sqrt(2) is irrational.' }], stop_reason: 'end_turn', usage: { input_tokens: 25, output_tokens: 120 } },
  ),
  anthropicUnary(
    'prompt-caching-cache-control',
    { model: 'claude-sonnet-4-20250514', max_tokens: 512, system: [{ type: 'text', text: 'Large reusable context here.', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: [{ type: 'text', text: 'Continue.' }] }] },
    { id: 'msg_01EEE', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Continuing from cached context.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 8, cache_creation_input_tokens: 2048, cache_read_input_tokens: 0 } },
  ),
  anthropicUnary(
    'count-tokens',
    { model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: [{ type: 'text', text: 'How many tokens is this?' }] }] },
    { input_tokens: 12 },
  ),
  anthropicUnary(
    'error-4xx',
    { model: 'claude-sonnet-4-20250514', messages: [] },
    { type: 'error', error: { type: 'invalid_request_error', message: 'messages: at least one message is required' } },
    400,
  ),
  {
    provider: 'anthropic',
    name: 'plain-text-stream',
    capture: {
      route: '/v1/messages',
      provider: 'anthropic',
      request: { method: 'POST', url: '/v1/messages', headers: JSON_HEADERS, body: { model: 'claude-sonnet-4-20250514', max_tokens: 256, stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello.' }] }] } },
      streamEvents: [
        { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_01FFF', role: 'assistant', usage: { input_tokens: 10, output_tokens: 0 } } } },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there!' } } },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ],
    },
  },

  // --- openai-chat /v1/chat/completions (openai backend) ---
  {
    provider: 'openai-chat',
    name: 'text',
    capture: {
      route: '/v1/chat/completions',
      provider: 'openai',
      request: { method: 'POST', url: '/v1/chat/completions', headers: JSON_HEADERS, body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'What is REST?' }] } },
      response: { status: 200, headers: JSON_HEADERS, body: { id: 'chatcmpl-AAA', object: 'chat.completion', created: 1700000000, model: 'gpt-4o', choices: [{ index: 0, message: { role: 'assistant', content: 'REST is an architectural style for APIs.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 } } },
      usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 },
    },
  },
  {
    provider: 'openai-chat',
    name: 'tools',
    capture: {
      route: '/v1/chat/completions',
      provider: 'openai',
      request: { method: 'POST', url: '/v1/chat/completions', headers: JSON_HEADERS, body: { model: 'gpt-4o', tools: [{ type: 'function', function: { name: 'get_time', parameters: { type: 'object', properties: { tz: { type: 'string' } } } } }], messages: [{ role: 'user', content: 'What time is it in UTC?' }] } },
      response: { status: 200, headers: JSON_HEADERS, body: { id: 'chatcmpl-BBB', object: 'chat.completion', created: 1700000001, model: 'gpt-4o', choices: [{ index: 0, message: { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{"tz":"UTC"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 } } },
      usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 },
    },
  },
  {
    provider: 'openai-chat',
    name: 'text-stream',
    capture: {
      route: '/v1/chat/completions',
      provider: 'openai',
      request: { method: 'POST', url: '/v1/chat/completions', headers: JSON_HEADERS, body: { model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'Count to two.' }] } },
      streamEvents: [
        { event: 'chat.completion.chunk', data: { id: 'chatcmpl-CCC', object: 'chat.completion.chunk', created: 1700000002, model: 'gpt-4o', choices: [{ index: 0, delta: { role: 'assistant', content: 'One' }, finish_reason: null }] } },
        { event: 'chat.completion.chunk', data: { id: 'chatcmpl-CCC', object: 'chat.completion.chunk', created: 1700000002, model: 'gpt-4o', choices: [{ index: 0, delta: { content: ' two' }, finish_reason: null }] } },
        { event: 'chat.completion.chunk', data: { id: 'chatcmpl-CCC', object: 'chat.completion.chunk', created: 1700000002, model: 'gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
        { event: 'done', data: '[DONE]' },
      ],
    },
  },
  {
    provider: 'openai-chat',
    name: 'error-429',
    capture: {
      route: '/v1/chat/completions',
      provider: 'openai',
      request: { method: 'POST', url: '/v1/chat/completions', headers: JSON_HEADERS, body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] } },
      response: { status: 429, headers: JSON_HEADERS, body: { error: { message: 'Rate limit reached', type: 'rate_limit_error' } } },
    },
  },

  // --- gemini /v1/chat/completions (google backend) ---
  {
    provider: 'gemini',
    name: 'text',
    capture: {
      route: '/v1/chat/completions',
      provider: 'google',
      request: { method: 'POST', url: '/v1/chat/completions', headers: JSON_HEADERS, body: { model: 'gemini-1.5-pro', messages: [{ role: 'user', content: 'Name a primary color.' }] } },
      response: { status: 200, headers: JSON_HEADERS, body: { id: 'chatcmpl-GGG', object: 'chat.completion', created: 1700000003, model: 'gemini-1.5-pro', choices: [{ index: 0, message: { role: 'assistant', content: 'Blue.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } } },
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
    },
  },
  {
    provider: 'gemini',
    name: 'text-stream',
    capture: {
      route: '/v1/chat/completions',
      provider: 'google',
      request: { method: 'POST', url: '/v1/chat/completions', headers: JSON_HEADERS, body: { model: 'gemini-1.5-pro', stream: true, messages: [{ role: 'user', content: 'Greet me.' }] } },
      streamEvents: [
        { event: 'chat.completion.chunk', data: { id: 'chatcmpl-GS', object: 'chat.completion.chunk', model: 'gemini-1.5-pro', choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] } },
        { event: 'chat.completion.chunk', data: { id: 'chatcmpl-GS', object: 'chat.completion.chunk', model: 'gemini-1.5-pro', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
        { event: 'done', data: '[DONE]' },
      ],
    },
  },

  // --- ollama /v1/chat/completions (ollama backend) ---
  {
    provider: 'ollama',
    name: 'text',
    capture: {
      route: '/v1/chat/completions',
      provider: 'ollama',
      request: { method: 'POST', url: '/v1/chat/completions', headers: JSON_HEADERS, body: { model: 'llama3.1', messages: [{ role: 'user', content: 'Say ok.' }] } },
      response: { status: 200, headers: JSON_HEADERS, body: { id: 'chatcmpl-OLL', object: 'chat.completion', created: 1700000004, model: 'llama3.1', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 6, completion_tokens: 1, total_tokens: 7 } } },
      usage: { prompt_tokens: 6, completion_tokens: 1, total_tokens: 7 },
    },
  },
];

/** Write all synthetic cases under `baseDir` and return the case names. */
export function generateSyntheticCorpus(baseDir: string): string[] {
  return CASES.map((c) => {
    writeCorpusCase(baseDir, c.provider, c.name, c.capture);
    return `${c.provider}/${c.name}`;
  });
}

/** The corpus root: two levels up from this file (test/fixtures/tools -> test/fixtures). */
export function defaultCorpusRoot(): string {
  return join(__dirname, '..');
}

if (require.main === module) {
  const target = process.argv[2] ?? defaultCorpusRoot();
  const written = generateSyntheticCorpus(target);
  // eslint-disable-next-line no-console
  console.log(`Wrote ${written.length} synthetic cases to ${target}:\n  ${written.join('\n  ')}`);
}
