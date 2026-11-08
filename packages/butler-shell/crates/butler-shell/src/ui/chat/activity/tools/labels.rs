//! `toolchainUtils.tsx`, `toolchainDetails.tsx` (labels), `toolchainIcons.tsx`, and the
//! `app/copy.ts` label helpers they call (`interfaceProgressLabel`, `interfaceArgumentLabel`).
use butler_ds::ui::Icon;
use butler_ds::ui::context::Lang;

use super::copy::{self, find, text};
use crate::ui::source::wire::{
    InterfaceTextReference, InterfaceTextReferenceKey, ProgressDetailRow, ProgressRow,
};

/// A string field that JS treats as present: neither missing nor empty.
pub(super) fn nonempty(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.is_empty())
}

/// `appCopy.guided.tools[name]`: a tool's label by its id, when the copy has one.
pub(crate) fn tool_label(lang: Lang, name: &str) -> Option<&'static str> {
    find(lang, &format!("tool.{name}"))
}

/// `appCopy.guided.tools[name] ?? appCopy.guided.tools.fallback`
fn tool_name_label(lang: Lang, name: &str) -> &'static str {
    tool_label(lang, name).unwrap_or_else(|| text(lang, "tool.fallback"))
}

fn public_tool_label(row: &ProgressRow, lang: Lang) -> String {
    let name = row.safe_tool_name.as_deref().unwrap_or("");
    if ["Bun", "Bash", "Web search", "Read", "Edit", "Write"].contains(&name) {
        return name.to_owned();
    }
    tool_name_label(lang, name).to_owned()
}

/// publicOperationTitle: `progress.operations[name] ?? guided.tools[name] ?? progress.fallback`.
fn public_operation_title(name: &str, lang: Lang) -> &'static str {
    let name = name.trim();
    find(lang, &format!("op.{name}"))
        .or_else(|| find(lang, &format!("tool.{name}")))
        .unwrap_or_else(|| text(lang, "pg.fallback"))
}

/// The tokens of `"[^"]*"|'[^']*'|\S+`.
fn words(command: &str) -> Vec<&str> {
    let mut found = Vec::new();
    let mut rest = command.trim_start();
    while let Some(first) = rest.chars().next() {
        let quoted = (first == '"' || first == '\'')
            .then(|| rest[1..].find(first).map(|close| close + 2))
            .flatten();
        let end = quoted.unwrap_or_else(|| rest.find(char::is_whitespace).unwrap_or(rest.len()));
        found.push(&rest[..end]);
        rest = rest[end..].trim_start();
    }
    found
}

/// `replace(/^["']|["']$/gu, "")`
fn unquote(value: &str) -> &str {
    let quote = |c: char| c == '"' || c == '\'';
    let value = value.strip_prefix(quote).unwrap_or(value);
    value.strip_suffix(quote).unwrap_or(value)
}

/// commandProgram (butler-i18n tool-display.ts): the program a command line runs.
pub(super) fn command_program(command: &str) -> String {
    let words = words(command);
    let executable = unquote(words.first().copied().unwrap_or(""))
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .to_owned();
    let lower = executable.to_lowercase();
    let shell = ["powershell", "pwsh", "cmd"]
        .iter()
        .any(|name| lower == *name || lower == format!("{name}.exe"));
    if !shell {
        return executable;
    }
    let flag = words
        .iter()
        .position(|word| ["-command", "-c", "/c", "/k"].contains(&word.to_lowercase().as_str()));
    let Some(flag) = flag else {
        return executable;
    };
    let joined = words[flag + 1..].join(" ");
    let nested = unquote(&joined);
    let nested = nested.strip_prefix('&').map_or(nested, str::trim_start);
    let program = command_program(nested);
    let keyword = [
        "if", "for", "foreach", "while", "try", "switch", "return", "throw", "function",
    ]
    .contains(&program.to_lowercase().as_str());
    let mut chars = program.chars();
    let identifier = chars
        .next()
        .is_some_and(|first| first.is_alphabetic() || first == '_')
        && chars.all(|c| c.is_alphanumeric() || matches!(c, '_' | '.' | '-'));
    if identifier && !keyword {
        program
    } else {
        executable
    }
}

/// uniqueFileTargets (butler-i18n tool-display.ts)
fn unique_file_targets(target: &str) -> String {
    let mut seen: Vec<&str> = Vec::new();
    for value in target.split(", ").map(str::trim).filter(|v| !v.is_empty()) {
        if !seen.contains(&value) {
            seen.push(value);
        }
    }
    seen.join(", ")
}

