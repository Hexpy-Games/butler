//! Lane-bound App intent adapter and runtime ownership operation.
use super::*;

pub(super) fn pending(storage: BtccStorage) -> ApplicationFuture<Vec<Value>> {
    Box::pin(async move {
        storage.work_model_read(|db| {
        let mut stmt = db.prepare(store::ownership_sql::PENDING_PROJECTIONS)?;
        let rows = stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().map(|(op,kind,payload)|Ok(json!({"op_id":op,"kind":kind,"payload":serde_json::from_str::<Value>(&payload)?}))).collect()
    }).await.map_err(error)
    })
}
pub(super) fn applied(storage: BtccStorage, op: String) -> ApplicationFuture<()> {
    Box::pin(async move {
        storage
            .work_model_write(move |tx| {
                store::acknowledge_intent(
                    tx,
                    &store::Context {
                        now: chrono::Utc::now().timestamp_millis(),
                        actor: json!({"runtime":"app_projection"}),
                    },
                    &op,
                )?;
                Ok(())
            })
            .await
            .map_err(error)
    })
}
pub(super) async fn ownership(
    service: &butler_turn::btcc::SubsessionService,
    session: String,
    input: Option<Value>,
) -> Result<Value, GatewayApplicationError> {
    let input = input.ok_or_else(GatewayApplicationError::internal)?;
    let task = input["task_id"]
        .as_str()
        .ok_or_else(GatewayApplicationError::internal)?;
    let decision = input["decision"]
        .as_str()
        .ok_or_else(GatewayApplicationError::internal)?;
    let expected = input["expected_revision"]
        .as_i64()
        .ok_or_else(GatewayApplicationError::internal)?;
    let expected_epoch = input["expected_owner_epoch"]
        .as_i64()
        .ok_or_else(GatewayApplicationError::internal)?;
    let result = service
        .task_ownership(&session, task, decision, expected, expected_epoch)
        .await
        .map_err(GatewayApplicationError::internal_from)?;
    if result["error"]["code"] == "conflict" {
        return Err(GatewayApplicationError::Public {
            status: 409,
            code: "conflict".into(),
            message: "이미 다른 대화로 옮겨졌습니다".into(),
            source: None,
        });
    }
    Ok(result)
}
