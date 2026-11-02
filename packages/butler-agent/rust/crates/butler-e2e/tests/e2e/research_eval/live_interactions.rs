//! Respond through the same durable request references as the App.
use butler_e2e::e2e::{HarnessError, gateway::Gateway};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub(super) const REPLY: &str = "Proceed with your best judgment; I have no further preferences. / 판단하신 대로 진행해 주세요. 추가로 원하는 조건은 없습니다.";

#[derive(Default)]
pub(super) struct Interactions {
    pub asks: usize,
    pub approvals: usize,
    handled: BTreeSet<String>,
}
impl Interactions {
    /// Owner-chat asks include requests from its Steward and Workers.
    /// Return false when a fourth distinct question remains pending.
    pub(super) async fn respond(&mut self, gw: &Gateway) -> Result<bool, HarnessError> {
        let pending = gw.get("/sessions/general/pending-asks").await?;
        if pending.status != 200 {
            return Err(HarnessError("pending asks unavailable".into()));
        }
        let cards = gw.approval_requests("general").await?;
        for ask in pending.data()["asks"].as_array().into_iter().flatten() {
            let id = ask["ask_id"].as_str().unwrap_or_default();
            if self.handled.contains(id) {
                continue;
            }
            let Some((kind, reference)) = id.split_once(':') else {
                return Err(HarnessError("unrecognized pending ask reference".into()));
            };
            let (action, body) = match kind {
                "question" => {
                    if self.asks == 3 {
                        return Ok(false);
                    }
                    let card = cards
                        .iter()
                        .find(|c| c["request_ref"] == reference)
                        .ok_or_else(|| HarnessError("pending question card unavailable".into()))?;
                    ("answer", response(&card["questions"])?)
                }
                "approval" => ("allow", json!({"scope":"once"})),
                _ => return Err(HarnessError("unsupported pending ask kind".into())),
            };
            let result = gw
                .post(
                    &format!("/authority-requests/{reference}/{action}?session_id=general"),
                    body,
                )
                .await?;
            if result.status != 202 {
                return Err(HarnessError(format!(
                    "pending ask response failed: {}",
                    result.status
                )));
            }
            self.handled.insert(id.to_owned());
            if kind == "question" {
                self.asks += 1;
            } else {
                self.approvals += 1;
            }
        }
        Ok(true)
    }
}
fn response(questions: &Value) -> Result<Value, HarnessError> {
    let fields = questions["questions"]
        .as_array()
        .ok_or_else(|| HarnessError("pending question fields unavailable".into()))?;
    let answers: Vec<_> = fields
        .iter()
        .map(|q| json!({"id":q["id"],"selected":[],"custom":REPLY,"skipped":false}))
        .collect();
    Ok(json!({"status":"answered","answers":answers}))
}
