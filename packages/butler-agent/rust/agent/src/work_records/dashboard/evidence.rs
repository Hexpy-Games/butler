//! Dashboard-consumed worker completion safety from durable task evidence.

use parking_lot::Mutex;
use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
    sync::LazyLock,
};

use regex::Regex;
use serde_json::Value;

use crate::public_text::trim_js_whitespace as trim;

#[derive(Default)]
struct Facts {
    implementation: bool,
    execution: bool,
    report: bool,
    final_blocker: bool,
    environment_blocker: bool,
    refs: bool,
}

pub(super) struct Safety {
    pub mode: &'static str,
    pub safe: bool,
    pub completion: bool,
    pub guard: Option<&'static str>,
}

pub(super) fn direct(directory: &Path, status: &str, request: &str) -> Safety {
    let facts = collect(directory);
    let classification = classification(directory, request);
    let evidence = if facts.environment_blocker {
        (
            true,
            false,
            Some(
                "Worker recorded an environment blocker; resolve dependencies or setup before claiming completion.",
            ),
        )
    } else if facts.final_blocker || classification == "explicit-blocker" {
        (
            true,
            false,
            Some("Worker recorded a final blocker; report the blocker, not completion."),
        )
    } else if classification == "implementation-required" && !facts.implementation {
        (
            false,
            false,
            Some("Implementation-required worker task has no implementation evidence."),
        )
    } else if classification != "implementation-required"
        && !facts.execution
        && !facts.report
        && !facts.refs
    {
        (
            false,
            false,
            Some("Worker task has no durable evidence to review."),
        )
    } else {
        (true, true, None)
    };
    match status {
        "APPROVED" | "RUNNING" => Safety {
            mode: "executing",
            safe: false,
            completion: false,
            guard: Some(
                "Legacy state records approved or running work; current execution is unverified. Do not claim completion.",
            ),
        },
        "RECOVERABLE" => Safety {
            mode: "repairing",
            safe: false,
            completion: false,
            guard: Some(
                "Legacy state records an interrupted worker; no native execution owner can resume it. Do not claim completion.",
            ),
        },
        "DONE" | "REVIEWED" if !evidence.0 => Safety {
            mode: "reviewing",
            safe: false,
            completion: false,
            guard: Some(
                evidence
                    .2
                    .unwrap_or("Worker completion evidence is insufficient."),
            ),
        },
        "DONE" | "REVIEWED" => Safety {
            mode: "complete",
            safe: true,
            completion: evidence.1,
            guard: evidence.2,
        },
        "KILLED" => Safety {
            mode: "cancelled",
            safe: false,
            completion: false,
            guard: Some("Worker was stopped before completion."),
        },
        "FAILED" => Safety {
            mode: "failed",
            safe: true,
            completion: false,
            guard: Some("Only a failure report is safe; do not claim completion."),
        },
        _ => Safety {
            mode: "failed",
            safe: false,
            completion: false,
            guard: Some("Worker state is unknown; inspect durable evidence before reporting."),
        },
    }
}

pub(super) fn planned(status: &str, review: Option<&Value>) -> Safety {
    let mode = match status {
        "PLANNED" => "planning",
        "PLANNED_RUNNING" => "executing",
        "WORKER_DONE" | "REVIEWING" | "REVIEW_FAILED" | "REVIEW_INCONCLUSIVE" => "reviewing",
        "WORKER_FAILED" | "REPAIRING" => "repairing",
        "BLOCKED_WAITING_PRINCIPAL" => "blocked",
        "REVIEW_PASSED" | "PUBLIC_REPORT_READY" | "FAILED_PUBLIC_REPORT_READY" => "reporting",
        "REPORTED" => "complete",
        _ => "cancelled",
    };
    match status {
        "PUBLIC_REPORT_READY" => Safety {
            mode,
            safe: true,
            completion: true,
            guard: None,
        },
        "FAILED_PUBLIC_REPORT_READY" => Safety {
            mode,
            safe: true,
            completion: false,
            guard: Some(
                "Only a failure or partial-outcome report is ready; do not claim completion.",
            ),
        },
        "REPORTED" => Safety {
            mode,
            safe: true,
            completion: review
                .and_then(|value| value.get("verdict"))
                .and_then(Value::as_str)
                == Some("PASS"),
            guard: None,
        },
        _ => Safety {
            mode,
            safe: false,
            completion: false,
            guard: Some(match mode {
                "planning" => "The plan exists but execution has not started.",
                "executing" => {
                    "Legacy planned work is recorded as executing; current execution is unverified. Review durable evidence."
                }
                "reviewing" => "Review evidence is not complete enough for public completion.",
                "repairing" => "Repair is required before public completion can be claimed.",
                "blocked" => "A principal decision is required before work can continue.",
                "reporting" => "A reviewed public report still needs to be prepared.",
                "complete" => "Work has already been reported.",
                _ => "Work was cancelled.",
            }),
        },
    }
}

