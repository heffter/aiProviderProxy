/**
 * Service template tests (epic AIPP-13, subtask 13.3; FR-OPS-006).
 */

import { describe, it, expect } from 'vitest';
import {
  detectPlatform,
  serviceTemplate,
  systemdUnit,
  launchdPlist,
  windowsScheduledTask,
  installHint,
} from '../../src/ops/service/index.js';

const input = {
  nodePath: '/usr/bin/node',
  cliPath: '/opt/aipp/dist/cli/aipp.js',
};

describe('detectPlatform', () => {
  it('maps the OS to a service platform', () => {
    expect(detectPlatform('win32')).toBe('windows');
    expect(detectPlatform('darwin')).toBe('launchd');
    expect(detectPlatform('linux')).toBe('systemd');
    expect(detectPlatform('freebsd')).toBe('systemd');
  });
});

describe('service templates', () => {
  it('systemd unit runs aipp start and restarts on failure', () => {
    const unit = systemdUnit(input);
    expect(unit).toContain('[Service]');
    expect(unit).toContain('/usr/bin/node /opt/aipp/dist/cli/aipp.js start');
    expect(unit).toContain('Restart=on-failure');
  });

  it('launchd plist keeps the gateway alive at load', () => {
    const plist = launchdPlist(input);
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('dev.aiproviderproxy');
    expect(plist).toContain('<string>start</string>');
  });

  it('windows scheduled task XML runs at logon with restart', () => {
    const xml = windowsScheduledTask(input);
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<Command>/usr/bin/node</Command>');
    expect(xml).toContain('start');
    expect(xml).toContain('<RestartOnFailure>');
  });

  it('serviceTemplate dispatches by platform', () => {
    expect(serviceTemplate('systemd', input)).toBe(systemdUnit(input));
    expect(serviceTemplate('launchd', input)).toBe(launchdPlist(input));
    expect(serviceTemplate('windows', input)).toBe(windowsScheduledTask(input));
  });

  it('installHint gives the platform install command', () => {
    expect(installHint('systemd', 'x')).toContain('systemctl --user enable');
    expect(installHint('launchd', 'x')).toContain('launchctl load');
    expect(installHint('windows', 'task.xml')).toContain('schtasks /Create');
  });
});
