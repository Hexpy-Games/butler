//! `app/approvalRequest.ts` and `app/approvalTargets.ts`: the narrowed approval of a pending
//! authority request and the card's content in the app language.
use serde_json::Value;

use crate::ui::i18n::authority::Authority;
use crate::ui::source::Risk;
use crate::ui::source::wire::AuthorityApprovalCardWire;
use crate::ui::store::progress::tool_titles;

/// `approval.action_kind` values the agent sends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ActionKind {
    GenerateImage,
    EditImage,
    EditFiles,
    RunCommand,
    NetworkCommand,
    WebRequest,
    UseConnector,
    ManageSchedule,
    UpdateProject,
    StartConversation,
    RestartService,
    CreateWorktree,
    SwitchFolder,
    Other,
}

impl ActionKind {
    fn parse(kind: &str) -> Self {
        match kind {
            "generate_image" => Self::GenerateImage,
            "edit_image" => Self::EditImage,
            "edit_files" => Self::EditFiles,
            "run_command" => Self::RunCommand,
            "network_command" => Self::NetworkCommand,
            "web_request" => Self::WebRequest,
            "use_connector" => Self::UseConnector,
            "manage_schedule" => Self::ManageSchedule,
            "update_project" => Self::UpdateProject,
            "start_conversation" => Self::StartConversation,
            "restart_service" => Self::RestartService,
            "create_worktree" => Self::CreateWorktree,
            "switch_folder" => Self::SwitchFolder,
            _ => Self::Other,
        }
    }

    /// COMMAND_KINDS: the example is the command line, shown as sent.
    fn is_command(kind: &str) -> bool {
        matches!(kind, "run_command" | "network_command")
    }

    fn is_command_kind(self) -> bool {
        matches!(self, Self::RunCommand | Self::NetworkCommand)
    }
}

/// A detail line: plain text, or a command body shown as sent.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Line {
    Text(String),
    Code(String),
}

impl Line {
    pub(super) fn text(&self) -> &str {
        match self {
            Self::Text(text) | Self::Code(text) => text,
        }
    }
}

pub(super) struct Target {
    kind: String,
    path: String,
    label: Option<String>,
}

pub(super) struct ImageOperation {
    model: String,
    size: String,
    quality: String,
    prompt: String,
}

pub(super) struct BrowserStep {
    action: String,
    role: String,
    name: String,
    frame: String,
    value_preview: Option<String>,
    addons: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum AllowSite {
    SignedIn,
    Payment,
}

pub(super) struct Operation {
    pub(super) tool: String,
    read_only: bool,
    pub(super) targets: Vec<String>,
    image: Option<ImageOperation>,
    browser_steps: Option<Vec<BrowserStep>>,
    sign_in_step: Option<String>,
    pub(super) wait_reason: Option<String>,
    browser_signed_in: Option<bool>,
    pub(super) allow_site: Option<AllowSite>,
    pub(super) allow_conversation: Option<bool>,
    command: Option<String>,
}

pub(super) struct Schedule {
    pub(super) title: String,
    pub(super) kind: String,
    browser_signin: Option<bool>,
    browser_payment: Option<bool>,
    pub(super) time: Option<String>,
    pub(super) run_at: Option<String>,
    pub(super) start_at: Option<String>,
    pub(super) interval_seconds: Option<i64>,
    access_mode: Option<String>,
}

pub(super) struct Approval {
    action_kind: String,
    targets: Vec<Target>,
    count: i64,
    examples: Vec<String>,
    examples_truncated: Option<Vec<bool>>,
    pub(super) operation: Option<Operation>,
    schedule: Option<Schedule>,
    unisolated_read_only: bool,
    risk: Option<Risk>,
}

/// One pending request (`AuthorityApprovalCard`).
pub(super) struct Card {
    pub(super) request_ref: String,
    pub(super) reason: String,
    /// The legacy Korean display text: title and description.
    pub(super) scope: Option<(String, String)>,
    pub(super) approval: Option<Approval>,
}

/// The approval card's content in the app language.
pub(super) struct View {
    pub(super) title: String,
    pub(super) details: Vec<Line>,
    pub(super) risk: Risk,
    pub(super) conversation_scope: Option<String>,
    pub(super) action_kind: ActionKind,
}

mod present;
pub(super) use present::{is_handoff, view};

const MAX_EXAMPLES: usize = 3;
const DETAIL_TARGET_KINDS: [&str; 5] = ["connector", "schedule", "other", "outside", "file"];

/// `normalizeAuthorityApprovals`: only records whose every renderable field has the expected
/// type become cards; the order is kept.
pub(super) fn cards(raw: &[Value]) -> Vec<Card> {
    raw.iter().filter_map(card).collect()
}

fn card(entry: &Value) -> Option<Card> {
    let wire: AuthorityApprovalCardWire = serde_json::from_value(entry.clone()).ok()?;
    if wire.request_ref.trim().is_empty()
        || !matches!(wire.category.as_str(), "command" | "reviewed_effect")
        || wire.reason.trim().is_empty()
        || wire.executable.trim().is_empty()
        || wire.command_count < 1
    {
        return None;
    }
    let scope = wire.scope.as_ref().and_then(|scope| {
        Some((
            scope.get("title")?.as_str()?.to_owned(),
            scope.get("description")?.as_str()?.to_owned(),
        ))
    });
    Some(Card {
        request_ref: wire.request_ref,
        reason: wire.reason,
        scope,
        approval: wire.approval.as_ref().and_then(approval),
    })
}

fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_owned)
}

