/**
 * Verifies the package rename and binary wiring (epic AIPP-2, subtask 2.1;
 * FR-IDENT-001..003).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BIN_ALIAS,
  BIN_NAME,
  PRODUCT_NAME,
  PRODUCT_VERSION,
} from '../../src/identity.js';

const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
) as {
  name: string;
  version: string;
  private?: boolean;
  bin: Record<string, string>;
};

describe('package identity', () => {
  it('is renamed to aiproviderproxy and marked private', () => {
    expect(pkg.name).toBe(PRODUCT_NAME);
    expect(pkg.name).toBe('aiproviderproxy');
    expect(pkg.private).toBe(true);
  });

  it('wires the aipp and aiproviderproxy binaries to the new CLI entrypoint', () => {
    expect(pkg.bin[BIN_NAME]).toBe('dist/cli/aipp.js');
    expect(pkg.bin[BIN_ALIAS]).toBe('dist/cli/aipp.js');
  });

  it('no longer exposes the RelayPlane binaries', () => {
    expect(pkg.bin).not.toHaveProperty('relayplane');
    expect(pkg.bin).not.toHaveProperty('relayplane-proxy');
  });

  it('keeps PRODUCT_VERSION in sync with the manifest', () => {
    // identity.ts cannot import the manifest (tsc rootDir is ./src), so the
    // version is duplicated there by necessity. Its docstring says "must be
    // kept in sync" -- this is what actually enforces it. The value is reported
    // to Tokemetry as the source version, so drift would mislabel every
    // exported usage event.
    expect(PRODUCT_VERSION).toBe(pkg.version);
  });
});
