/**
 * Complexity classifier tests (epic AIPP-10, subtask 10.1; FR-ROUTE-002).
 *
 * A fixture corpus with expected complexity labels, plus the last-user-message
 * scoping and whole-conversation floor behaviours ported from the legacy proxy.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyComplexity,
  messageText,
  normalizeMessages,
  type ClassifierMessage,
} from '../../src/routing/complexity.js';

function user(text: string): ClassifierMessage {
  return { role: 'user', text };
}

describe('classifyComplexity fixture corpus', () => {
  const cases: Array<{
    label: string;
    messages: ClassifierMessage[];
    want: string;
  }> = [
    { label: 'greeting', messages: [user('hi there')], want: 'simple' },
    {
      label: 'single keyword (analyze) is moderate',
      messages: [user('analyze this sentence')],
      want: 'moderate',
    },
    {
      label: 'architecture request is complex',
      messages: [user('design a distributed system architecture')],
      want: 'complex',
    },
    {
      label: 'code + implement stacks to complex',
      messages: [user('implement a function that sorts an array')],
      want: 'complex',
    },
    {
      label: 'short factual question is simple',
      messages: [user('what is the capital of France')],
      want: 'simple',
    },
    {
      label: 'multi-step plan is complex',
      messages: [
        user(
          'first design the schema then implement and optimize the migrate step',
        ),
      ],
      want: 'complex',
    },
  ];

  for (const c of cases) {
    it(c.label, () => {
      expect(classifyComplexity(c.messages).complexity).toBe(c.want);
    });
  }
});

describe('last-user-message scoping', () => {
  it('scores only the last user message for keyword signals', () => {
    const messages: ClassifierMessage[] = [
      {
        role: 'system',
        text: 'architect distributed microservice infrastructure',
      },
      user('hi'),
    ];
    // The huge system prompt must NOT drag a trivial user turn to complex.
    expect(classifyComplexity(messages).complexity).toBe('simple');
  });

  it('uses the LAST user message when several are present', () => {
    const messages: ClassifierMessage[] = [
      user('hello'),
      { role: 'assistant', text: 'hi' },
      user('implement and refactor the distributed system architecture'),
    ];
    // The trivial first turn is ignored; the last turn scores complex.
    expect(classifyComplexity([user('hello')]).complexity).toBe('simple');
    expect(classifyComplexity(messages).complexity).toBe('complex');
  });

  it('falls back to all messages when there is no user message', () => {
    const messages: ClassifierMessage[] = [
      { role: 'system', text: 'implement and refactor the module' },
    ];
    expect(classifyComplexity(messages).complexity).toBe('moderate');
  });
});

describe('whole-conversation floors', () => {
  it('escalates a tiny last message when total context is enormous', () => {
    const big = 'x'.repeat(120_000 * 4); // ~120K tokens
    const messages: ClassifierMessage[] = [
      { role: 'system', text: big },
      user('ok'),
    ];
    const result = classifyComplexity(messages);
    expect(result.totalTokens).toBeGreaterThan(100_000);
    expect(result.complexity).toBe('complex'); // +5 context floor
  });

  it('adds a message-count signal for long conversations', () => {
    const many: ClassifierMessage[] = [];
    for (let i = 0; i < 55; i++) many.push(user('ok'));
    // 55 messages -> +2 count signal alone is moderate.
    expect(classifyComplexity(many).complexity).toBe('moderate');
  });
});

describe('score and token reporting', () => {
  it('reports a monotonic score and token estimates', () => {
    const r = classifyComplexity([user('analyze and compare and audit')]);
    expect(r.score).toBeGreaterThanOrEqual(2);
    expect(r.lastUserTokens).toBeGreaterThan(0);
    expect(r.totalTokens).toBeGreaterThan(0);
  });
});

describe('messageText / normalizeMessages', () => {
  it('extracts a plain string', () => {
    expect(messageText('hello')).toBe('hello');
  });

  it('extracts text parts and drops non-text blocks', () => {
    const content = [
      { type: 'text', text: 'a' },
      { type: 'image', source: {} },
      { type: 'text', text: 'b' },
    ];
    expect(messageText(content)).toBe('a b');
  });

  it('returns empty string for unknown content', () => {
    expect(messageText(undefined)).toBe('');
    expect(messageText(42)).toBe('');
  });

  it('normalizes role/content pairs', () => {
    const norm = normalizeMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'yo' }] },
    ]);
    expect(norm).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'yo' },
    ]);
  });
});
