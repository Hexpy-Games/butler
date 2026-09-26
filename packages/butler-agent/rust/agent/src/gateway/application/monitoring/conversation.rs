//! Bounded-page reads and source-compatible public conversation enrichment.

use crate::public_text::fixed_regex;
use std::{cmp::Reverse, collections::HashSet, sync::LazyLock};

use regex::Regex;

use super::super::{AppApplication, AppSessionViewPage};
use super::AppWorkStatusConversationFact;
use crate::gateway::{
    GatewayApplicationError,
    protocol::{MessageRole, MessageStatus},
};

impl AppApplication {
    pub(crate) async fn work_status_conversation_owned(
        &self,
        chat_id: String,
    ) -> Result<AppWorkStatusConversationFact, GatewayApplicationError> {
        let runtime_session_id = super::super::app_session_hint(&chat_id);
        let mut after_cursor = Some(0_u64);
        let mut latest_report = None;
        let mut internal_refs = HashSet::from([chat_id.clone(), runtime_session_id]);

        loop {
            let page = self
                .message_window(
                    chat_id.clone(),
                    AppSessionViewPage {
                        after_cursor,
                        limit: 200,
                        ..AppSessionViewPage::default()
                    },
                )
                .await?;
            for message in &page.view.messages {
                push_nonempty(&mut internal_refs, Some(&message.id));
                push_nonempty(&mut internal_refs, Some(&message.chat_id));
                push_nonempty(&mut internal_refs, message.turn_id.as_deref());
                push_nonempty(
                    &mut internal_refs,
                    message.conversation_session_id.as_deref(),
                );
                push_nonempty(&mut internal_refs, message.conversation_turn_id.as_deref());
                push_nonempty(
                    &mut internal_refs,
                    message.conversation_message_id.as_deref(),
                );
                if matches!(&message.role, MessageRole::Assistant)
                    && matches!(&message.status, MessageStatus::Delivered)
                {
                    if !message.text.trim().is_empty() {
                        latest_report = Some(message.text.clone());
                    }
                    for artifact in message.artifacts.as_deref().unwrap_or_default() {
                        push_nonempty(&mut internal_refs, Some(&artifact.id));
                        push_nonempty(&mut internal_refs, artifact.session_id.as_deref());
                        push_nonempty(&mut internal_refs, artifact.project_id.as_deref());
                        push_nonempty(&mut internal_refs, artifact.message_id.as_deref());
                        push_nonempty(&mut internal_refs, artifact.turn_id.as_deref());
                        push_nonempty(&mut internal_refs, artifact.file_id.as_deref());
                    }
                }
            }
            if !page.has_more {
                break;
            }
            let Some(cursor) = page.view.messages.last().map(|message| message.cursor) else {
                break;
            };
            if after_cursor.is_some_and(|previous| previous >= cursor) {
                return Err(GatewayApplicationError::Internal);
            }
            after_cursor = Some(cursor);
        }

        let mut internal_refs = internal_refs.into_iter().collect::<Vec<_>>();
        internal_refs.sort_unstable_by(|left, right| {
            Reverse(left.len())
                .cmp(&Reverse(right.len()))
                .then_with(|| left.cmp(right))
        });
        let latest_report_summary = latest_report.map(|report| {
            safe_conversation_label(&report, &internal_refs, "A recent report is available.")
        });
        let mut after_cursor = Some(0_u64);
        let mut seen_artifacts = HashSet::new();
        let mut recent_artifacts = Vec::new();
        loop {
            let page = self
                .message_window(
                    chat_id.clone(),
                    AppSessionViewPage {
                        after_cursor,
                        limit: 200,
                        ..AppSessionViewPage::default()
                    },
                )
                .await?;
            for message in &page.view.messages {
                if !matches!(&message.role, MessageRole::Assistant)
                    || !matches!(&message.status, MessageStatus::Delivered)
                {
                    continue;
                }
                for artifact in message.artifacts.as_deref().unwrap_or_default() {
                    let label =
                        safe_conversation_label(&artifact.title, &internal_refs, "Artifact");
                    if seen_artifacts.insert(label.clone()) {
                        recent_artifacts.push(label);
                        if recent_artifacts.len() > 3 {
                            recent_artifacts.remove(0);
                        }
                    }
                }
            }
            if !page.has_more {
                break;
            }
            let Some(cursor) = page.view.messages.last().map(|message| message.cursor) else {
                break;
            };
            if after_cursor.is_some_and(|previous| previous >= cursor) {
                return Err(GatewayApplicationError::Internal);
            }
            after_cursor = Some(cursor);
        }
        Ok(AppWorkStatusConversationFact {
            latest_report_summary,
            recent_artifacts,
        })
    }
}

