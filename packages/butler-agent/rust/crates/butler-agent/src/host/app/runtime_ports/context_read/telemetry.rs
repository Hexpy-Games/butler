//! Append-only telemetry indexes preserve exact-turn precedence and file freshness.
use super::{AppContextReadQuery, AppContextUsage, Telemetry, bounded_summary, positive_tokens};
use butler_runtime::operations::LogTail;
use serde_json::Value;
use std::{collections::HashMap, path::Path};

type Key = (String, Option<String>);
#[derive(Clone, Copy)]
struct Tokens {
    ts: i64,
    count: u64,
    ordinal: u64,
}
#[derive(Default)]
pub(super) struct Index {
    #[cfg(test)]
    prompt_tail: LogTail,
    monitor_tail: LogTail,
    prompts: HashMap<Key, Tokens>,
    monitors: HashMap<Key, Tokens>,
    compactions: HashMap<String, (LogTail, Option<String>)>,
    ordinal: u64,
}
impl Index {
    #[cfg(test)]
    pub(super) fn refresh(&mut self, root: &Path) {
        let mut prompt = std::mem::take(&mut self.prompt_tail);
        prompt.advance_json(
            &root.join("metrics/prompt-cache-usage.jsonl"),
            self,
            |index| index.prompts.clear(),
            Self::fold_prompt,
        );
        self.prompt_tail = prompt;
        self.refresh_monitor(root);
    }

    fn refresh_monitor(&mut self, root: &Path) {
        let mut monitor = std::mem::take(&mut self.monitor_tail);
        monitor.advance_json(
            &root.join("metrics/context-monitor.jsonl"),
            self,
            |index| index.monitors.clear(),
            Self::fold_monitor,
        );
        self.monitor_tail = monitor;
    }
    pub(super) fn open(root: &Path) -> Self {
        let mut index = Self::default();
        // The usage owner supplies prompt rows from the same descriptor and
        // cursor at initialization and on every subsequent fresh read.
        index.refresh_monitor(root);
        if let Ok(files) = std::fs::read_dir(root.join("context/compactions")) {
            for entry in files.flatten() {
                if entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "jsonl")
                    && let Some(name) = entry.path().file_stem().and_then(|name| name.to_str())
                {
                    index.summary(root, name);
                }
            }
        }
        index
    }
    #[cfg(test)]
    pub(super) fn read(&mut self, root: &Path, query: &AppContextReadQuery) -> Telemetry {
        self.refresh(root);
        self.current(root, query)
    }

    pub(super) fn reset_prompt(&mut self) {
        self.prompts.clear();
    }

    pub(super) fn fold_prompt_row(&mut self, row: &[u8]) {
        let row = row.strip_suffix(b"\n").unwrap_or(row);
        if row.len() <= butler_core::json_lines::MAX_JSON_LINE_BYTES
            && let Ok(value) = serde_json::from_slice(row)
        {
            self.fold_prompt(&value);
        }
    }

    pub(super) fn read_shared_prompt(
        &mut self,
        root: &Path,
        query: &AppContextReadQuery,
    ) -> Telemetry {
        self.refresh_monitor(root);
        self.current(root, query)
    }

    fn current(&mut self, root: &Path, query: &AppContextReadQuery) -> Telemetry {
        let scope = format!("btcc-guided:{}", query.runtime_session_id);
        let exact = query
            .turn_id
            .as_ref()
            .and_then(|turn| self.prompts.get(&(scope.clone(), Some(turn.clone()))))
            .copied();
        let legacy = self.prompts.get(&(scope, None)).copied().filter(|row| {
            query
                .latest_turn_started_at_ms
                .is_some_and(|start| row.ts >= start)
        });
        let monitor = [None, Some(query.model_ref.clone())]
            .into_iter()
            .filter_map(|model| {
                self.monitors
                    .get(&(query.runtime_session_id.clone(), model))
                    .copied()
            })
            .filter(|row| {
                query
                    .latest_turn_started_at_ms
                    .is_none_or(|start| row.ts >= start)
            })
            .max_by_key(|row| (row.ts, row.ordinal));
        let usage = match (exact, legacy, monitor) {
            (None, Some(provider), Some(monitor)) if monitor.ts > provider.ts => {
                Some(usage(monitor, "context_monitor"))
            }
            (Some(row), _, _) | (None, Some(row), _) => Some(usage(row, "provider_prompt_usage")),
            (None, None, Some(row)) => Some(usage(row, "context_monitor")),
            _ => None,
        };
        let safe = query
            .runtime_session_id
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                    character
                } else {
                    '_'
                }
            })
            .collect::<String>();
        Telemetry {
            usage,
            compaction_summary: self.summary(root, &safe),
        }
    }
    fn fold_prompt(&mut self, value: &Value) {
        let Some(scope) = value
            .get("scope")
            .and_then(Value::as_str)
            .filter(|scope| scope.starts_with("btcc-guided:"))
        else {
            return;
        };
        let turn = match value.get("turnId") {
            None => None,
            Some(Value::String(turn)) => Some(turn.clone()),
            _ => return,
        };
        let Some(count) = positive_tokens(value.get("promptTokens")) else {
            return;
        };
        self.ordinal += 1;
        insert(
            &mut self.prompts,
            (scope.into(), turn),
            Tokens {
                ts: value.get("ts").and_then(Value::as_i64).unwrap_or(-1),
                count,
                ordinal: self.ordinal,
            },
        );
    }
    fn fold_monitor(&mut self, value: &Value) {
        if value.get("kind").and_then(Value::as_str) != Some("runtime_turn") {
            return;
        }
        let Some(session) = value.get("sessionId").and_then(Value::as_str) else {
            return;
        };
        let Some(chars) = value
            .get("totalPromptChars")
            .and_then(Value::as_u64)
            .filter(|chars| *chars > 0)
        else {
            return;
        };
        self.ordinal += 1;
        insert(
            &mut self.monitors,
            (
                session.into(),
                value
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            ),
            Tokens {
                ts: value.get("ts").and_then(Value::as_i64).unwrap_or(-1),
                count: chars.div_ceil(4),
                ordinal: self.ordinal,
            },
        );
    }
    fn summary(&mut self, root: &Path, safe: &str) -> Option<String> {
        let (tail, summary) = self.compactions.entry(safe.into()).or_default();
        tail.advance_json(
            &root
                .join("context/compactions")
                .join(format!("{safe}.jsonl")),
            summary,
            |summary| *summary = None,
            |summary, value| {
                if value.get("schema").and_then(Value::as_str)
                    == Some("butler.context.compaction.v1")
                    && value.get("status").and_then(Value::as_str) == Some("ok")
                {
                    *summary = value
                        .get("summary")
                        .and_then(Value::as_str)
                        .map(bounded_summary);
                }
            },
        );
        summary.clone()
    }
}
fn insert(rows: &mut HashMap<Key, Tokens>, key: Key, row: Tokens) {
    if rows.get(&key).is_none_or(|old| row.ts >= old.ts) {
        rows.insert(key, row);
    }
}
fn usage(row: Tokens, source: &str) -> AppContextUsage {
    AppContextUsage {
        prompt_tokens: row.count,
        source: source.into(),
    }
}
