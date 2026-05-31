import { expect, test } from "bun:test";
import {
  applyOsServiceRegistrationPlan,
  buildLaunchdPlist,
  buildSystemdUnit,
  createOsServiceRegistrationPlan,
  createOsServicePreview,
} from "../../packages/butler-agent/src/operations/service/os-service-adapter.ts";

test("launchd adapter registers one foreground Butler service", () => {
  const plist = buildLaunchdPlist({
    butlerHome: "/Users/alice/butler",
    butlerData: "/Users/alice/.butler",
  });

  expect(plist).toContain("<key>Label</key>");
  expect(plist).toContain("<string>com.hexpy.butler</string>");
  expect(plist).toContain("/Users/alice/butler/packages/butler-agent/scripts/service-daemon.sh");
  expect(plist).toContain("<key>BUTLER_HOME</key>");
  expect(plist).toContain("<string>/Users/alice/butler</string>");
  expect(plist).toContain("<key>BUTLER_DATA</key>");
  expect(plist).toContain("<string>/Users/alice/.butler</string>");
  expect(plist.match(/service-daemon\.sh/g)?.length).toBe(1);
  expect(plist).not.toContain("native-scheduler.ts");
  expect(plist).not.toContain("sync-consumer.ts");
  expect(plist).not.toContain("embed-server.ts");
});

test("systemd adapter registers one foreground Butler service with control-group kill mode", () => {
  const unit = buildSystemdUnit({
    butlerHome: "/home/alice/butler",
    butlerData: "/home/alice/.butler",
  });

  expect(unit).toContain("[Service]");
  expect(unit).toContain("ExecStart=/bin/bash /home/alice/butler/packages/butler-agent/scripts/service-daemon.sh");
  expect(unit).toContain("Environment=BUTLER_HOME=/home/alice/butler");
  expect(unit).toContain("Environment=BUTLER_DATA=/home/alice/.butler");
  expect(unit).toContain("KillMode=control-group");
  expect(unit.match(/service-daemon\.sh/g)?.length).toBe(1);
  expect(unit).not.toContain("native-scheduler.ts");
  expect(unit).not.toContain("sync-consumer.ts");
  expect(unit).not.toContain("embed-server.ts");
});

test("OS service preview is safe and deterministic", () => {
  const preview = createOsServicePreview({
    platform: "systemd",
    butlerHome: "/home/alice/butler",
    butlerData: "/home/alice/.butler",
  });

  expect(preview).toMatchObject({
    platform: "systemd",
    serviceCount: 1,
    foregroundEntrypoint: "/home/alice/butler/packages/butler-agent/scripts/service-daemon.sh",
    secretsIncluded: false,
    rawTextIncluded: false,
  });
  expect(preview.body).toContain("ExecStart=/bin/bash /home/alice/butler/packages/butler-agent/scripts/service-daemon.sh");
});

test("launchd registration plan writes one user agent and one service command sequence", () => {
  const plan = createOsServiceRegistrationPlan({
    action: "install",
    platform: "launchd",
    butlerHome: "/Users/alice/butler",
    butlerData: "/Users/alice/.butler",
    homeDir: "/Users/alice",
    uid: 501,
  });

  expect(plan).toMatchObject({
    action: "install",
    platform: "launchd",
    serviceCount: 1,
    label: "com.hexpy.butler",
    serviceFile: "/Users/alice/Library/LaunchAgents/com.hexpy.butler.plist",
    foregroundEntrypoint: "/Users/alice/butler/packages/butler-agent/scripts/service-daemon.sh",
    mutates: true,
    secretsIncluded: false,
    rawTextIncluded: false,
  });
  expect(plan.body).toContain("/Users/alice/butler/packages/butler-agent/scripts/service-daemon.sh");
  expect(plan.steps.map((step) => step.argv.join(" "))).toEqual([
    "launchctl bootstrap gui/501 /Users/alice/Library/LaunchAgents/com.hexpy.butler.plist",
    "launchctl kickstart -k gui/501/com.hexpy.butler",
  ]);
  expect(plan.steps.map((step) => step.argv.join(" ")).join("\n")).not.toContain("butler-main");
});

test("systemd registration plan writes one user unit and one service command sequence", () => {
  const plan = createOsServiceRegistrationPlan({
    action: "install",
    platform: "systemd",
    butlerHome: "/home/alice/butler",
    butlerData: "/home/alice/.butler",
    homeDir: "/home/alice",
  });

  expect(plan).toMatchObject({
    action: "install",
    platform: "systemd",
    serviceCount: 1,
    label: "butler.service",
    serviceFile: "/home/alice/.config/systemd/user/butler.service",
    foregroundEntrypoint: "/home/alice/butler/packages/butler-agent/scripts/service-daemon.sh",
  });
  expect(plan.steps.map((step) => step.argv.join(" "))).toEqual([
    "systemctl --user daemon-reload",
    "systemctl --user enable --now butler.service",
  ]);
  expect(plan.body).toContain("KillMode=control-group");
});

test("service registration apply writes and removes only the single service file", () => {
  const writes: Array<{ path: string; body: string }> = [];
  const removes: string[] = [];
  const mkdirs: string[] = [];
  const commands: string[] = [];

  const install = createOsServiceRegistrationPlan({
    action: "install",
    platform: "systemd",
    butlerHome: "/home/alice/butler",
    butlerData: "/home/alice/.butler",
    homeDir: "/home/alice",
  });
  const installResult = applyOsServiceRegistrationPlan(install, {
    mkdir: (path) => mkdirs.push(path),
    writeFile: (path, body) => writes.push({ path, body }),
    rmFile: (path) => removes.push(path),
    runCommand: (argv) => {
      commands.push(argv.join(" "));
      return { exitCode: 0 };
    },
  });

  expect(installResult.mutated).toBe(true);
  expect(mkdirs).toEqual([
    "/home/alice/.config/systemd/user",
    "/home/alice/.butler/logs",
  ]);
  expect(writes).toHaveLength(1);
  expect(writes[0].path).toBe("/home/alice/.config/systemd/user/butler.service");
  expect(commands).toEqual([
    "systemctl --user daemon-reload",
    "systemctl --user enable --now butler.service",
  ]);

  const uninstall = createOsServiceRegistrationPlan({
    action: "uninstall",
    platform: "systemd",
    butlerHome: "/home/alice/butler",
    butlerData: "/home/alice/.butler",
    homeDir: "/home/alice",
  });
  const uninstallResult = applyOsServiceRegistrationPlan(uninstall, {
    mkdir: () => {},
    writeFile: (path, body) => writes.push({ path, body }),
    rmFile: (path) => removes.push(path),
    runCommand: (argv) => {
      commands.push(argv.join(" "));
      return { exitCode: 0 };
    },
  });

  expect(uninstallResult.mutated).toBe(true);
  expect(removes).toEqual(["/home/alice/.config/systemd/user/butler.service"]);
  expect(commands.slice(2)).toEqual([
    "systemctl --user disable --now butler.service",
    "systemctl --user daemon-reload",
  ]);
});

test("service status plan is read-only", () => {
  const plan = createOsServiceRegistrationPlan({
    action: "status",
    platform: "launchd",
    butlerHome: "/Users/alice/butler",
    butlerData: "/Users/alice/.butler",
    homeDir: "/Users/alice",
    uid: 501,
  });

  expect(plan.mutates).toBe(false);
  expect(plan.body).toBe("");
  expect(plan.steps).toEqual([
    {
      argv: ["launchctl", "print", "gui/501/com.hexpy.butler"],
      mutates: false,
      optional: true,
    },
  ]);
});
