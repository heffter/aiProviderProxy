/**
 * Fallback trigger + downgrade unit tests (epic AIPP-10, subtask 10.2).
 */

import { describe, it, expect } from 'vitest';
import {
  checkDowngrade,
  applyDowngradeHeaders,
  isReliabilityStatus,
  isReliabilityCategory,
  DEFAULT_DOWNGRADE_CONFIG,
  type DowngradeConfig,
} from '../../src/routing/fallback.js';

const enabled: DowngradeConfig = {
  enabled: true,
  thresholdPercent: 80,
  mapping: { 'claude-opus-4-6': 'claude-sonnet-4-6' },
};

describe('checkDowngrade', () => {
  it('is a no-op when disabled', () => {
    expect(
      checkDowngrade('claude-opus-4-6', 100, DEFAULT_DOWNGRADE_CONFIG),
    ).toMatchObject({ downgraded: false });
  });

  it('is a no-op below the threshold', () => {
    expect(checkDowngrade('claude-opus-4-6', 79, enabled).downgraded).toBe(
      false,
    );
  });

  it('downgrades at/above the threshold when a mapping exists', () => {
    const r = checkDowngrade('claude-opus-4-6', 92, enabled);
    expect(r).toMatchObject({
      downgraded: true,
      originalModel: 'claude-opus-4-6',
      newModel: 'claude-sonnet-4-6',
    });
    expect(r.reason).toContain('92.0%');
    expect(r.reason).toContain('threshold: 80%');
  });

  it('does not downgrade a model without a mapping', () => {
    const r = checkDowngrade('some-model', 99, enabled);
    expect(r.downgraded).toBe(false);
    expect(r.reason).toBe('no mapping available');
  });
});

describe('applyDowngradeHeaders', () => {
  it('stamps x-aipp downgrade markers only when downgraded', () => {
    const headers: Record<string, string> = {};
    applyDowngradeHeaders(headers, {
      downgraded: false,
      originalModel: 'm',
      newModel: 'm',
      reason: '',
    });
    expect(headers).toEqual({});

    applyDowngradeHeaders(headers, {
      downgraded: true,
      originalModel: 'claude-opus-4-6',
      newModel: 'claude-sonnet-4-6',
      reason: 'budget at 90.0% (threshold: 80%)',
    });
    expect(headers).toEqual({
      'x-aipp-downgraded': 'true',
      'x-aipp-downgrade-reason': 'budget at 90.0% (threshold: 80%)',
      'x-aipp-original-model': 'claude-opus-4-6',
    });
  });
});

describe('reliability trigger predicates', () => {
  it('matches configured trigger statuses', () => {
    expect(isReliabilityStatus(429, [429, 529, 503])).toBe(true);
    expect(isReliabilityStatus(500, [429, 529, 503])).toBe(false);
    expect(isReliabilityStatus(undefined, [429])).toBe(false);
  });

  it('treats transient upstream categories as retryable, faults as not', () => {
    expect(isReliabilityCategory('provider_overloaded')).toBe(true);
    expect(isReliabilityCategory('provider_timeout')).toBe(true);
    expect(isReliabilityCategory('provider_connection_error')).toBe(true);
    expect(isReliabilityCategory('client_validation_error')).toBe(false);
    expect(isReliabilityCategory('provider_auth_error')).toBe(false);
  });
});
