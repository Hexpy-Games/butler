//! Bounded-page reads and source-compatible public conversation enrichment.

use butler_core::public_text::fixed_regex;
use std::sync::LazyLock;

use regex::Regex;

use super::super::AppApplication;
use super::AppWorkStatusConversationFact;
use crate::gateway::GatewayApplicationError;

impl AppApplication {
    pub(crate) async fn work_status_conversation_owned(
        &self,
        session_id: String,
    ) -> Result<AppWorkStatusConversationFact, GatewayApplicationError> {
        self.storage
            .execute(move |db| super::materialized::read(db, &session_id))
            .await
            .map_err(super::super::app_error)
    }
}

/// References are sorted by descending byte length by the materialized projection.
pub(super) fn safe_conversation_label(
    value: &str,
    internal_refs: &[String],
    fallback: &str,
) -> String {
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
    // Longer references cannot match the original label. Shorter replacements
    // retain their original order and inspect the current text after each match.
    let start = internal_refs.partition_point(|reference| reference.len() > value.len());
    for reference in &internal_refs[start..] {
        if text.contains(reference) {
            text = text.replace(reference, "internal reference");
        }
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
    let safe = butler_core::public_text::sanitize_public_text(text.trim(), fallback);
    let mut units = safe.encode_utf16();
    let preview = units.by_ref().take(180).collect::<Vec<_>>();
    if units.next().is_some() {
        format!("{}...", String::from_utf16_lossy(&preview[..177]))
    } else {
        safe
    }
}
