//! Validate model identities and evidence, without interpreting content.
use super::{PatternError, types::*};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Deserialize)]
struct Update {
    pattern_id: Option<String>,
    title: String,
    intent: String,
    window: Window,
    evidence_ids: Vec<String>,
}
#[derive(Default)]
pub(super) struct MergeCount {
    pub created: u64,
    pub updated: u64,
    pub dropped: u64,
}

pub(super) fn reply(raw: &str, key: &str) -> Result<Vec<Value>, PatternError> {
    let start = raw.find('{').ok_or(PatternError::InvalidReply)?;
    let end = raw.rfind('}').ok_or(PatternError::InvalidReply)?;
    let json = raw.get(start..=end).ok_or(PatternError::InvalidReply)?;
    let value: Value = serde_json::from_str(json).map_err(|_| PatternError::InvalidReply)?;
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .ok_or(PatternError::InvalidReply)
}

pub(super) fn merge(
    store: &mut PatternStore,
    page: &[PatternEvent],
    updates: Vec<Value>,
    now: DateTime<Utc>,
) -> MergeCount {
    let events: HashMap<_, _> = page.iter().map(|e| (e.id.as_str(), e.created_at)).collect();
    let mut used = HashSet::new();
    let mut count = MergeCount::default();
    for value in updates {
        let Ok(update) = serde_json::from_value::<Update>(value) else {
            count.dropped += 1;
            continue;
        };
        if !valid_window(&update.window)
            || update.title.trim().is_empty()
            || update.intent.trim().is_empty()
            || update
                .pattern_id
                .as_ref()
                .is_some_and(|id| !store.patterns.iter().any(|p| &p.id == id))
        {
            count.dropped += 1;
            continue;
        }
        let cited: Vec<_> = update
            .evidence_ids
            .iter()
            .filter_map(|id| {
                events
                    .get(id.as_str())
                    .filter(|_| used.insert(id.clone()))
                    .copied()
            })
            .collect();
        let (Some(first), Some(last)) = (cited.iter().min(), cited.iter().max()) else {
            count.dropped += 1;
            continue;
        };
        if let Some(pattern) = store
            .patterns
            .iter_mut()
            .find(|p| Some(&p.id) == update.pattern_id.as_ref())
        {
            pattern.title = update.title;
            pattern.intent = update.intent;
            pattern.window = update.window;
            pattern.evidence.count += cited.len() as u64;
            pattern.evidence.first_at = pattern.evidence.first_at.min(*first);
            pattern.evidence.last_at = pattern.evidence.last_at.max(*last);
            pattern.updated_at = now;
            count.updated += 1;
        } else {
            store.patterns.push(Pattern {
                id: format!("pat_{}", uuid::Uuid::new_v4()),
                title: update.title,
                intent: update.intent,
                window: update.window,
                evidence: Evidence {
                    count: cited.len() as u64,
                    first_at: *first,
                    last_at: *last,
                },
                created_at: now,
                updated_at: now,
                proposed_at: None,
            });
            count.created += 1;
        }
    }
    count
}

fn valid_window(window: &Window) -> bool {
    !window.days.is_empty()
        && window.days.iter().all(|d| {
            matches!(
                d.as_str(),
                "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"
            )
        })
        && valid_time(&window.start)
        && valid_time(&window.end)
}
pub(super) fn valid_time(time: &str) -> bool {
    let [h1, h2, b':', m1, m2] = time.as_bytes() else {
        return false;
    };
    matches!(h1, b'0'..=b'2')
        && h2.is_ascii_digit()
        && (*h1 != b'2' || *h2 <= b'3')
        && matches!(m1, b'0'..=b'5')
        && m2.is_ascii_digit()
}
#[derive(Deserialize)]
struct Proposal {
    pattern_id: String,
    title: String,
    action: ProposedAction,
}
#[derive(Deserialize)]
struct ProposedAction {
    title: String,
    prompt: String,
    schedule: Schedule,
}

pub(super) fn propose(
    store: &mut PatternStore,
    values: Vec<Value>,
    run_id: &str,
    level: &str,
    now: DateTime<Utc>,
) -> Option<String> {
    if store.bundles.iter().any(|b| b.run_id == run_id) {
        return None;
    }
    let mut candidates = Vec::new();
    for value in values {
        let Ok(p) = serde_json::from_value::<Proposal>(value) else {
            continue;
        };
        if p.title.trim().is_empty()
            || p.action.title.trim().is_empty()
            || p.action.prompt.trim().is_empty()
            || !matches!(p.action.schedule.r#type.as_str(), "daily" | "weekdays")
            || !valid_time(&p.action.schedule.time)
        {
            continue;
        }
        let Some(pattern) = store
            .patterns
            .iter_mut()
            .find(|pattern| pattern.id == p.pattern_id && pattern.proposed_at.is_none())
        else {
            continue;
        };
        pattern.proposed_at = Some(now);
        candidates.push(Candidate {
            pattern_id: p.pattern_id,
            state: "pending".into(),
            title: p.title,
            action: Action {
                kind: "schedule".into(),
                title: p.action.title,
                prompt: p.action.prompt,
                schedule: p.action.schedule,
                deliver_to: "chats".into(),
            },
            evidence: pattern.evidence.clone(),
        });
    }
    if candidates.is_empty() {
        return None;
    }
    let id = format!("bundle_{run_id}");
    store.bundles.push(Bundle {
        id: id.clone(),
        run_id: run_id.into(),
        created_at: now,
        level: level.into(),
        candidates,
    });
    if store.bundles.len() > 30 {
        store.bundles.drain(..store.bundles.len() - 30);
    }
    Some(id)
}
