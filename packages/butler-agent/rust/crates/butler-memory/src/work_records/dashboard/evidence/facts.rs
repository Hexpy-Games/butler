//! Durable worker evidence: file references, activity, receipts, transcripts and tool results, reduced to the facts completion safety needs.

use super::*;

/// A line of `worker_activity_events.jsonl`.
#[derive(Default, Deserialize)]
pub(super) struct ActivityEvent {
    #[serde(default, deserialize_with = "crate::lenient::option")]
    semantic_phase: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    action_kind: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    status_line: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    decision_summary: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    completion_review: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    event: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    completion_contract: Option<CompletionContract>,
    #[serde(default, deserialize_with = "crate::lenient::strings")]
    evidence_refs: Option<Vec<String>>,
}

/// What a worker declared about its own completion.
#[derive(Default, Deserialize)]
pub(super) struct CompletionContract {
    #[serde(default, deserialize_with = "crate::lenient::option")]
    has_execution_evidence: Option<bool>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    has_commit_evidence: Option<bool>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    has_blocker_evidence: Option<bool>,
}

/// A line of an evidence receipt log.
#[derive(Default, Deserialize)]
pub(super) struct Receipt {
    #[serde(
        default,
        rename = "receiptType",
        deserialize_with = "crate::lenient::option"
    )]
    receipt_type: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::strings")]
    satisfies: Option<Vec<String>>,
}

/// A line of the worker session transcript.
#[derive(Default, Deserialize)]
pub(super) struct TranscriptEvent {
    #[serde(default, deserialize_with = "crate::lenient::option")]
    kind: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    payload: Option<ToolPayload>,
}

/// A tool call or result in the transcript.
#[derive(Default, Deserialize)]
pub(super) struct ToolPayload {
    #[serde(default, deserialize_with = "crate::lenient::option")]
    name: Option<String>,
    /// Passthrough: the tool's result, shaped by each tool; matched as text.
    #[serde(default)]
    result: Option<Value>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    arguments: Option<ToolArguments>,
}

#[derive(Default, Deserialize)]
pub(super) struct ToolArguments {
    #[serde(default, deserialize_with = "crate::lenient::option")]
    command: Option<String>,
}

/// The completion facts a tool result may state.
#[derive(Default, Deserialize)]
pub(super) struct ToolResultFacts {
    #[serde(default, deserialize_with = "crate::lenient::option")]
    command: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    written_files: Option<Vec<serde::de::IgnoredAny>>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    verified_output_files: Option<Vec<serde::de::IgnoredAny>>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    durable_artifact_created: Option<bool>,
}

/// Every durable trace of the worker: result and log text, activity events,
/// evidence receipts and the worker session transcript.
pub(super) fn collect(directory: &Path) -> Facts {
    let mut facts = Facts {
        refs: file_refs(directory),
        ..Facts::default()
    };
    let result = read(&directory.join("result.md"));
    let log = read(&directory.join("log.txt"));
    let text = format!("{log}\n{result}");
    facts.implementation |= matches_fixed(
        r"(?i)\b(apply_patch|patch\s+-p|git apply|git\s+diff|diff\s+-|bun test|npm test|pnpm test|yarn test|vitest|jest|playwright|typecheck|lint|tsc|git\s+commit|sed\s+-i|perl\s+-pi|cat\s+>|printf\s+.*>|tee\s+|mv\s+.*|cp\s+.*|touch|mkdir\s+-p)\b",
        &text,
    );
    facts.execution |= text.contains("run_shell")
        || text.contains("run_command")
        || text.contains("===== COMMAND:");
    facts.final_blocker |= matches_fixed(
        r"(?i)\b(blocked|blocker|cannot safely|unable to proceed|TIMEOUT|deadlock|auth|credential)\b",
        &result,
    );
    facts.environment_blocker |= environment_blocker(&result);
    for line in json_lines(&directory.join("worker_activity_events.jsonl")) {
        activity_facts(&mut facts, &crate::lenient::view(&line));
    }
    for name in [
        "evidence-receipts.jsonl",
        "evidence_receipts.jsonl",
        "worker_evidence.jsonl",
    ] {
        for receipt in json_lines(&directory.join(name)) {
            receipt_facts(&mut facts, &crate::lenient::view(&receipt));
        }
    }
    transcript_facts(&mut facts, directory);
    facts
}

/// A non-empty result, a worker activity or preflight file, or a patch,
/// diff, commit or evidence file.
pub(super) fn file_refs(directory: &Path) -> bool {
    let files = directory
        .join("result.md")
        .metadata()
        .is_ok_and(|metadata| metadata.len() > 0)
        || [
            "worker_activity_events.jsonl",
            "worker_activity.json",
            "worker-preflight.md",
        ]
        .iter()
        .any(|name| directory.join(name).exists());
    files
        || std::fs::read_dir(directory).is_ok_and(|entries| {
            entries.flatten().any(|entry| {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                ["patch", "diff", "commit", "evidence"]
                    .iter()
                    .any(|prefix| name.starts_with(prefix))
            })
        })
}

