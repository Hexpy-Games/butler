import { existsSync, readFileSync } from "fs";
import type {
  RuntimeSessionInit,
  SessionRole,
} from "../../test-support/harness/contracts.ts";
import { butlerAgentResourcesPath } from "../../runtime/paths.ts";

export interface SessionContextPolicyCatalog {
  schema: string;
  updatedAt?: string;
  policies: SessionContextPolicy[];
}

export interface SessionContextPolicy {
  id: string;
  status: "active" | "disabled" | string;
  description?: string;
  match: SessionContextPolicyMatch;
  context: {
    title: string;
    lines: string[];
  };
}

export interface SessionContextPolicyMatch {
  roles?: SessionRole[];
  metadataAny?: Array<{
    key: string;
    type?: "string" | "boolean" | "number";
  }>;
}

export function loadSessionContextPolicyCatalog(
  butlerHome: string,
): SessionContextPolicyCatalog {
  const path = butlerAgentResourcesPath(
    butlerHome,
    "runtime-policies",
    "session-context-policies.json",
  );
  if (!existsSync(path)) {
    return {
      schema: "butler.runtime.session_context_policies.v1",
      policies: [],
    };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionContextPolicyCatalog>;
  return {
    schema: typeof parsed.schema === "string"
      ? parsed.schema
      : "butler.runtime.session_context_policies.v1",
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
    policies: Array.isArray(parsed.policies)
      ? parsed.policies.filter(isSessionContextPolicy)
      : [],
  };
}

export function renderSessionContextPolicyContext(input: {
  catalog: SessionContextPolicyCatalog;
  session: RuntimeSessionInit;
}): string {
  const sections = input.catalog.policies
    .filter((policy) => policy.status === "active")
    .filter((policy) => matchesPolicy(policy.match, input.session))
    .map((policy) => renderPolicy(policy, input.session))
    .filter(Boolean);
  return sections.join("\n\n");
}

function renderPolicy(
  policy: SessionContextPolicy,
  session: RuntimeSessionInit,
): string {
  const title = policy.context.title.trim();
  const lines = policy.context.lines
    .map((line) => renderTemplate(line, session).trim())
    .filter(Boolean);
  if (!title || lines.length === 0) return "";
  return [`## ${title}`, ...lines].join("\n");
}

function renderTemplate(value: string, session: RuntimeSessionInit): string {
  return value
    .replaceAll("{{session.role}}", session.role)
    .replaceAll("{{workspacePath}}", session.workspacePath.trim())
    .replace(/\{\{metadata\.([A-Za-z0-9_.-]+)\}\}/gu, (_match, key: string) => {
      const metadataValue = session.metadata?.[key];
      return typeof metadataValue === "string" || typeof metadataValue === "number" ||
          typeof metadataValue === "boolean"
        ? String(metadataValue)
        : "";
    });
}

function matchesPolicy(
  match: SessionContextPolicyMatch,
  session: RuntimeSessionInit,
): boolean {
  if (match.roles?.length && !match.roles.includes(session.role)) return false;
  const metadata = session.metadata ?? {};
  const metadataMatches = match.metadataAny?.some((item) => {
    const value = metadata[item.key];
    if (item.type === "string") return typeof value === "string" && value.trim().length > 0;
    if (item.type === "boolean") return typeof value === "boolean";
    if (item.type === "number") return typeof value === "number" && Number.isFinite(value);
    return value !== undefined && value !== null;
  }) ?? true;
  return metadataMatches;
}

function isSessionContextPolicy(value: unknown): value is SessionContextPolicy {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SessionContextPolicy>;
  return typeof record.id === "string" &&
    record.match !== undefined &&
    record.context !== undefined &&
    typeof record.context.title === "string" &&
    Array.isArray(record.context.lines);
}
