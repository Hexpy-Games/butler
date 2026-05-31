import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { spawnSync } from "child_process";
import { butlerAgentScriptPath } from "../../runtime/paths.ts";

export type OsServicePlatform = "launchd" | "systemd";
export type OsServicePlatformSelection = OsServicePlatform | "auto";
export type OsServiceRegistrationAction = "install" | "uninstall" | "status";

export interface OsServiceAdapterInput {
  butlerHome: string;
  butlerData: string;
  label?: string;
}

export interface OsServicePreviewInput extends OsServiceAdapterInput {
  platform: OsServicePlatform;
}

export interface OsServicePreview {
  platform: OsServicePlatform;
  label: string;
  serviceCount: 1;
  foregroundEntrypoint: string;
  stdoutFile: string;
  stderrFile: string;
  body: string;
  rawTextIncluded: false;
  secretsIncluded: false;
}

export interface OsServiceRegistrationStep {
  argv: string[];
  mutates: boolean;
  optional?: boolean;
}

export interface OsServiceRegistrationInput extends OsServiceAdapterInput {
  action: OsServiceRegistrationAction;
  platform?: OsServicePlatformSelection;
  homeDir?: string;
  processPlatform?: string;
  uid?: number | null;
}

export interface OsServiceRegistrationPlan {
  action: OsServiceRegistrationAction;
  platform: OsServicePlatform;
  label: string;
  serviceCount: 1;
  serviceFile: string;
  foregroundEntrypoint: string;
  stdoutFile: string;
  stderrFile: string;
  body: string;
  steps: OsServiceRegistrationStep[];
  mutates: boolean;
  rawTextIncluded: false;
  secretsIncluded: false;
}

export interface OsServiceCommandResult {
  argv: string[];
  exitCode: number;
  optional?: boolean;
}

export interface OsServiceRegistrationApplyResult {
  action: OsServiceRegistrationAction;
  platform: OsServicePlatform;
  serviceFile: string;
  mutated: boolean;
  commands: OsServiceCommandResult[];
}

export interface OsServiceRegistrationDependencies {
  mkdir?: (path: string) => void;
  writeFile?: (path: string, body: string) => void;
  rmFile?: (path: string) => void;
  runCommand?: (argv: string[]) => { exitCode: number };
}

function label(input?: string): string {
  return input || "com.hexpy.butler";
}

function daemonScript(home: string): string {
  return butlerAgentScriptPath(home, "service-daemon.sh");
}

function stdoutFile(data: string): string {
  return join(data, "logs", "service-daemon-out.log");
}

