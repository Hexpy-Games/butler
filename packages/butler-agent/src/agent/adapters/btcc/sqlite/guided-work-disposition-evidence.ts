import type { Database } from "bun:sqlite";

export function normalizeDispositionStringList(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function normalizeDispositionOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

/** Resolve only current-Turn ordinary results or applied receipts of this Work. */
export function resolveDispositionEvidence(
  db: Database,
  workId: string,
  turnId: string,
  evidenceRefs: string[],
): string[] {
  if (evidenceRefs.length === 0) {
    return db.query<{ result_ref: string }, [string, string]>(`
      SELECT result.result_ref
      FROM btcc_guided_work_results result
      JOIN btcc_guided_tool_calls calls ON calls.call_id = result.tool_call_id
      WHERE result.work_id = ? AND result.origin_turn_id = ?
        AND calls.status = 'completed'
      ORDER BY result.sequence ASC
    `).all(workId, turnId).map(({ result_ref }) => result_ref);
  }
  const snapshot: string[] = [];
  for (const reference of evidenceRefs) {
    const result = db.query<
      { result_ref: string; status: string },
      [string, string, string, string]
    >(`
      SELECT result.result_ref, calls.status AS status
      FROM btcc_guided_work_results result
      JOIN btcc_guided_tool_calls calls ON calls.call_id = result.tool_call_id
      WHERE result.work_id = ? AND result.origin_turn_id = ?
        AND (result.result_ref = ? OR result.tool_call_id = ?)
    `).get(workId, turnId, reference, reference);
    if (result?.status === "completed") {
      snapshot.push(result.result_ref);
      continue;
    }
    const current = db.query<
      { call_id: string; status: string },
      [string, string]
    >(`
      SELECT call_id, status FROM btcc_guided_tool_calls
      WHERE turn_id = ? AND call_id = ?
    `).get(turnId, reference);
    if (current?.status === "completed") {
      const attached = db.query<{
        result_ref: string;
        work_id: string;
        origin_turn_id: string;
      }, [string]>(`
        SELECT result_ref, work_id, origin_turn_id
        FROM btcc_guided_work_results WHERE tool_call_id = ?
      `).get(reference);
      if (attached?.work_id === workId && attached.origin_turn_id === turnId) {
        snapshot.push(attached.result_ref);
        continue;
      }
    }
    const effectRows = db.query<{
      work_id: string;
      status: string;
      receipt_id: string;
    }, [string]>(`
      SELECT work_id, status, receipt_id
      FROM btcc_guided_effects WHERE receipt_id = ?
    `).all(reference);
    if (effectRows.length > 0) {
      if (effectRows.length !== 1) {
        throw new Error(`Durable Work evidence reference is ambiguous: ${reference}`);
      }
      const effect = effectRows[0]!;
      if (effect.work_id !== workId || effect.status !== "applied") {
        throw new Error(`Durable Work evidence reference is not eligible: ${reference}`);
      }
      snapshot.push(effect.receipt_id);
      continue;
    }
    throw new Error(`Durable Work evidence reference is not eligible: ${reference}`);
  }
  return snapshot;
}
