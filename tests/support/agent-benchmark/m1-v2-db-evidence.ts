import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { M1V2DbEvidence } from "./m1-v2-types.ts";

const MAX_DATABASES = 40;

export function readM1V2DbEvidence(
  butlerData: string,
  turnId: string,
): M1V2DbEvidence {
  const paths = sqlitePaths(butlerData);
  let quickCheckPassed = paths.length > 0;
  const toolNames: string[] = [];
  let duplicateAppliedEffects: number | null = null;
  let unresolvedCorrections: number | null = null;
  let lostRequiredAnchors: number | null = null;
  for (const path of paths) {
    let db: Database;
    try {
      db = new Database(path, { readonly: true });
    } catch {
      quickCheckPassed = false;
      continue;
    }
    try {
      const quick = db.query<{ quick_check: string }, []>("PRAGMA quick_check").get();
      quickCheckPassed &&= quick?.quick_check === "ok";
      if (!tableExists(db, "btcc_guided_tool_calls")) continue;
      toolNames.push(...db.query<{ tool_name: string }, [string]>(`
        SELECT tool_name FROM btcc_guided_tool_calls
        WHERE turn_id = ? ORDER BY started_at, call_id
      `).all(turnId).map((row) => row.tool_name));
      const safety = readSafetyEvidence(db, turnId);
      if (safety) {
        duplicateAppliedEffects = (duplicateAppliedEffects ?? 0) +
          safety.duplicateAppliedEffects;
        unresolvedCorrections = (unresolvedCorrections ?? 0) +
          safety.unresolvedCorrections;
        lostRequiredAnchors = (lostRequiredAnchors ?? 0) +
          safety.lostRequiredAnchors;
      }
    } catch {
      quickCheckPassed = false;
    } finally {
      db.close();
    }
  }
  return {
    quickCheckDatabases: paths.length,
    quickCheckPassed,
    toolCalls: toolNames.length,
    webToolCalls: toolNames.filter((name) =>
      name === "web_search" || name === "web_read").length,
    pagePreviewToolCalls: toolNames.filter((name) =>
      name === "inspect_workspace_page").length,
    buildCommandToolCalls: toolNames.filter((name) => name === "run_command").length,
    fileMutationToolCalls: toolNames.filter((name) =>
      name === "write_file" || name === "edit_file").length,
    duplicateAppliedEffects,
    unresolvedCorrections,
    lostRequiredAnchors,
  };
}
function readSafetyEvidence(db: Database, turnId: string): {
  duplicateAppliedEffects: number;
  unresolvedCorrections: number;
  lostRequiredAnchors: number;
} | null {
  const required = [
    "btcc_guided_turn_work_bindings",
    "btcc_guided_effects",
    "btcc_guided_work_review_revisions",
    "btcc_guided_work_effect_blockers",
    "btcc_guided_work_plan_revisions",
    "btcc_guided_work_results",
    "btcc_guided_tool_calls",
    "btcc_guided_work_checkpoint_revisions",
  ];
  if (!required.every((table) => tableExists(db, table))) return null;
  const workId = db.query<{ work_id: string }, [string]>(`
    SELECT work_id FROM btcc_guided_turn_work_bindings
    WHERE turn_id = ? AND is_current = 1 LIMIT 1
  `).get(turnId)?.work_id ?? null;
  const duplicateAppliedEffects = workId
    ? db.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM (
          SELECT identity_sha256 FROM btcc_guided_effects
          WHERE work_id = ? AND status = 'applied'
          GROUP BY identity_sha256 HAVING COUNT(*) > 1
        )
      `).get(workId)?.count ?? 0
    : 0;
  const unresolvedCorrections = workId
    ? lostAcceptedCorrectionCount(db, workId)
    : 0;
  const unresolvedEffectAnchors = db.query<{ count: number }, [string, string]>(`
    SELECT COUNT(*) AS count FROM btcc_guided_work_effect_blockers
    WHERE status = 'unresolved' AND (source_turn_id = ? OR work_id = ?)
  `).get(turnId, workId ?? "")?.count ?? 0;
  const lostRequiredAnchors = unresolvedEffectAnchors +
    (workId ? lostGoverningAnchorCount(db, workId) : 0);
  return { duplicateAppliedEffects, unresolvedCorrections, lostRequiredAnchors };
}

function lostAcceptedCorrectionCount(db: Database, workId: string): number {
  const finalPlan = db.query<{
    plan_revision_id: string;
    objective: string;
    governing_refs_json: string;
    actions_json: string;
    checks_json: string;
  }, [string]>(`
    SELECT plan_revision_id, objective, governing_refs_json, actions_json, checks_json
    FROM btcc_guided_work_plan_revisions WHERE work_id = ?
    ORDER BY revision DESC LIMIT 1
  `).get(workId);
  const results = db.query<{ sequence: number; result_json: string | null }, [string]>(`
    SELECT result.sequence, call.result_json FROM btcc_guided_work_results result
    JOIN btcc_guided_tool_calls call ON call.call_id = result.tool_call_id
    WHERE result.work_id = ? ORDER BY result.sequence
  `).all(workId);
  const finalResultSequence = results.at(-1)?.sequence ?? 0;
  const resultCarrier = results.map((row) => row.result_json ?? "").join("\n");
  const effects = db.query<{
    receipt_id: string;
    identity_sha256: string;
    receipt_json: string | null;
  }, [string]>(`
    SELECT receipt_id, identity_sha256, receipt_json FROM btcc_guided_effects
    WHERE work_id = ? AND status = 'applied' ORDER BY journal_revision
  `).all(workId);
  const effectCarrier = effects.map((row) => row.receipt_json ?? "").join("\n");
  const effectReceiptsResolve = effects.every((effect) =>
    effectReceiptIdentityMatches(effect));
  const finalResultReviewId = db.query<{ review_revision_id: string }, [string]>(`
    SELECT review_revision_id FROM btcc_guided_work_review_revisions
    WHERE work_id = ? AND subject = 'result'
    ORDER BY revision DESC LIMIT 1
  `).get(workId)?.review_revision_id ?? null;
  const finalActionStates = db.query<{ action_states_json: string }, [string]>(`
    SELECT action_states_json FROM btcc_guided_work_checkpoint_revisions
    WHERE work_id = ? ORDER BY revision DESC LIMIT 1
  `).get(workId)?.action_states_json ?? null;
  const planCarrier = finalPlan
    ? [finalPlan.objective, finalPlan.governing_refs_json,
      finalPlan.actions_json, finalPlan.checks_json].join("\n")
    : "";
  const reviews = db.query<{
    review_revision_id: string;
    subject: string;
    corrections_json: string;
    bound_plan_revision_id: string | null;
    bound_result_sequence: number | null;
    bound_result_review_revision_id: string | null;
    bound_action_states_json: string | null;
  }, [string]>(`
    SELECT review_revision_id, subject, corrections_json, bound_plan_revision_id,
      bound_result_sequence, bound_result_review_revision_id,
      bound_action_states_json
    FROM btcc_guided_work_review_revisions
    WHERE work_id = ? AND verdict = 'accept' ORDER BY revision
  `).all(workId);
  let lost = 0;
  for (const review of reviews) {
    const corrections = parseStringArray(review.corrections_json);
    if (!corrections) {
      lost += 1;
      continue;
    }
    const carrier = review.subject === "plan"
      ? planCarrier
      : review.subject === "result"
      ? resultCarrier
      : [planCarrier, resultCarrier, effectCarrier,
        review.bound_action_states_json ?? ""].join("\n");
    const identityBound = review.subject === "plan"
      ? Boolean(finalPlan && review.bound_plan_revision_id === finalPlan.plan_revision_id)
      : review.subject === "result"
      ? review.bound_result_sequence === finalResultSequence
      : Boolean(finalPlan && review.bound_plan_revision_id === finalPlan.plan_revision_id &&
        review.bound_result_sequence === finalResultSequence &&
        review.bound_result_review_revision_id === finalResultReviewId &&
        finalActionStates !== null && review.bound_action_states_json !== null &&
        structuredJsonEqual(review.bound_action_states_json, finalActionStates) &&
        effectReceiptsResolve);
    lost += corrections.filter((correction) =>
      !identityBound || !normalizedCarrierIncludes(carrier, correction)).length;
  }
  return lost;
}

function effectReceiptIdentityMatches(effect: {
  receipt_id: string;
  identity_sha256: string;
  receipt_json: string | null;
}): boolean {
  if (!effect.receipt_json) return false;
  try {
    const receipt = JSON.parse(effect.receipt_json) as Record<string, unknown>;
    return receipt.receiptId === effect.receipt_id &&
      receipt.identitySha256 === effect.identity_sha256;
  } catch {
    return false;
  }
}

function structuredJsonEqual(left: string, right: string): boolean {
  try {
    return stableJsonValue(JSON.parse(left)) === stableJsonValue(JSON.parse(right));
  } catch {
    return false;
  }
}

function stableJsonValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonValue).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJsonValue(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function lostGoverningAnchorCount(db: Database, workId: string): number {
  const plans = db.query<{ governing_refs_json: string }, [string]>(`
    SELECT governing_refs_json FROM btcc_guided_work_plan_revisions
    WHERE work_id = ? ORDER BY revision
  `).all(workId);
  if (plans.length === 0) return 0;
  const initial = parseStringArray(plans[0]!.governing_refs_json);
  const finalValues = parseStringArray(plans.at(-1)!.governing_refs_json);
  if (!initial || !finalValues) return 1;
  const final = new Set(finalValues);
  return initial.filter((anchor) => !final.has(anchor)).length;
}

function parseStringArray(value: string): string[] | null {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0)
      : null;
  } catch {
    return null;
  }
}

function normalizedCarrierIncludes(carrier: string, correction: string): boolean {
  const normalize = (value: string): string => value.normalize("NFKC")
    .replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
  const needle = normalize(correction);
  return needle.length > 0 && normalize(carrier).includes(needle);
}

function sqlitePaths(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const visit = (directory: string): void => {
    if (found.length >= MAX_DATABASES) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (found.length >= MAX_DATABASES) return;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".sqlite") || entry.name.endsWith(".db")) &&
        statSync(path).size > 0
      ) found.push(path);
    }
  };
  visit(root);
  return found.sort();
}

function tableExists(db: Database, table: string): boolean {
  return Boolean(db.query<{ name: string }, [string]>(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
  `).get(table));
}