fn classification(directory: &Path, request: &str) -> &'static str {
    let explicit = read(&directory.join("classification"));
    if let Some(classification) = [
        "implementation-required",
        "research-only",
        "review-only",
        "writing-only",
        "diagnosis-only",
        "explicit-blocker",
    ]
    .into_iter()
    .find(|candidate| *candidate == trim(&explicit))
    {
        return classification;
    }
    let plan = read(&directory.join("plan.md"));
    if trim(request).is_empty() && trim(&plan).is_empty() {
        return "diagnosis-only";
    }
    let text = format!("{request}\n{plan}").to_lowercase();
    if pattern(
        r"(blocked|blocker|cannot safely|can't safely|불가능|막힘|차단|진행할 수 없)",
        &text,
    ) {
        return "explicit-blocker";
    }
    if pattern(
        r"(implement|fix|change|modify|patch|edit|create|add|update|refactor|ship|수정|구현|변경|추가|고쳐|만들|반영)",
        &text,
    ) {
        return "implementation-required";
    }
    if pattern(r"(review|audit|검토|리뷰)", &text) {
        return "review-only";
    }
    if pattern(
        r"(research|investigate|diagnose|analy[sz]e|summari[sz]e|check|verify|inspect|조사|분석|진단|파악|요약|확인|검증)",
        &text,
    ) {
        return "diagnosis-only";
    }
    if pattern(r"(write|draft|document|문서|작성|정리)", &text) {
        return "writing-only";
    }
    "implementation-required"
}

