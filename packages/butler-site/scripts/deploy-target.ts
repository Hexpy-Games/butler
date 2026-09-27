/**
 * GitHub Pages target for the site: `site` and `base` for a project page,
 * derived from GITHUB_REPOSITORY or `git remote get-url origin`.
 * SITE_URL and SITE_BASE override either part.
 */
import { execFileSync } from "node:child_process";

export interface DeployTarget {
  site: string;
  base: string;
}

type Env = Record<string, string | undefined>;

export function parseGitHubRemote(url: string): { owner: string; repo: string } | undefined {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u.exec(url.trim());
  return match ? { owner: match[1], repo: match[2] } : undefined;
}

function gitRemote(): string | undefined {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

function normalizeBase(base: string): string {
  const trimmed = base.replace(/^\/+|\/+$/gu, "");
  return trimmed ? `/${trimmed}/` : "/";
}

export function resolveDeployTarget(env: Env = process.env, remote: () => string | undefined = gitRemote): DeployTarget {
  const [envOwner, envRepo] = (env.GITHUB_REPOSITORY ?? "").split("/");
  const fromEnv = envOwner && envRepo ? { owner: envOwner, repo: envRepo } : undefined;
  const repository = fromEnv ?? (() => {
    const url = remote();
    return url ? parseGitHubRemote(url) : undefined;
  })();
  const pagesHost = repository ? `${repository.owner.toLowerCase()}.github.io` : undefined;
  const derivedSite = pagesHost ? `https://${pagesHost}` : "http://localhost:4321";
  const derivedBase = repository && repository.repo.toLowerCase() !== pagesHost ? `/${repository.repo}/` : "/";
  return {
    site: (env.SITE_URL ?? derivedSite).replace(/\/+$/u, ""),
    base: normalizeBase(env.SITE_BASE ?? derivedBase),
  };
}
