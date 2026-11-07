//! SpaceRowMeta's interfaceProgressLabel, translated from app/copy.ts and i18n/locale.ts.
mod copy;
use super::Shell;
use crate::ui::{
    source::wire::{
        InterfaceTextReference, InterfaceTextReferenceKey as Key,
        InterfaceTextReferenceParametersToolsItem, SessionSummary,
    },
    store::navigation::{SpaceRowData, space_activity},
};
use copy::Catalog;
use std::collections::HashSet;

impl Shell {
    pub(super) fn space_row_status(&self, row: &SpaceRowData) -> (String, String) {
        let mut label = row.session.as_ref().map_or_else(String::new, |session| {
            if session.attention_required {
                self.sidebar_copy(Catalog::Progress, "attention")
                    .unwrap_or_default()
                    .to_owned()
            } else {
                self.interface_progress_label(session)
            }
        });
        if label.is_empty() {
            let working =
                row.session.as_ref().and_then(|s| space_activity(s, false)) == Some("working");
            self.sidebar_copy(
                Catalog::Progress,
                if working { "spaceWorking" } else { "attention" },
            )
            .unwrap_or_default()
            .clone_into(&mut label);
        }
        let progress = row
            .session
            .as_ref()
            .and_then(|s| s.work_progress.as_ref())
            .map_or_else(String::new, |p| {
                format!(
                    " · {}/{}",
                    p.completed.saturating_add(1).min(p.total),
                    p.total
                )
            });
        (label, progress)
    }
    fn sidebar_copy(&self, catalog: Catalog, key: &str) -> Option<&'static str> {
        copy::lookup(catalog, key).map(|(en, ko)| self.copy(en, ko))
    }
    fn interface_progress_label(&self, session: &SessionSummary) -> String {
        if let Some(reference) = session
            .safe_status_content
            .as_ref()
            .and_then(|c| c.summary.as_ref().or(c.title.as_ref()))
        {
            return self.format_interface_text(reference);
        }
        if let Some(label) = self.progress_label_key(session) {
            return label;
        }
        let raw = session.safe_status_label.as_deref().unwrap_or_default();
        self.sidebar_copy(Catalog::Tools, raw)
            .map_or_else(|| raw.to_owned(), str::to_owned)
    }
    fn progress_label_key(&self, session: &SessionSummary) -> Option<String> {
        let key = session.safe_status_label_key.as_deref()?;
        if let Some(operation) = key.strip_prefix("operation:") {
            return Some(
                self.sidebar_copy(Catalog::Operations, operation)
                    .or_else(|| self.sidebar_copy(Catalog::Progress, "fallback"))
                    .unwrap_or_default()
                    .to_owned(),
            );
        }
        if !matches!(
            key,
            "working" | "accepted" | "generating" | "storageRecovery" | "reconnecting" | "stopping"
        ) {
            return None;
        }
        let label = self.sidebar_copy(Catalog::Progress, key)?;
        if key == "reconnecting"
            && let Some(parameters) = &session.safe_status_label_parameters
        {
            return Some(format!(
                "{label} ({}/{})",
                parameters.attempt, parameters.maxAttempts
            ));
        }
        Some(label.to_owned())
    }
    fn format_interface_text(&self, reference: &InterfaceTextReference) -> String {
        let parameters = reference.parameters.as_ref();
        match reference.key {
            Key::WorkerStatus => {
                let phase = parameters
                    .and_then(|p| p.phase.as_deref())
                    .unwrap_or("executing");
                self.sidebar_copy(Catalog::Worker, phase)
                    .or_else(|| self.sidebar_copy(Catalog::Worker, "executing"))
                    .unwrap_or_default()
                    .to_owned()
            }
            Key::ToolTitle => self.tool_title(
                parameters
                    .and_then(|p| p.toolName.as_deref())
                    .unwrap_or("fallback"),
                parameters.and_then(|p| p.target.as_deref()),
            ),
            Key::ToolsSummary => self.tools_summary(
                parameters
                    .and_then(|p| p.tools.as_deref())
                    .unwrap_or_default(),
            ),
            _ => self.guided_status(
                &reference.key,
                parameters
                    .and_then(|p| p.text.as_deref())
                    .unwrap_or_default(),
            ),
        }
    }
    fn tool_title(&self, name: &str, target: Option<&str>) -> String {
        let target = target.filter(|t| !t.is_empty());
        if name == "run_command"
            && let Some(target) = target
        {
            return target.to_owned();
        }
        let title = self
            .sidebar_copy(Catalog::Tools, name)
            .or_else(|| self.sidebar_copy(Catalog::Tools, "fallback"))
            .unwrap_or_default();
        target.map_or_else(|| title.to_owned(), |target| format!("{title}: {target}"))
    }
    fn tools_summary(&self, tools: &[InterfaceTextReferenceParametersToolsItem]) -> String {
        let mut seen = HashSet::new();
        let text = tools
            .iter()
            .map(|tool| self.tool_title(&tool.name, tool.target.as_deref()))
            .filter(|title| seen.insert(title.clone()))
            .collect::<Vec<_>>()
            .join(" · ");
        if text.is_empty() {
            self.copy(
                "Working with the required tools.",
                "필요한 도구로 작업을 진행하고 있습니다.",
            )
            .to_owned()
        } else {
            self.copy(
                "Checking the required information with {text}.",
                "{text} 도구로 필요한 정보를 확인하고 있습니다.",
            )
            .replace("{text}", &text)
        }
    }
    fn guided_status(&self, key: &Key, text: &str) -> String {
        let simple = match key {
            Key::CheckingPrevious => "checkingPrevious",
            Key::CheckingRequest => "checkingRequest",
            Key::ToolWorking => "toolWorking",
            Key::CheckingInformation => "checkingInformation",
            Key::CommandExecuting => "commandExecuting",
            Key::ConceptionTitle => "conceptionTitle",
            Key::PlanningNext => "planningNext",
            Key::ReportTitle => "reportTitle",
            Key::ConceptionSummary => {
                return if text.is_empty() {
                    self.copy(
                        "Confirmed the request goal and scope.",
                        "요청의 목표와 범위를 확인했습니다.",
                    )
                    .to_owned()
                } else {
                    self.copy(
                        "Confirmed the request goal and scope: {text}",
                        "요청의 목표와 범위를 확인했습니다: {text}",
                    )
                    .replace("{text}", text)
                };
            }
            Key::WorkInProgress => {
                return self
                    .copy("Working on {text}.", "{text} 작업을 진행하고 있습니다.")
                    .replace("{text}", text);
            }
            _ => return String::new(),
        };
        self.sidebar_copy(Catalog::Guided, simple)
            .unwrap_or_default()
            .to_owned()
    }
}