fn push_nonempty(values: &mut HashSet<String>, value: Option<&str>) {
    if let Some(value) = value.filter(|value| !value.is_empty()) {
        values.insert(value.to_owned());
    }
}

fn safe_conversation_label(value: &str, internal_refs: &[String], fallback: &str) -> String {
    static MARKDOWN_LINK: LazyLock<Regex> =
        LazyLock::new(|| fixed_regex(r"!?\[([^\]]*)\]\([^)]*\)"));
    static URL: LazyLock<Regex> = LazyLock::new(|| fixed_regex(r"(?i)\b[a-z][a-z0-9+.-]*://\S+"));
    static UNIX_PATH: LazyLock<Regex> = LazyLock::new(|| {
        fixed_regex(r"(?:/Users|/home|/private|/var|/tmp|/Volumes|/opt|/usr|/etc)/[^\s),;]+")
    });
    static HOME_PATH: LazyLock<Regex> = LazyLock::new(|| fixed_regex(r"(?:~/|\$HOME/)[^\s),;]+"));
    static WINDOWS_PATH: LazyLock<Regex> = LazyLock::new(|| fixed_regex(r"\b[A-Za-z]:\\[^\s),;]+"));
    static UNC_PATH: LazyLock<Regex> = LazyLock::new(|| fixed_regex(r"\\\\[^\s\\]+\\[^\s),;]+"));
    static REPOSITORY_PATH: LazyLock<Regex> =
        LazyLock::new(|| fixed_regex(r"\b(?:packages|src|tests|docs|project-ledger)/[^\s),;]+"));
    static UUID: LazyLock<Regex> =
        LazyLock::new(|| fixed_regex(r"(?i)\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b"));
    static LONG_HEX: LazyLock<Regex> = LazyLock::new(|| fixed_regex(r"(?i)\b[0-9a-f]{24,}\b"));

    let mut text = value.to_owned();
    for reference in internal_refs {
        text = text.replace(reference, "internal reference");
    }
    text = MARKDOWN_LINK.replace_all(&text, "$1").into_owned();
    text = URL.replace_all(&text, "reference").into_owned();
    text = UNIX_PATH.replace_all(&text, "local reference").into_owned();
    text = HOME_PATH.replace_all(&text, "local reference").into_owned();
    text = WINDOWS_PATH
        .replace_all(&text, "local reference")
        .into_owned();
    text = UNC_PATH.replace_all(&text, "local reference").into_owned();
    text = REPOSITORY_PATH
        .replace_all(&text, "local reference")
        .into_owned();
    text = UUID.replace_all(&text, "internal reference").into_owned();
    text = LONG_HEX
        .replace_all(&text, "internal reference")
        .into_owned();
    let safe = crate::public_text::sanitize_public_text(text.trim(), fallback);
    let mut units = safe.encode_utf16();
    let preview = units.by_ref().take(180).collect::<Vec<_>>();
    if units.next().is_some() {
        format!("{}...", String::from_utf16_lossy(&preview[..177]))
    } else {
        safe
    }
}
