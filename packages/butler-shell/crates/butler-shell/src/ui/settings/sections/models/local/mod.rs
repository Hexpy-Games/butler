//! Models: a Custom model's settings (`LocalModelSettings.tsx`, rendered with
//! `hideRegisteredList`, so the registered list and its delete belong to the models page):
//! the API information, discovery, and the model's own fields, for a new model or an edit.
//!
//! Not ported: leaving with unsaved edits is not guarded (`useLocalModelUnsavedGuard`'s leave
//! guard and `beforeunload`); the page only shows its unsaved-changes line.
mod copy;
mod form;
mod model;
mod view;

use butler_ds::ui::blocks::settings_section::SettingsSection;
use butler_ds::ui::toast::{self, Toast, ToastId};
use butler_shell_client::Error;
use gpui::{AnyWindowHandle, App, AppContext as _, Context, SharedString, Subscription, Window};
use serde::Deserialize as _;

use crate::ui::settings::state::fetch;
use crate::ui::settings::{Action, SectionCtx};
use copy::get as words;
use form::Form;
use model::{Discovered, Limits, LocalModel, Registered, find_local};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Busy {
    Discover,
    Register,
}

/// `LocalModelSettings`
pub(crate) struct LocalModelSettings {
    ctx: SectionCtx,
    window: AnyWindowHandle,
    on_back: Action,
    /// `initialEditModel` until the catalog has it.
    pending_edit: Option<SharedString>,
    initial: Option<LocalModel>,
    form: Form,
    advanced_open: bool,
    discovery: Option<Vec<LocalModel>>,
    discovery_error: Option<&'static str>,
    busy: Option<Busy>,
    status: String,
    /// The last registration toast, which the next one replaces (`local-model-*`).
    toast: Option<ToastId>,
    _catalog: Subscription,
}

impl LocalModelSettings {
    pub(crate) fn new(
        ctx: SectionCtx,
        initial_edit_model: Option<SharedString>,
        on_back: Action,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let catalog = cx.observe(&ctx.state, |this, _, cx| {
            this.resolve_edit(cx);
            cx.notify();
        });
        let mut page = Self {
            ctx,
            window: window.window_handle(),
            on_back,
            pending_edit: initial_edit_model,
            initial: None,
            form: Form::default(),
            advanced_open: false,
            discovery: None,
            discovery_error: None,
            busy: None,
            status: String::new(),
            toast: None,
            _catalog: catalog,
        };
        page.resolve_edit(cx);
        page
    }

    /// The sections the add/edit page shows for a local provider.
    pub(crate) fn sections(
        &mut self,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<SettingsSection> {
        let this = cx.entity();
        vec![
            view::api_section(self, &this, cx),
            view::info_section(self, &this, cx),
        ]
    }

    /// `useEffect(editModel(initialEditModel))`, once the catalog lists the model.
    fn resolve_edit(&mut self, cx: &App) {
        let Some(model_ref) = self.pending_edit.as_ref() else {
            return;
        };
        let found = self
            .ctx
            .state
            .read(cx)
            .catalog()
            .and_then(|catalog| find_local(catalog, model_ref));
        if let Some(model) = found {
            self.pending_edit = None;
            self.form.edit(&model);
            self.status.clear();
            self.initial = Some(model);
        }
    }

    /// `modelCatalog.response_timeout`
    fn limits(&self, cx: &App) -> Option<Limits> {
        let limits = self.ctx.state.read(cx).catalog()?.get("response_timeout")?;
        Limits::deserialize(limits).ok()
    }

    fn can_discover(&self) -> bool {
        self.form.can_discover(self.busy.is_some())
    }

    fn can_register(&self, cx: &App) -> bool {
        self.form
            .can_register(self.busy.is_some(), self.limits(cx).as_ref())
    }

    /// The discovered model the entry fields came from.
    fn selected_model(&self) -> Option<&LocalModel> {
        let models = self.discovery.as_deref()?;
        models
            .iter()
            .find(|model| model.model_ref == self.form.selected_ref)
    }

    /// `chooseDiscoveredModel`
    fn choose(&mut self, model_ref: &str) {
        model_ref.clone_into(&mut self.form.selected_ref);
        let chosen = self
            .discovery
            .iter()
            .flatten()
            .find(|model| model.model_ref == model_ref)
            .cloned();
        if let Some(model) = chosen {
            self.form.fill(&model);
            self.form.seed_image_input(Some(&model));
        }
    }

    /// Shows `next` in place of the last registration toast.
    fn notify(&mut self, next: Toast, cx: &mut Context<Self>) {
        let next = match self.toast {
            Some(id) => next.id(id),
            None => next,
        };
        self.toast = Some(toast::show(cx, next));
    }

    /// `discover`
    fn discover(&mut self, cx: &mut Context<Self>) {
        if !self.can_discover() {
            return;
        }
        self.discovery_error = None;
        self.busy = Some(Busy::Discover);
        self.status.clear();
        self.discovery = None;
        let body = self.form.discovery_body();
        fetch(
            cx,
            move |client| async move { client.discover_local_models(&body).await },
            |this: &mut Self, result: Result<Discovered, Error>, cx| {
                this.busy = None;
                match result {
                    Ok(found) => this.discovered(found.models, cx),
                    // CARVE-OUT(G-codes): React maps the error code; every failure shows the
                    // discovery fallback.
                    Err(_) => this.discovery_error = Some(words(cx).discover_failed),
                }
            },
        );
    }

    /// The first discovered model fills the entry fields.
    fn discovered(&mut self, models: Vec<LocalModel>, cx: &App) {
        let first = models.first();
        self.form.selected_ref = first
            .map(|model| model.model_ref.clone())
            .unwrap_or_default();
        if let Some(first) = first {
            self.form.fill(first);
        }
        self.form.seed_image_input(first);
        self.status = (words(cx).discovered_status)(models.len());
        self.discovery = Some(models);
    }

    /// `register`: a new model or the edit of one.
    fn register(&mut self, cx: &mut Context<Self>) {
        if !self.can_register(cx) {
            return;
        }
        self.busy = Some(Busy::Register);
        self.status.clear();
        let ratio = self
            .initial
            .as_ref()
            .and_then(|model| model.local_reasoning_budget_ratio);
        let payload = self.form.payload(self.selected_model(), ratio);
        let editing = self.form.is_editing();
        let model_ref = self.form.editing_ref.clone();
        fetch(
            cx,
            move |client| async move {
                if editing {
                    client.update_local_model(&model_ref, &payload).await
                } else {
                    client.register_local_model(&payload).await
                }
            },
            move |this: &mut Self, result: Result<Registered, Error>, cx| {
                this.busy = None;
                match result {
                    Ok(saved) => this.registered(&saved.model, editing, cx),
                    Err(_) => {
                        let failed = words(cx).register_failed;
                        this.notify(Toast::error(failed), cx);
                    }
                }
            },
        );
    }

    /// The catalog changed: read it again, say so, and go back (`onSaved`).
    fn registered(&mut self, model: &LocalModel, editing: bool, cx: &mut Context<Self>) {
        self.ctx.reload_catalog(cx);
        let words = words(cx);
        let say = if editing {
            words.saved_status
        } else {
            words.registered_status
        };
        self.notify(Toast::success(say(model.name())), cx);
        let (handle, back) = (self.window, self.on_back.clone());
        cx.defer(move |cx| {
            let _ = cx.update_window(handle, |_, window, cx| back(window, cx));
        });
    }
}
