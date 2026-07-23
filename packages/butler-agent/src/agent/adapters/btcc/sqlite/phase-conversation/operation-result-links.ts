import type { Database } from "bun:sqlite";
import type {
  OperationRequest,
  OperationResult,
  PhaseRunBinding,
} from "../../../../btcc/gateway-api.ts";
import {
  projectEphemeralOperationResult,
  type OperationResultProjection,
} from "../../../../btcc/operation-result/index.ts";
import { operationRoundScope } from "../../../../btcc/gateway-api.ts";
import { digest, stableJson } from "../identity.ts";

export class PhaseOperationResultLinks {
  constructor(private readonly db: Database) {}

  insert(
    binding: PhaseRunBinding,
    input: { request: OperationRequest; result: OperationResult },
  ): OperationResultProjection {
    const requestJson = stableJson(input.request);
    const projection = normalizeProjection(binding, input.result);
    const projectionJson = stableJson(projection);
    if (stableJson(projection.request) !== requestJson) {
      throw new Error("BTCC operation result embeds a different request");
    }
    const operationId = digest(
      `btcc-phase-operation.v2\0${operationRoundScope(binding)}\0${input.request.requestId}`,
    );
    this.db.query(`
      INSERT OR IGNORE INTO btcc_phase_operation_result_links (
        operation_id, checkpoint_id, checkpoint_revision,
        request_id, result_id, request_json, projection_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      operationId,
      binding.checkpointId,
      binding.checkpointRevision + 1,
      input.request.requestId,
      projection.resultRef.id,
      requestJson,
      projectionJson,
    );
    const row = this.db.query<{
      request_json: string;
      projection_json: string;
    }, [string]>(`
      SELECT request_json, projection_json FROM btcc_phase_operation_result_links
      WHERE operation_id = ?
    `).get(operationId);
    if (row?.request_json !== requestJson || row.projection_json !== projectionJson) {
      throw new Error("BTCC operation request identity conflict");
    }
    return projection;
  }

  load(binding: PhaseRunBinding): OperationResultProjection[] {
    return this.db.query<{ projection_json: string }, [string, number]>(`
      SELECT projection_json FROM btcc_phase_operation_result_links
      WHERE checkpoint_id = ? AND checkpoint_revision <= ?
      ORDER BY checkpoint_revision, rowid
    `).all(binding.checkpointId, binding.checkpointRevision)
      .map(({ projection_json }) =>
        JSON.parse(projection_json) as OperationResultProjection);
  }
}

function normalizeProjection(
  binding: PhaseRunBinding,
  result: OperationResult,
): OperationResultProjection {
  if (
    result.resultRef &&
    result.requestRef &&
    result.capabilityRef &&
    result.byteLength !== undefined &&
    result.preview !== undefined &&
    result.omittedBytes !== undefined &&
    result.readScopeRef
  ) {
    return result as OperationResultProjection;
  }
  if (!result.content) {
    throw new Error("BTCC phase result link requires a projection or complete content");
  }
  return projectEphemeralOperationResult({
    binding,
    request: result.request,
    result: { ...result, content: result.content },
    modelSelection: {
      provider: "checkpoint",
      model: "projection",
      reasoningEffort: "none",
      controls: {},
      controlsHash: "checkpoint-projection",
    },
  });
}