fn collect(directory: &Path) -> Facts {
    let mut facts = Facts {
        refs: directory
            .join("result.md")
            .metadata()
            .is_ok_and(|metadata| metadata.len() > 0)
            || [
                "worker_activity_events.jsonl",
                "worker_activity.json",
                "worker-preflight.md",
            ]
            .iter()
            .any(|name| directory.join(name).exists()),
        ..Facts::default()
    };
    if let Ok(entries) = std::fs::read_dir(directory) {
        facts.refs |= entries.flatten().any(|entry| {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            ["patch", "diff", "commit", "evidence"]
                .iter()
                .any(|prefix| name.starts_with(prefix))
        });
    }
    let result = read(&directory.join("result.md"));
    let log = read(&directory.join("log.txt"));
    let text = format!("{log}\n{result}");
    facts.implementation |= pattern(
        r"(?i)\b(apply_patch|patch\s+-p|git apply|git\s+diff|diff\s+-|bun test|npm test|pnpm test|yarn test|vitest|jest|playwright|typecheck|lint|tsc|git\s+commit|sed\s+-i|perl\s+-pi|cat\s+>|printf\s+.*>|tee\s+|mv\s+.*|cp\s+.*|touch|mkdir\s+-p)\b",
        &text,
    );
    facts.execution |= text.contains("run_shell")
        || text.contains("run_command")
        || text.contains("===== COMMAND:");
    facts.final_blocker |= pattern(
        r"(?i)\b(blocked|blocker|cannot safely|unable to proceed|TIMEOUT|deadlock|auth|credential)\b",
        &result,
    );
    facts.environment_blocker |= environment_blocker(&result);
    for line in json_lines(&directory.join("worker_activity_events.jsonl")) {
        let semantic = field(&line, "semantic_phase");
        let action = field(&line, "action_kind");
        let phrase = format!(
            "{} {}",
            field(&line, "status_line"),
            field(&line, "decision_summary")
        )
        .to_lowercase();
        let contract = line.get("completion_contract").unwrap_or(&Value::Null);
        facts.execution |= semantic == "executing"
            || contract.get("has_execution_evidence") == Some(&Value::Bool(true));
        facts.report |= semantic == "reporting";
        facts.implementation |= contract.get("has_commit_evidence") == Some(&Value::Bool(true))
            || pattern(
                r"(?i)(apply_patch|patch|edit_file|write_file|file_modified|modify|create_file|file_created|git_diff|diff|test|typecheck|lint|verify|commit|검증|modified|updated|edited|wrote|created|added)",
                &format!("{action} {phrase}"),
            );
        let blocked = semantic == "blocked"
            || field(&line, "completion_review") == "blocked"
            || contract.get("has_blocker_evidence") == Some(&Value::Bool(true));
        let terminal = blocked
            && (["worker_failed", "worker_finished"].contains(&field(&line, "event"))
                || field(&line, "completion_review") == "blocked");
        facts.final_blocker |= terminal;
        facts.environment_blocker |= terminal && environment_blocker(&phrase);
        facts.refs |= line
            .get("evidence_refs")
            .and_then(Value::as_array)
            .is_some_and(|values| values.iter().any(Value::is_string));
    }
    for name in [
        "evidence-receipts.jsonl",
        "evidence_receipts.jsonl",
        "worker_evidence.jsonl",
    ] {
        for receipt in json_lines(&directory.join(name)) {
            let satisfies = receipt
                .get("satisfies")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            facts.execution |= field(&receipt, "receiptType") == "execution"
                || satisfies
                    .iter()
                    .any(|value| value.as_str() == Some("command_executed"));
            facts.implementation |= satisfies.iter().filter_map(Value::as_str).any(|value| pattern(r"file_created|file_modified|durable_artifact|patch|diff|test|validation|typecheck|lint|commit",value));
            facts.refs = true;
        }
    }
    let session = read(&directory.join("session_id"));
    if !session.is_empty() {
        let sanitized = format!("worker/{}", trim(&session))
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                    c
                } else {
                    '_'
                }
            })
            .collect::<String>();
        if let Some(data) = directory.parent().and_then(Path::parent) {
            for event in json_lines(&data.join("transcripts").join(format!("{sanitized}.jsonl"))) {
                if !matches!(field(&event, "kind"), "tool_result" | "tool_call") {
                    continue;
                }
                let payload = event.get("payload").unwrap_or(&Value::Null);
                let result = payload.get("result").unwrap_or(&Value::Null);
                let command = result
                    .get("command")
                    .and_then(Value::as_str)
                    .or_else(|| {
                        payload
                            .pointer("/arguments/command")
                            .and_then(Value::as_str)
                    })
                    .unwrap_or("");
                let text = format!("{}\n{}\n{}", field(payload, "name"), command, result);
                facts.execution |= field(payload, "name") == "run_command";
                facts.implementation |= result
                    .get("written_files")
                    .and_then(Value::as_array)
                    .is_some_and(|items| !items.is_empty())
                    || result
                        .get("verified_output_files")
                        .and_then(Value::as_array)
                        .is_some_and(|items| !items.is_empty())
                    || result.get("durable_artifact_created") == Some(&Value::Bool(true))
                    || pattern(
                        r"(?i)\b(apply_patch|patch\s+-p|git apply|git\s+diff|diff\s+-|bun test|npm test|pnpm test|yarn test|vitest|jest|playwright|typecheck|lint|tsc|git\s+commit|committed)\b",
                        &text,
                    );
                if field(&event, "kind") == "tool_result" {
                    facts.refs = true;
                }
            }
        }
    }
    facts
}

fn read(path: &Path) -> String {
    std::fs::read(path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}
fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn json_lines(path: &Path) -> impl Iterator<Item = Value> {
    File::open(path)
        .ok()
        .into_iter()
        .flat_map(|file| BufReader::new(file).lines())
        .filter_map(|line| line.ok().and_then(|line| serde_json::from_str(&line).ok()))
}
fn pattern(source: &'static str, value: &str) -> bool {
    static CACHE: LazyLock<Mutex<HashMap<&'static str, Regex>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    let mut cache = CACHE.lock();
    cache
        .entry(source)
        .or_insert_with(|| Regex::new(source).expect("source evidence pattern"))
        .is_match(value)
}
fn environment_blocker(value: &str) -> bool {
    pattern(
        r"(?is)\b(tsc|typescript|bun|npm|pnpm|yarn|node_modules|dependency|dependencies)\b.{0,120}\b(command not found|not found|missing|not installed)\b",
        value,
    ) || pattern(
        r"(?is)\b(command not found|not found|missing|not installed)\b.{0,120}\b(tsc|typescript|bun|npm|pnpm|yarn|node_modules|dependency|dependencies)\b",
        value,
    )
}
