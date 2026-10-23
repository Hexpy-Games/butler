//! A replay carries the complete original execution without executing its tools.
use super::super::{BtccStorage, StorageResult};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

pub(crate) const TURN: &str = "SELECT t.turn_id,t.original_message,t.final_payload_json FROM wm_instructions i JOIN btcc_turns t ON t.turn_id=i.anchor_id WHERE i.id=?1 AND i.target_session_id=?2";
pub(crate) const ROUNDS: &str = "SELECT normalized_response_json FROM btcc_model_round_acceptances WHERE turn_id=?1 ORDER BY rowid";
pub(crate) const TOOLS: &str = "SELECT tool_name,arguments_json,status,result_json,error_code FROM btcc_guided_tool_calls WHERE turn_id=?1 ORDER BY turn_sequence,rowid";

impl BtccStorage {
    pub async fn kept_work_model_transcript(
        &self,
        session: String,
        message: &str,
    ) -> StorageResult<Option<String>> {
        let Some(receipt) = message.strip_prefix("cutover-message:") else {
            return Ok(None);
        };
        let receipt = receipt.to_owned();
        self.work_model_read(move |db| {
            let source: Option<(String, String, Option<String>)> = db
                .query_row(TURN, params![receipt, session], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
                .optional()?;
            let Some((turn, request, answer)) = source else {
                return Ok(None);
            };
            let responses = db
                .prepare(ROUNDS)?
                .query_map([&turn], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .map(|raw| serde_json::from_str::<Value>(&raw))
                .collect::<Result<Vec<_>, _>>()?;
            let tools = db
                .prepare(TOOLS)?
                .query_map([&turn], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })?
                .collect::<rusqlite::Result<Vec<StoredTool>>>()?
                .into_iter()
                .map(tool)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Some(
                json!({
                    "turn_id":turn, "request":request, "model_responses":responses,
                    "tool_results":tools,
                    "answer":answer.map(|raw|serde_json::from_str::<Value>(&raw)).transpose()?
                })
                .to_string(),
            ))
        })
        .await
    }
}

type StoredTool = (String, String, String, Option<String>, Option<String>);
fn tool((name, args, status, result, error): StoredTool) -> Result<Value, serde_json::Error> {
    Ok(json!({
        "name":name, "arguments":serde_json::from_str::<Value>(&args)?, "status":status,
        "result":result.map(|raw|serde_json::from_str::<Value>(&raw)).transpose()?, "error":error
    }))
}
