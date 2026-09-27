//! Dashboard-consumed worker completion safety from durable task evidence.

use butler_core::tool_protocol::ToolName;
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
    sync::LazyLock,
};

use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

use butler_core::public_text::fixed_regex;

use butler_core::public_text::trim_js_whitespace as trim;
mod facts;
use facts::{collect, matches_fixed, read};

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent observed facts, each read separately"
)]
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

/// Safety of a direct worker task from its status and durable evidence.
pub(super) fn direct(directory: &Path, status: &str, request: &str) -> Safety {
    let evidence = verdict(&collect(directory), classification(directory, request));
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
        "DONE" | "REVIEWED" if !evidence.reportable => Safety {
            mode: "reviewing",
            safe: false,
            completion: false,
            guard: Some(
                evidence
                    .guard
                    .unwrap_or("Worker completion evidence is insufficient."),
            ),
        },
        "DONE" | "REVIEWED" => Safety {
            mode: "complete",
            safe: true,
            completion: evidence.complete,
            guard: evidence.guard,
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

/// What a finished worker's evidence allows it to report.
struct Verdict {
    /// The outcome may be reported (a blocker or a completion).
    reportable: bool,
    /// Completion may be claimed.
    complete: bool,
    guard: Option<&'static str>,
}

fn verdict(facts: &Facts, classification: &str) -> Verdict {
    let (reportable, complete, guard) = if facts.environment_blocker {
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
    Verdict {
        reportable,
        complete,
        guard,
    }
}

/// Safety of a planned task from its status; a reported task may claim
/// completion only when its review verdict passed.
pub(super) fn planned(status: &str, review_verdict: Option<&str>) -> Safety {
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
            completion: review_verdict == Some("PASS"),
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
    if matches_fixed(
        r"(blocked|blocker|cannot safely|can't safely|불가능|막힘|차단|진행할 수 없)",
        &text,
    ) {
        return "explicit-blocker";
    }
    if matches_fixed(
        r"(implement|fix|change|modify|patch|edit|create|add|update|refactor|ship|수정|구현|변경|추가|고쳐|만들|반영)",
        &text,
    ) {
        return "implementation-required";
    }
    if matches_fixed(r"(review|audit|검토|리뷰)", &text) {
        return "review-only";
    }
    if matches_fixed(
        r"(research|investigate|diagnose|analy[sz]e|summari[sz]e|check|verify|inspect|조사|분석|진단|파악|요약|확인|검증)",
        &text,
    ) {
        return "diagnosis-only";
    }
    if matches_fixed(r"(write|draft|document|문서|작성|정리)", &text) {
        return "writing-only";
    }
    "implementation-required"
}
