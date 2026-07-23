import { join } from "node:path";
import { Database } from "bun:sqlite";
import type {
  ObservationResult,
  OperationRequest,
} from "../../core/index.ts";
import {
  parseResultScopeRef,
  projectRecord,
  projectionBudgetBytes,
  ref,
  requestScope,
  stableJson,
  type OperationResultProjection,
  type OperationResultRecord,
  type OperationResultStore,
} from "../../operation-result/index.ts";
import { OperationPayloadFiles } from "./payload-files.ts";
import {
  decodeResultSelector,
  selectOperationResult,
} from "./result-selector.ts";

type StoredResult = {
  requestJson: string;
  record: OperationResultRecord;
};

export class SqliteOperationResultStore implements OperationResultStore {
  private readonly database: Database;
  private readonly payloads: OperationPayloadFiles;

  constructor(butlerData: string) {
    const runtimeRoot = join(butlerData, "runtime", "btcc");
    this.payloads = new OperationPayloadFiles(join(runtimeRoot, "result-payloads"));
    this.database = new Database(join(runtimeRoot, "operation-results.sqlite"), {
      create: true,
    });
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS btcc_operation_results (
        result_id TEXT PRIMARY KEY,
        result_sha256 TEXT NOT NULL,
        request_scope TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        record_json TEXT NOT NULL,
        UNIQUE(request_scope, request_id)
      );
    `);
  }

  async find(input: Parameters<OperationResultStore["find"]>[0]) {
    const scope = requestScope(input.binding);
    const row = this.database.query<{
      request_json: string;
      record_json: string;
    }, [string, string]>(`
      SELECT request_json, record_json
      FROM btcc_operation_results
      WHERE request_scope = ? AND request_id = ?
    `).get(scope, input.request.requestId);
    if (!row) return null;
    assertSameRequest(row.request_json, input.request);
    const record = JSON.parse(row.record_json) as OperationResultRecord;
    return this.project(record, input.request, input.modelSelection);
  }

  async record(input: Parameters<OperationResultStore["record"]>[0]) {
    return this.recordAtScope(requestScope(input.binding), input);
  }

  recordExternal(input: {
    sourceTurnId: string;
    triggerId: string;
    request: OperationRequest;
    result: ObservationResult;
    modelSelection: Parameters<OperationResultStore["record"]>[0]["modelSelection"];
  }): OperationResultProjection {
    return this.recordAtScope(
      `external:${input.sourceTurnId}:${input.triggerId}`,
      input,
    );
  }

  private recordAtScope(
    scope: string,
    input: {
      request: OperationRequest;
      result: ObservationResult;
      modelSelection: Parameters<OperationResultStore["record"]>[0]["modelSelection"];
    },
  ): OperationResultProjection {
    const { payloadRef, byteLength } = this.payloads.import(
      input.result.payloadSource ?? input.result.content,
    );
    const requestRef = ref("operation-request", stableJson(input.request));
    const body = {
      requestScope: scope,
      requestRef,
      payloadRef,
      outcome: input.result.outcome,
      observationRef: input.result.observationRef,
      structuralRefs: structuralRefs(input.result),
    };
    const record: OperationResultRecord = {
      resultRef: ref("operation-result", stableJson(body)),
      requestRef,
      requestScope: body.requestScope,
      requestId: input.request.requestId,
      capabilityRef: input.request.capabilityRef,
      outcome: input.result.outcome,
      payloadRef,
      mediaType: "text/plain; charset=utf-8",
      byteLength,
      completeness: input.result.completeness ?? "requested_scope_complete",
      observationRef: input.result.observationRef,
      ...structuralRefs(input.result),
    };
    this.insertRecord(input.request, record);
    const stored = this.loadRecord(record.resultRef);
    assertSameRequest(stored.requestJson, input.request);
    if (stableJson(stored.record) !== stableJson(record)) {
      throw new Error("Operation result identity conflicts with its stored record");
    }
    return this.project(stored.record, input.request, input.modelSelection);
  }

  async read(input: Parameters<OperationResultStore["read"]>[0]) {
    const resultRef = parseResultScopeRef(input.request.scopeRef);
    const stored = this.loadRecord(resultRef);
    const sourceRequest = JSON.parse(stored.requestJson) as OperationRequest;
    const selector = decodeResultSelector(input.request.input);
    const view = selectOperationResult({
      files: this.payloads,
      payloadSha256: stored.record.payloadRef.sha256,
      byteLength: stored.record.byteLength,
      selector,
    });
    const projection = projectRecord({
      record: stored.record,
      request: input.request,
      payload: this.payloads.readPrefix(
        stored.record.payloadRef.sha256,
        projectionBudgetBytes(input.modelSelection),
      ),
      maxPreviewBytes: projectionBudgetBytes(input.modelSelection),
    });
    return {
      ...projection,
      request: input.request,
      requestId: input.request.requestId,
      capabilityRef: input.request.capabilityRef,
      requestRef: ref("operation-request", stableJson(sourceRequest)),
      preview: "",
      omittedBytes: Math.max(0, stored.record.byteLength - Buffer.byteLength(view.content)),
      view,
    } satisfies OperationResultProjection;
  }

  close(): void {
    this.database.close();
  }

  private insertRecord(
    request: OperationRequest,
    record: OperationResultRecord,
  ): void {
    const requestJson = stableJson(request);
    const recordJson = stableJson(record);
    this.database.query(`
      INSERT INTO btcc_operation_results (
        result_id, result_sha256, request_scope, request_id,
        request_json, record_json
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_scope, request_id) DO NOTHING
    `).run(
      record.resultRef.id,
      record.resultRef.sha256,
      record.requestScope,
      record.requestId,
      requestJson,
      recordJson,
    );
  }

  private loadRecord(resultRef: { id: string; sha256: string }): StoredResult {
    const row = this.database.query<{
      result_sha256: string;
      request_json: string;
      record_json: string;
    }, [string]>(`
      SELECT result_sha256, request_json, record_json
      FROM btcc_operation_results WHERE result_id = ?
    `).get(resultRef.id);
    if (!row || row.result_sha256 !== resultRef.sha256) {
      throw new Error("Operation result reference is not available");
    }
    return {
      requestJson: row.request_json,
      record: JSON.parse(row.record_json) as OperationResultRecord,
    };
  }

  private project(
    record: OperationResultRecord,
    request: OperationRequest,
    selection: Parameters<OperationResultStore["find"]>[0]["modelSelection"],
  ): OperationResultProjection {
    return projectRecord({
      record,
      request,
      payload: this.payloads.readPrefix(
        record.payloadRef.sha256,
        projectionBudgetBytes(selection),
      ),
      maxPreviewBytes: projectionBudgetBytes(selection),
    });
  }
}

function assertSameRequest(storedJson: string, request: OperationRequest): void {
  if (storedJson !== stableJson(request)) {
    throw new Error("Operation result request identity conflict");
  }
}

function structuralRefs(result: ObservationResult) {
  return {
    ...(result.artifactRevisionRef
      ? { artifactRevisionRef: result.artifactRevisionRef }
      : {}),
    ...(result.targetSnapshotRef
      ? { targetSnapshotRef: result.targetSnapshotRef }
      : {}),
    ...(result.validationReceiptRef
      ? { validationReceiptRef: result.validationReceiptRef }
      : {}),
    ...(result.transactionRef ? { transactionRef: result.transactionRef } : {}),
    ...(result.commitJournalRef
      ? { commitJournalRef: result.commitJournalRef }
      : {}),
    ...(result.promotionReceiptRef
      ? { promotionReceiptRef: result.promotionReceiptRef }
      : {}),
    ...(result.promotedSnapshotRef
      ? { promotedSnapshotRef: result.promotedSnapshotRef }
      : {}),
    ...(result.promotionRecords
      ? { promotionRecords: result.promotionRecords }
      : {}),
  };
}
