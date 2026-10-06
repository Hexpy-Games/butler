use butler_core::public_text::fixed_regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use butler_turn::btcc::{BtccError, BtccRepositories, ContextDocumentRead, TurnRecord};

pub(super) struct DocumentProjection {
    pub context: String,
    pub sections: Vec<DocumentSection>,
    pub instruction_components: Value,
    pub project_instructions: String,

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
) -> Vec<DocumentSection> {
    let mut documents = Vec::new();
    for reference in refs {
        let Ok(document) = repo.read_context_document(reference.clone()).await else {
            continue;
        };
        if document.source_id == "project-instructions" {
            continue; // Exact admitted instructions are projected separately from memory.
        }
        let history = history_document(&document);
        let content = match projected {
            Some(projected) => projected.get(&reference).cloned().unwrap_or_default(),
            None => document.content,
        };
        documents.push((
            document.source_id,
            document.projection_class,
            content,
            history,
        ));
    }
    documents.sort_by_key(|(source, _, _, _)| std::cmp::Reverse(super::excerpts::priority(source)));
    let count = documents.len();
    let mut remaining = limit;
    let mut contents = Vec::new();
    for (index, (source, kind, content, history)) in documents.into_iter().enumerate() {
        // Keep room for a deterministic omission marker for every later source.
        let reserve = (count - index - 1) * 160;
        let allowance = remaining.saturating_sub(reserve).max(remaining.min(160));
        let retrieval = format!("source {source}; use recall_memory or read_file to expand");
        let budget_content = if projected.is_some() {
            content.as_str()
        } else {
            history
                .as_ref()
                .map_or(content.as_str(), |h| h.main_budget_projection.as_str())
        };
        let charged = super::excerpts::text(budget_content, allowance, &retrieval);
        let value = if projected.is_some() && content.is_empty() {
            String::new()
        } else {
            history.map_or_else(|| charged.clone(), |h| h.history)
        };
        if !value.trim().is_empty() {
            contents.push(DocumentSection {
                stage: stage(&kind, &source),
                id: source,
                text: value.clone(),
                budget_text: charged.clone(),
            });
        }
        remaining = remaining.saturating_sub(charged.len() + 2);
    }
    contents
}

fn history_document(
    document: &ContextDocumentRead,
) -> Option<butler_turn::conversation::HistoryDocument> {
    (document.source_id == "recent-conversation")
        .then(|| {
            serde_json::from_str(
                document
                    .content
                    .strip_prefix("## Recent Conversation\n\n")
                    .unwrap_or(&document.content),
            )
            .ok()
        })
        .flatten()
}

fn language(candidate: &str) -> Option<String> {
    static RESPONSE_LANGUAGE: LazyLock<Regex> =
        LazyLock::new(|| fixed_regex(r"(?imu)^Assistant Response Language:\s*(.+)$"));
    let prefix = butler_core::json::Utf16Prefix::new(candidate, 12_000);
    let text = prefix.utf8_for_hash();
    let language = RESPONSE_LANGUAGE.captures(&text)?.get(1)?;
    let language = butler_core::public_text::trim_js_whitespace(language.as_str());
    (!language.is_empty()).then(|| {
        butler_core::json::Utf16Prefix::new(language, 80)
            .utf8_for_hash()
            .into_owned()
    })
}

pub(super) async fn response_language(repo: &BtccRepositories, turn: &TurnRecord) -> String {
    for reference in
        references(turn, "mandatoryHotCacheRefs").chain(references(turn, "optionalHotCacheRefs"))
    {
        if let Ok(document) = repo.read_context_document(reference.to_owned()).await
            && document.source_id != "project-instructions"
            && let Some(language) = language(&document.content)
        {
            return language;
        }
    }
    String::new()
}

fn bounded_non_eol(
    mut documents: Vec<ContextDocumentRead>,
    limit: usize,
) -> Vec<ContextDocumentRead> {
    documents.sort_by_key(|doc| std::cmp::Reverse(super::excerpts::priority(&doc.source_id)));
    let mut remaining = limit;
    for document in &mut documents {
        if matches!(
            document.source_id.as_str(),
            "role" | "runtime-system-contract"
        ) {
            remaining = remaining.saturating_sub(document.content.len());
            continue; // Governing runtime instructions stay exact.
        }
        let retrieval = format!(
            "source {}; use read_file for configured persona or recall_memory for profile hints",
            document.source_id
        );
        document.content = super::excerpts::text(&document.content, remaining, &retrieval);
        remaining = remaining.saturating_sub(document.content.len());
    }
    documents
}

