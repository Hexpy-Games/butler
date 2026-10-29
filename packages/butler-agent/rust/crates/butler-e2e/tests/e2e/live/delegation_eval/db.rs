//! Read-only scoring of the case's own BTCC database, after agent shutdown.
use butler_e2e::e2e::HarnessError;
use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};

fn open(path: &Path) -> Result<butler_platform::sqlite::Connection, HarnessError> {
    Ok(butler_platform::sqlite::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?)
}
pub(super) fn settled(path: &Path) -> Result<bool, HarnessError> {
    Ok(open(path)?.query_row(
        "SELECT EXISTS(SELECT 1 FROM btcc_subsession_outbox o JOIN btcc_subsession_delegations d USING(relation_id) WHERE o.status='delivered' AND json_extract(d.packet_json,'$.child_role')='steward')",
        [],
        |r| r.get(0),
    )?)
}
fn rows(db: &Connection, sql: &str) -> Result<Vec<Value>, HarnessError> {
    let mut stmt = db.prepare(sql)?;
    let names: Vec<_> = stmt
        .column_names()
        .iter()
        .map(ToString::to_string)
        .collect();
    let values = stmt
        .query_map([], |row| {
            let mut out = serde_json::Map::new();
            for (i, name) in names.iter().enumerate() {
                let value = match row.get_ref(i)? {
                    ValueRef::Null | ValueRef::Blob(_) => Value::Null,
                    ValueRef::Integer(n) => json!(n),
                    ValueRef::Real(n) => json!(n),
                    ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                };
                out.insert(name.clone(), value);
            }
            Ok(Value::Object(out))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(values)
}
pub(super) fn snapshot(path: &Path, case: &Value, first: bool) -> Result<Value, HarnessError> {
    let db = open(path)?;
    let tools = rows(
        &db,
        "SELECT c.rowid AS call_order,c.*,COALESCE(json_extract(t.context_json,'$.executionPolicy.role'),'butler') AS role FROM btcc_guided_tool_calls c JOIN btcc_turns t ON t.turn_id=c.turn_id ORDER BY c.rowid",
    )?;
    if first {
        return Ok(json!({"executed_tools":tools}));
    }
    let works = rows(
        &db,
        "SELECT w.*,json_extract(d.packet_json,'$.child_role') AS role FROM btcc_guided_works w LEFT JOIN btcc_subsession_delegations d ON d.root_work_id=w.work_id ORDER BY w.rowid",
    )?;
    let plans = rows(
        &db,
        "SELECT p.*,c.rowid AS call_order FROM btcc_guided_work_plan_revisions p LEFT JOIN btcc_guided_work_mutations m ON m.record_id=p.plan_revision_id LEFT JOIN btcc_guided_tool_calls c ON c.call_id=m.mutation_call_id ORDER BY p.rowid",
    )?;
    let reviews = rows(
        &db,
        "SELECT r.*,c.rowid AS call_order FROM btcc_guided_work_review_revisions r LEFT JOIN btcc_guided_work_mutations m ON m.record_id=r.review_revision_id LEFT JOIN btcc_guided_tool_calls c ON c.call_id=m.mutation_call_id ORDER BY r.rowid",
    )?;
    let dispositions = rows(
        &db,
        "SELECT * FROM btcc_guided_work_disposition_revisions ORDER BY rowid",
    )?;
    let delegations = rows(
        &db,
        "SELECT * FROM btcc_subsession_delegations ORDER BY rowid",
    )?;
    let mut counts = BTreeMap::<String, usize>::new();
    for call in &tools {
        *counts
            .entry(call["tool_name"].as_str().unwrap().into())
            .or_default() += 1;
    }
    let steward = works.iter().find(|w| w["role"] == "steward");
    let work_id = steward.map(|w| &w["work_id"]);
    let current_plan = steward.and_then(|w| {
        plans
            .iter()
            .find(|p| p["plan_revision_id"] == w["current_plan_revision_id"])
    });
    let review = work_id.and_then(|id| {
        reviews
            .iter()
            .rev()
            .find(|r| &r["work_id"] == id && r["subject"] == "plan")
    });
    let accepted = review.zip(current_plan).is_some_and(|(r, p)| {
        r["verdict"] == "accept" && r["bound_plan_revision_id"] == p["plan_revision_id"]
    });
    let first_mutation = tools
        .iter()
        .filter(|t| t["role"] == "steward")
        .find(|t| mutating(t));
    let before = work_id.is_some()
        && first_mutation.is_none_or(|call| {
            let plan = plans.iter().rev().find(|p| {
                Some(&p["work_id"]) == work_id
                    && p["call_order"]
                        .as_i64()
                        .is_some_and(|n| n < call["call_order"].as_i64().unwrap())
            });
            let r = reviews.iter().rev().find(|r| {
                Some(&r["work_id"]) == work_id
                    && r["subject"] == "plan"
                    && r["call_order"]
                        .as_i64()
                        .is_some_and(|n| n < call["call_order"].as_i64().unwrap())
            });
            plan.zip(r).is_some_and(|(p, r)| {
                r["verdict"] == "accept" && r["bound_plan_revision_id"] == p["plan_revision_id"]
            })
        });
    let workers = tools
        .iter()
        .filter(|t| t["role"] == "steward" && t["tool_name"] == "delegate_to_worker" && success(t))
        .count();
    let mode = current_plan
        .map(|p| p["execution_mode"].clone())
        .unwrap_or(Value::Null);
    let expected = match case["expected_mode"].as_str() {
        Some("workers") => json!(accepted && mode == "workers" && workers > 0),
        Some("direct") => json!(accepted && mode == "direct" && workers == 0),
        _ => Value::Null,
    };
    let terminal = dispositions
        .iter()
        .rev()
        .find(|d| Some(&d["work_id"]) == work_id)
        .is_some_and(|d| d["disposition"] == "completed" || d["disposition"] == "blocked");
    let parent = works
        .iter()
        .filter(|w| w["role"].is_null())
        .any(|w| w["status"] == "completed" || w["status"] == "blocked");
    let refusals = tools
        .iter()
        .filter(|t| {
            let result: Value = serde_json::from_str(t["result_json"].as_str().unwrap_or("null"))
                .unwrap_or(Value::Null);
            let output = result.get("output").unwrap_or(&result);
            t["role"] == "steward"
                && (t["error_code"] == "steward_plan_review_required"
                    || output["error"]["code"] == "steward_plan_review_required")
        })
        .count();
    Ok(
        json!({"plan_before_first_mutation":first_mutation.map(|_|before),"first_mutation":first_mutation,"plan_review_accepted":accepted,
        "plan_gate_refusals":refusals,"workers_when_expected":expected,"chosen_mode":mode,"workers":workers,
        "disposition_recorded":terminal && parent,"parent_settled":parent,"tools":tools,"tool_counts":counts,
        "works":works,"plans":plans,"reviews":reviews,"dispositions":dispositions,"delegations":delegations,
        "checks_look_met":"manual review required; inspect artifacts and tool results"}),
    )
}
fn success(call: &Value) -> bool {
    let result: Value =
        serde_json::from_str(call["result_json"].as_str().unwrap_or("null")).unwrap_or(Value::Null);
    let result = result.get("output").unwrap_or(&result);
    call["status"] == "completed"
        && call["error_code"].is_null()
        && result["ok"] != false
        && !matches!(result["status"].as_str(), Some("refused" | "failed"))
        && result["error"].is_null()
}
fn mutating(call: &Value) -> bool {
    use butler_turn::btcc::{
        AccessDecision, AccessMode, AccessRequest, ApprovalRisk, CapabilityKind, DenyReason,
        GuidedCatalogSnapshot, TargetScope, TurnTaint, decide,
    };
    let name = call["tool_name"].as_str().unwrap();
    let mut args: Value =
        serde_json::from_str(call["arguments_json"].as_str().unwrap_or("{}")).unwrap();
    let name = if name == "tool_call" {
        let id = args["id"]
            .as_str()
            .unwrap_or("")
            .trim_start_matches("native:")
            .to_owned();
        args = args["arguments"].clone();
        id
    } else {
        name.into()
    };
    if name == "run_command" {
        return !matches!(
            args["state_effect"].as_str(),
            None | Some("read_only" | "validation" | "remote_observation")
        );
    }
    if name == "browser_act" {
        return args["steps"].as_array().is_none_or(|s| {
            s.iter().any(|v| {
                v["commits"] == true
                    || !matches!(
                        v["action"].as_str(),
                        Some("scroll" | "hover" | "wait" | "back" | "forward" | "reload")
                    )
            })
        });
    }
    let source = butler_core::tool_catalog::load().unwrap().to_string();
    let catalog = GuidedCatalogSnapshot::parse(&source).unwrap();
    catalog.steward_plan_effects().any(|n| n == name)
        || matches!(
            decide(
                &AccessMode::ReadOnly,
                AccessRequest {
                    kind: CapabilityKind::of_call(&name, args.as_object().unwrap(), false),
                    risk: ApprovalRisk::Low,
                    scope: TargetScope::NoTarget,
                    taint: TurnTaint::Clean,
                }
            ),
            AccessDecision::Deny(DenyReason::ReadOnly | DenyReason::FullAccessRequired)
        )
}
