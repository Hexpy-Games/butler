use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::btcc::{BtccError, BtccRepositories, ContextDocumentRead, TurnRecord};

pub(super) struct DocumentProjection {
    pub context: String,
    pub response_language: String,
    pub governing: String,
    pub persona: String,
    pub eol: String,
}

fn references<'a>(turn: &'a TurnRecord, field: &str) -> impl Iterator<Item = &'a str> {
    turn.context
        .get(field)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

async fn group(
    repo: &BtccRepositories,
    refs: impl Iterator<Item = String>,
    limit: usize,
    projected: Option<&HashMap<String, String>>,
) -> String {
    let mut remaining = limit;
    let mut contents = Vec::new();
    for reference in refs {
        if remaining == 0 {
            break;
        }
        // Source treats missing optional context as a best-effort omission.
        let content: Cow<'_, str> = match projected {
            Some(projected) => {
                Cow::Borrowed(projected.get(&reference).map(String::as_str).unwrap_or(""))
            }
            None => match repo.resolve_context_document(reference).await {
                Ok(content) => Cow::Owned(content),
                Err(_) => continue,
            },
        };
        let prefix = crate::json::Utf16Prefix::new(content.as_ref(), remaining);
        let value = prefix.utf8_for_hash();
        if !crate::public_text::trim_js_whitespace(&value).is_empty() {
            contents.push(value.into_owned());
        }
        remaining = remaining.saturating_sub(prefix.len_utf16());
    }
    contents.join("\n\n")
}

fn language(candidate: &str) -> Option<String> {
    static RESPONSE_LANGUAGE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?imu)^Assistant Response Language:\s*(.+)$")
            .expect("source response language pattern")
    });
    let prefix = crate::json::Utf16Prefix::new(candidate, 12_000);
    let text = prefix.utf8_for_hash();
    let language = RESPONSE_LANGUAGE.captures(&text)?.get(1)?;
    let language = crate::public_text::trim_js_whitespace(language.as_str());
    (!language.is_empty()).then(|| {
        crate::json::Utf16Prefix::new(language, 80)
            .utf8_for_hash()
            .into_owned()
    })
}

pub(super) async fn response_language(repo: &BtccRepositories, turn: &TurnRecord) -> String {
    for reference in
        references(turn, "mandatoryHotCacheRefs").chain(references(turn, "optionalHotCacheRefs"))
    {
        if let Ok(content) = repo.resolve_context_document(reference.to_owned()).await
            && let Some(language) = language(&content)
        {
            return language;
        }
    }
    String::new()
}

fn bounded_non_eol(documents: Vec<ContextDocumentRead>) -> Vec<ContextDocumentRead> {
    let mut remaining = 10 * 1024;
    let count = documents.len();
    let mut bounded = Vec::new();
    for (index, mut document) in documents.into_iter().enumerate() {
        if remaining == 0 {
            break;
        }
        let allowance = remaining / (count - index);
        let mut bytes = 0;
        let mut end = 0;
        for (offset, character) in document.content.char_indices() {
            let size = character.len_utf8();
            if bytes + size > allowance {
                break;
            }
            bytes += size;
            end = offset + size;
        }
        document.content.truncate(end);
        remaining -= bytes;
        bounded.push(document);
    }
    bounded
}

pub(super) async fn read(
    repo: &BtccRepositories,
    turn: &TurnRecord,
    response_language: String,
    projected: Option<&HashMap<String, String>>,
) -> Result<DocumentProjection, BtccError> {
    let recent = group(
        repo,
        references(turn, "recentFeedbackRefs").map(str::to_owned),
        20_000,
        projected,
    )
    .await;
    let mandatory = group(
        repo,
        references(turn, "mandatoryHotCacheRefs").map(str::to_owned),
        36_000,
        projected,
    )
    .await;
    let optional = group(
        repo,
        references(turn, "optionalHotCacheRefs").map(str::to_owned),
        16_000,
        projected,
    )
    .await;
    let mut groups = Vec::new();
    for (title, value) in [
        ("Recent conversation and feedback", recent),
        ("Required working context", mandatory),
        ("Optional working context", optional),
    ] {
        if !value.is_empty() {
            groups.push(format!("## {title}\n\n{value}"));
        }
    }
    let mut admitted = Vec::new();
    let user_ref = turn
        .context
        .get("userRef")
        .and_then(Value::as_str)
        .unwrap_or_default();
    for reference in references(turn, "profileRefs") {
        let document = repo.read_context_document(reference.to_owned()).await?;
        if document.context_ref != reference
            || document.projection_class != "profile"
            || document.scope_kind != "user"
            || document.scope_id != user_ref
        {
            return Err(BtccError::new(
                "guided_profile_instruction_document_invalid",
                "guided_profile_instruction_document_invalid",
            ));
        }
        admitted.push(document);
    }
    let mut eol = admitted
        .iter()
        .filter(|document| document.source_id == "eol");
    let eol_content = eol
        .next()
        .map(|document| crate::public_text::trim_js_whitespace(&document.content).to_owned());
    if eol.next().is_some() || eol_content.as_deref().is_none_or(str::is_empty) {
        return Err(BtccError::new(
            "guided_eol_instruction_document_invalid",
            "guided_eol_instruction_document_invalid",
        ));
    }
    let persona_sources: HashSet<_> = [
        "active-persona-reminder",
        "first-chat-onboarding",
        "personalization-profile",
        "profile-projection",
        "turn-personalization-profile",
    ]
    .into_iter()
    .collect();
    let governing_sources: HashSet<_> = ["role", "runtime-system-contract"].into_iter().collect();
    let others = admitted
        .into_iter()
        .filter(|document| document.source_id != "eol")
        .collect::<Vec<_>>();
    if others.iter().any(|document| {
        !persona_sources.contains(document.source_id.as_str())
            && !governing_sources.contains(document.source_id.as_str())
    }) {
        return Err(BtccError::new(
            "guided_profile_instruction_document_invalid",
            "guided_profile_instruction_document_invalid",
        ));
    }
    let bounded = bounded_non_eol(others);
    let join = |accepted: &HashSet<&str>| {
        bounded
            .iter()
            .filter(|document| accepted.contains(document.source_id.as_str()))
            .map(|document| crate::public_text::trim_js_whitespace(&document.content))
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    Ok(DocumentProjection {
        context: groups.join("\n\n"),
        response_language,
        governing: join(&governing_sources),
        persona: join(&persona_sources),
        eol: format!(
            "The following exact EOL was durably admitted for this Turn. It is a governing instruction for both Butler and Steward, not Butler persona or ordinary user content.\n{}",
            eol_content.unwrap_or_default()
        ),
    })
}
