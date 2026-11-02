//! Durable exclusive Task contracts. Scope decisions belong to the model.
use serde::{Deserialize, Serialize};
mod render;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanSubject {
    pub key: String,
    pub label: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskScope {
    #[serde(default)]
    pub owns: Vec<TaskOwnership>,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub excludes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskOwnership {
    pub subject: String,
    #[serde(default)]
    pub aspects: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskInput {
    pub task: String,
    #[serde(rename = "use")]
    pub usage: TaskInputUse,
    pub reason: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskInputUse {
    Facts,
    Artifact,
    Verify,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskOutput {
    pub format: String,
    #[serde(default)]
    pub fields: Vec<String>,
    #[serde(default)]
    pub files: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskResolution {
    pub resolution: String,
    pub reason: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskContract {
    pub scope: Option<TaskScope>,
    pub output: Option<TaskOutput>,
    #[serde(default)]
    pub inputs: Vec<TaskInput>,
    pub overlap: Option<TaskResolution>,
    #[serde(default)]
    pub merge_after: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskOverlap {
    pub task: String,
    pub cells: Vec<String>,
    pub resolution: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkTask {
    pub task_id: String,
    pub work_id: String,
    pub plan_revision_id: String,
    pub action_key: String,
    pub relation_id: String,
    pub status: String,
    pub scope: TaskScope,
    pub inputs: Vec<TaskInput>,
    pub output: TaskOutput,
    pub overlaps: Vec<TaskOverlap>,
    pub merge_after: Vec<String>,
    pub result_ref: Option<String>,
    pub summary: Option<String>,
}

/// Lexical workspace paths: reject escapes, globs and absolute paths at admission.
pub fn task_path(value: &str) -> Option<String> {
    let value = butler_core::public_text::trim_js_whitespace(value).replace('\\', "/");
    if value.trim().is_empty()
        || value.starts_with('/')
        || value.as_bytes().get(1) == Some(&b':')
            && value
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphabetic)
        || value.contains(['*', '?', '[', ']'])
    {
        return None;
    }
    let mut parts = Vec::new();
    for part in value.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            _ => parts.push(part),
        }
    }
    Some(if parts.is_empty() {
        ".".into()
    } else {
        parts.join("/")
    })
}

pub fn task_path_contains(parent: &str, child: &str) -> bool {
    parent == "."
        || parent == child
        || child
            .strip_prefix(parent)
            .is_some_and(|s| s.starts_with('/'))
}

/// Empty aspects reserve the entire subject; paths reserve complete subtrees.
pub fn task_overlap(left: &TaskScope, right: &TaskScope) -> Vec<String> {
    let mut cells = Vec::new();
    for a in &left.owns {
        for b in right.owns.iter().filter(|b| b.subject == a.subject) {
            if a.aspects.is_empty() && b.aspects.is_empty() {
                cells.push(format!("{}:*", a.subject));
            } else {
                let aspects = if a.aspects.is_empty() {
                    &b.aspects
                } else {
                    &a.aspects
                };
                cells.extend(
                    aspects
                        .iter()
                        .filter(|aspect| {
                            b.aspects.is_empty()
                                || a.aspects.is_empty()
                                || b.aspects.contains(aspect)
                        })
                        .map(|aspect| format!("{}:{aspect}", a.subject)),
                );
            }
        }
    }
    for a in &left.paths {
        for b in &right.paths {
            if task_path_contains(a, b) {
                cells.push(format!("path:{b}"));
            } else if task_path_contains(b, a) {
                cells.push(format!("path:{a}"));
            }
        }
    }
    cells.sort();
    cells.dedup();
    cells
}

impl TaskContract {
    pub(crate) fn render_packet(
        packet: &crate::btcc::SubsessionPacket,
        tasks: &[WorkTask],
    ) -> String {
        render::render_context(packet, tasks)
    }
}