/// toolchainLabel
fn toolchain_label(row: &ProgressRow, lang: Lang) -> String {
    let name = nonempty(row.safe_tool_name.as_deref());
    if name == Some("ask_user") {
        return public_operation_title("ask_user", lang).to_owned();
    }
    if let (Some(name), Some(input)) = (name, nonempty(row.safe_input_label.as_deref())) {
        let target = if name == "run_command" {
            command_program(input)
        } else if ["read_file", "write_file", "edit_file"].contains(&name) {
            unique_file_targets(input)
        } else {
            input.to_owned()
        };
        return format!("{}: {target}", public_tool_label(row, lang));
    }
    if name.is_some() {
        return public_tool_label(row, lang);
    }
    row.safe_input_label
        .clone()
        .unwrap_or_else(|| text(lang, "d.tool").to_owned())
}

/// interfaceArgumentLabel
fn argument_label(kind: Option<&str>, label: &str, lang: Lang) -> String {
    kind.and_then(|kind| kind.strip_prefix("argument_"))
        .and_then(|name| find(lang, &format!("arg.{name}")))
        .unwrap_or(label)
        .to_owned()
}

/// toolchainDetailLabel
pub(super) fn detail_label(detail: &ProgressDetailRow, row: &ProgressRow, lang: Lang) -> String {
    let value = detail.safe_value.as_deref().map_or("", str::trim);
    let label = if row.kind.as_deref() == Some("todo")
        && detail.safe_label.trim().eq_ignore_ascii_case("phase")
    {
        text(lang, "st.phase").to_owned()
    } else {
        argument_label(detail.kind.as_deref(), &detail.safe_label, lang)
    };
    if value.is_empty() {
        return label;
    }
    if row.safe_tool_name.as_deref() == Some("Web search") {
        return copy::web_search_detail(lang, value);
    }
    copy::detail_row(&label, value)
}

/// toolTitle in formatInterfaceText.
fn tool_title(lang: Lang, name: &str, target: Option<&str>) -> String {
    let target = target.filter(|target| !target.is_empty());
    if name == "run_command"
        && let Some(target) = target
    {
        return target.to_owned();
    }
    let title = tool_name_label(lang, name);
    target.map_or_else(|| title.to_owned(), |target| format!("{title}: {target}"))
}

/// formatInterfaceText (butler-i18n locale.ts)
pub(super) fn format_interface_text(reference: &InterfaceTextReference, lang: Lang) -> String {
    let parameters = reference.parameters.as_ref();
    let phase = parameters.and_then(|p| p.phase.as_deref());
    let tool_name = parameters.and_then(|p| p.toolName.as_deref());
    let target = parameters.and_then(|p| p.target.as_deref());
    let value = parameters.and_then(|p| p.text.as_deref()).unwrap_or("");
    match reference.key {
        InterfaceTextReferenceKey::WorkerStatus => {
            let key = format!("ws.{}", phase.unwrap_or("executing"));
            find(lang, &key)
                .unwrap_or_else(|| text(lang, "ws.executing"))
                .to_owned()
        }
        InterfaceTextReferenceKey::ToolTitle => {
            tool_title(lang, tool_name.unwrap_or("fallback"), target)
        }
        InterfaceTextReferenceKey::ToolsSummary => {
            let mut titles: Vec<String> = Vec::new();
            for tool in parameters
                .and_then(|p| p.tools.as_ref())
                .into_iter()
                .flatten()
            {
                let title = tool_title(lang, &tool.name, tool.target.as_deref());
                if !titles.contains(&title) {
                    titles.push(title);
                }
            }
            copy::tools_summary(lang, &titles.join(" · "))
        }
        InterfaceTextReferenceKey::ConceptionSummary => copy::conception_summary(lang, value),
        InterfaceTextReferenceKey::WorkInProgress => copy::work_in_progress(lang, value),
        InterfaceTextReferenceKey::CheckingPrevious => text(lang, "g.checkingPrevious").into(),
        InterfaceTextReferenceKey::CheckingRequest => text(lang, "g.checkingRequest").into(),
        InterfaceTextReferenceKey::ToolWorking => text(lang, "g.toolWorking").into(),
        InterfaceTextReferenceKey::CheckingInformation => {
            text(lang, "g.checkingInformation").into()
        }
        InterfaceTextReferenceKey::CommandExecuting => text(lang, "g.commandExecuting").into(),
        InterfaceTextReferenceKey::ConceptionTitle => text(lang, "g.conceptionTitle").into(),
        InterfaceTextReferenceKey::PlanningNext => text(lang, "g.planningNext").into(),
        InterfaceTextReferenceKey::ReportTitle => text(lang, "g.reportTitle").into(),
        InterfaceTextReferenceKey::Unknown => String::new(),
    }
}