pub(super) fn activity_facts(facts: &mut Facts, line: &ActivityEvent) {
    let field = |value: &Option<String>| value.as_deref().unwrap_or("").to_owned();
    let semantic = field(&line.semantic_phase);
    let action = field(&line.action_kind);
    let phrase = format!(
        "{} {}",
        field(&line.status_line),
        field(&line.decision_summary)
    )
    .to_lowercase();
    let contract = line.completion_contract.as_ref();
    let declared =
        |fact: fn(&CompletionContract) -> Option<bool>| contract.and_then(fact) == Some(true);
    facts.execution |= semantic == "executing" || declared(|c| c.has_execution_evidence);
    facts.report |= semantic == "reporting";
    facts.implementation |= declared(|c| c.has_commit_evidence)
        || matches_fixed(
            r"(?i)(apply_patch|patch|edit_file|write_file|file_modified|modify|create_file|file_created|git_diff|diff|test|typecheck|lint|verify|commit|검증|modified|updated|edited|wrote|created|added)",
            &format!("{action} {phrase}"),
        );
    let review = field(&line.completion_review);
    let blocked =
        semantic == "blocked" || review == "blocked" || declared(|c| c.has_blocker_evidence);
    let terminal = blocked
        && (["worker_failed", "worker_finished"].contains(&field(&line.event).as_str())
            || review == "blocked");
    facts.final_blocker |= terminal;
    facts.environment_blocker |= terminal && environment_blocker(&phrase);
    facts.refs |= line
        .evidence_refs
        .as_ref()
        .is_some_and(|values| !values.is_empty());
}

pub(super) fn receipt_facts(facts: &mut Facts, receipt: &Receipt) {
    let satisfies = receipt.satisfies.as_deref().unwrap_or(&[]);
    facts.execution |= receipt.receipt_type.as_deref() == Some("execution")
        || satisfies.iter().any(|value| value == "command_executed");
    facts.implementation |= satisfies.iter().any(|value| {
        matches_fixed(
            r"file_created|file_modified|durable_artifact|patch|diff|test|validation|typecheck|lint|commit",
            value,
        )
    });
    facts.refs = true;
}

/// Tool calls and results of the worker session's transcript
/// (`transcripts/worker/<session>.jsonl` under the data root).
pub(super) fn transcript_facts(facts: &mut Facts, directory: &Path) {
    let session = read(&directory.join("session_id"));
    if session.is_empty() {
        return;
    }
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
    let Some(data) = directory.parent().and_then(Path::parent) else {
        return;
    };
    for event in json_lines(&data.join("transcripts").join(format!("{sanitized}.jsonl"))) {
        let event: TranscriptEvent = crate::lenient::view(&event);
        let kind = event.kind.as_deref().unwrap_or("");
        if !matches!(kind, "tool_result" | "tool_call") {
            continue;
        }
        tool_facts(facts, &event.payload.unwrap_or_default());
        if kind == "tool_result" {
            facts.refs = true;
        }
    }
}

pub(super) fn tool_facts(facts: &mut Facts, payload: &ToolPayload) {
    let result = payload.result.as_ref().unwrap_or(&Value::Null);
    let stated: ToolResultFacts = crate::lenient::view(result);
    let command = stated
        .command
        .as_deref()
        .or_else(|| {
            payload
                .arguments
                .as_ref()
                .and_then(|arguments| arguments.command.as_deref())
        })
        .unwrap_or("");
    let name = payload.name.as_deref().unwrap_or("");
    let text = format!("{name}\n{command}\n{result}");
    facts.execution |= name == ToolName::RunCommand;
    facts.implementation |= stated.written_files.is_some_and(|items| !items.is_empty())
        || stated
            .verified_output_files
            .is_some_and(|items| !items.is_empty())
        || stated.durable_artifact_created == Some(true)
        || matches_fixed(
            r"(?i)\b(apply_patch|patch\s+-p|git apply|git\s+diff|diff\s+-|bun test|npm test|pnpm test|yarn test|vitest|jest|playwright|typecheck|lint|tsc|git\s+commit|committed)\b",
            &text,
        );
}

pub(super) fn read(path: &Path) -> String {
    std::fs::read(path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}
pub(super) fn json_lines(path: &Path) -> impl Iterator<Item = Value> {
    File::open(path)
        .ok()
        .into_iter()
        .flat_map(|file| BufReader::new(file).lines())
        .filter_map(|line| line.ok().and_then(|line| serde_json::from_str(&line).ok()))
}
pub(super) fn environment_blocker(value: &str) -> bool {
    matches_fixed(
        r"(?is)\b(tsc|typescript|bun|npm|pnpm|yarn|node_modules|dependency|dependencies)\b.{0,120}\b(command not found|not found|missing|not installed)\b",
        value,
    ) || matches_fixed(
        r"(?is)\b(command not found|not found|missing|not installed)\b.{0,120}\b(tsc|typescript|bun|npm|pnpm|yarn|node_modules|dependency|dependencies)\b",
        value,
    )
}
