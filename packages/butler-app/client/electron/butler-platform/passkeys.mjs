// Electron has no WebAuthn UI on macOS or Linux, so a passkey request there waits with nothing on screen.
// Windows hands it to the OS passkey sheet.
export function passkeyPageArgs(platform = process.platform) {
  return platform === "win32" ? [] : ["--butler-no-passkey-ui"];
}
