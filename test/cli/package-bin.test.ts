/**
 * Verifies the package rename and binary wiring (epic AIPP-2, subtask 2.1;
 * FR-IDENT-001..003).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIN_ALIAS, BIN_NAME, PRODUCT_NAME } from '../../src/identity.js';

const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
) as {
  name: string;
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
});
