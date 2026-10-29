//! Process-local render hysteresis, independent of the SQL size approximation.
use super::*;
#[derive(Clone)]
pub(super) struct HistoryStart {
    pub first: String,
    pub prefix: String,
    pub summaries: String,
}
#[derive(Default)]
pub(crate) struct HistoryStarts(Mutex<VecDeque<(String, HistoryStart)>>);
impl HistoryStarts {
    pub(super) fn get(&self, key: &str) -> Option<HistoryStart> {
        self.0
            .lock()
            .ok()?
            .iter()
            .find(|(id, _)| id == key)
            .map(|(_, start)| start.clone())
    }
    pub(super) fn record(&self, key: String, start: HistoryStart) {
        if let Ok(mut entries) = self.0.lock() {
            entries.retain(|(id, _)| id != &key);
            if entries.len() == CACHE_TURNS {
                entries.pop_front();
            }
            entries.push_back((key, start));
        }
    }
}

pub(super) fn select(
    window: &HistoryWindow,
    turns: &[&std::sync::Arc<crate::context::ConversationSemanticTurnAtom>],
    rendered: &[String],
    summaries: &str,
    cap: usize,
    charge: &dyn Fn(&str) -> ContextResult<usize>,
    previous: Option<&HistoryStart>,
) -> ContextResult<(usize, String)> {
    let previous = previous.filter(|old| old.summaries == summaries);
    let mut dropped = previous
        .and_then(|old| {
            turns
                .iter()
                .position(|turn| turn.turn_id.as_ref().unwrap_or(&turn.id) == &old.first)
        })
        .unwrap_or(0);
    let mut digest = bounded_digest(&window.digest, (cap / 20).min(1_000), charge)?;
    let mut prefix = if let Some(old) = previous.filter(|old| {
        turns
            .get(dropped)
            .is_some_and(|turn| turn.turn_id.as_ref().unwrap_or(&turn.id) == &old.first)
    }) {
        old.prefix.clone()
    } else {
        prefix_text(window.omitted_turns, &digest, summaries)
    };
    if fits(&join(&prefix, &rendered[dropped..]), cap, charge)? {
        return Ok((dropped, prefix));
    }
    // Charge each turn once, including its separator. Only the final candidate
    // is charged as a whole; do not tokenize every successively shorter suffix.
    let costs = rendered
        .iter()
        .map(|text| charge(&format!("{text}\n")))
        .collect::<ContextResult<Vec<_>>>()?;
    let mut used: usize = costs[dropped..].iter().sum();
    loop {
        while used + charge(&prefix)? > cap * 3 / 5 && rendered.len() - dropped > VERBATIM_TURNS {
            digest = extend_digest(&digest, turns[dropped], (cap / 20).min(1_000), charge)?;
            used = used.saturating_sub(costs[dropped]);
            dropped += 1;
            prefix = prefix_text(window.omitted_turns + dropped, &digest, summaries);
        }
        if charge(&join(&prefix, &rendered[dropped..]))? <= cap * 3 / 5
            || rendered.len() - dropped <= VERBATIM_TURNS
        {
            break;
        }
        digest = extend_digest(&digest, turns[dropped], (cap / 20).min(1_000), charge)?;
        used = used.saturating_sub(costs[dropped]);
        dropped += 1;
        prefix = prefix_text(window.omitted_turns + dropped, &digest, summaries);
    }
    Ok((dropped, prefix))
}
