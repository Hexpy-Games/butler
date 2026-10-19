use super::UsageAttribution;

impl UsageAttribution {
    /// An auxiliary operation performed on behalf of a known chat.
    pub fn attributed_background(phase: &str, root: Option<String>, role: Option<String>) -> Self {
        Self {
            usage_root: root,
            usage_role: role,
            ..Self::background(phase)
        }
    }

    /// A model operation outside a turn, classified independently of its destination.
    pub fn background(phase: &str) -> Self {
        Self {
            usage_root: None,
            usage_role: None,
            session_kind: Some("background".into()),
            turn_id: String::new(),
            prompt_diagnostics: None,
            phase: phase.into(),
            reasoning_effort: None,
            round_index: None,
        }
    }
}
