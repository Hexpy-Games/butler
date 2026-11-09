//! The form of `stores/automationStore.ts` and `automationForm.ts`: what the detail edits, the
//! body a save sends, the field a refused save names, and the reads the form needs
//! (settings, model catalog, vault).
use gpui::SharedString;
use serde::Deserialize;
use serde_json::{Value, json};

use super::super::types::{AutomationRecord, AutomationRunsPage, CalendarSchedule};
use crate::ui::composer::decode_catalog;
use crate::ui::composer::menus::ModelChoice;
use crate::ui::source::wire::{AccessMode, CalendarScheduleKind, NavigationView, SessionSummary};

/// `DEFAULT_SCHEDULE_ACCESS_MODE`
pub(super) const DEFAULT_ACCESS: AccessMode = AccessMode::Auto;
/// `localSchedule`'s time.
pub(super) const DEFAULT_TIME: &str = "08:00";
/// The intervals the select lists; any other is "custom".
pub(super) const INTERVALS: [i64; 5] = [600, 1800, 3600, 7200, 86400];

/// `CalendarSchedule` as the form edits it.
#[derive(Clone, PartialEq)]
pub(super) struct Slot {
    pub(super) daily: bool,
    pub(super) time: String,
    pub(super) weekdays: Vec<i64>,
    pub(super) tz: String,
}

impl Slot {
    fn from_wire(schedule: &CalendarSchedule) -> Self {
        Self {
            daily: schedule.kind == CalendarScheduleKind::Daily,
            time: schedule.time.clone(),
            weekdays: schedule.weekdays.clone(),
            tz: schedule.tz.clone(),
        }
    }

    /// `schedule.kind`
    pub(super) fn kind(&self) -> &'static str {
        if self.daily { "daily" } else { "weekly" }
    }

    fn wire(&self) -> Value {
        json!({ "kind": self.kind(), "time": self.time, "weekdays": self.weekdays, "tz": self.tz })
    }
}

/// `AccessMode` on the wire.
pub(super) fn wire_mode(mode: &AccessMode) -> &'static str {
    match mode {
        AccessMode::ReadOnly => "read_only",
        AccessMode::AskFirst => "ask_first",
        AccessMode::AskExceptReads => "ask_except_reads",
        AccessMode::FullAccess => "full_access",
        AccessMode::Auto | AccessMode::Unknown => "auto",
    }
}

/// The automation store's fields.
pub(super) struct Form {
    pub(super) title: String,
    pub(super) prompt: String,
    pub(super) target: SharedString,
    pub(super) interval: i64,
    pub(super) slot: Option<Slot>,
    pub(super) kind: String,
    pub(super) run_at: Option<String>,
    pub(super) start_at: Option<String>,
    pub(super) access: AccessMode,
    /// Empty follows the target chat's model.
    pub(super) model: String,
    /// The model as loaded: a save sends `model` only when it changed.
    pub(super) initial_model: String,
    pub(super) state: String,
    pub(super) signin: bool,
    pub(super) payment: bool,
}

impl Form {
    /// `initialize` for a new schedule.
    pub(super) fn blank(target: SharedString) -> Self {
        Self {
            title: String::new(),
            prompt: String::new(),
            target,
            interval: 1800,
            slot: None,
            kind: "interval".to_owned(),
            run_at: None,
            start_at: None,
            access: DEFAULT_ACCESS,
            model: String::new(),
            initial_model: String::new(),
            state: "enabled".to_owned(),
            signin: false,
            payment: false,
        }
    }

    /// `initialize` for a loaded one.
    pub(super) fn from_record(record: AutomationRecord) -> Self {
        let summary = record.summary;
        let model = summary.model.unwrap_or_default();
        Self {
            title: summary.title,
            prompt: record.prompt_body,
            target: record.target_session_id.into(),
            interval: summary.interval_seconds.unwrap_or(1800),
            slot: summary.schedule.as_ref().map(Slot::from_wire),
            kind: summary
                .schedule_type
                .unwrap_or_else(|| "interval".to_owned()),
            run_at: record.run_at,
            start_at: record.start_at,
            access: match summary.access_mode {
                AccessMode::Unknown => DEFAULT_ACCESS,
                mode => mode,
            },
            initial_model: model.clone(),
            model,
            state: summary.state,
            signin: summary.browser_signin == Some(true),
            payment: summary.browser_payment == Some(true),
        }
    }

