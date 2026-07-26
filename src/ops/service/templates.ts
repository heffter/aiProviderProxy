/**
 * Service definition templates (epic AIPP-13, subtask 13.3; FR-OPS-006).
 *
 * Generates a run-at-boot service definition for the host platform so the
 * gateway can run as a background service: a systemd unit (Linux), a launchd
 * plist (macOS), or a Windows Scheduled Task XML. The CLI prints the template;
 * installation (which needs elevation) is a documented manual step, so nothing
 * here performs a privileged or side-effecting operation.
 */

/** Supported service platforms. */
export type ServicePlatform = 'systemd' | 'launchd' | 'windows';

/** Inputs for a service template. */
export interface ServiceTemplateInput {
  /** Absolute path to the node executable. */
  nodePath: string;
  /** Absolute path to the aipp CLI entry (dist/cli/aipp.js). */
  cliPath: string;
  /** The account the service runs as (informational). */
  user?: string;
}

const SERVICE_NAME = 'aiproviderproxy';

/** Detect the service platform for the current OS. */
export function detectPlatform(
  platform: NodeJS.Platform = process.platform,
): ServicePlatform {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'launchd';
  return 'systemd';
}

/** A systemd unit that runs `aipp start`. */
export function systemdUnit(input: ServiceTemplateInput): string {
  return [
    '[Unit]',
    'Description=aiproviderproxy local AI gateway',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${input.nodePath} ${input.cliPath} start`,
    'Restart=on-failure',
    'RestartSec=5',
    ...(input.user ? [`User=${input.user}`] : []),
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** A launchd plist that runs `aipp start` and keeps it alive. */
export function launchdPlist(input: ServiceTemplateInput): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>dev.${SERVICE_NAME}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${input.nodePath}</string>`,
    `    <string>${input.cliPath}</string>`,
    '    <string>start</string>',
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** A Windows Scheduled Task XML (register with `schtasks /Create /XML`). */
export function windowsScheduledTask(input: ServiceTemplateInput): string {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>aiproviderproxy local AI gateway</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <RestartOnFailure>',
    '      <Interval>PT1M</Interval>',
    '      <Count>3</Count>',
    '    </RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${input.nodePath}</Command>`,
    `      <Arguments>"${input.cliPath}" start</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\n');
}

/** Generate the template for a platform. */
export function serviceTemplate(
  platform: ServicePlatform,
  input: ServiceTemplateInput,
): string {
  switch (platform) {
    case 'systemd':
      return systemdUnit(input);
    case 'launchd':
      return launchdPlist(input);
    case 'windows':
      return windowsScheduledTask(input);
  }
}

/** The manual install command for a platform. */
export function installHint(platform: ServicePlatform, file: string): string {
  switch (platform) {
    case 'systemd':
      return `Save the unit to ~/.config/systemd/user/${SERVICE_NAME}.service, then: systemctl --user enable --now ${SERVICE_NAME}`;
    case 'launchd':
      return `Save the plist to ~/Library/LaunchAgents/dev.${SERVICE_NAME}.plist, then: launchctl load ~/Library/LaunchAgents/dev.${SERVICE_NAME}.plist`;
    case 'windows':
      return `Save the XML (e.g. to ${file}), then: schtasks /Create /TN ${SERVICE_NAME} /XML "${file}"`;
  }
}
