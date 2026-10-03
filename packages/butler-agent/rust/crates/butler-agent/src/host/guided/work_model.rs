//! Host adaptation of the opt-in domain; existing router round selects the tier.
pub(super) mod schema;

use butler_turn::btcc::{BtccError, DurableWorkService, GuidedPhaseSelection, WorkTurnScope};
use serde_json::{Map, Value, json};

pub(super) fn tool(name: &str) -> bool {
    matches!(name, "work_apply" | "work_read")
}

fn legacy_writer(name: &str) -> bool {
    matches!(
        name,
        "start_work"
            | "continue_work"
            | "replace_work_plan"
            | "record_work_checkpoint"
            | "record_work_review"
            | "record_work_disposition"
            | "update_todo_list"
            | "list_todo_list"
            | "update_work_stream_state"
            | "list_work_streams"
    )
}

pub(super) fn surface(phase: &mut GuidedPhaseSelection, summary: &Value) {
    let bootstrap = phase
        .provider_tools
        .iter()
        .any(|t| t["name"] == "start_work")
        || (phase.execution_policy.access_mode != butler_turn::btcc::AccessMode::ReadOnly
            && summary["plan_id"].is_string()
            && summary["tier"].as_u64().is_some_and(|tier| tier > 0)
            && summary["status"] != "completed");
    phase.authorized_names.retain(|name| !legacy_writer(name));
    phase
        .provider_tools
        .retain(|t| !t["name"].as_str().is_some_and(legacy_writer));
    for definition in &mut phase.provider_tools {
        if definition["name"]
            .as_str()
            .is_some_and(|n| matches!(n, "delegate_to_steward" | "delegate_to_worker"))
        {
            definition["description"]="Assign the current running canonical Task only, retaining its Work/Spec. Requires Tier 2; nested assignment requires the explicit Task grant. Child effects keep existing authority.".into();
            definition["parameters"] = json!({"type":"object","additionalProperties":false,"properties":{"request":{"type":"string"}},"required":[]});
        }
    }
    schemas(phase, summary, bootstrap);
    if bootstrap
        && phase.execution_policy.role == butler_turn::btcc::PolicyRole::Worker
        && summary["current_task"]["allow_nested_delegation"] == true
    {
        phase.authorized_names.push("delegate_to_worker".into());
        phase.provider_tools.push(json!({"name":"delegate_to_worker","description":"Assign the canonical Task under its nested grant and narrower authority.","parameters":{"type":"object","additionalProperties":false,"properties":{},"required":[]}}));
    }
    phase.stable_instruction_prefix = "You are Butler. Preserve the user's exact request, language, named entities and admitted effect authority. Use evidence before claiming results.\nChoose workload in the existing direct-versus-delegate judgement: Tier 0 for Q&A/search/one action creates nothing. Tier 1 for 2–5 small steps: work_apply create_light once with request goal, 2–3 observable criteria and all Tasks. Tier 2 for software, research, analysis/report, long-running work, >5 Tasks or any delegation: create a recursive software/research Spec tree and Plan with bound Works/Tasks. No extra classification round. The request grants in-scope authoring/publication/activation; ask only for scope expansion or new effect authority.\nUse work_read for exact current IDs, revisions and Specs. Start each ready Task before effects, submit result/evidence refs, review every criterion at its result revision, complete only accepted review. Rank never bypasses prerequisites. Task IDs and completed evidence are immutable; no separate todo list. Queue waits for this Task, even across Turns; resolve delivered drafts using existing criteria or cancel a question before the next claim. Steer applies at safe points and fences stale tools. work_apply names receipt instruction_id; delivery is not application. Ordered operations require current graph/control revisions and reason. session_control requires direct-child relation epoch. Query unavailable operations; replan revision conflicts. Complete Works/Plan with full criterion coverage; read responsible Spec and ancestors before effects. Null research results may meet method criteria without proving hypotheses.\nDelegate ready Tier 2 Tasks without child root Works. Lower-tier growth/split/replacement stays pending for reviewed replan. Prose grants no extra authority or completion. Preserve memory/conversation and effect approval policy; report facts and blocked reasons.".into();
    if !bootstrap {
        phase.stable_instruction_prefix = "You are Butler. Answer quick Q&A and search directly: Tier 0 creates no Spec/Work/Task. Preserve the exact request, user language, entities and admitted authority. Use tools and memory/conversation evidence when needed. Never claim an effect without evidence. Delegation requires Tier 2 before assignment; retain all existing effect guards.".into();
    }
    if let Some(prefix) = &mut phase.stable_provider_cache_prefix {
        prefix["instructionPrefix"] = phase.stable_instruction_prefix.clone().into();
        prefix["stablePrefixRevision"] = "butler.work-model-instructions.v1".into();
    }
}

