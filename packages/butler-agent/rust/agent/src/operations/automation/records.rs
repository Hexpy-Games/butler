use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::AutomationError;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(super) enum AutomationSchedule {
    Once {
        run_at: String,
    },
    Interval {
        interval_minutes: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        start_at: Option<String>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct AutomationRecord {
    pub version: u8,
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub session_id: String,
    pub status: String,
    pub schedule: AutomationSchedule,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    pub run_count: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct AutomationPreview {
    pub id: String,
    pub title: String,
    pub session_id: String,
    pub status: String,
    pub schedule: AutomationSchedule,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    pub run_count: u64,
    pub prompt_preview: String,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct ClaimedAutomationRun {
    pub automation: AutomationPreview,
    pub envelope: Value,
}

pub(super) fn preview(record: &AutomationRecord) -> AutomationPreview {
    let compact = compact_whitespace(&record.prompt);
    let prompt_preview = if compact.encode_utf16().count() > 160 {
        format!("{}...", utf16_prefix(&compact, 157))
    } else {
        compact
    };
    AutomationPreview {
        id: record.id.clone(),
        title: record.title.clone(),
        session_id: record.session_id.clone(),
        status: record.status.clone(),
        schedule: record.schedule.clone(),
        next_run_at: record.next_run_at.clone(),
        last_run_at: record.last_run_at.clone(),
        run_count: record.run_count,
        prompt_preview,
    }
}

pub(super) fn utf16_prefix(value: &str, limit: usize) -> String {
    let mut units = 0;
    value
        .chars()
        .take_while(|character| {
            let next = units + character.len_utf16();
            if next > limit {
                return false;
            }
            units = next;
            true
        })
        .collect()
}

fn compact_whitespace(value: &str) -> String {
    let mut output = String::new();
    let mut spacing = false;
    for character in value
        .trim_matches(|ch: char| ch.is_whitespace() || ch == '\u{feff}')
        .chars()
    {
        if character.is_whitespace() || character == '\u{feff}' {
            spacing = !output.is_empty();
        } else {
            if spacing {
                output.push(' ');
            }
            output.push(character);
            spacing = false;
        }
    }
    output
}

pub(super) fn envelope(record: &AutomationRecord, run_at: &str) -> Value {
    let run_number = record.run_count + 1;
    let id = format!("automation:{}:{run_number}", record.id);
    json!({
        "eventId": id,
        "transport": "automation",
        "accountId": "local",
        "peer": {"kind":"dm","id":record.session_id},
        "sender": {"id":"butler-automation","displayName":"Butler Automation"},
        "message": {"id":id,"text":record.prompt,"timestamp":run_at},
        "routingHints": {"sessionId":record.session_id},
        "raw": {"automationId":record.id,"runNumber":run_number},
    })
}

pub(super) fn format_millis(value: i64) -> Result<String, AutomationError> {
    crate::js_date::format_iso_millis(value).ok_or_else(|| {
        AutomationError::new(
            "automation_date_invalid",
            "Automation date is outside TimeClip",
        )
    })
}
