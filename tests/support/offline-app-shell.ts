// The reads the App shell issues on every surface (global dialogs, session
// header, composer, sidebar), answered offline with the gateway's empty state
// for a signed-in install. Each body is checked against the client's own
// response type, so a shape change fails typecheck. Smokes that serve the
// built App without a gateway route these here and refuse everything else
// through `refuseUnrouted`, so a new read fails by name instead of drifting
// into a fake success.
import type { Route } from "playwright";
import type { CanonGrant } from "../../packages/butler-app/client/ui/src/app/canonTrust.ts";
import type { AuthorityRequestsTransportView, ChatGptAccountView, ConversationPermissionView, NewChatBriefingView, PersonalizationView,
  SessionQueueView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import type { CanonOverview, CanonSidebar } from "../../packages/butler-app/client/shared/canon-contracts.ts";
import type { SessionPendingAsks } from "../../packages/butler-app/client/shared/pending-asks-contracts.ts";

const at = "2026-10-25T09:00:00Z";

/** The gateway's empty answer to an App shell read, or undefined when `url` is not one. */
export function appShellRead(url: URL, method: string): unknown {
  if (method !== "GET") return undefined;
  const { pathname: path, searchParams: query } = url;
  const segment = (pattern: RegExp) => { const match = path.match(pattern); return match ? decodeURIComponent(match[1]!) : undefined; };
  const session = segment(/^\/sessions\/([^/]+)\/pending-asks$/u);
  if (session) return { session_id: session, open_count: 0, asks: [] } satisfies SessionPendingAsks;
  const sidebar = segment(/^\/projects\/([^/]+)\/canon\/sidebar$/u);
  if (sidebar) return { project_id: sidebar, groups: [] } satisfies CanonSidebar;
  const project = segment(/^\/projects\/([^/]+)\/canon$/u);
  if (project) return { project_id: project, backlog_revision: 0, backlog: [], plans: [] } satisfies CanonOverview;
  switch (path) {
    case "/canon/mcp-grants": return { grants: [] } satisfies { grants: CanonGrant[] };
    case "/authority-requests": return { session_id: query.get("session_id"), requests: [], permissions: [] } satisfies
      AuthorityRequestsTransportView & { permissions: ConversationPermissionView[] };
    case "/session-queue": return { session_id: query.get("session_id") ?? "", queued_messages: [] } satisfies SessionQueueView;
    case "/setup/chatgpt-account": return { status: "signed_in", label: null, plan_notice_pending: false,
      legacy_prompt_pending: false } satisfies ChatGptAccountView;
    case "/personalization": return personalization;
    case "/new-chat-briefing": return { moment: "", title: "", suggestions: [], raw_text_included: false,
      source: { scope: query.has("project_id") ? "project" : "general", content_origin: "heuristic_fallback", consolidation_run_id: null,
        generated_at: at, locale: "ko", persona_applied: false, profile_projection_applied: false } } satisfies NewChatBriefingView;
  }
  return undefined;
}

/** Records a request no route answers and refuses it the way the gateway refuses an unknown path. */
export function refuseUnrouted(route: Route, unrouted: string[]) {
  const url = new URL(route.request().url());
  unrouted.push(`${route.request().method()} ${url.pathname}`);
  return route.fulfill({ status: 404, json: { ok: false, error: { code: "not_found" } } });
}

const personalization = {
  persona: "", eol: "", updated_at: at, persona_presets: [],
  profile: { butler_nickname: "", principal_name: "", preferred_address: "", updated_at: null, storage_label: "" },
  profiling: { mode: "off", enabled: false, consent_version: "", consented_at: null, storage_label: "", raw_profile_browser_visible: false,
    extractor_model: "", effective_extractor_model: "", extractor_uses_butler_model: true },
} satisfies PersonalizationView;