    /// The body of a create or an update.
    pub(super) fn body(&self) -> Value {
        let mut body = json!({
            "browser_signin": self.signin,
            "browser_payment": self.payment,
            "title": self.title,
            "prompt_body": self.prompt,
            "target_session_id": self.target,
            "interval_seconds": self.interval,
            "access_mode": wire_mode(&self.access),
            "schedule": self.slot.as_ref().map(Slot::wire),
            "schedule_type": self.kind,
        });
        for (key, value) in [("run_at", &self.run_at), ("start_at", &self.start_at)] {
            if let Some(value) = value {
                body[key] = json!(value);
            }
        }
        if self.model != self.initial_model {
            body["model"] = json!(self.model);
        }
        body
    }

    /// `setSchedule`: the frequency's kind follows the schedule.
    pub(super) fn set_slot(&mut self, slot: Option<Slot>) {
        slot.as_ref()
            .map_or("interval", Slot::kind)
            .clone_into(&mut self.kind);
        self.slot = slot;
    }
}

/// `AutomationFormField`
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Field {
    AccessMode,
    Form,
}

/// `AutomationSaveError`: the last save the gateway refused as invalid.
#[derive(Clone, Copy)]
pub(super) struct SaveError {
    pub(super) field: Field,
    pub(super) message: &'static str,
}

/// `withoutFieldError`
pub(super) fn without_field(error: Option<SaveError>, field: Field) -> Option<SaveError> {
    error.filter(|error| error.field != field && error.field != Field::Form)
}

/// `GET /automations/{id}` and `/runs`, read together.
#[derive(Deserialize)]
pub(super) struct Loaded {
    pub(super) detail: super::super::types::AutomationDetailView,
    pub(super) runs: AutomationRunsPage,
}

/// The part of `GET /settings` the form reads.
#[derive(Deserialize, Default)]
pub(super) struct SettingsSlice {
    #[serde(default)]
    pub(super) timezone: Option<String>,
    #[serde(default)]
    pub(super) schedule_access_mode: Option<AccessMode>,
}

/// `scheduleDefaultAccessMode`
pub(super) fn schedule_default(settings: &SettingsSlice) -> AccessMode {
    match &settings.schedule_access_mode {
        Some(AccessMode::Unknown) | None => DEFAULT_ACCESS,
        Some(mode) => mode.clone(),
    }
}

/// `GET /security/vault`: `useVault().view?.available === false`.
#[derive(Deserialize)]
pub(super) struct VaultSlice {
    #[serde(default)]
    pub(super) available: Option<bool>,
}

/// `runtimeModels(modelCatalog)`: the ready registered models when any are registered, else
/// the ready catalog models.
pub(super) fn runtime_models(catalog: &Value) -> Vec<ModelChoice> {
    let Some(catalog) = decode_catalog(catalog) else {
        return Vec::new();
    };
    let models = match catalog.registered_models {
        Some(registered) if !registered.is_empty() => registered,
        _ => catalog.models,
    };
    models
        .into_iter()
        .filter(|model| model.runtime_supported && model.availability.as_deref() == Some("ready"))
        .collect()
}

/// `allSessionsFromNavigation`: chats, then each project's sessions as "project / title".
pub(super) fn session_options(
    navigation: Option<&NavigationView>,
    general: &'static str,
) -> Vec<(SharedString, SharedString)> {
    let title = |session: &SessionSummary| {
        if session.title.is_empty() {
            session.session_hint.clone()
        } else {
            session.title.clone()
        }
    };
    let mut options = Vec::new();
    if let Some(navigation) = navigation {
        for chat in &navigation.chats {
            options.push((chat.id.clone().into(), title(chat).into()));
        }
        for project in &navigation.projects {
            for session in project.sessions.iter().flatten() {
                let label = format!("{} / {}", project.display_name, title(session));
                options.push((session.id.clone().into(), label.into()));
            }
        }
    }
    if options.is_empty() {
        options.push(("general".into(), general.into()));
    }
    options
}