fn text(value: &Value, key: &str) -> Option<String> {
    string(value, key).filter(|text| !text.trim().is_empty())
}

/// `normalizeApprovalSummary`: malformed targets and examples are dropped; a missing kind or an
/// invalid count drops the whole summary.
fn approval(value: &Value) -> Option<Approval> {
    if !value.is_object() {
        return None;
    }
    let action_kind = text(value, "action_kind")?;
    let count = match value.get("count") {
        None => 1,
        Some(count) => count.as_i64().filter(|count| *count >= 0)?,
    };
    let (targets, relative) = targets(value.get("targets"));
    let truncated = value.get("examples_truncated").and_then(Value::as_array);
    let mut examples = Vec::new();
    let mut flags = Vec::new();
    let given = value.get("examples").and_then(Value::as_array);
    for (index, example) in given.into_iter().flatten().enumerate() {
        let Some(example) = example.as_str().filter(|e| !e.trim().is_empty()) else {
            continue;
        };
        let shown = if ActionKind::is_command(&action_kind) || !is_absolute_path(example) {
            example.to_owned()
        } else {
            relative(example)
        };
        if shown.is_empty() {
            continue;
        }
        examples.push(shown);
        flags.push(truncated.and_then(|t| t.get(index)) == Some(&Value::Bool(true)));
    }
    Some(Approval {
        count,
        examples_truncated: flags.iter().any(|f| *f).then_some(flags),
        examples,
        operation: operation(value.get("operation")),
        schedule: schedule(value.get("schedule")),
        unisolated_read_only: value.get("command_access").and_then(Value::as_str)
            == Some("read_only_unisolated"),
        risk: match value.get("risk").and_then(Value::as_str) {
            Some("low") => Some(Risk::Low),
            Some("medium") => Some(Risk::Medium),
            Some("high") => Some(Risk::High),
            _ => None,
        },
        action_kind,
        targets,
    })
}

fn operation(value: Option<&Value>) -> Option<Operation> {
    let value = value.filter(|v| v.is_object())?;
    let tool = text(value, "tool")?;
    let read_only = match value.get("access").and_then(Value::as_str)? {
        "read_only" => true,
        "change" => false,
        _ => return None,
    };
    let targets = value
        .get("targets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|t| !t.trim().is_empty())
        .map(str::to_owned)
        .collect();
    Some(Operation {
        tool,
        read_only,
        targets,
        image: image(value.get("image")),
        browser_steps: browser_steps(value.get("browser_steps")),
        sign_in_step: string(value, "sign_in_step"),
        wait_reason: string(value, "wait_reason"),
        browser_signed_in: match value.get("browser_mode").and_then(Value::as_str) {
            Some("signed_out") => Some(false),
            Some("signed_in") => Some(true),
            _ => None,
        },
        allow_site: match value.get("allow_site").and_then(Value::as_str) {
            Some("signed_in") => Some(AllowSite::SignedIn),
            Some("payment") => Some(AllowSite::Payment),
            _ => None,
        },
        allow_conversation: value.get("allow_conversation").and_then(Value::as_bool),
        command: text(value, "command"),
    })
}

/// `normalizeImageOperation`.
fn image(value: Option<&Value>) -> Option<ImageOperation> {
    let value = value.filter(|v| v.is_object())?;
    for key in ["action", "model", "model_ref", "size", "quality", "prompt"] {
        string(value, key)?;
    }
    value
        .get("images")?
        .as_array()?
        .iter()
        .all(Value::is_string)
        .then(|| ImageOperation {
            model: string(value, "model").unwrap_or_default(),
            size: string(value, "size").unwrap_or_default(),
            quality: string(value, "quality").unwrap_or_default(),
            prompt: string(value, "prompt").unwrap_or_default(),
        })
}

fn browser_steps(value: Option<&Value>) -> Option<Vec<BrowserStep>> {
    let steps = value?.as_array()?;
    Some(
        steps
            .iter()
            .filter_map(|step| {
                let addons = step.get("addons")?.as_array()?;
                if !addons.iter().all(Value::is_string) {
                    return None;
                }
                Some(BrowserStep {
                    action: string(step, "action")?,
                    role: string(step, "role")?,
                    name: string(step, "name")?,
                    frame: string(step, "frame")?,
                    value_preview: string(step, "value_preview"),
                    addons: addons.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
                })
            })
            .collect(),
    )
}

fn schedule(value: Option<&Value>) -> Option<Schedule> {
    let value = value.filter(|v| v.is_object())?;
    let title = string(value, "title")?;
    let schedule_type = string(value, "schedule_type")
        .filter(|t| matches!(t.as_str(), "once" | "interval" | "daily" | "weekdays" | "update"))?;
    let flag = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_bool)
            .or((schedule_type != "update").then_some(false))
    };
    Some(Schedule {
        title: title.trim().to_owned(),
        browser_signin: flag("browser_signin"),
        browser_payment: flag("browser_payment"),
        time: text(value, "time"),
        run_at: text(value, "run_at"),
        start_at: text(value, "start_at"),
        interval_seconds: value
            .get("interval_seconds")
            .and_then(|n| n.as_i64().or_else(|| n.as_f64().and_then(|f| format!("{}", f.trunc()).parse().ok()))),
        access_mode: string(value, "access_mode").filter(|m| {
            matches!(m.as_str(), "auto" | "read_only" | "ask_first" | "ask_except_reads" | "full_access")
        }),
        kind: schedule_type,
    })
}

