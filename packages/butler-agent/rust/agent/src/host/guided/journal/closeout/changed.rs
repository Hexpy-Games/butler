use std::collections::HashMap;

use serde_json::{Value, json};

use crate::btcc::{BtccError, ToolJournalCloseoutRow};

use super::{invalid, safe_path};

struct Detail {
    path: String,
    lines: Vec<Value>,
    additions: usize,
    deletions: usize,
    before: Option<String>,
    after: Option<String>,
}

#[derive(Default)]
pub(super) struct ChangedCollector {
    order: Vec<String>,
    by_path: HashMap<String, (Detail, Detail)>,
}

impl ChangedCollector {
    pub(super) fn add(&mut self, row: &ToolJournalCloseoutRow) -> Result<(), BtccError> {
        if let Some(changed) = &row.changed_files {
            let raw = changed.as_str().trim();
            if raw.starts_with('[') && !raw[1..raw.len() - 1].trim().is_empty() {
                return self.add_array(raw);
            }
        }
        let Some(result) = &row.result else {
            return Ok(());
        };
        if result.field("ok").map_err(invalid)? == Some("false")
            || !matches!(row.tool_name.as_str(), "write_file" | "edit_file")
        {
            return Ok(());
        }
        if row.tool_name == "edit_file"
            && let Some(raw) = result.field("changed_files").map_err(invalid)?
            && raw.starts_with('[')
        {
            return self.add_array(raw);
        }
        if let Some(raw) = result.field("changed_file").map_err(invalid)?
            && raw != "null"
        {
            return self.add_one(raw);
        }
        if row.tool_name == "edit_file"
            && result.field("effect").map_err(invalid)? == Some("\"workspace_file_edit_batch\"")
        {
            if let Some(raw) = row.arguments.field("edits").map_err(invalid)?
                && raw.starts_with('[')
            {
                return crate::json::visit_raw_array(raw, |edit| {
                    if let Ok(value) = serde_json::from_str::<Value>(edit)
                        && let Some(path) = value.get("path").and_then(Value::as_str)
                    {
                        self.append(path_only(path));
                    }
                    Ok(())
                })
                .map_err(invalid);
            }
            return Ok(());
        }
        if let Some(raw) = result.field("path").map_err(invalid)?
            && let Ok(path) = serde_json::from_str::<String>(raw)
        {
            self.append(path_only(&path));
        }
        Ok(())
    }

    fn add_array(&mut self, raw: &str) -> Result<(), BtccError> {
        crate::json::visit_raw_array(raw, |candidate| {
            if let Ok(value) = serde_json::from_str::<Value>(candidate) {
                self.append(safe_detail(&value));
            }
            Ok(())
        })
        .map_err(invalid)
    }

    fn add_one(&mut self, raw: &str) -> Result<(), BtccError> {
        if let Ok(value) = serde_json::from_str::<Value>(raw) {
            self.append(safe_detail(&value));
        }
        Ok(())
    }

    fn append(&mut self, detail: Option<Detail>) {
        let Some(mut detail) = detail else {
            return;
        };
        if let Some((_, last)) = self.by_path.get_mut(&detail.path) {
            detail.before = None;
            *last = detail;
        } else if self.order.len() < 40 {
            self.order.push(detail.path.clone());
            let first = copy_first(&detail);
            detail.before = None;
            self.by_path.insert(detail.path.clone(), (first, detail));
        }
    }

    pub(super) fn finish(mut self) -> Vec<Value> {
        self.order.into_iter().filter_map(|path| {
            let (first, last) = self.by_path.remove(&path)?;
            if let (Some(before), Some(after)) = (first.before, last.after.as_ref()) {
                crate::workspace::net_changed_file_detail(&path, before.as_bytes(), after.as_bytes())
                    .map(|detail| json!({
                        "path": detail.path,
                        "additions": detail.additions,
                        "deletions": detail.deletions,
                        "lines": detail.lines.into_iter().map(|line| {
                            let mut value = json!({"type":line.kind,"content":line.content});
                            if let Some(number) = line.old_line { value["old_line"] = json!(number); }
                            if let Some(number) = line.new_line { value["new_line"] = json!(number); }
                            value
                        }).collect::<Vec<_>>()
                    }))
            } else {
                Some(json!({"path":last.path,"additions":last.additions,
                    "deletions":last.deletions,"lines":last.lines}))
            }
        }).collect()
    }
}

fn copy_first(detail: &Detail) -> Detail {
    Detail {
        path: detail.path.clone(),
        lines: Vec::new(),
        additions: 0,
        deletions: 0,
        before: detail.before.clone(),
        after: None,
    }
}

fn path_only(value: &str) -> Option<Detail> {
    Some(Detail {
        path: safe_path(value, false)?,
        lines: Vec::new(),
        additions: 0,
        deletions: 0,
        before: None,
        after: None,
    })
}

fn safe_detail(value: &Value) -> Option<Detail> {
    let item = value.as_object()?;
    let path = safe_path(item.get("path")?.as_str()?, false)?;
    let mut lines = Vec::new();
    let mut additions = 0;
    let mut deletions = 0;
    for value in item.get("lines")?.as_array()? {
        let Some(line) = value.as_object() else {
            continue;
        };
        let Some(kind) = line.get("type").and_then(Value::as_str) else {
            continue;
        };
        let Some(content) = line.get("content").and_then(Value::as_str) else {
            continue;
        };
        if !matches!(kind, "added" | "deleted") {
            continue;
        }
        let number = |name| -> Option<Option<u64>> {
            match line.get(name) {
                None => Some(None),
                Some(value) => value
                    .as_f64()
                    .filter(|number| {
                        number.is_finite()
                            && number.fract() == 0.0
                            && *number >= 1.0
                            && *number <= 9_007_199_254_740_991.0
                    })
                    .map(|number| Some(crate::json::saturating_u64(number))),
            }
        };
        let (Some(old), Some(new)) = (number("old_line"), number("new_line")) else {
            continue;
        };
        let mut entry = json!({"type":kind,"content":content});
        if let Some(old) = old {
            entry["old_line"] = json!(old);
        }
        if let Some(new) = new {
            entry["new_line"] = json!(new);
        }
        if kind == "added" {
            additions += 1;
        } else {
            deletions += 1;
        }
        lines.push(entry);
    }
    if additions == 0 && deletions == 0 {
        return None;
    }
    Some(Detail {
        path,
        lines,
        additions,
        deletions,
        before: item
            .get("before_text")
            .and_then(Value::as_str)
            .map(str::to_owned),
        after: item
            .get("after_text")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}
