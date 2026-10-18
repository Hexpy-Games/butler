//! W3C correlation without propagating credentials or external headers.
#[derive(Clone, Default, serde::Deserialize, serde::Serialize)]
#[serde(default)]
pub struct TraceContext {
    pub trace_id: Option<String>,
    pub span_id: Option<String>,
    pub turn_id: Option<String>,
    pub chat_id: Option<String>,
    pub message_id: Option<String>,
}
impl TraceContext {
    pub fn current() -> Self {
        let mut row = crate::Record::new("DEBUG", "trace", "context", "");
        crate::structured_logging::current_ids(&mut row);
        Self {
            trace_id: row.trace_id,
            span_id: row.span_id,
            turn_id: row.turn_id,
            chat_id: row.chat_id,
            message_id: row.attrs["message_id"].as_str().map(str::to_owned),
        }
    }
    pub fn from_traceparent(value: &str) -> Option<Self> {
        let parts: Vec<_> = value.split('-').collect();
        if parts.len() != 4
            || parts[0] != "00"
            || !crate::structured_logging::valid_trace_id(parts[1], 32)
            || !crate::structured_logging::valid_trace_id(parts[2], 16)
            || parts[3].len() != 2
            || !parts[3]
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return None;
        }
        Some(Self {
            trace_id: Some(parts[1].into()),
            span_id: Some(parts[2].into()),
            ..Self::default()
        })
    }
    pub fn http_span(&self, level: &str) -> tracing::Span {
        let trace_id = self
            .trace_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
        tracing::error_span!(parent: None, "http.server", log_level = level, trace_id,
            parent_span_id = self.span_id.as_deref(), turn_id = self.turn_id.as_deref(),
            chat_id = self.chat_id.as_deref(), message_id = self.message_id.as_deref())
    }
    pub fn span(&self, name: &'static str) -> tracing::Span {
        let trace_id = self
            .trace_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
        let parent = self.span_id.as_deref();
        let turn_id = self.turn_id.as_deref();
        let chat_id = self.chat_id.as_deref();
        match name {
            "http.server" => self.http_span("DEBUG"),
            _ => {
                tracing::info_span!(parent: None, "turn.queue", trace_id, parent_span_id = parent, turn_id, chat_id, message_id = self.message_id.as_deref())
            }
        }
    }
}
