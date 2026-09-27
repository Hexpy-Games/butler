import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  codesignArguments,
  evaluateGatekeeperAssessment,
  macNotaryConfigFromEnv,
  macSigningConfigFromEnv,
  notarytoolLogArguments,
  notarytoolSubmitArguments,
  parseCodesignDisplay,
  parseCodesigningIdentities,
  parseNotarySubmission,
  planMacCodeSigning,
  productionSignatureIssues,
  selectDeveloperIdIdentity,
  signMacCodeInsideOut,
  type MacCodeSigningTarget,
} from "../../packages/butler-app/scripts/release/mac-signing.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodTree(root);
    rmSync(root, { recursive: true, force: true });
  }
});

const MACH_O_64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);
const MACH_O_FAT = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02]);

function write(path: string, content: string | Buffer, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, mode);
}

function infoPlist(executable: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key>
  <string>${executable}</string>
</dict></plist>
`;
}

function fakeApp(path: string, executable: string): void {
  write(join(path, "Contents", "Info.plist"), infoPlist(executable));
  write(join(path, "Contents", "MacOS", executable), MACH_O_64, 0o755);
}

function fakeFramework(path: string, name: string, extra: Record<string, Buffer>): void {
  const version = join(path, "Versions", "A");
  write(join(version, name), MACH_O_64, 0o755);
  write(join(version, "Resources", "Info.plist"), infoPlist(name));
  for (const [file, content] of Object.entries(extra)) write(join(version, file), content, 0o755);
  symlinkSync("A", join(path, "Versions", "Current"));
  symlinkSync(join("Versions", "Current", name), join(path, name));
  symlinkSync(join("Versions", "Current", "Resources"), join(path, "Resources"));
}

// Mirrors the Electron 41 bundle that electron-packager produces for Butler.
function fakeButlerApp(): { root: string; app: string } {
  const root = mkdtempSync(join(tmpdir(), "butler-mac-signing-"));
  roots.push(root);
  const app = join(root, "Butler.app");
  fakeApp(app, "Butler");
  const frameworks = join(app, "Contents", "Frameworks");
  fakeFramework(join(frameworks, "Electron Framework.framework"), "Electron Framework", {
    "Libraries/libEGL.dylib": MACH_O_64,
    "Libraries/libffmpeg.dylib": MACH_O_FAT,
    "Helpers/chrome_crashpad_handler": MACH_O_64,
  });
  symlinkSync(join("Versions", "Current", "Libraries"), join(frameworks, "Electron Framework.framework", "Libraries"));
  fakeFramework(join(frameworks, "Squirrel.framework"), "Squirrel", { "Resources/ShipIt": MACH_O_64 });
  fakeFramework(join(frameworks, "Mantle.framework"), "Mantle", {});
  for (const helper of ["Butler Helper", "Butler Helper (GPU)", "Butler Helper (Plugin)", "Butler Helper (Renderer)"]) {
    fakeApp(join(frameworks, `${helper}.app`), helper);
  }
  fakeApp(join(app, "Contents", "Library", "LoginItems", "Butler Menu Bar Helper.app"), "Butler Menu Bar Helper");
  const payload = join(app, "Contents", "Resources", "bundled-agent");
  write(join(payload, "bin", "butler-agent"), MACH_O_64, 0o555);
  write(join(payload, "resources", "defaults.json"), "{}", 0o444);
  write(join(payload, "resources", "tool.sh"), "#!/bin/sh\necho ok\n", 0o555);
  write(join(payload, "native-agent-manifest.json"), "{}", 0o444);
  chmodSync(join(payload, "bin"), 0o555);
  write(join(app, "Contents", "Resources", "app-client", "index.html"), "<main>Butler</main>");
  write(join(app, "Contents", "Resources", "butler.icns"), "icns");
  return { root, app };
}

function chmodTree(path: string): void {
  try {
    const stat = statSync(path);
    if (!stat.isDirectory()) return;
    chmodSync(path, 0o755);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) chmodTree(join(path, entry.name));
    }
  } catch {}
}

function relativePaths(app: string, plan: MacCodeSigningTarget[]): string[] {
  return plan.map((target) => relative(app, target.path) || ".");
}

test("inside-out plan signs every nested Mach-O before the bundle that contains it", () => {
  const { app } = fakeButlerApp();
  const plan = planMacCodeSigning(app);
  const paths = relativePaths(app, plan);

  expect(paths.at(-1)).toBe(".");
  expect(new Set(paths).size).toBe(paths.length);
  expect(paths).toEqual(expect.arrayContaining([
    "Contents/Resources/bundled-agent/bin/butler-agent",
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib",
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib",
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler",
    "Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt",
    "Contents/Frameworks/Electron Framework.framework",
    "Contents/Frameworks/Squirrel.framework",
    "Contents/Frameworks/Mantle.framework",
    "Contents/Frameworks/Butler Helper.app",
    "Contents/Frameworks/Butler Helper (GPU).app",
    "Contents/Frameworks/Butler Helper (Plugin).app",
    "Contents/Frameworks/Butler Helper (Renderer).app",
    "Contents/Library/LoginItems/Butler Menu Bar Helper.app",
  ]));
  expect(paths).toHaveLength(14);

  for (const [index, target] of plan.entries()) {
    const containers = plan.filter((other) => target.path.startsWith(`${other.path}/`));
    for (const container of containers) {
      expect(plan.indexOf(container)).toBeGreaterThan(index);
    }
  }
});

test("inside-out plan skips bundle main executables, symlinks and non Mach-O files", () => {
  const { app } = fakeButlerApp();
  const paths = relativePaths(app, planMacCodeSigning(app));

  expect(paths).not.toContain("Contents/MacOS/Butler");
  expect(paths).not.toContain("Contents/Frameworks/Butler Helper.app/Contents/MacOS/Butler Helper");
  expect(paths).not.toContain("Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework");
  expect(paths).not.toContain("Contents/Frameworks/Electron Framework.framework/Electron Framework");
  expect(paths).not.toContain("Contents/Frameworks/Electron Framework.framework/Libraries/libEGL.dylib");
  expect(paths).not.toContain("Contents/Resources/bundled-agent/resources/tool.sh");
  expect(paths).not.toContain("Contents/Resources/app-client/index.html");
});

test("only the Electron app and its helpers carry the Electron entitlements", () => {
  const { app } = fakeButlerApp();
  const plan = planMacCodeSigning(app);
  const withEntitlements = plan
    .filter((target) => target.entitlements === "electron")
    .map((target) => relative(app, target.path) || ".")
    .sort();

  expect(withEntitlements).toEqual([
    ".",
    "Contents/Frameworks/Butler Helper (GPU).app",
    "Contents/Frameworks/Butler Helper (Plugin).app",
    "Contents/Frameworks/Butler Helper (Renderer).app",
    "Contents/Frameworks/Butler Helper.app",
  ]);
  const agent = plan.find((target) => target.path.endsWith("bundled-agent/bin/butler-agent"));
  expect(agent).toMatchObject({ kind: "file", entitlements: null, identifier: "com.hexpy.butler.agent" });
});

test("production codesign arguments use Developer ID, hardened runtime and a secure timestamp", () => {
  const { app } = fakeButlerApp();
  const plan = planMacCodeSigning(app);
  const config = { mode: "production" as const, identity: "ABCDEF0123", keychain: "/tmp/release.keychain-db" };
  const rootArgs = codesignArguments(plan.at(-1)!, config, "/repo/electron.entitlements.plist");
  expect(rootArgs).toEqual([
    "--force",
    "--sign", "ABCDEF0123",
    "--keychain", "/tmp/release.keychain-db",
    "--timestamp",
    "--options", "runtime",
    "--entitlements", "/repo/electron.entitlements.plist",
    app,
  ]);
  const agent = plan.find((target) => target.identifier)!;
  expect(codesignArguments(agent, { ...config, keychain: null }, "/repo/electron.entitlements.plist")).toEqual([
    "--force",
    "--sign", "ABCDEF0123",
    "--timestamp",
    "--options", "runtime",
    "--identifier", "com.hexpy.butler.agent",
    agent.path,
  ]);
});

test("ad-hoc codesign arguments keep local builds unhardened and untimestamped", () => {
  const { app } = fakeButlerApp();
  const plan = planMacCodeSigning(app);
  expect(codesignArguments(plan.at(-1)!, { mode: "ad-hoc" }, "/repo/e.plist")).toEqual([
    "--force", "--sign", "-", "--entitlements", "/repo/e.plist", app,
  ]);
});

test("signing restores the read-only native Agent payload after codesign rewrites it", () => {
  const { app } = fakeButlerApp();
  const agentPath = join(app, "Contents", "Resources", "bundled-agent", "bin", "butler-agent");
  const signed: string[] = [];
  const plan = signMacCodeInsideOut(app, { mode: "ad-hoc" }, "/repo/e.plist", (args) => {
    const path = args.at(-1)!;
    signed.push(path);
    if (path === agentPath) {
      // codesign writes a sibling temp file and renames it over the original.
      const temp = `${path}.cstemp`;
      writeFileSync(temp, Buffer.concat([MACH_O_64, Buffer.from("signed")]));
      renameSync(temp, path);
    }
  });
  expect(signed).toEqual(plan.map((target) => target.path));
  expect(readFileSync(agentPath).subarray(MACH_O_64.length).toString()).toBe("signed");
  expect(statSync(agentPath).mode & 0o777).toBe(0o555);
  expect(statSync(dirname(agentPath)).mode & 0o777).toBe(0o555);
});

test("signing configuration follows the release environment", () => {
  expect(macSigningConfigFromEnv({})).toEqual({ mode: "ad-hoc" });
  expect(macSigningConfigFromEnv({
    BUTLER_APP_SIGN_IDENTITY: " Developer ID Application: Hexpy Games (TEAM123456) ",
    BUTLER_APP_SIGN_KEYCHAIN: "/tmp/k.keychain-db",
  })).toEqual({
    mode: "production",
    identity: "Developer ID Application: Hexpy Games (TEAM123456)",
    keychain: "/tmp/k.keychain-db",
  });
  expect(() => macSigningConfigFromEnv({ BUTLER_APP_REQUIRE_PRODUCTION_SIGNING: "1" }))
    .toThrow("BUTLER_APP_SIGN_IDENTITY is required for production macOS releases");

  expect(macNotaryConfigFromEnv({})).toBeNull();
  expect(macNotaryConfigFromEnv({ BUTLER_APP_NOTARY_KEYCHAIN_PROFILE: "butler-notary" }))
    .toEqual({ profile: "butler-notary", keychain: null });
  expect(() => macNotaryConfigFromEnv({ BUTLER_APP_REQUIRE_PRODUCTION_SIGNING: "1" }))
    .toThrow("BUTLER_APP_NOTARY_KEYCHAIN_PROFILE is required for production macOS releases");
});

const FIND_IDENTITY_OUTPUT = `
  1) 1111111111111111111111111111111111111111 "Apple Development: Dev Person (AAAAAAAAAA)"
  2) 2222222222222222222222222222222222222222 "Developer ID Application: Hexpy Games (TEAM123456)"
  3) 3333333333333333333333333333333333333333 "Developer ID Application: Other Company (OTHER12345)"
     3 valid identities found
