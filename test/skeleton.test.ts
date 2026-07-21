/**
 * Smoke tests for the AIPP-2 target skeleton (epic AIPP-2, subtask 2.2).
 *
 * Asserts every placeholder module imports cleanly and exposes its marker, and
 * that the product identity is the renamed one. Also exercises the skeleton so
 * coverage counts it.
 */

import { describe, it, expect } from 'vitest';
import { MODULE_NAME as gateway } from '../src/gateway/index.js';
import { MODULE_NAME as protocols } from '../src/protocols/index.js';
import { MODULE_NAME as providers } from '../src/providers/index.js';
import { MODULE_NAME as models } from '../src/models/index.js';
import { MODULE_NAME as lifecycle } from '../src/lifecycle/index.js';
import { MODULE_NAME as routing } from '../src/routing/index.js';
import { MODULE_NAME as tokemetry } from '../src/integrations/tokemetry/index.js';
import { MODULE_NAME as ops } from '../src/ops/index.js';
import { MODULE_NAME as config } from '../src/config/index.js';
import { MODULE_NAME as cli } from '../src/cli/index.js';
import {
  BIN_ALIAS,
  BIN_NAME,
  DISPLAY_NAME,
  HOME_DIR_NAME,
  PRODUCT_NAME,
} from '../src/identity.js';

describe('target skeleton', () => {
  it('exposes every module boundary from PRD section 10.1', () => {
    expect({
      gateway,
      protocols,
      providers,
      models,
      lifecycle,
      routing,
      tokemetry,
      ops,
      config,
      cli,
    }).toEqual({
      gateway: 'gateway',
      protocols: 'protocols',
      providers: 'providers',
      models: 'models',
      lifecycle: 'lifecycle',
      routing: 'routing',
      tokemetry: 'tokemetry',
      ops: 'ops',
      config: 'config',
      cli: 'cli',
    });
  });
});

describe('product identity', () => {
  it('is the renamed aiproviderproxy / aipp identity', () => {
    expect(PRODUCT_NAME).toBe('aiproviderproxy');
    expect(BIN_NAME).toBe('aipp');
    expect(BIN_ALIAS).toBe('aiproviderproxy');
    expect(DISPLAY_NAME).toBe('AI Provider Proxy');
    expect(HOME_DIR_NAME).toBe('.aiproviderproxy');
  });
});
