import { expect, test } from "bun:test";
import {
  BUTLER_MSI_COMPONENT_GUID,
  BUTLER_MSI_UPGRADE_CODE,
  butlerPerUserMsiWix,
} from "../../packages/butler-app/client/electron/scripts/windows-msi.mjs";

test("Butler MSI is an x64 per-user bootstrapper without machine persistence", () => {
  const wix = butlerPerUserMsiWix({ version: "0.0.19" });

  expect(wix).toContain('Version="0.0.19"');
  expect(wix).toContain('InstallScope="perUser"');
  expect(wix).toContain('InstallPrivileges="limited"');
  expect(wix).toContain('Platform="x64"');
  expect(wix).toContain('<Directory Id="LocalAppDataFolder">');
  expect(wix).toContain('File Id="ButlerBootstrapper"');
  expect(wix).toContain('RegistryValue Root="HKCU"');
  expect(wix).toContain('RemoveFolder Id="RemoveButlerInstallerDirectory"');
  expect(wix).toContain('CustomAction Id="InstallButler"');
  expect(wix).toContain('CustomAction Id="UninstallButler"');
  expect(wix).not.toContain("ProgramFilesFolder");
  expect(wix).not.toContain("HKLM");
  expect(wix).not.toContain("CurrentVersion\\Run");
  expect(BUTLER_MSI_UPGRADE_CODE).toMatch(/^[0-9A-F-]{36}$/u);
  expect(BUTLER_MSI_COMPONENT_GUID).toMatch(/^[0-9A-F-]{36}$/u);
});

test("Butler MSI rejects versions outside the Windows Installer range", () => {
  expect(() => butlerPerUserMsiWix({ version: "1.2" })).toThrow(
    "Windows MSI version must contain three numeric components",
  );
  expect(() => butlerPerUserMsiWix({ version: "1.2.65535" })).toThrow(
    "Windows MSI version component is out of range",
  );
});