fn is_absolute_path(path: &str) -> bool {
    let path = path.trim();
    let bytes = path.as_bytes();
    let separator = |b: u8| b == b'/' || b == b'\\';
    path.starts_with('/')
        || path.starts_with("\\\\")
        || (bytes.first() == Some(&b'~') && bytes.get(1).is_none_or(|b| separator(*b)))
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && separator(bytes[2]))
}

/// Trailing separators dropped, keeping at least one character.
fn without_trailing_separators(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        path.chars().take(1).collect()
    } else {
        trimmed.to_owned()
    }
}

/// `path` inside `root`, relative to it; `None` when it lies elsewhere.
fn within(path: &str, root: Option<&str>) -> Option<String> {
    let root = root.filter(|r| !r.is_empty())?;
    let rest = path.strip_prefix(root)?;
    if !rest.is_empty() && !rest.starts_with(['/', '\\']) {
        return None;
    }
    if rest.split(['/', '\\']).any(|part| part == "..") {
        return None;
    }
    Some(rest.trim_start_matches(['/', '\\']).to_owned())
}

/// `approvalTargetsFromTransport`: project-relative paths inside the root, exact paths elsewhere.
fn targets(value: Option<&Value>) -> (Vec<Target>, impl Fn(&str) -> String + use<>) {
    let raw: Vec<(String, String)> = value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|target| {
            Some((
                target.get("kind")?.as_str()?.to_owned(),
                target.get("path")?.as_str()?.trim().to_owned(),
            ))
        })
        .collect();
    let root = raw
        .iter()
        .find(|(kind, path)| kind == "folder" && is_absolute_path(path))
        .map(|(_, path)| without_trailing_separators(path));
    let relative = move |path: &str| {
        let trimmed = path.trim();
        if !is_absolute_path(trimmed) {
            return if trimmed == "." {
                String::new()
            } else {
                trimmed
                    .strip_prefix("./")
                    .or_else(|| trimmed.strip_prefix(".\\"))
                    .unwrap_or(trimmed)
                    .to_owned()
            };
        }
        within(&without_trailing_separators(trimmed), root.as_deref())
            .unwrap_or_else(|| trimmed.to_owned())
    };
    let targets = raw
        .iter()
        .map(|(kind, path)| {
            if kind != "folder" {
                return Target { kind: kind.clone(), path: relative(path), label: None };
            }
            let label = without_trailing_separators(path);
            let label = if label == "." { String::new() } else { label };
            Target {
                kind: kind.clone(),
                path: String::new(),
                label: (!label.is_empty()).then_some(label),
            }
        })
        .collect();
    (targets, relative)
}

/// The workspace's label: the folder's first, else another target's.
fn workspace_label(approval: &Approval) -> Option<&str> {
    let labelled = |t: &&Target| t.label.as_deref().is_some_and(|l| !l.trim().is_empty());
    approval
        .targets
        .iter()
        .filter(|t| t.kind == "folder")
        .find(labelled)
        .or_else(|| approval.targets.iter().find(labelled))
        .and_then(|t| t.label.as_deref())
        .map(str::trim)
}

fn has_outside(approval: &Approval) -> bool {
    approval.targets.iter().any(|t| t.kind == "outside")
}

impl ActionKind {
    /// What the request touches, at a glance.
    pub(super) fn icon(self) -> butler_ds::ui::Icon {
        use butler_ds::ui::Icon;
        match self {
            Self::GenerateImage => Icon::ImageIcon,
            Self::EditImage => Icon::Pencil,
            Self::EditFiles | Self::SwitchFolder => Icon::Folder,
            Self::RunCommand => Icon::Terminal,
            Self::NetworkCommand | Self::WebRequest => Icon::Globe2,
            Self::UseConnector => Icon::McpServer,
            Self::ManageSchedule => Icon::Clock3,
            Self::UpdateProject => Icon::ListChecks,
            Self::StartConversation => Icon::MessageSquarePlus,
            Self::RestartService => Icon::RefreshCcw,
            Self::CreateWorktree => Icon::GitBranch,
            Self::Other => Icon::ShieldCheck,
        }
    }
}
