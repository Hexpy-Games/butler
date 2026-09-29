import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, relative, resolve } from "node:path";

// Leak check for the public DS site build (dist-ds-site/): no local absolute paths, usernames,
// credentials, private hostnames or real-looking personal data may ship. Extra private strings
// (tunnel hostnames, emails) come from BUTLER_LEAK_PATTERNS (comma-separated regexes) so they are
// never written into this public repository.

export interface LeakRule {
  name: string;
  pattern: RegExp;
}

export interface LeakFinding {
  file: string;
  rule: string;
  match: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function leakRules(env: Record<string, string | undefined> = process.env): LeakRule[] {
  const rules: LeakRule[] = [
    // Showcase fixtures use the neutral users "butler" and "example"; any other /Users/<name> is a leak.
    { name: "macOS home path", pattern: /\/Users\/(?!(?:butler|example)\/)[A-Za-z0-9._-]+/g },
    { name: "Linux home path", pattern: /\/home\/(?!(?:butler|example)\/)[A-Za-z0-9._-]+\//g },
    { name: "Windows home path", pattern: /[A-Za-z]:\\+Users\\+[A-Za-z0-9._-]+/g },
    { name: "Butler data dir", pattern: /~?\/\.butler\/[A-Za-z0-9._/-]+/g },
    { name: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
    { name: "Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}/g },
    { name: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
    { name: "Slack token", pattern: /\bxox[abpors]-[A-Za-z0-9-]{10,}/g },
    { name: "AWS key id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
    { name: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
    { name: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
    { name: "Cloudflare tunnel host", pattern: /\b[a-z0-9-]+\.(?:trycloudflare|cfargotunnel)\.com\b/gi },
    { name: "hexpy.games host", pattern: /\b(?:[a-z0-9-]+\.)*hexpy\.games\b/gi },
  ];
  const user = safeUsername();
  if (user && user.length >= 3 && !["root", "runner", "user"].includes(user)) {
    rules.push({ name: "local username", pattern: new RegExp(`\\b${escapeRegExp(user)}\\b`, "gi") });
  }
  const home = homedir();
  if (home && home.length > 1) rules.push({ name: "local home dir", pattern: new RegExp(escapeRegExp(home), "g") });
  for (const source of (env.BUTLER_LEAK_PATTERNS ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
    rules.push({ name: "BUTLER_LEAK_PATTERNS entry", pattern: new RegExp(source, "gi") });
  }
  return rules;
}

function safeUsername(): string | null {
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}

// The site's own domain is expected in CNAME and nowhere else is it a leak.
const ALLOWED: Array<{ file: RegExp; match: RegExp }> = [
  { file: /^CNAME$/, match: /^butler-design\.hexpy\.games$/i },
];

const TEXT_FILE = /\.(?:html|js|mjs|css|json|txt|md|svg|map|xml|webmanifest)$|^CNAME$/;

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

export function scanText(file: string, text: string, rules: LeakRule[]): LeakFinding[] {
  const findings: LeakFinding[] = [];
  for (const rule of rules) {
    for (const match of text.matchAll(rule.pattern)) {
      const value = match[0];
      if (ALLOWED.some((allow) => allow.file.test(file) && allow.match.test(value))) continue;
      findings.push({ file, rule: rule.name, match: value });
    }
  }
  return findings;
}

export function scanDist(distDir: string, rules = leakRules()): LeakFinding[] {
  return listFiles(distDir)
    .map((full) => relative(distDir, full).split("\\").join("/"))
    .filter((file) => TEXT_FILE.test(file.split("/").pop() ?? ""))
    .flatMap((file) => scanText(file, readFileSync(join(distDir, file), "utf8"), rules));
}

/** Masks the middle of a finding so the report never re-prints a secret in full. */
function mask(value: string): string {
  return value.length <= 8 ? value : `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`;
}

if (import.meta.main) {
  const distDir = resolve(process.argv[2] ?? join(process.cwd(), "packages", "butler-app", "client", "ui", "dist-ds-site"));
  const findings = scanDist(distDir);
  if (findings.length > 0) {
    for (const finding of findings) console.error(`${finding.file}: ${finding.rule}: ${mask(finding.match)}`);
    console.error(`ds-site leak check failed: ${findings.length} finding(s) in ${distDir}`);
    process.exit(1);
  }
  console.log(`ds-site leak check passed: ${listFiles(distDir).length} files in ${distDir}`);
}
