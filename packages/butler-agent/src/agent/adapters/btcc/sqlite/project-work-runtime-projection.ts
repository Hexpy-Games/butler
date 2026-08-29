import type { Database } from "bun:sqlite";
import {
  applyWorkActionUpdates,
  dispositionMaterialFingerprint,
  type DurableWorkView,
  type RecordWorkDispositionCommand,
} from "../../../btcc/work/index.ts";
import type {
  ProjectWorkOperationIdentity,
  ProjectWorkRuntimeProjection,
} from "../project-ledger/index.ts";
import { captureMaterialSnapshot } from
  "../project-ledger/project-work-material-snapshot.ts";
import { unresolvedEffectBlockersForWork } from
  "./guided-work-effect-blockers.ts";
import { resolveDispositionEvidence } from
  "./guided-work-disposition-evidence.ts";
import { readWorkEffectWatermark } from "./guided-work-material-reader.ts";
import { digest } from "./identity.ts";
import type { SqliteProjectWorkResultRuntime } from
  "./project-work-result-runtime.ts";

export function createSqliteProjectWorkRuntimeProjection(
  db: Database,
  resultRuntime: SqliteProjectWorkResultRuntime,
): ProjectWorkRuntimeProjection {
  return {
    locateCanonicalWorks: resultRuntime.locateCanonicalWorks.bind(resultRuntime),
    loadOriginalRequest(scope) {
      const row = db.query<{
        session_id: string;
        original_message_id: string;
        original_message: string;
      }, [string]>(`
        SELECT session_id, original_message_id, original_message
        FROM btcc_turns WHERE turn_id = ?
      `).get(scope.turnId);
      if (!row || row.session_id !== scope.sessionId) {
        throw new Error("project_work_runtime_origin_missing");
      }
      return Promise.resolve({
        turnId: scope.turnId,
        messageId: row.original_message_id,
        content: row.original_message,
      });
    },
    loadResultFacts(workId) {
      const rows = db.query<{
        tool_name: string;
        status: "completed" | "failed" | "cancelled";
        result_json: string | null;
        error_code: string | null;
      }, [string]>(`
        SELECT call.tool_name, call.status, call.result_json, call.error_code
        FROM btcc_guided_work_results result
        JOIN btcc_guided_tool_calls call ON call.call_id = result.tool_call_id
        WHERE result.work_id = ? ORDER BY result.sequence
      `).all(workId).slice(-50);
      return Promise.resolve(rows.map((row) => ({
        toolName: row.tool_name,
        status: row.status,
        ...(row.result_json ? { resultJson: JSON.parse(row.result_json) } : {}),
        ...(row.error_code ? { errorCode: row.error_code } : {}),
      })));
    },
    operationRecordedAt(identity: ProjectWorkOperationIdentity) {
      const timestamp = identity.mutationCallId
        ? db.query<{ started_at: string }, [string]>(`
            SELECT started_at FROM btcc_guided_tool_calls WHERE call_id = ?
          `).get(identity.mutationCallId)?.started_at
        : undefined;
      return Promise.resolve(timestamp ?? new Date().toISOString());
    },
    prepareDisposition(input: {
      command: RecordWorkDispositionCommand;
      current: DurableWorkView;
    }) {
      const latest = input.current.latestDisposition;
      const freshRuntimeCompletion =
        input.command.disposition === "open" &&
        input.current.status === "completed" &&
        input.command.runtimeOwnedOpenGeneration?.version === 1 &&
        latest?.originTurnId === input.command.turnId &&
        latest.disposition === input.current.status &&
        latest.materialFingerprint ===
          dispositionMaterialFingerprint(input.current);
      if (freshRuntimeCompletion) {
        return Promise.resolve({ mode: "current_view" as const });
      }
      const actionProgress = input.command.actionUpdates?.length
        ? applyWorkActionUpdates(input.current, input.command.actionUpdates)
        : input.current.actionProgress;
      if (
        input.command.disposition === "completed" &&
        unresolvedEffectBlockersForWork(db, input.current.workId).length > 0
      ) {
        throw new Error("Completed Work has an unresolved effect blocker");
      }
      return Promise.resolve({
        mode: "apply" as const,
        actionProgress,
        evidenceSnapshot: resolveDispositionEvidence(
          db,
          input.current.workId,
          input.command.turnId,
          input.command.evidenceRefs ?? [],
        ),
      });
    },
    captureWorkMaterial(input) {
      const materialFingerprint = dispositionMaterialFingerprint(input.candidate);
      const blockers = unresolvedEffectBlockersForWork(db, input.candidate.workId);
      return Promise.resolve({
        materialFingerprint,
        materialSnapshot: captureMaterialSnapshot(
          input.candidate,
          {
            effectWatermark: readWorkEffectWatermark(db, input.candidate.workId),
            effectBlockers: blockers.map((blocker) => ({
              blockerId: blocker.blockerId,
              sourceTurnId: blocker.sourceTurnId,
              capabilitySha256: digest(blocker.capability),
              targetSha256: digest(blocker.target),
              detailSha256: digest(blocker.detail),
            })),
          },
          materialFingerprint,
        ),
      });
    },
    observeCanonicalWorks: resultRuntime.observeCanonicalWorks.bind(resultRuntime),
  };
}