fn schemas(phase: &mut GuidedPhaseSelection, summary: &Value, bootstrap: bool) {
    if !bootstrap {
        return;
    }
    {
        let child = phase.execution_policy.role != butler_turn::btcc::PolicyRole::Butler;
        let create = !child && (summary["tier"] == 0 || summary["status"] == "completed");
        for definition in schema::definitions(create, child) {
            phase
                .authorized_names
                .push(definition["name"].as_str().unwrap_or_default().into());
            phase.provider_tools.push(definition);
        }
        if summary["tier"] == 2 {
            phase.authorized_names.retain(|n| {
                !matches!(
                    n.as_str(),
                    "steer_steward" | "steer_worker" | "cancel_steward"
                )
            });
            phase.provider_tools.retain(|t| {
                !matches!(
                    t["name"].as_str(),
                    Some("steer_steward" | "steer_worker" | "cancel_steward")
                )
            });
            phase.authorized_names.push("session_control".into());
            phase.provider_tools.push(schema::control());
        }
    }
}

pub(super) async fn execute(
    service: &DurableWorkService,
    scope: &WorkTurnScope,
    name: &str,
    args: &Map<String, Value>,
    call: &str,
) -> Result<Value, BtccError> {
    let Some(model) = service.work_model() else {
        return Ok(json!({"ok":false,"error":{"code":"work_model_disabled"}}));
    };
    let session = scope.session_id.clone();
    let result = if name == "work_apply" {
        let allowed = [
            "command",
            "expected_graph_revision",
            "idempotency_key",
            "instruction_id",
            "operations",
            "expected_control_epoch",
            "reason",
        ];
        if args.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Ok(json!({"ok":false,"error":{"code":"work_model_command_invalid"}}));
        }
        let command = if args.contains_key("operations") {
            if args.contains_key("command") {
                return Ok(json!({"ok":false,"error":{"code":"work_model_command_invalid"}}));
            }
            json!({"op":"batch","operations":args["operations"],"expected_control_epoch":args.get("expected_control_epoch"),"reason":args.get("reason")})
        } else {
            args.get("command").cloned().unwrap_or(Value::Null)
        };
        let input = json!({"instruction_id":args.get("instruction_id").cloned().unwrap_or_else(||scope.turn_id.clone().into()),"idempotency_key":args.get("idempotency_key").cloned().unwrap_or_else(|| call.into()),
            "expected_graph_revision":args.get("expected_graph_revision"),"command":command});
        match butler_turn::btcc::work_model::decode_request(input) {
            Ok(request) => model.apply(session, request).await,
            Err(error) => Err(error),
        }
    } else {
        if args
            .keys()
            .any(|key| !["view", "cursor", "node_id"].contains(&key.as_str()))
        {
            return Ok(json!({"ok":false,"error":{"code":"work_model_command_invalid"}}));
        }
        let cursor = args
            .get("cursor")
            .and_then(Value::as_str)
            .map(str::to_owned);
        match args.get("view").and_then(Value::as_str) {
            Some("operations") => Ok(
                json!({"available":["start","submit","review","complete","remove","reorder","dependencies","step","complete_work","complete_plan","add","edit","resolve_draft","block","batch"],"unavailable":[{"operations":["split","replace","escalate"],"reason":"in_use_spec_replan_unavailable"},{"operations":["pause","stop","resume"],"reason":"work_model_controls_unavailable"}]}),
            ),
            Some("summary" | "tasks") => model.summary(session, cursor).await,
            Some("graph") => model.graph(session, cursor).await,
            Some("spec") => {
                model
                    .read_spec(
                        session,
                        args.get("node_id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .into(),
                    )
                    .await
            }
            _ => Err(BtccError::relayed(
                "work_model_view_invalid",
                "work_model_view_invalid",
            )),
        }
    };
    Ok(result.unwrap_or_else(
        |error| json!({"ok":false,"error":{"code":error.code(),"message":error.message()}}),
    ))
}

pub(super) async fn guard(
    service: &DurableWorkService,
    session: &str,
    name: &str,
) -> Result<(), BtccError> {
    let Some(model) = service.work_model() else {
        return Ok(());
    };
    if legacy_writer(name) {
        return Err(BtccError::relayed(
            "work_model_writer_required",
            "Use work_apply with canonical bindings.",
        ));
    }
    if matches!(name, "delegate_to_steward" | "delegate_to_worker") {
        model.delegation_gate(session.into()).await?;
        model.delegation_task(session.into()).await?;
    }
    if matches!(
        name,
        "write_file" | "edit_file" | "call_mcp_tool" | "delegate_to_steward" | "delegate_to_worker"
    ) {
        model.effect_gate(session.into()).await?;
    }
    Ok(())
}