/// getInterfaceProgressLabel (butler-i18n locale.ts)
fn progress_label_for_key(row: &ProgressRow, lang: Lang) -> Option<String> {
    let key = row.interface_label_key.as_deref()?;
    if let Some(name) = key.strip_prefix("operation:") {
        let label = find(lang, &format!("op.{name}")).unwrap_or_else(|| text(lang, "pg.fallback"));
        return Some(label.to_owned());
    }
    let label = match key {
        "working" => text(lang, "st.working").to_owned(),
        "accepted" => text(lang, "pg.accepted").to_owned(),
        "generating" => text(lang, "st.generating").to_owned(),
        "storageRecovery" => text(lang, "pg.storageRecovery").to_owned(),
        "reconnecting" => match &row.interface_label_parameters {
            Some(p) => format!(
                "{} ({}/{})",
                text(lang, "pg.reconnecting"),
                p.attempt,
                p.maxAttempts
            ),
            None => text(lang, "pg.reconnecting").to_owned(),
        },
        "stopping" => text(lang, "pg.stopping").to_owned(),
        _ => return None,
    };
    Some(label)
}

/// interfaceProgressLabel (app/copy.ts)
fn interface_progress_label(row: &ProgressRow, lang: Lang) -> String {
    let content = row.interface_content.as_ref();
    let reference = content.and_then(|c| c.summary.as_ref()).or_else(|| {
        let no_summary = row
            .work_decision_summary
            .as_deref()
            .is_none_or(str::is_empty);
        content
            .and_then(|c| c.title.as_ref())
            .filter(|_| no_summary)
    });
    if let Some(reference) = reference {
        return format_interface_text(reference, lang);
    }
    progress_label_for_key(row, lang).unwrap_or_else(|| {
        find(lang, &format!("tool.{}", row.safe_label))
            .map_or_else(|| row.safe_label.clone(), str::to_owned)
    })
}

/// toolchainSummaryLabel: the title of a tool row.
pub(super) fn summary_label(row: &ProgressRow, lang: Lang) -> String {
    let name = nonempty(row.safe_tool_name.as_deref());
    if name == Some("ask_user") {
        return public_operation_title("ask_user", lang).to_owned();
    }
    if name == Some("delegate_to_worker") {
        return text(lang, "st.workerCall").to_owned();
    }
    if row.bridge_phase.as_deref() == Some("btcc_operation") {
        return operation_label(row, lang);
    }
    let details = row.safe_detail_rows.as_deref().unwrap_or_default();
    if row.kind.as_deref() == Some("todo")
        && name.is_none()
        && let Some(first) = details.first()
    {
        return detail_label(first, row, lang);
    }
    if name == Some("Web search") && details.len() > 1 {
        return copy::web_search_summary(lang, details.len());
    }
    if let Some(name) = name
        && details.len() > 1
    {
        return copy::tool_steps_summary(lang, tool_name_label(lang, name), details.len());
    }
    toolchain_label(row, lang)
}

/// The `btcc_operation` branch of toolchainSummaryLabel.
fn operation_label(row: &ProgressRow, lang: Lang) -> String {
    if nonempty(row.safe_input_label.as_deref()).is_some() {
        return toolchain_label(row, lang);
    }
    let label = interface_progress_label(row, lang);
    let name = row.safe_tool_name.as_deref().unwrap_or("");
    let known = [Lang::En, Lang::Ko].into_iter().any(|locale| {
        let title = find(locale, &format!("tool.{name}"));
        [
            title,
            Some(public_operation_title(name, locale)),
            find(locale, "tool.fallback"),
            find(locale, "pg.fallback"),
        ]
        .contains(&Some(label.as_str()))
    });
    if known {
        return public_tool_label(row, lang);
    }
    let generic = [
        row.safe_tool_name.as_deref(),
        find(lang, "tool.fallback"),
        find(lang, "pg.fallback"),
    ]
    .contains(&Some(label.as_str()));
    if !label.is_empty() && !generic {
        label
    } else {
        toolchain_label(row, lang)
    }
}

/// toolchainDetails.toolDetails without a stored output: the detail rows joined by a space.
pub(super) fn detail_text(row: &ProgressRow, lang: Lang) -> String {
    row.safe_detail_rows
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|detail| detail_label(detail, row, lang))
        .collect::<Vec<_>>()
        .join(" ")
}

/// activityIcon
pub(super) fn activity_icon(row: &ProgressRow) -> Icon {
    let tool = row.safe_tool_name.as_deref();
    match tool {
        Some("delegate_to_worker") => return Icon::Rocket,
        Some("read_file") => return Icon::FileText,
        Some("edit_file" | "write_file") => return Icon::Pencil,
        Some("run_command") => return Icon::Terminal,
        _ => {}
    }
    if row.bridge_phase.as_deref() == Some("btcc_operation") {
        return Icon::Wrench;
    }
    let label = row.safe_label.to_lowercase();
    let kind = row.kind.as_deref();
    if kind == Some("searched") || label.contains("search") {
        Icon::Search
    } else if kind == Some("read") || label.contains("read") {
        Icon::FileText
    } else {
        match kind {
            Some("ran_command") => Icon::Terminal,
            Some("edited") => Icon::Pencil,
            Some("dispatch") => Icon::Rocket,
            Some("used_tool") => Icon::Wrench,
            _ => Icon::ListChecks,
        }
    }
}
