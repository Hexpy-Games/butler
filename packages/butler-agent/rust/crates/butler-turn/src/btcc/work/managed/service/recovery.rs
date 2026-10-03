//! Restart hydration uses Ledger bodies plus SQLite metadata/hash intents.
use super::*;
use butler_core::json::at;

impl WorkModelService {
    pub(super) async fn recover(&self) -> Result<(), BtccError> {
        let mut cursor = (String::new(), String::new());
        loop {
            let page = self.repository.pending_intents(cursor.clone()).await?;
            if page.is_empty() {
                return Ok(());
            }
            for intent in page {
                let session = at(&intent, "/session")
                    .as_str()
                    .ok_or_else(|| error("work_model_integrity_error"))?
                    .to_owned();
                let key = at(&intent, "/key")
                    .as_str()
                    .ok_or_else(|| error("work_model_integrity_error"))?
                    .to_owned();
                cursor = (session.clone(), key);
                let mut request = at(&intent, "/request").clone();
                if !self.hydrate(&session, &mut request).await? {
                    continue;
                }
                let request = decode_request(request)?;
                check(
                    Some(fingerprint(&request)?.as_str()) == at(&intent, "/hash").as_str(),
                    "work_model_integrity_error",
                )?;
                self.apply(session, request).await?;
            }
        }
    }
    async fn hydrate(&self, session: &str, request: &mut Value) -> Result<bool, BtccError> {
        let instruction = at(request, "/instruction_id")
            .as_str()
            .ok_or_else(|| error("work_model_integrity_error"))?
            .to_owned();
        let op = at(request, "/command/op").as_str().unwrap_or_default();
        let pointer = match op {
            "create" => "/command/bundle/nodes",
            "publish" => "/command/nodes",
            "create_light" => "/command/done_criteria",
            _ => return Ok(true),
        };
        let body = if op == "create_light" {
            let key = at(request, "/idempotency_key")
                .as_str()
                .ok_or_else(|| error("work_model_integrity_error"))?;
            let id = stable_id("SPEC", session, &format!("{instruction}:{key}"))?;
            let Some(verified) = self
                .publication
                .locate(session.into(), instruction, id, 1)
                .await?
            else {
                return Ok(false);
            };
            check(
                Some(fingerprint(&verified.node.criteria)?.as_str())
                    == at(request, "/command/done_criteria/hash").as_str(),
                "spec_integrity_error",
            )?;
            serde_json::to_value(verified.node.criteria)
                .map_err(|e| error("work_model_encoding_failed").with_source(e))?
        } else {
            let nodes = at(request, pointer)
                .as_array()
                .ok_or_else(|| error("work_model_integrity_error"))?;
            let mut bodies = Vec::new();
            for node in nodes {
                let id = at(node, "/node_id")
                    .as_str()
                    .ok_or_else(|| error("work_model_integrity_error"))?
                    .to_owned();
                let revision = at(node, "/node_revision")
                    .as_u64()
                    .ok_or_else(|| error("work_model_integrity_error"))?;
                let Some(verified) = self
                    .publication
                    .locate(session.into(), instruction.clone(), id, revision)
                    .await?
                else {
                    return Ok(false);
                };
                check(
                    Some(fingerprint(&verified.node)?.as_str())
                        == at(node, "/content_hash").as_str(),
                    "spec_integrity_error",
                )?;
                bodies.push(verified.node);
            }
            serde_json::to_value(bodies)
                .map_err(|e| error("work_model_encoding_failed").with_source(e))?
        };
        *request
            .pointer_mut(pointer)
            .ok_or_else(|| error("work_model_integrity_error"))? = body;
        Ok(true)
    }
}
