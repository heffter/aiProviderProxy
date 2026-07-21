/**
 * Unit tests for the corpus layout, tap API, and linter (epic AIPP-1, subtask 1.3).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  lintCorpus,
  lintCorpusCase,
  readCorpusCase,
  recordCorpusCase,
  writeCorpusCase,
  PROVIDER_DIRS,
} from './corpus.js';
import { formatReport } from './lint-corpus.js';
import { RECORD_ENV_VAR, type RawCapture } from './recorder.js';

const PROMPT = 'CONTENTTOKEN_deploy_the_service_now';
const COMPLETION = 'CONTENTTOKEN_here_is_the_answer';
const SECRET = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH1111';

let baseDir: string;
const savedEnv = process.env[RECORD_ENV_VAR];

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'aipp-corpus-'));
  delete process.env[RECORD_ENV_VAR];
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
  if (savedEnv === undefined) {
    delete process.env[RECORD_ENV_VAR];
  } else {
    process.env[RECORD_ENV_VAR] = savedEnv;
  }
});

const unaryCapture: RawCapture = {
  route: '/v1/messages',
  provider: 'anthropic',
  request: {
    method: 'POST',
    url: '/v1/messages',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${SECRET}`,
    },
    body: {
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
    },
  },
  response: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      content: [{ type: 'text', text: COMPLETION }],
      usage: { input_tokens: 10, output_tokens: 4 },
    },
  },
};

const streamingCapture: RawCapture = {
  route: '/v1/chat/completions',
  provider: 'openai-chat',
  request: {
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: { model: 'gpt-4o' },
  },
  streamEvents: [
    { event: 'message_start', data: { type: 'message_start' } },
    {
      event: 'content_block_delta',
      data: { type: 'text_delta', text: COMPLETION },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ],
};

describe('writeCorpusCase / readCorpusCase', () => {
  it('round-trips a unary case with scrubbed content', () => {
    const caseDir = writeCorpusCase(
      baseDir,
      'anthropic',
      'plain-text',
      unaryCapture,
    );
    expect(existsSync(join(caseDir, 'request.json'))).toBe(true);
    expect(existsSync(join(caseDir, 'response.json'))).toBe(true);
    expect(existsSync(join(caseDir, 'stream.jsonl'))).toBe(false);

    const parsed = readCorpusCase('anthropic', caseDir);
    expect(parsed.request.headers).toEqual({
      'content-type': 'application/json',
    }); // auth dropped
    expect(
      (parsed.response?.body as { usage: { input_tokens: number } }).usage
        .input_tokens,
    ).toBe(10);

    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain(PROMPT);
    expect(serialized).not.toContain(COMPLETION);
    expect(serialized).not.toContain('sk-ant-');
  });

  it('round-trips a streaming case preserving event order', () => {
    const caseDir = writeCorpusCase(
      baseDir,
      'openai-chat',
      'stream-text',
      streamingCapture,
    );
    expect(existsSync(join(caseDir, 'stream.jsonl'))).toBe(true);
    expect(existsSync(join(caseDir, 'response.json'))).toBe(false);

    const parsed = readCorpusCase('openai-chat', caseDir);
    expect(parsed.streamEvents?.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_delta',
      'message_stop',
    ]);
    expect(JSON.stringify(parsed.streamEvents)).not.toContain(COMPLETION);
  });
});

describe('recordCorpusCase tap', () => {
  it('is a no-op returning null when recording is disabled', () => {
    expect(
      recordCorpusCase(unaryCapture, 'anthropic', 'plain-text', null),
    ).toBeNull();
    expect(
      recordCorpusCase(unaryCapture, 'anthropic', 'plain-text'),
    ).toBeNull(); // env unset
  });

  it('writes a case when a base dir is provided', () => {
    const caseDir = recordCorpusCase(
      unaryCapture,
      'anthropic',
      'plain-text',
      baseDir,
    );
    expect(caseDir).not.toBeNull();
    expect(existsSync(join(caseDir as string, 'request.json'))).toBe(true);
  });
});

describe('lintCorpusCase', () => {
  it('passes a properly scrubbed case', () => {
    const caseDir = writeCorpusCase(
      baseDir,
      'anthropic',
      'plain-text',
      unaryCapture,
    );
    const result = lintCorpusCase('anthropic', caseDir);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails a case that leaks a secret and a non-allowlisted header', () => {
    const caseDir = join(baseDir, 'anthropic', 'leaky');
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(
      join(caseDir, 'request.json'),
      JSON.stringify({
        method: 'POST',
        url: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SECRET}`,
        },
        body: { messages: [{ role: 'user', content: `call ${SECRET}` }] },
      }),
      'utf8',
    );
    writeFileSync(
      join(caseDir, 'response.json'),
      JSON.stringify({ status: 200, headers: {}, body: {} }),
      'utf8',
    );

    const result = lintCorpusCase('anthropic', caseDir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('secret'))).toBe(true);
    expect(
      result.errors.some((e) => e.includes('non-allowlisted header')),
    ).toBe(true);
  });

  it('fails a case with unscrubbed content text', () => {
    const caseDir = join(baseDir, 'anthropic', 'raw-content');
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(
      join(caseDir, 'request.json'),
      JSON.stringify({
        method: 'POST',
        url: '/v1/messages',
        headers: { 'content-type': 'application/json' },
        body: {
          system: 'You are a helpful assistant with raw text',
          messages: [],
        },
      }),
      'utf8',
    );
    writeFileSync(
      join(caseDir, 'response.json'),
      JSON.stringify({ status: 200, headers: {}, body: {} }),
      'utf8',
    );

    const result = lintCorpusCase('anthropic', caseDir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('unscrubbed content'))).toBe(
      true,
    );
  });

  it('fails a case missing both response and stream files', () => {
    const caseDir = join(baseDir, 'anthropic', 'incomplete');
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(
      join(caseDir, 'request.json'),
      JSON.stringify({
        method: 'POST',
        url: '/v1/messages',
        headers: {},
        body: {},
      }),
      'utf8',
    );
    const result = lintCorpusCase('anthropic', caseDir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('neither'))).toBe(true);
  });
});

describe('lintCorpus aggregate', () => {
  it('reports zero cases for an empty corpus and passes', () => {
    const report = lintCorpus(baseDir);
    expect(report.totalCases).toBe(0);
    for (const provider of PROVIDER_DIRS) {
      expect(report.byProvider[provider]).toBe(0);
    }
    expect(formatReport(report).code).toBe(0); // empty corpus passes with a warning
  });

  it('aggregates pass/fail across provider directories', () => {
    writeCorpusCase(baseDir, 'anthropic', 'plain-text', unaryCapture);
    writeCorpusCase(baseDir, 'openai-chat', 'stream-text', streamingCapture);
    const report = lintCorpus(baseDir);
    expect(report.totalCases).toBe(2);
    expect(report.okCases).toBe(2);
    expect(formatReport(report).code).toBe(0);
  });
});
