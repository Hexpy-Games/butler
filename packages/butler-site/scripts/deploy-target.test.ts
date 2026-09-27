import { describe, expect, test } from "bun:test";
import { parseGitHubRemote, resolveDeployTarget } from "./deploy-target";

describe("parseGitHubRemote", () => {
  test("reads owner and repo from https and ssh remotes", () => {
    expect(parseGitHubRemote("https://github.com/Hexpy-Games/butler.git")).toEqual({ owner: "Hexpy-Games", repo: "butler" });
    expect(parseGitHubRemote("git@github.com:Hexpy-Games/butler.git")).toEqual({ owner: "Hexpy-Games", repo: "butler" });
    expect(parseGitHubRemote("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
  });

  test("ignores non-GitHub remotes", () => {
    expect(parseGitHubRemote("https://gitlab.com/a/b.git")).toBeUndefined();
  });
});

describe("resolveDeployTarget", () => {
  test("derives the GitHub Pages project URL from the remote", () => {
    expect(resolveDeployTarget({}, () => "git@github.com:Hexpy-Games/butler.git"))
      .toEqual({ site: "https://hexpy-games.github.io", base: "/butler/" });
  });

  test("a user/organization pages repository is served from the root", () => {
    expect(resolveDeployTarget({}, () => "https://github.com/octo/octo.github.io.git"))
      .toEqual({ site: "https://octo.github.io", base: "/" });
  });

  test("GITHUB_REPOSITORY wins over the remote, and SITE_URL / SITE_BASE win over both", () => {
    expect(resolveDeployTarget({ GITHUB_REPOSITORY: "acme/docs" }, () => "git@github.com:x/y.git"))
      .toEqual({ site: "https://acme.github.io", base: "/docs/" });
    expect(resolveDeployTarget({ SITE_URL: "https://docs.example.com/", SITE_BASE: "/" }, () => undefined))
      .toEqual({ site: "https://docs.example.com", base: "/" });
    expect(resolveDeployTarget({ SITE_BASE: "guide" }, () => "git@github.com:a/b.git"))
      .toEqual({ site: "https://a.github.io", base: "/guide/" });
  });

  test("falls back to a local root without a remote", () => {
    expect(resolveDeployTarget({}, () => undefined)).toEqual({ site: "http://localhost:4321", base: "/" });
  });
});
