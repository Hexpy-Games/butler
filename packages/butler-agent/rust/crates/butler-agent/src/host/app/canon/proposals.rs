//! Canon proposal adapter; every query uses the existing canon SQL lanes.
use super::*;

pub(super) fn execute(
    storage: BtccStorage,
    action: String,
    input: Value,
) -> ApplicationFuture<Value> {
    Box::pin(async move {
        if matches!(
            action.as_str(),
            "get" | "raw" | "open" | "turns" | "spec" | "specs" | "attention"
        ) {
            return storage
                .canon_read(move |db| read(db, &action, &input))
                .await
                .map_err(error);
        }
        let ctx = store::Context {
            now: chrono::Utc::now().timestamp_millis(),
            actor: json!({"person":butler_gateway::gateway::APP_PERSON_ID,
                "via":if input["by"].is_null(){"butler"}else{"app"},"origin":"chat"}),
        };
        storage
            .canon_write(move |tx| write(tx, &ctx, &action, &input))
            .await
            .map_err(error)
    })
}
fn read(db: &rusqlite::Connection, action: &str, input: &Value) -> store::Result<Value> {
    let id = input["id"].as_str().unwrap_or_default();
    match action {
        "spec" => store::read_canon_spec(db, id),
        "specs" => store::canon_project_spec_nodes(db, id),
        "get" => store::canon_proposal_detail(db, id, input["language"].as_str().unwrap_or("en")),
        "raw" => store::get_canon_proposal(db, id),
        "open" => Ok(json!(store::open_canon_proposals(
            db,
            input["session_id"].as_str(),
            usize::try_from(input["limit"].as_u64().unwrap_or(201))
                .map_err(|_| store::Error::Invalid("limit too large"))?,
            input["before"].as_str(),
            input["language"].as_str().unwrap_or("en")
        )?)),
        "attention" => {
            let mut owners = Vec::new();
            for owner in input["sessions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                let count: i64 =
                    db.query_row(store::COUNT_CANON_OPEN_PROPOSALS, [owner], |r| r.get(0))?;
                if count > 0 {
                    owners.push(owner);
                }
            }
            Ok(json!(owners))
        }
        _ => {
            let turns = input["turns"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            Ok(json!(store::canon_proposal_turn_cards(db, &turns)?))
        }
    }
}
fn write(
    tx: &store::Transaction<'_>,
    ctx: &store::Context,
    action: &str,
    input: &Value,
) -> store::Result<Value> {
    let id = input["id"].as_str().unwrap_or_default();
    let row = if matches!(action, "apply" | "cancel") {
        Some(store::get_canon_proposal(tx, id)?)
    } else {
        None
    };
    let by = if row.as_ref().is_some_and(|r| r["source"] == "mcp") {
        Some("inspector")
    } else {
        input["by"].as_str()
    };
    match action {
        "select" => store::select_canon_proposal_target(
            tx,
            id,
            input["project_id"].as_str(),
            input["new_name"].as_str(),
        ),
        "create" => store::create_canon_proposal(tx, ctx, input),
        "apply" => store::apply_canon_proposal(
            tx,
            ctx,
            id,
            input["project_id"].as_str().unwrap_or_default(),
            by,
        ),
        "cancel" => store::transition_canon_proposal(tx, ctx, id, "cancelled", by),
        "bind" => {
            store::bind_canon_proposal_epic(
                tx,
                ctx,
                id,
                input["session_id"].as_str().unwrap_or_default(),
            )?;
            Ok(
                json!({"ok":true,"bound":[format!("canon:epic/{id}")],"message":store::CANON_APPLIED_MESSAGE}),
            )
        }
        _ => Err(store::Error::Invalid("unknown proposal action")),
    }
}
