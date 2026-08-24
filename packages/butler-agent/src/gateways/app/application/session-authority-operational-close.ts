import type {
  AuthorityOperationalCloseReason,
  AuthorityOperationalCloseResult,
  PrincipalAuthority,
} from "../../../agent/btcc/authority/index.ts";
import type { ProjectActionResult, SessionActionResult } from "../interface/protocol/app-protocol.ts";
import type { AppStoreNavigationProjectApi } from "./store-api/navigation-project-store-api.ts";
import { sessionHintForRow } from "../domain/sessions/session-read-model.ts";

/** Real App session lifecycle stop that operationally closes open requests. */
export type SessionLifecycleStopTrigger =
  | "archive"
  | "permanent_delete";

export type ProjectLifecycleAction = "archive" | "delete" | "permanent_delete";

const CLOSE_REASON_BY_TRIGGER: Record<
  SessionLifecycleStopTrigger,
  AuthorityOperationalCloseReason
> = {
  archive: "session_archived",
  permanent_delete: "session_permanently_deleted",
};

/** Mixed public metadata carried alongside a session archive stop. */
export type SessionLifecycleStopMetadata = { title?: string };

/** Mixed public metadata carried alongside a project archive action. */
export type ProjectLifecycleActionMetadata = {
  displayName?: string;
  pinned?: boolean;
};

/**
 * Single application workflow for every public App session lifecycle stop that
 * archives (POST /sessions/:id/archive and PATCH /sessions/:id with
 * archived:true) or permanently deletes: validates the factual session exists
 * (same failure as the lifecycle mutation), durably operational-closes only
 * the still-open authority requests whose owning AND source self-session match
 * this App session, then invokes the existing session mutation itself,
 * carrying any simultaneous title update through the same adapter. It never
 * manufactures a card decision and leaves decided or terminal-outcome records
 * untouched.
 *
 * Fail-safe invariant: the authority database and the App lifecycle database
 * are separate durable resources with no cross-resource atomicity. The
 * intentional order is validate factual target -> durable authority close ->
 * lifecycle mutation. If the lifecycle mutation fails after the close, the
 * authority request stays operationally closed, the card stays absent, and no
 * later decision/scheduling/execution is possible; retries are idempotent.
 * This accepted fail-safe behavior deliberately has neither rollback nor a
 * distributed transaction.
 */
export function sessionLifecycleStopWithAuthorityClose(input: {
  authority: PrincipalAuthority;
  store: Pick<
    AppStoreNavigationProjectApi,
    "getSession" | "archiveSession" | "deleteSessionPermanent"
  >;
  sessionId: string;
  stop: SessionLifecycleStopTrigger;
  metadata?: SessionLifecycleStopMetadata;
}): SessionActionResult {
  input.store.getSession(input.sessionId);
  closeSelfSessionRequests({
    authority: input.authority,
    sessionId: input.sessionId,
    trigger: input.stop,
  });
  return input.stop === "permanent_delete"
    ? input.store.deleteSessionPermanent(input.sessionId)
    : input.store.archiveSession(input.sessionId, input.metadata);
}

/**
 * Single application workflow for every public App project lifecycle action
 * that archives or deletes (POST /projects/:id/archive, DELETE /projects/:id,
 * and PATCH /projects/:id with archived:true): resolves every factual session
 * id of an existing project (including already archived sessions), routes each
 * through the same self-session operational-close operation, then invokes the
 * existing project mutation itself, carrying any simultaneous display_name/
 * pinned update through the same adapter. An absent project yields no close
 * targets and fails with the existing mutation error.
 *
 * Fail-safe invariant: identical to the session workflow above. The authority
 * close of each factual project session is durable before the project mutation
 * runs; if that mutation fails afterwards, every already-closed request stays
 * operationally closed with no rollback and retries stay idempotent.
 */
export function projectLifecycleActionWithAuthorityClose(input: {
  authority: PrincipalAuthority;
  store: Pick<
    AppStoreNavigationProjectApi,
    | "projectSessionIdsForLifecycle"
    | "archiveProject"
    | "deleteProject"
    | "deleteProjectPermanent"
  >;
  projectId: string;
  action: ProjectLifecycleAction;
  metadata?: ProjectLifecycleActionMetadata;
}): ProjectActionResult {
  const trigger: SessionLifecycleStopTrigger = input.action === "permanent_delete"
    ? "permanent_delete"
    : "archive";
  for (const sessionId of input.store.projectSessionIdsForLifecycle(input.projectId)) {
    closeSelfSessionRequests({
      authority: input.authority,
      sessionId,
      trigger,
    });
  }
  switch (input.action) {
    case "archive":
      return input.store.archiveProject(input.projectId, input.metadata);
    case "delete":
      return input.store.deleteProject(input.projectId);
    case "permanent_delete":
      return input.store.deleteProjectPermanent(input.projectId);
  }
}

function closeSelfSessionRequests(input: {
  authority: PrincipalAuthority;
  sessionId: string;
  trigger: SessionLifecycleStopTrigger;
}): AuthorityOperationalCloseResult {
  if (!input.sessionId.trim()) {
    throw new SessionAuthorityOperationalCloseError(
      "session_authority_close_session_missing",
    );
  }
  return input.authority.closeSelfSession({
    selfSessionId: sessionHintForRow(input.sessionId),
    reason: CLOSE_REASON_BY_TRIGGER[input.trigger],
  });
}

export class SessionAuthorityOperationalCloseError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SessionAuthorityOperationalCloseError";
  }
}
