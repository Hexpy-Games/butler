use super::*;
use butler_gateway::gateway::{APP_PERSON_ID, AppCanonDelegate};
fn context(delegate: Option<AppCanonDelegate>) -> store::Context {
    store::Context {
        now: chrono::Utc::now().timestamp_millis(),
        actor: delegate
            .map(|d| json!({"person":APP_PERSON_ID,"via":d.title,"client":d.name,"origin":"mcp"}))
            .unwrap_or_else(|| json!({"person":APP_PERSON_ID,"via":"app"})),
    }
}
pub(super) fn admit(
    storage: BtccStorage,
    delegate: AppCanonDelegate,
    capability: String,
) -> ApplicationFuture<Value> {
    Box::pin(async move {
        let ctx = context(Some(delegate));
        storage
            .canon_write(move |tx| store::grants::admit(tx, &ctx, &capability))
            .await
            .map_err(error)
    })
}
pub(super) fn execute(
    storage: BtccStorage,
    ledger: progress::ProjectReader,
    request: AppCanonRequest,
) -> ApplicationFuture<Value> {
    Box::pin(async move {
        let AppCanonRequest {
            resource,
            id,
            input,
            delegate,
        } = request;
        let delegated = delegate.is_some();
        let query = matches!(
            resource,
            AppCanonResource::List | AppCanonResource::Activity | AppCanonResource::Grants
        );
        let result = if input.is_some() && !query {
            let input = input.unwrap_or(Value::Null);
            let ctx = context(delegate);
            storage
                .canon_write(move |tx| {
                    let value = store::write_api(tx, &ctx, store_resource(resource), &id, input)?;
                    project(tx, resource, value, delegated)
                })
                .await
                .map_err(error)
        } else {
            storage
                .canon_read(move |db| {
                    if resource == AppCanonResource::EpicProgress {
                        return Ok(json!({"epic_id":id}));
                    }
                    if delegated && resource == AppCanonResource::Epic {
                        return Ok(serde_json::to_value(store::public::epic(db, &id)?)?);
                    }
                    if delegated && resource == AppCanonResource::Canon {
                        return store::page::list(db, &id, &json!({}));
                    }
                    if delegated && resource == AppCanonResource::Plan {
                        let plan = store::read_plan(db, &id)?;
                        return store::page::list(
                            db,
                            plan["project_id"].as_str().unwrap_or_default(),
                            &json!({"plan_id":id}),
                        );
                    }
                    let value = store::api::read_query(
                        db,
                        store_resource(resource),
                        &id,
                        &input.unwrap_or(json!({})),
                    )?;
                    project(db, resource, value, delegated)
                })
                .await
                .map_err(error)
        }?;
        if delegated {
            Ok(result)
        } else {
            progress::enrich(&storage, &ledger, result).await
        }
    })
}

fn project(
    db: &rusqlite::Connection,
    resource: AppCanonResource,
    value: Value,
    delegated: bool,
) -> store::Result<Value> {
    if delegated
        && matches!(
            resource,
            AppCanonResource::Epic | AppCanonResource::CreateEpic | AppCanonResource::EditEpic
        )
    {
        return Ok(serde_json::to_value(store::public::project_epic(
            &value, db,
        )?)?);
    }
    Ok(value)
}
