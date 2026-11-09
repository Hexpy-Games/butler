//! The actions of `stores/automationStore.ts`: initialize, save, run/pause/resume and remove,
//! with the reads the form needs (settings, model catalog, vault).
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::Error;
use gpui::{App, Context};
use serde_json::{Value, json};

use super::copy::words;
use super::model::{
    Field, Form, Loaded, SaveError, SettingsSlice, VaultSlice, runtime_models, schedule_default,
};
use super::{Action, AutomationDetail};
use crate::ui::manage::schedules::hint_login;
use crate::ui::source::fetch::fetch;

/// What a run, pause or resume asks of the gateway.
#[derive(Clone, Copy)]
pub(super) enum Mutation {
    Run,
    Pause,
    Resume,
}

impl Mutation {
    fn name(self) -> &'static str {
        match self {
            Self::Run => "run",
            Self::Pause => "pause",
            Self::Resume => "resume",
        }
    }
}

fn error_toast(cx: &mut App, text: impl Into<gpui::SharedString>) {
    toast::show(cx, Toast::error(text));
}

fn success_toast(cx: &mut App) {
    let text = words(Ds::get(cx).lang()).saved;
    toast::show(cx, Toast::success(text));
}

impl AutomationDetail {
    /// What the page runs once the owner settles: after the current update ends, on the window.
    pub(super) fn run_action(&self, action: &Action, cx: &mut Context<Self>) {
        let (action, window) = (action.clone(), self.window);
        cx.defer(move |cx| {
            let _ = window.update(cx, |_, window, cx| action(window, cx));
        });
    }

    /// The reads the form shows beside the schedule itself.
    pub(super) fn load_environment(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.get_settings().await },
            |this, result: Result<SettingsSlice, Error>, _| {
                let settings = result.unwrap_or_default();
                if this.is_new {
                    this.form.access = schedule_default(&settings);
                    this.ready = true;
                }
                if let Some(timezone) = settings.timezone {
                    this.timezone = timezone;
                }
            },
        );
        fetch(
            cx,
            |client| async move { client.get_model_catalog().await },
            |this, result: Result<Value, Error>, _| {
                this.models = result
                    .map(|catalog| runtime_models(&catalog))
                    .unwrap_or_default();
            },
        );
        fetch(
            cx,
            |client| async move { client.list_vault().await },
            |this, result: Result<VaultSlice, Error>, _| {
                this.vault_unavailable = result.is_ok_and(|vault| vault.available == Some(false));
            },
        );
    }

    /// `initialize` for a saved schedule.
    pub(super) fn load(&mut self, cx: &mut Context<Self>) {
        let id = self.automation_id.to_string();
        fetch(
            cx,
            move |client| async move {
                let detail = client.get_automation(&id).await?;
                let runs = client.list_automation_runs(&id).await?;
                Ok(json!({ "detail": detail, "runs": runs }))
            },
            |this, result: Result<Loaded, Error>, cx| {
                match result {
                    Ok(loaded) => {
                        this.form = Form::from_record(loaded.detail.automation);
                        this.runs = loaded.runs.runs;
                        this.error = None;
                    }
                    Err(_) => {
                        let text = words(Ds::get(cx).lang()).detail_failed;
                        error_toast(cx, text);
                    }
                }
                this.ready = true;
            },
        );
    }

    /// `save`: create when new, else update; then `onSaved`.
    pub(super) fn save(&mut self, cx: &mut Context<Self>) {
        if self.saving {
            return;
        }
        self.saving = true;
        self.error = None;
        cx.notify();
        let (body, id, is_new) = (
            self.form.body(),
            self.automation_id.to_string(),
            self.is_new,
        );
        fetch(
            cx,
            move |client| async move {
                if is_new {
                    client.create_automation(&body).await
                } else {
                    client.update_automation(&id, &body).await
                }
            },
            |this, result: Result<Value, Error>, cx| {
                this.saving = false;
                let words = words(Ds::get(cx).lang());
                match result {
                    Ok(_) => {
                        let on_saved = this.on_saved.clone();
                        this.run_action(&on_saved, cx);
                        if this.is_new {
                            hint_login(cx);
                        } else {
                            this.load(cx);
                        }
                        success_toast(cx);
                    }
                    // G-codes: the client returns no error code, so only a 400 names the form.
                    Err(Error::Http(400)) => {
                        this.error = Some(SaveError {
                            field: Field::Form,
                            message: words.error_invalid,
                        });
                    }
                    Err(_) => error_toast(cx, words.save_failed),
                }
            },
        );
    }

    /// `mutate`: run, pause or resume, then `onSaved` and a fresh read.
    pub(super) fn mutate(&mut self, mutation: Mutation, cx: &mut Context<Self>) {
        if self.is_new {
            return;
        }
        let id = self.automation_id.to_string();
        fetch(
            cx,
            move |client| async move {
                match mutation {
                    Mutation::Run => client.run_automation(&id).await,
                    Mutation::Pause => client.pause_automation(&id).await,
                    Mutation::Resume => client.resume_automation(&id).await,
                }
            },
            move |this, result: Result<Value, Error>, cx| match result {
                Ok(_) => {
                    let on_saved = this.on_saved.clone();
                    this.run_action(&on_saved, cx);
                    this.load(cx);
                    success_toast(cx);
                }
                Err(_) => {
                    let text = (words(Ds::get(cx).lang()).action_failed)(mutation.name());
                    error_toast(cx, text);
                }
            },
        );
    }

    /// `remove`, after the owner confirmed: delete, `onSaved`, then back to the list.
    pub(super) fn remove(&mut self, cx: &mut Context<Self>) {
        let id = self.automation_id.to_string();
        fetch(
            cx,
            move |client| async move { client.delete_automation(&id).await },
            |this, result: Result<Value, Error>, cx| match result {
                Ok(_) => {
                    for action in [this.on_saved.clone(), this.on_back.clone()] {
                        this.run_action(&action, cx);
                    }
                }
                Err(_) => {
                    let text = words(Ds::get(cx).lang()).delete_failed;
                    error_toast(cx, text);
                }
            },
        );
    }
}
