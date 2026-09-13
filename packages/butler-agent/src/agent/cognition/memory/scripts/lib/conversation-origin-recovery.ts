import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { ConversationOriginEvidence } from "../../../../conversation/types.ts";
import { AgentConversationStore } from "../../../../conversation/store.ts";
import { classifyConversationOrigin } from "../../../../conversation/session-admission.ts";
import { readPersistedConversationAdmissionEvidence, readPersistedSubsessionOriginIndex } from "../../../../adapters/btcc/sqlite/turn-admission-repository.ts";
import { agentBtccStoragePaths } from "../../../../adapters/btcc/sqlite/storage-ownership/index.ts";
import { readHistoricalAppOriginEvidence } from "../../../../conversation/historical-recovery-runtime.ts";
import { NativeInboundQueue, type PersistedOriginEvidence } from "../../../../../gateways/core/inbound-queue.ts";

export function classifyHistoricalConversationOrigins(butlerData: string, options: { signal?: AbortSignal; deadlineAt?: number } = {}) {
  const store = new AgentConversationStore({ butlerData });
  const queue = new NativeInboundQueue(butlerData);
  const paths = agentBtccStoragePaths(butlerData);
  const btcc = existsSync(paths.agentBtccDbPath) ? new Database(paths.agentBtccDbPath, { readonly: true }) : null;
  const appPath = paths.legacyAppDbPath;
  let applied = 0, unchanged = 0, unknown = 0, pending = 0;
  const deadlineAt = options.deadlineAt ?? Date.now() + 60_000;
  const record = (row: ReturnType<AgentConversationStore["readOriginCandidatesPage"]>[number], decision: ReturnType<typeof classifyConversationOrigin>, correctInternalOrigin = false) => {
    if (!decision.complete) throw new Error("memory_origin_evidence_unavailable");
    const result = store.recordOriginClassification({ ...row, decision, correctInternalOrigin });
    if (result === "applied") applied += 1;
    else if (result === "unchanged") unchanged += 1;
    else if (result === "classification_conflict") throw new Error("memory_origin_classification_conflict");
    else throw new Error("memory_source_changed");
    if (decision.kind === "unknown") unknown += 1;
  };
  try {
    const subsessionOrigins = btcc ? readPersistedSubsessionOriginIndex(btcc) : new Map<string, ConversationOriginEvidence>();
    // Requests are classified before outcomes so an assistant can only inherit an
    // origin from the exact, already-classified request referenced by its outcome.
    for (const role of ["user", "assistant"] as const) {
      let after: string | null = null;
      while (true) {
      if (options.signal?.aborted || Date.now() >= deadlineAt) throw new Error("memory_origin_evidence_unavailable");
      const rows = store.readOriginCandidatesPage(after, 100);
      if (!rows.length) break;
      after = rows.at(-1)!.message_id;
      const selected = rows.filter((row) => row.role === role && !row.origin_version);
      const locators = selected.flatMap((row) => row.role === "user" && row.external_session_id && row.source_ref
        ? [{ eventId: row.source_ref, runtimeSessionId: row.external_session_id, turnId: row.turn_id }]
        : []);
      const queueMatches = new Map<string, PersistedOriginEvidence>();
      let queueAvailable = true;
      let queueComplete = locators.length === 0;
      let queueCursor: string | null = null;
      while (locators.length && !queueComplete) {
        const page = queue.readPersistedOriginEvidenceBatch(locators, {
          cursor: queueCursor,
          limit: 500,
          signal: options.signal,
          deadlineAt,
        });
        if (!page.available) { queueAvailable = false; break; }
        for (const [key, value] of page.matches) queueMatches.set(key, value);
        queueComplete = page.complete;
        if (!queueComplete && page.cursor === queueCursor) { queueAvailable = false; break; }
        queueCursor = page.cursor;
      }
      for (const row of rows) {
        if (options.signal?.aborted || Date.now() >= deadlineAt) throw new Error("memory_origin_evidence_unavailable");
        if (row.role !== role) continue;
        const outboxEvidence = role === "user" && row.external_session_id && row.source_ref
          ? subsessionOrigins.get(`${row.external_session_id}\0${row.source_ref}`)
          : undefined;
        if (outboxEvidence && row.origin_kind !== "internal_control") {
          record(row, classifyConversationOrigin({ ref: row.source_ref, publicIngress: false,
            internalControl: true, evidenceAvailable: true, evidence: [outboxEvidence] }), true);
          continue;
        }
        if (role === "user" && row.origin_version) { unchanged += 1; continue; }
        if (role === "assistant") {
          if (row.turn_id && !row.outcome_id) { pending += 1; continue; }
          const request = row.outcome_request_message_id ? store.readMessageById(row.outcome_request_message_id) : null;
          const exactOutcome = row.outcome_public_assistant_message_id === row.message_id &&
            request?.session_id === row.session_id && request?.turn_id === row.turn_id;
          const requestEvidence = request?.origin_evidence_json
            ? JSON.parse(request.origin_evidence_json) as ReturnType<typeof classifyConversationOrigin>["evidence"] : [];
          const correctInternalOrigin = Boolean(exactOutcome && request?.origin_kind === "internal_control" &&
            requestEvidence.some((evidence) => evidence.kind === "subsession" && evidence.sha256 !== null));
          if (row.origin_version && (!correctInternalOrigin || row.origin_kind === "internal_control")) {
            unchanged += 1; continue;
          }
          const publicResult = exactOutcome && request?.origin_kind === "user_input";
          const internal = exactOutcome && request?.origin_kind === "internal_control";
          let decision = classifyConversationOrigin({ ref: row.source_ref, publicIngress: publicResult,
            internalControl: internal,
            // A durable outcome with no request reference proves absence, while a
            // non-null reference still requires the exact classified request.
            evidenceAvailable: !row.outcome_id || row.turn_id === null ||
              row.outcome_request_message_id === null || Boolean(request?.origin_version), evidence: row.outcome_id
              ? [...(correctInternalOrigin ? requestEvidence : []), { kind: "turn_outcome", ref: row.outcome_id, sha256: null }] : [] });
          if (decision.kind === "user_input") decision = { ...decision, kind: "assistant_public" as const, reason: "verified_public_outcome" };
          record(row, decision, correctInternalOrigin);
        } else {
          const admission = btcc && row.external_session_id && row.turn_id && row.source_ref
            ? readPersistedConversationAdmissionEvidence(btcc, { canonicalSessionId: row.session_id,
              turnId: row.turn_id, requestId: row.request_id, sourceRef: row.source_ref,
              gateway: row.source_gateway, runtimeSessionId: row.external_session_id })
            : { available: true, matched: false, publicIngress: false, internalControl: false, evidence: [] };
          const app = readHistoricalAppOriginEvidence({ dbPath: appPath, canonicalSessionId: row.session_id,
            canonicalTurnId: row.turn_id, canonicalMessageId: row.message_id, externalSessionId: row.external_session_id });
          const inbound = row.source_ref
            ? queueMatches.get(row.source_ref) ?? { matched: false, internalControl: false, ref: null, sha256: null }
            : { matched: false, internalControl: false, ref: null, sha256: null };
          const evidence = [...admission.evidence,
            ...(app.matched && app.ref ? [{ kind: "app_ingress" as const, ref: app.ref, sha256: app.sha256 }] : []),
            ...(inbound.matched && inbound.ref ? [{ kind: "gateway_ingress" as const, ref: inbound.ref, sha256: inbound.sha256 }] : [])];
          const internal = admission.internalControl || app.internalControl || inbound.internalControl;
          const positive = admission.publicIngress || app.matched && !app.internalControl || inbound.matched && !inbound.internalControl;
          const decision = classifyConversationOrigin({ ref: row.source_ref, publicIngress: positive,
            internalControl: internal,
            evidenceAvailable: positive || internal || admission.available && app.available && queueAvailable && queueComplete,
            evidence });
          record(row, decision);
        }
      }
      if (rows.length < 100) break;
      }
    }
    return { version: "conversation-origin-v1", applied, unchanged, unknown, pending };
  } finally { btcc?.close(); store.close(); }
}