`;

test("Developer ID identity selection is pinned to the release team", () => {
  const identities = parseCodesigningIdentities(FIND_IDENTITY_OUTPUT);
  expect(identities).toEqual([
    { hash: "1111111111111111111111111111111111111111", name: "Apple Development: Dev Person (AAAAAAAAAA)" },
    { hash: "2222222222222222222222222222222222222222", name: "Developer ID Application: Hexpy Games (TEAM123456)" },
    { hash: "3333333333333333333333333333333333333333", name: "Developer ID Application: Other Company (OTHER12345)" },
  ]);
  expect(selectDeveloperIdIdentity(identities, "TEAM123456")).toEqual(identities[1]);
  expect(() => selectDeveloperIdIdentity(identities, "MISSING123"))
    .toThrow("no Developer ID Application identity for team MISSING123");
  expect(() => selectDeveloperIdIdentity(identities, null))
    .toThrow("multiple Developer ID Application identities");
  expect(selectDeveloperIdIdentity(identities.slice(0, 2), null)).toEqual(identities[1]);
  expect(() => selectDeveloperIdIdentity(parseCodesigningIdentities("0 valid identities found"), null))
    .toThrow("no Developer ID Application identity");
});

const DEVELOPER_ID_DISPLAY = `Executable=/tmp/Butler.app/Contents/MacOS/Butler
Identifier=com.hexpy.butler
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=28+7 location=embedded
Hash type=sha256 size=32
Signature size=9046
Authority=Developer ID Application: Hexpy Games (TEAM123456)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Sep 28, 2026 at 10:00:00
Info.plist entries=30
TeamIdentifier=TEAM123456
Runtime Version=15.0.0
Sealed Resources version=2 rules=13 files=100
Internal requirements count=1 size=180
`;

const AD_HOC_DISPLAY = `Executable=/tmp/Butler.app/Contents/Resources/bundled-agent/bin/butler-agent
Identifier=butler-agent-5b3f
Format=Mach-O thin (arm64)
CodeDirectory v=20400 size=5678 flags=0x20002(adhoc,linker-signed) hashes=170+0 location=embedded
Signature=adhoc
TeamIdentifier=not set
`;

test("codesign display parsing reads authority, team, flags and timestamp", () => {
  expect(parseCodesignDisplay(DEVELOPER_ID_DISPLAY)).toEqual({
    identifier: "com.hexpy.butler",
    authorities: [
      "Developer ID Application: Hexpy Games (TEAM123456)",
      "Developer ID Certification Authority",
      "Apple Root CA",
    ],
    teamIdentifier: "TEAM123456",
    flags: ["runtime"],
    timestamped: true,
    adHoc: false,
  });
  expect(parseCodesignDisplay(AD_HOC_DISPLAY)).toMatchObject({
    teamIdentifier: null,
    flags: ["adhoc", "linker-signed"],
    timestamped: false,
    adHoc: true,
  });
});

test("production signature gate rejects ad-hoc, foreign team, unhardened and untimestamped code", () => {
  expect(productionSignatureIssues(parseCodesignDisplay(DEVELOPER_ID_DISPLAY), { teamId: "TEAM123456" })).toEqual([]);
  expect(productionSignatureIssues(parseCodesignDisplay(DEVELOPER_ID_DISPLAY), { teamId: "OTHER12345" }))
    .toEqual(["team identifier TEAM123456 does not match OTHER12345"]);
  expect(productionSignatureIssues(parseCodesignDisplay(AD_HOC_DISPLAY), { teamId: null })).toEqual([
    "ad-hoc signature",
    "not signed with a Developer ID Application certificate",
    "hardened runtime is not enabled",
    "secure timestamp is missing",
  ]);
  const dmg = DEVELOPER_ID_DISPLAY.replace("flags=0x10000(runtime)", "flags=0x0(none)");
  expect(productionSignatureIssues(parseCodesignDisplay(dmg), { teamId: "TEAM123456", requireRuntime: false })).toEqual([]);
});

test("notarytool arguments target the stored keychain profile", () => {
  expect(notarytoolSubmitArguments("/out/Butler.zip", { profile: "butler-notary", keychain: "/tmp/k.keychain-db" })).toEqual([
    "notarytool", "submit", "/out/Butler.zip",
    "--keychain-profile", "butler-notary",
    "--keychain", "/tmp/k.keychain-db",
    "--wait",
    "--output-format", "json",
  ]);
  expect(notarytoolLogArguments("abc-123", { profile: "butler-notary", keychain: null })).toEqual([
    "notarytool", "log", "abc-123", "--keychain-profile", "butler-notary",
  ]);
});

test("notary submission results require an Accepted status", () => {
  expect(parseNotarySubmission('{"id":"abc-123","status":"Accepted","message":"Processing complete"}'))
    .toEqual({ id: "abc-123", status: "Accepted", message: "Processing complete" });
  expect(parseNotarySubmission('Conducting pre-submission checks...\n{"id":"abc-123","status":"Invalid","message":"Processing complete"}\n'))
    .toEqual({ id: "abc-123", status: "Invalid", message: "Processing complete" });
  expect(parseNotarySubmission("Error: HTTP status code: 401")).toBeNull();
});

test("Gatekeeper assessment must come from a notarized Developer ID", () => {
  expect(evaluateGatekeeperAssessment(0, "Butler.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Hexpy Games (TEAM123456)\n"))
    .toEqual({ ok: true, warning: null });
  expect(evaluateGatekeeperAssessment(0, "Butler.app: accepted\nsource=Developer ID\n").ok).toBe(false);
  expect(evaluateGatekeeperAssessment(3, "Butler.app: rejected\nsource=Unnotarized Developer ID\n").ok).toBe(false);
  expect(evaluateGatekeeperAssessment(0, "Butler.app: accepted\noverride=security disabled\n")).toEqual({
    ok: true,
    warning: "Gatekeeper assessments are disabled on this host; notarization is proven by the stapled ticket",
  });
});
