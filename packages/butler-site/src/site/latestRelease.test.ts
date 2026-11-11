// test-category: pure-logic
import { describe, expect, test } from "bun:test";
import { pickDownload, type Release } from "./latestRelease";

function release(tag: string, published: string, names: string[], draft = false): Release {
  const assets = names.map((name) => ({ name, browser_download_url: `https://example.test/${tag}/${name}` }));
  return { tag_name: tag, draft, prerelease: false, published_at: published, assets };
}

describe("pickDownload", () => {
  test("a file missing from the newest release links the newest published release that has it", () => {
    const older = release("v1.0.0", "2026-01-01T00:00:00Z", ["butler-app-1.0.0-linux-arm64.deb", "butler-app-1.0.0-linux-arm64.deb.sha256"]);
    const newer = release("v1.1.0", "2026-02-01T00:00:00Z", ["butler-app-1.1.0-linux-x64.deb"]);
    const draft = release("v1.2.0", "2026-03-01T00:00:00Z", ["butler-app-1.2.0-linux-arm64.deb"], true);
    expect(pickDownload([draft, newer, older], "deb-x64").name).toBe("butler-app-1.1.0-linux-x64.deb");
    expect(pickDownload([draft, newer, older], "deb-arm64")).toEqual({
      name: "butler-app-1.0.0-linux-arm64.deb",
      url: "https://example.test/v1.0.0/butler-app-1.0.0-linux-arm64.deb",
    });
    expect(pickDownload([draft, newer, older], "deb-arm64", true).name).toBe("butler-app-1.0.0-linux-arm64.deb.sha256");
  });
});
