use super::*;
/// Editor authorization is persisted with the user message's content metadata.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImageEditRequest {
    pub image: String,
    pub mask: Option<String>,
}

impl MessageSendRequest {
    pub(in crate::gateway) fn persist_editor_metadata(&mut self) -> Result<(), serde_json::Error> {
        if let Some(edit) = self.image_edit.take() {
            let text = self
                .text
                .as_ref()
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let content = self.content_parts.get_or_insert_with(|| MessageContent {
                version: 1,
                parts: vec![MessageContentPart::Text {
                    text,
                    extra: Map::new(),
                }],
                extra: Map::new(),
            });
            content
                .extra
                .insert("image_edit".into(), serde_json::to_value(edit)?);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default)]
pub struct MessageSendRequest {
    pub image_edit: Option<ImageEditRequest>,
    pub expected_project_id: Option<String>,
    pub content_parts: Option<MessageContent>,
    pub chat_id: Option<Value>,
    pub text: Option<Value>,
    pub client_message_id: Option<Value>,
    pub attachments: Option<Value>,
    pub model: Option<Value>,
    pub reasoning_effort: Option<Value>,
    pub access_mode: Option<Value>,
    pub plan_mode: Option<Value>,
    pub subsession_result: Option<butler_turn::btcc::SubsessionResultContext>,
    /// Set only by the scheduler and the internal steward-result route (never
    /// parsed from a client body): the schedule run this message belongs to,
    /// and whether nobody attends it.
    pub schedule_run: Option<butler_turn::btcc::ScheduleRunContext>,
}
