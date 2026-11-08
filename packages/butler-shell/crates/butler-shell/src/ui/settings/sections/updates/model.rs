//! The `/updates` snapshot (`UpdateStatusView`, `ComponentUpdateStatus`, `UpdateProgressView`):
//! only the fields the page reads, plus `updateComponentDisplay`, `emptyComponentStatus` and
//! `updateProgressDisplay`.
use serde::Deserialize;

use super::copy::Words;

/// `UPDATE_COMPONENTS`
pub(super) const APP: &str = "app";

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
pub(super) struct ComponentView {
    pub(super) component: String,
    current_version: Option<String>,
    available_version: Option<String>,
    pub(super) update_available: bool,
    pub(super) check_state: Option<String>,
    bundled_agent_version: Option<String>,
}

impl ComponentView {
    /// `emptyComponentStatus`
    pub(super) fn empty(component: &str) -> Self {
        Self {
            component: component.to_owned(),
            ..Self::default()
        }
    }

    /// `versionLabel`
    pub(super) fn version_label(&self) -> String {
        let current = self
            .current_version
            .as_deref()
            .filter(|version| !version.is_empty())
            .unwrap_or("-");
        let available = self
            .available_version
            .as_deref()
            .filter(|version| !version.is_empty())
            .unwrap_or(current);
        if self.update_available {
            format!("{current} -> {available}")
        } else {
            current.to_owned()
        }
    }

    /// `bundledAgentVersionLabel`
    pub(super) fn bundled_agent_label(&self) -> Option<String> {
        let version = self.bundled_agent_version.as_deref()?;
        (self.component == APP && !version.is_empty()).then(|| format!("Butler Agent {version}"))
    }
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
pub(super) struct Progress {
    pub(super) component: String,
    pub(super) stage: String,
    pub(super) revision: u64,
    pub(super) bytes_done: Option<f64>,
    pub(super) bytes_total: Option<f64>,
    pub(super) cancellable: bool,
    pub(super) error_code: Option<String>,
}

impl Progress {
    /// `updateIsRunning`
    pub(super) fn is_running(&self) -> bool {
        !matches!(
            self.stage.as_str(),
            "idle" | "ready" | "failed" | "completed"
        )
    }

    pub(super) fn cancelled(&self) -> bool {
        self.error_code.as_deref() == Some("update_cancelled")
    }

    /// The total, when it is known (`bytes_total > 0`).
    pub(super) fn known_total(&self) -> Option<f64> {
        self.bytes_total.filter(|total| *total > 0.)
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub(super) struct Status {
    pub(super) components: Vec<ComponentView>,
    pub(super) progress: Option<Progress>,
}

/// The answer of POST /updates/cancel.
#[derive(Default, Deserialize)]
#[serde(default)]
pub(super) struct Cancelled {
    pub(super) cancelled: bool,
}

/// `updateFailureMessage`
pub(super) fn failure_message(code: Option<&str>, copy: &'static Words) -> &'static str {
    let code = code.unwrap_or("");
    if code.starts_with("update_stage_") {
        copy.error_storage
    } else if code == "update_activation_failed" {
        copy.error_apply
    } else if ["incompatible", "platform_missing", "missing_platform"]
        .iter()
        .any(|part| code.contains(part))
    {
        copy.error_incompatible
    } else if ["checksum", "sha256", "signature"]
        .iter()
        .any(|part| code.contains(part))
    {
        copy.error_damaged
    } else if ["network", "unavailable"]
        .iter()
        .any(|part| code.contains(part))
    {
        copy.error_download
    } else {
        copy.error_generic
    }
}

/// `formatUpdateBytes`: decimal megabytes, one fraction digit below 10.
pub(super) fn format_bytes(bytes: f64, copy: &'static Words) -> String {
    let megabytes = bytes / 1_000_000.;
    let digits = usize::from(megabytes < 10.);
    let text = format!("{megabytes:.digits$}");
    let text = if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.')
    } else {
        &text
    };
    format!("{text}{}", copy.megabyte)
}
