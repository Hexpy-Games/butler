use super::*;

impl SqliteSubsessionRepository {
    pub(crate) async fn prompt_result_for_relation(
        &self,
        relation: String,
    ) -> Result<Option<Value>, StorageError> {
        let Some(mut result) = self.result_for_relation(relation).await? else {
            return Ok(None);
        };
        let id = result
            .get("result_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let summary = result
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let refs: Vec<String> = serde_json::from_value(
            result
                .get("acceptance_evidence")
                .cloned()
                .unwrap_or(Value::Null),
        )
        .map_err(|e| StorageError::new(StorageCode::SubsessionResultInvalid, e.to_string()))?;
        let manifest = self
            .storage
            .execute(move |db| {
                super::super::operation_results::evidence::manifest(db, &id, &refs, &summary)
            })
            .await?;
        if let Some(object) = result.as_object_mut() {
            object.remove("acceptance_evidence");
            object.insert("evidence".into(), manifest.into());
        }
        Ok(Some(result))
    }
}

pub(super) fn delivery_text(
    db: &rusqlite::Connection,
    id: &str,
    status: &str,
    summary: &str,
    refs: &[String],
    feedback: &str,
) -> Result<String, StorageError> {
    let evidence = super::super::operation_results::evidence::manifest(db, id, refs, summary)?;
    Ok(format!(
        "Delegated result\nresult_id: {id}\nstatus: {status}\nsummary: {summary}\n{evidence}{feedback}"
    ))
}
