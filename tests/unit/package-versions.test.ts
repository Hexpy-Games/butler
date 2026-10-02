import { expect, test } from "bun:test";
import { archPackageVersion, debPackageVersion } from "../../packages/butler-app/scripts/release/package-versions.ts";

// test-category: pure-logic
test("Linux package prereleases precede stable without changing release identities", () => {
  for (const number of [5, 9, 10, 99]) {
    const exact = `0.1.0-preview.${number}`;
    expect(archPackageVersion(exact)).toBe(`0.1.0preview.${number}`);
    expect(debPackageVersion(exact)).toBe(`0.1.0~preview.${number}`);
  }
  expect(archPackageVersion("0.1.0")).toBe("0.1.0");
  expect(debPackageVersion("0.1.0")).toBe("0.1.0");
  expect(archPackageVersion("0.1.0-preview.5+build.1")).toBe("0.1.0preview.5");
  expect(archPackageVersion("0.1.0-1")).toBe("0.1.0pre1");
  expect(() => archPackageVersion("not a version")).toThrow("Invalid package version");
});
