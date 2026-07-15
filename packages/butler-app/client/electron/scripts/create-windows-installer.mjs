#!/usr/bin/env node
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { windowsPowerShellEnvironment } from "../windows-powershell-environment.mjs";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Butler Squirrel packaging requires Windows x64");
}

const require = createRequire(import.meta.url);
const { createWindowsInstaller } = require("electron-winstaller");
const { sign } = require("@electron/windows-sign");
const appDirectory = requiredOption("--app-directory");
const outputDirectory = requiredOption("--output-directory");
const setupExe = requiredOption("--setup-exe");
const setupIcon = requiredOption("--setup-icon");
const version = requiredOption("--version");
const certificateFile = process.env.BUTLER_WINDOWS_SIGN_CERTIFICATE_FILE?.trim();
const certificatePassword =
  process.env.BUTLER_WINDOWS_SIGN_CERTIFICATE_PASSWORD ?? "";
const certificateThumbprint =
  process.env.BUTLER_WINDOWS_SIGN_CERTIFICATE_SHA1?.trim().toUpperCase();

if (
  certificateThumbprint &&
  !/^[A-F0-9]{40}$/u.test(certificateThumbprint)
) {
  throw new Error("Windows signing certificate thumbprint is invalid");
}

if (
  process.env.BUTLER_APP_REQUIRE_PRODUCTION_SIGNING === "1" &&
  !certificateFile &&
  !certificateThumbprint
) {
  throw new Error(
    "A Windows signing certificate file or CurrentUser certificate thumbprint is required for production Windows releases",
  );
}

const signingOptions = certificateFile
  ? {
      certificateFile: resolve(certificateFile),
      certificatePassword,
    }
  : certificateThumbprint
    ? {
        signWithParams: `/sha1 ${certificateThumbprint} /fd SHA256`,
      }
    : null;

if (signingOptions) {
  const signingFailures = [];
  await sign({
    appDirectory: resolve(appDirectory),
    description: "Butler",
    hashes: ["sha256"],
    ...(certificateThumbprint
      ? {
          hookFunction: (path) => {
            try {
              signWithCurrentUserCertificate(path, certificateThumbprint);
            } catch {
              signingFailures.push(path);
            }
          },
        }
      : signingOptions),
  });
  if (signingFailures.length > 0) {
    throw new Error(
      `Windows packaged PE signing failed for ${signingFailures.length} file(s)`,
    );
  }
}

await createWindowsInstaller({
  appDirectory: resolve(appDirectory),
  outputDirectory: resolve(outputDirectory),
  authors: "Hexpy Games",
  owners: "Hexpy Games",
  description: "Butler dedicated desktop client",
  title: "Butler",
  name: "butler-app",
  exe: "Butler.exe",
  version,
  setupExe,
  setupIcon: resolve(setupIcon),
  iconUrl:
    "https://raw.githubusercontent.com/Hexpy-Games/butler/main/packages/butler-app/client/electron/assets/butler.ico",
  noMsi: true,
  ...(signingOptions ?? {}),
});

function requiredOption(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : "";
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function signWithCurrentUserCertificate(path, thumbprint) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$certificate = Get-Item -LiteralPath ('Cert:\\CurrentUser\\My\\' + $env:BUTLER_SIGN_THUMBPRINT)",
    "$parameters = @{ LiteralPath = $env:BUTLER_SIGN_PATH; Certificate = $certificate; HashAlgorithm = 'SHA256' }",
    "if ($env:BUTLER_SIGN_TIMESTAMP_SERVER) { $parameters.TimestampServer = $env:BUTLER_SIGN_TIMESTAMP_SERVER }",
    "$signature = Set-AuthenticodeSignature @parameters",
    "if ([string]$signature.Status -ne 'Valid') { throw 'signature_invalid' }",
  ].join("; ");
  const result = spawnSync(
    process.env.BUTLER_POWERSHELL || "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    {
      encoding: "utf8",
      env: windowsPowerShellEnvironment(process.env, {
        BUTLER_SIGN_PATH: path,
        BUTLER_SIGN_THUMBPRINT: thumbprint,
        BUTLER_SIGN_TIMESTAMP_SERVER:
          process.env.BUTLER_WINDOWS_SIGN_TIMESTAMP_SERVER ?? "",
      }),
      shell: false,
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    throw new Error("Windows packaged PE signing failed");
  }
}
