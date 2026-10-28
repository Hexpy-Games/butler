//! Read-time labels from the structured operations, never the model's summary.
use serde_json::Value;

pub(super) fn label(
    document: &Value,
    changes: &[Value],
    plan: Option<&Value>,
    language: &str,
) -> String {
    let ko = language == "ko";
    let mut labels = Vec::new();
    for change in changes {
        let title = change["title"].as_str().unwrap_or_default();
        let label = match change["op"].as_str().unwrap_or_default() {
            "epic.create" => registration(document, plan, ko),
            "epic.move" => {
                let destination = change["destination_plan_title"].as_str().unwrap_or(if ko {
                    "백로그"
                } else {
                    "Backlog"
                });
                if ko {
                    format!("‘{destination}’으로 과제 이동")
                } else {
                    format!("Move Epic to ‘{destination}’")
                }
            }
            "epic.edit" => {
                if ko {
                    "과제 변경".into()
                } else {
                    "Edit Epic".into()
                }
            }
            "plan.create" => {
                if ko {
                    format!("‘{title}’ 계획 등록")
                } else {
                    format!("Add plan ‘{title}’")
                }
            }
            "plan.edit" => {
                if ko {
                    "계획 변경".into()
                } else {
                    "Edit plan".into()
                }
            }
            "plan.reorder" => {
                if ko {
                    "과제 순서 변경".into()
                } else {
                    "Reorder Epics".into()
                }
            }
            "spec.edit" => {
                if ko {
                    "명세 변경".into()
                } else {
                    "Edit spec".into()
                }
            }
            // The required epic.create also labels project.create.
            _ => continue,
        };
        if !labels.contains(&label) {
            labels.push(label);
        }
    }
    labels.join(" · ")
}
fn registration(document: &Value, plan: Option<&Value>, ko: bool) -> String {
    if let Some(name) = document["new_name"].as_str() {
        return if ko {
            format!("새 프로젝트 ‘{name}’ 만들고 과제 등록")
        } else {
            format!("Create project ‘{name}’ and add Epic")
        };
    }
    if let Some(title) = plan.and_then(|p| p["title"].as_str()) {
        return if ko {
            format!("‘{title}’에 과제 등록")
        } else {
            format!("Add Epic to ‘{title}’")
        };
    }
    if ko {
        "백로그에 과제 등록".into()
    } else {
        "Add Epic to Backlog".into()
    }
}
