import { describe, expect, test } from "bun:test";
import { leakRules, scanText } from "../smoke/ds-site-leak-check.ts";

const rules = leakRules({ BUTLER_LEAK_PATTERNS: "private-tunnel\\.example\\.net" });

describe("ds-site leak check", () => {
  test("flags local paths, tokens, private hosts and extra patterns", () => {
    const text = [
      "/Users/alice/projects/app",
      "C:\\Users\\alice\\app",
      "sk-abcdefghijklmnopqrstuvwxyz0123",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "https://demo-1.trycloudflare.com",
      "internal.hexpy.games",
      "https://private-tunnel.example.net",
    ].join("\n");
    const names = scanText("assets/index.js", text, rules).map((finding) => finding.rule);
    expect(names).toEqual(expect.arrayContaining([
      "macOS home path",
      "Windows home path",
      "OpenAI-style key",
      "GitHub token",
      "Cloudflare tunnel host",
      "hexpy.games host",
      "BUTLER_LEAK_PATTERNS entry",
    ]));
  });

  test("allows neutral fixture users and the site's own CNAME", () => {
    expect(scanText("assets/index.js", "/Users/butler/projects/x /Users/example/a", rules)).toEqual([]);
    expect(scanText("CNAME", "butler-design.hexpy.games\n", rules)).toEqual([]);
    expect(scanText("index.html", "butler-design.hexpy.games", rules)).toHaveLength(1);
  });
});
