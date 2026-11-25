// test-category: pure-logic
import { expect, test } from "bun:test";
import { storePackageVersion } from "../../packages/butler-app/scripts/windows/store/store-version.ts";

test("Store package versions preserve release order", () => {
  const rows = [
    ["0.1.0-preview.0", "1.1.0.0"],
    ["0.1.0-preview.17", "1.1.17.0"],
    ["0.1.0", "1.1.999.0"],
    ["0.1.1-preview.1", "1.1.1001.0"],
    ["0.1.1", "1.1.1999.0"],
    ["0.2.0-preview.1", "1.2.1.0"],
    ["1.0.0", "2.0.999.0"],
  ];
  let previous: number[] | undefined;
  for (const [app, store] of rows) {
    const actual = storePackageVersion(app);
    expect(actual).toBe(store);
    const parts = actual.split(".").map(Number);
    if (previous) {
      const differing = parts.findIndex((part, index) => part !== previous![index]);
      expect(differing).toBeGreaterThanOrEqual(0);
      expect(parts[differing]).toBeGreaterThan(previous[differing]);
    }
    previous = parts;
  }
  for (const app of ["0.1.0-preview.999", "0.1.65", "0.1.0-beta.1", "65535.0.0"]) {
    expect(() => storePackageVersion(app)).toThrow();
  }
});
