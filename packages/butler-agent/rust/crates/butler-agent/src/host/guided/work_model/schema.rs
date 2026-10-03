use serde_json::{Value, json};

fn object(fields: &[(&str, Value)], required: &[&str]) -> Value {
    json!({"type":"object","additionalProperties":false,
        "properties":fields.iter().map(|(k,v)| ((*k).to_owned(),v.clone())).collect::<serde_json::Map<_,_>>(),"required":required})
}
fn string() -> Value {
    json!({"type":"string"})
}
fn integer() -> Value {
    json!({"type":"integer","minimum":0})
}
fn list(item: Value) -> Value {
    let mut value = json!({"type":"array"});
    if let Some(object) = value.as_object_mut() {
        object.insert("items".into(), item);
    }
    value
}
fn strings() -> Value {
    list(string())
}

fn criterion() -> Value {
    object(
        &[
            ("id", string()),
            ("text", string()),
            ("part_id", string()),
            ("verification", string()),
        ],
        &["id", "text"],
    )
}
fn task() -> Value {
    object(
        &[
            ("key", string()),
            ("description", string()),
            ("work_key", string()),
            ("node_id", string()),
            ("part_ids", strings()),
            ("criterion_ids", strings()),
            ("after", strings()),
            ("allow_nested_delegation", json!({"type":"boolean"})),
            (
                "kind",
                json!({"type":"string","enum":["execute","integrate","review"]}),
            ),
        ],
        &["key", "description", "criterion_ids"],
    )
}
fn work() -> Value {
    object(
        &[
            ("key", string()),
            ("node_id", string()),
            ("outcome", string()),
            ("part_ids", strings()),
            ("criterion_ids", strings()),
        ],
        &["key", "node_id", "outcome", "part_ids", "criterion_ids"],
    )
}
fn node() -> Value {
    let part = object(
        &[
            ("id", string()),
            ("behaviour", string()),
            ("design", string()),
            ("implementation", string()),
        ],
        &["id", "behaviour"],
    );
    let coverage = object(
        &[
            ("criterion_id", string()),
            ("child_node_id", string()),
            ("child_criterion_id", string()),
            ("semantics", json!({"type":"string","enum":["all","any"]})),
            ("justification", string()),
        ],
        &["criterion_id", "child_node_id", "child_criterion_id"],
    );
    object(
        &[
            ("node_id", string()),
            ("node_revision", integer()),
            ("parent_id", json!({"type":["string","null"]})),
            ("concern_id", string()),
            ("responsibility", string()),
            (
                "kind",
                json!({"type":"string","enum":["brief","software","research"]}),
            ),
            ("parts", list(part)),
            ("criteria", list(criterion())),
            ("child_coverage", list(coverage)),
            ("source_refs", strings()),
            ("decision_refs", strings()),
            ("research_method", research()),
            ("independent_review", json!({"type":"boolean"})),
        ],
        &[
            "node_id",
            "parent_id",
            "concern_id",
            "responsibility",
            "kind",
            "parts",
            "criteria",
        ],
    )
}
fn command(op: &str, fields: &[(&str, Value)], required: &[&str]) -> Value {
    let mut fields = fields.to_vec();
    fields.push(("op", json!({"type":"string","enum":[op]})));
    let mut required = required.to_vec();
    required.push("op");
    object(&fields, &required)
}
fn bootstrap() -> Vec<Value> {
    let bundle = object(
        &[
            ("tier", json!({"type":"integer","enum":[2]})),
            ("goal", string()),
            ("root_node_id", string()),
            ("nodes", list(node())),
            ("works", list(work())),
            ("tasks", list(task())),
        ],
        &["tier", "goal", "root_node_id", "nodes", "works", "tasks"],
    );
    vec![
        command(
            "create_light",
            &[
                ("goal", string()),
                ("done_criteria", list(criterion())),
                ("tasks", list(task())),
            ],
            &["goal", "done_criteria", "tasks"],
        ),
        command("create", &[("bundle", bundle)], &["bundle"]),
    ]
}
fn lifecycle() -> Vec<Value> {
    let base = [("task_id", string()), ("expected_revision", integer())];
    let mut commands = ["start", "complete", "remove"]
        .map(|op| command(op, &base, &["task_id", "expected_revision"]))
        .to_vec();
    commands.push(command(
        "submit",
        &[
            base[0].clone(),
            base[1].clone(),
            ("result_refs", strings()),
            ("evidence_refs", strings()),
        ],
        &[
            "task_id",
            "expected_revision",
            "result_refs",
            "evidence_refs",
        ],
    ));
    let result = object(
        &[
            ("criterion_id", string()),
            (
                "verdict",
                json!({"type":"string","enum":["pass","fail","unverified"]}),
            ),
            ("evidence_refs", strings()),
            ("reason", string()),
        ],
        &["criterion_id", "verdict", "evidence_refs", "reason"],
    );
    commands.push(command(
        "review",
        &[
            base[0].clone(),
            base[1].clone(),
            ("result_revision", integer()),
            ("criterion_results", list(result)),
        ],
        &[
            "task_id",
            "expected_revision",
            "result_revision",
            "criterion_results",
        ],
    ));
    commands.push(command(
        "complete_work",
        &[("work_id", string())],
        &["work_id"],
    ));
    commands.push(command("complete_plan", &[], &[]));
    let edge = object(&[("from", string()), ("to", string())], &["from", "to"]);
    commands.push(command(
        "dependencies",
        &[("add", list(edge.clone())), ("remove", list(edge.clone()))],
        &["add", "remove"],
    ));
    commands.push(command(
        "reorder",
        &[("task_ids", strings())],
        &["task_ids"],
    ));
    commands.push(command("step",&[("task_id",string()),("phase",json!({"type":"string","enum":["conception","planning","execution","review","validation","reporting"]}))],&["task_id","phase"]));
    commands.retain(|c| c["properties"]["op"]["enum"][0] != "remove");
    commands.push(command(
        "remove",
        &[
            base[0].clone(),
            base[1].clone(),
            ("remove_edges", list(edge)),
        ],
        &["task_id", "expected_revision", "remove_edges"],
    ));
    commands
}

pub(super) fn definitions(create: bool, child: bool) -> Vec<Value> {
    let mut commands = if create { bootstrap() } else { vec![] };
    commands.extend(lifecycle());
    if child {
        commands.retain(|c| {
            ["start", "submit", "review", "complete"].contains(
                &c["properties"]["op"]["enum"][0]
                    .as_str()
                    .unwrap_or_default(),
            )
        });
    }
    vec![
        json!({"name":"work_apply","description":"Create request-bound brief/full Spec and canonical Tasks, or execute/review them. No Spec approval prompt. Runtime supplies instruction identity.",
        "parameters":object(&[("command",json!({"anyOf":commands})),("expected_graph_revision",integer()),("idempotency_key",string())], &["command"])}),
        json!({"name":"work_read","description":"Read canonical Summary, Tasks, DAG or exact Spec and ancestors. Page cursors preserve complete state.",
            "parameters":object(&[("view",json!({"type":"string","enum":["summary","tasks","graph","spec","operations"]})),("cursor",string()),("node_id",string())], &["view"])}),
    ]
}

fn research() -> Value {
    object(
        &[
            ("questions", strings()),
            ("hypotheses", strings()),
            ("method", string()),
            ("variables_controls", string()),
            ("sampling_sources", string()),
            ("analysis", string()),
            ("falsification", string()),
        ],
        &[
            "questions",
            "hypotheses",
            "method",
            "variables_controls",
            "sampling_sources",
            "analysis",
            "falsification",
        ],
    )
}