pub(super) async fn read(
    repo: &BtccRepositories,
    turn: &TurnRecord,
    response_language: String,
    projected: Option<&HashMap<String, String>>,
) -> Result<DocumentProjection, BtccError> {
    let window = turn
        .model_selection
        .context_window_tokens
        .unwrap_or(200_000.0);
    let optional_limit = butler_core::json::saturating_usize((window * 0.2).min(16_000.0));
    let profile_limit = butler_core::json::saturating_usize((window * 0.2).min(10_240.0));
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
        optional_limit,
        projected,
    )
    .await;
    let mut groups = Vec::new();
    let mut sections = Vec::new();
    for (title, value) in [
        ("Recent conversation and feedback", recent),
        ("Required working context", mandatory),
        ("Optional working context", optional),
    ] {
        {
            let header = format!("## {title}");
            let budget = value
                .iter()
                .filter(|section| !section.budget_text.trim().is_empty())
                .map(|section| section.budget_text.as_str())
                .collect::<Vec<_>>();
            if !budget.is_empty() {
                groups.push(format!("{header}\n\n{}", budget.join("\n\n")));
            }
            sections.push(DocumentSection {
                id: title.into(),
                text: header.clone(),
                budget_text: header,
                stage: Stage::Stable,
            });
            sections.extend(value);
        }
    }
    project_profile(
        repo,
        turn,
        groups.join("\n\n"),
        sections,
        response_language,
        profile_limit,
    )
    .await
}

async fn project_profile(
    repo: &BtccRepositories,
    turn: &TurnRecord,
    context: String,
    sections: Vec<DocumentSection>,
    response_language: String,
    profile_limit: usize,
) -> Result<DocumentProjection, BtccError> {
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
            return Err(BtccError::relayed(
                "guided_profile_instruction_document_invalid",
                "guided_profile_instruction_document_invalid",
            ));
        }
        admitted.push(document);
    }
    let eol_content = exact_eol(&admitted)?;
    let project_instructions = exact_project_instructions(repo, turn).await?;
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
        return Err(BtccError::relayed(
            "guided_profile_instruction_document_invalid",
            "guided_profile_instruction_document_invalid",
        ));
    }
    let bounded = bounded_non_eol(others, profile_limit);
    let join = |accepted: &HashSet<&str>| {
        bounded
            .iter()
            .filter(|document| accepted.contains(document.source_id.as_str()))
            .map(|document| butler_core::public_text::trim_js_whitespace(&document.content))
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    Ok(DocumentProjection {
        context,
        sections,
        instruction_components: super::diagnostics::instruction_components(&bounded),
        project_instructions,

        response_language,
        governing: join(&governing_sources),
        persona: join(&persona_sources),
        eol: format!(
            "The following exact EOL was durably admitted for this Turn. It is a governing instruction for both Butler and Steward, not Butler persona or ordinary user content.\n{eol_content}"
        ),
    })
}

fn exact_eol(admitted: &[ContextDocumentRead]) -> Result<String, BtccError> {
    let mut eol = admitted
        .iter()
        .filter(|document| document.source_id == "eol");
    let eol_content = eol
        .next()
        .map(|document| butler_core::public_text::trim_js_whitespace(&document.content).to_owned());
    if eol.next().is_some() || eol_content.as_deref().is_none_or(str::is_empty) {
        return Err(BtccError::relayed(
            "guided_eol_instruction_document_invalid",
            "guided_eol_instruction_document_invalid",
        ));
    }
    Ok(eol_content.unwrap_or_default())
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Stage {
    Stable,
    History,
    Volatile,
}

pub(super) struct DocumentSection {
    pub id: String,
    pub text: String,
    pub stage: Stage,
    pub budget_text: String,
}

fn stage(kind: &str, id: &str) -> Stage {
    // Owner's cross-turn measurement: profile, rules (~11 KB), optional docs
    // and feedback change <10%; the other mandatory/runtime docs change 30-100%.
    // Classify by admitted kind/id after applying main's shared group budgets.
    if id == "recent-conversation" {
        Stage::History
    } else if matches!(
        id,
        "runtime-state" | "inbound-message" | "current-attachments"
    ) {
        Stage::Volatile
    } else if id == "rules" || matches!(kind, "profile" | "optional_hot_cache" | "recent_feedback")
    {
        Stage::Stable
    } else {
        Stage::Volatile
    }
}

/// Project operating instructions stay exact across memory budgets and phases.
async fn exact_project_instructions(
    repo: &BtccRepositories,
    turn: &TurnRecord,
) -> Result<String, BtccError> {
    let mut contents = Vec::new();
    for reference in references(turn, "mandatoryHotCacheRefs") {
        let document = repo.read_context_document(reference.to_owned()).await?;
        if document.source_id != "project-instructions" {
            continue;
        }
        if document.projection_class != "mandatory_hot_cache"
            || document.scope_kind != "project"
            || turn.context.get("projectRef").and_then(Value::as_str)
                != Some(document.scope_id.as_str())
        {
            return Err(BtccError::relayed(
                "guided_project_instruction_document_invalid",
                "guided_project_instruction_document_invalid",
            ));
        }
        contents.push(document.content);
    }
    Ok(contents.join("\n\n"))
}
