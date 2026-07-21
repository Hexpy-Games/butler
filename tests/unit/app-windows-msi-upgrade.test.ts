import { expect, test } from "bun:test";

import { butlerPerUserMsiWix } from "../../packages/butler-app/client/electron/scripts/windows-msi.mjs";

test("Butler MSI skips Squirrel uninstall during same-version MajorUpgrade", () => {
  const wix = butlerPerUserMsiWix({ version: "0.0.19" });

  expect(wix).toContain('MajorUpgrade AllowSameVersionUpgrades="yes"');
  expect(wix).toContain(
    '<Custom Action="UninstallButler" Before="RemoveFiles">REMOVE=&quot;ALL&quot; AND NOT UPGRADINGPRODUCTCODE</Custom>',
  );
  expect(wix).not.toContain(
    '<Custom Action="UninstallButler" Before="RemoveFiles">REMOVE=&quot;ALL&quot;</Custom>',
  );
});
