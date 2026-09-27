use chrono::{DateTime, Utc};
use serde_json::json;

use super::contracts::{BriefingInputSnapshot, BriefingProjectSignal};

pub(super) fn prompt(
    input: &BriefingInputSnapshot,
    project: Option<&BriefingProjectSignal>,
    now: DateTime<Utc>,
    local_minute: u16,
    run_id: &str,
) -> String {
    let locale = locale(input);
    let projection = input.projection.as_ref().map(|profile| json!({
        "updated_at": profile.updated_at,
        "how_to_answer": head(&profile.how_to_answer, 8),
        "how_to_collaborate": head(&profile.how_to_collaborate, 8),
        "response_hints": head(&profile.response_hints, 8),
        "current_attention": if project.is_some() { &[][..] } else { head(&profile.current_attention, 10) },
        "active_boundaries": head(&profile.active_boundaries, 8),
        "likely_failure_modes": head(&profile.likely_failure_modes, 6),
    }));
    let persona = input
        .persona
        .text
        .as_deref()
        .filter(|text| !text.is_empty())
        .map(|text| {
            json!({
                "id": input.persona.id,
                "excerpt": text.chars().take(2400).collect::<String>(),
            })
        });
    let project_payload = project.map(|project| json!({
        "id": project.id,
        "name": project.display_name,
        "summary": project.summary,
        "recent_session_titles": project.recent_session_titles.iter().take(8).collect::<Vec<_>>(),
        "ledger_event_summary": project.ledger_event_summary.iter().take(12).collect::<Vec<_>>(),
        "open_work_titles": project.open_work_titles.iter().take(12).collect::<Vec<_>>(),
        "completed_work_titles": project.completed_work_titles.iter().take(30).collect::<Vec<_>>(),
        "excluded_topics": project.excluded_topics.iter().take(20).collect::<Vec<_>>(),
    }));
    let mut output_shape = json!({
        "moment":"short time label",
        "title":"one short fallback greeting or question for the surface",
        "description":"one short sentence about why these cards are here",
        "suggestions":[{"id":"stable-kebab-id","title":"topic name","description":"why this is useful to open","text":"message to send if selected","source_kind":"one allowed source kind"}],
    });
    if project.is_none() {
        output_shape["title_variants"] = json!({
            "morning":"surface headline for local morning",
            "afternoon":"surface headline for local afternoon",
            "evening":"surface headline for local evening",
            "night":"surface headline for local night",
        });
    }
    let rules = if project.is_some() {
        vec![
            "Every suggestion must be directly about the selected project.",
            "Treat recent session titles as topics already discussed, not as unfinished tasks or requests to repeat.",
            "Completed Work titles are explicitly finished; never repackage one as a new design, implementation, review, or verification card.",
            "Open Work titles are the only explicit unfinished-work signals; do not infer open status from a chat title.",
            "Use the project summary and past topics to propose distinct, optional future capabilities, experiments, or decisions.",
            "Each card must create a new outcome beyond the cited past topic; name that outcome in the title and the message to send.",
            "Do not propose a status check, recap, review, re-audit, re-verification, or finishing an earlier conversation solely because its title appears here.",
            "Do not claim a feature is missing or work is unfinished without an explicit status signal.",
            "Avoid restating or lightly rephrasing any recent session title as a card.",
            "Never mention or propose a topic listed in excluded_topics.",
            "Do not introduce general interests, meals, entertainment, news, or unrelated personal topics unless the project summaries explicitly mention them.",
            "If project signal is thin, make fewer sharper project cards instead of filling with generic topics.",
        ]
    } else {
        vec![
            "Use general user-level signals, unfinished topics, repeated questions, current interests, adjacent directions, and timely context.",
            "Do not turn unfinished work into pressure or obligation.",
        ]
    };
    // Pretty-printing a `Value` cannot fail; fall back to compact text regardless.
    let prompt = json!({
        "task": if project.is_some() { "project_new_chat_briefing" } else { "general_new_chat_briefing" },
        "locale":locale, "now":now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "time_of_day":time_of_day(local_minute), "consolidation_run_id":run_id,
        "persona":persona, "runtime_projection":projection, "profile_summaries":[],
        "project":project_payload, "scope_rules":rules, "output_shape":output_shape,
    });
    serde_json::to_string_pretty(&prompt).unwrap_or_else(|_| prompt.to_string())
}

pub(super) fn instructions(locale: &str, has_persona: bool) -> String {
    let mut lines = vec![
        "You generate Butler's New Chat Briefing artifact.".to_owned(),
        format!("Write visible copy in {}.", if locale == "ko" { "Korean" } else { "English" }),
        "Return JSON only. Do not wrap it in Markdown.".into(),
        "The title is the page headline: a short greeting or question, not a status label.".into(),
        "For general briefings, include title_variants with morning, afternoon, evening, and night; these are also page headlines.".into(),
        "For project briefings, do not include time-of-day title variants.".into(),
        "Each card title names a topic. Each card description says why opening it may be useful.".into(),
        "For project cards, turn historical topics into genuinely new directions; do not ask to repeat prior work or summarize what was already done.".into(),
        "Do not pressure the user, create urgency, shame unfinished work, or tell the user what they must do.".into(),
        "Do not describe the interface, the memory system, the prompt, the persona, or why you generated the artifact.".into(),
        "Do not include raw transcript text, filesystem paths, private reasoning, or provider payloads.".into(),
        "Create 4 to 6 suggestions.".into(),
    ];
    lines.push(if has_persona {
        "Apply the active persona subtly in phrasing, without turning the page into a performance."
            .into()
    } else {
        "Use neutral Butler copy because no persona text was supplied.".into()
    });
    lines.join("\n")
}

pub(super) fn locale(input: &BriefingInputSnapshot) -> &str {
    match &input.settings {
        super::BriefingSettings::Configured { locale, .. }
        | super::BriefingSettings::Unavailable { locale, .. } => locale,
    }
}

#[expect(
    clippy::match_same_arms,
    reason = "explicit arms document the known values beside the default"
)]
pub(super) fn time_of_day(local_minute: u16) -> &'static str {
    match local_minute / 60 {
        0..=5 => "night",
        6..=11 => "morning",
        12..=17 => "afternoon",
        18..=21 => "evening",
        _ => "night",
    }
}

pub(super) fn moment(local_minute: u16, locale: &str) -> String {
    let hour = local_minute / 60;
    let minute = local_minute % 60;
    let period = if locale == "ko" {
        if hour < 12 { "오전" } else { "오후" }
    } else if hour < 12 {
        "AM"
    } else {
        "PM"
    };
    let hour = match hour % 12 {
        0 => 12,
        value => value,
    };
    if locale == "ko" {
        format!("{period} {hour}:{minute:02}")
    } else {
        format!("{hour}:{minute:02} {period}")
    }
}

fn head(values: &[String], count: usize) -> &[String] {
    &values[..values.len().min(count)]
}