function stderrFile(data: string): string {
  return join(data, "logs", "service-daemon-err.log");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildLaunchdPlist(input: OsServiceAdapterInput): string {
  const serviceLabel = label(input.label);
  const script = daemonScript(input.butlerHome);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(serviceLabel)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${escapeXml(script)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BUTLER_HOME</key>
    <string>${escapeXml(input.butlerHome)}</string>
    <key>BUTLER_DATA</key>
    <string>${escapeXml(input.butlerData)}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${escapeXml(input.butlerHome)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutFile(input.butlerData))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrFile(input.butlerData))}</string>
</dict>
</plist>
`;
}

export function buildSystemdUnit(input: OsServiceAdapterInput): string {
  const serviceLabel = label(input.label);
  const script = daemonScript(input.butlerHome);
  return `[Unit]
Description=Butler local assistant service
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${input.butlerHome}
Environment=BUTLER_HOME=${input.butlerHome}
Environment=BUTLER_DATA=${input.butlerData}
ExecStart=/bin/bash ${script}
Restart=always
RestartSec=5
KillMode=control-group
StandardOutput=append:${stdoutFile(input.butlerData)}
StandardError=append:${stderrFile(input.butlerData)}

[Install]
WantedBy=default.target
# ButlerLabel=${serviceLabel}
`;
}

export function createOsServicePreview(input: OsServicePreviewInput): OsServicePreview {
  const body = input.platform === "launchd"
    ? buildLaunchdPlist(input)
    : buildSystemdUnit(input);
  return {
    platform: input.platform,
    label: label(input.label),
    serviceCount: 1,
    foregroundEntrypoint: daemonScript(input.butlerHome),
    stdoutFile: stdoutFile(input.butlerData),
    stderrFile: stderrFile(input.butlerData),
    body,
    rawTextIncluded: false,
    secretsIncluded: false,
  };
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function resolveRegistrationPlatform(input: OsServiceRegistrationInput): OsServicePlatform {
  const requested = input.platform ?? "auto";
  if (requested === "launchd" || requested === "systemd") return requested;
  const platform = input.processPlatform ?? process.platform;
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  throw new Error(`unsupported OS service platform: ${platform}`);
}

function launchdDomain(uid: number | null | undefined): string {
  return `gui/${uid ?? currentUid() ?? "$UID"}`;
}

function launchdServiceTarget(uid: number | null | undefined, serviceLabel: string): string {
  return `${launchdDomain(uid)}/${serviceLabel}`;
}

function launchdServiceFile(homeDir: string, serviceLabel: string): string {
  return join(homeDir, "Library", "LaunchAgents", `${serviceLabel}.plist`);
}

function systemdServiceFile(homeDir: string): string {
  return join(homeDir, ".config", "systemd", "user", "butler.service");
}

function systemdUnitName(): string {
  return "butler.service";
}

export function createOsServiceRegistrationPlan(input: OsServiceRegistrationInput): OsServiceRegistrationPlan {
  const platform = resolveRegistrationPlatform(input);
  const homeDir = input.homeDir ?? homedir();
  const foregroundEntrypoint = daemonScript(input.butlerHome);
  const base = {
    action: input.action,
    platform,
    serviceCount: 1 as const,
    foregroundEntrypoint,
    stdoutFile: stdoutFile(input.butlerData),
    stderrFile: stderrFile(input.butlerData),
    rawTextIncluded: false as const,
    secretsIncluded: false as const,
  };

  if (platform === "launchd") {
    const serviceLabel = label(input.label);
    const serviceFile = launchdServiceFile(homeDir, serviceLabel);
    const domain = launchdDomain(input.uid);
    const target = launchdServiceTarget(input.uid, serviceLabel);
    const body = input.action === "install" ? buildLaunchdPlist(input) : "";
    const steps: OsServiceRegistrationStep[] = input.action === "install"
      ? [
          { argv: ["launchctl", "bootstrap", domain, serviceFile], mutates: true },
          { argv: ["launchctl", "kickstart", "-k", target], mutates: true },
        ]
      : input.action === "uninstall"
        ? [{ argv: ["launchctl", "bootout", target], mutates: true, optional: true }]
        : [{ argv: ["launchctl", "print", target], mutates: false, optional: true }];
    return {
      ...base,
      label: serviceLabel,
      serviceFile,
      body,
      steps,
      mutates: input.action !== "status",
    };
  }

  const serviceLabel = systemdUnitName();
  const serviceFile = systemdServiceFile(homeDir);
  const body = input.action === "install" ? buildSystemdUnit(input) : "";
  const steps: OsServiceRegistrationStep[] = input.action === "install"
    ? [
        { argv: ["systemctl", "--user", "daemon-reload"], mutates: true },
        { argv: ["systemctl", "--user", "enable", "--now", serviceLabel], mutates: true },
      ]
    : input.action === "uninstall"
      ? [
          { argv: ["systemctl", "--user", "disable", "--now", serviceLabel], mutates: true, optional: true },
          { argv: ["systemctl", "--user", "daemon-reload"], mutates: true },
        ]
      : [{ argv: ["systemctl", "--user", "is-active", serviceLabel], mutates: false, optional: true }];
  return {
    ...base,
    label: serviceLabel,
    serviceFile,
    body,
    steps,
    mutates: input.action !== "status",
  };
}

export function applyOsServiceRegistrationPlan(
  plan: OsServiceRegistrationPlan,
  deps: OsServiceRegistrationDependencies = {},
): OsServiceRegistrationApplyResult {
  const mkdir = deps.mkdir ?? ((path) => mkdirSync(path, { recursive: true, mode: 0o700 }));
  const writeFile = deps.writeFile ?? ((path, body) => writeFileSync(path, body, { mode: 0o644 }));
  const rmFile = deps.rmFile ?? ((path) => rmSync(path, { force: true }));
  const runCommand = deps.runCommand ?? ((argv) => {
    const result = spawnSync(argv[0], argv.slice(1), { stdio: "ignore" });
    return { exitCode: result.status ?? 1 };
  });

  if (plan.action === "install") {
    mkdir(dirname(plan.serviceFile));
    mkdir(dirname(plan.stdoutFile));
    writeFile(plan.serviceFile, plan.body);
  }

  const commands: OsServiceCommandResult[] = [];
  for (const step of plan.steps) {
    const result = runCommand(step.argv);
    commands.push({
      argv: step.argv,
      exitCode: result.exitCode,
      optional: step.optional,
    });
    if (result.exitCode !== 0 && !step.optional && plan.action !== "status") {
      throw new Error(`OS service command failed with exit code ${result.exitCode}: ${step.argv.join(" ")}`);
    }
  }

  if (plan.action === "uninstall") {
    rmFile(plan.serviceFile);
  }

  return {
    action: plan.action,
    platform: plan.platform,
    serviceFile: plan.serviceFile,
    mutated: plan.mutates,
    commands,
  };
}
