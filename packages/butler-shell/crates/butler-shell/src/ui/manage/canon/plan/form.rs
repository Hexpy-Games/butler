//! `PlanFormDialog.tsx`: a plan's title, description and due date, to create or to edit.
use butler_ds::ui::blocks::dialog_form::DialogForm;
use butler_ds::ui::context::Ds;
use butler_ds::ui::dialog::{Dialog, DialogContent, Size as DialogSize};
use butler_ds::ui::field::{Field, FieldLabel};
use butler_ds::ui::text::Input;
use butler_shell_client::Error;
use gpui::AppContext as _;
use gpui::{App, Context, Entity, IntoElement, ParentElement as _, Render, SharedString, Window};
use gpui_elements::editable_text::{EditableTextState, StringStorage, TextChanged};
use serde_json::json;
use std::rc::Rc;

use super::copy::words;
use super::feedback::write_failure;
use crate::ui::manage::canon::common::{form_fields, form_footer_submit};
use crate::ui::manage::{Action, Pick};
use crate::ui::source::fetch::fetch;
use crate::ui::source::wire::{CanonPlan, PlanDetail};

/// `PlanFormDialog`: `plan` edits it, `None` creates one (and tells `on_created` its id).
pub(crate) struct PlanFormDialog {
    project: SharedString,
    plan: Option<CanonPlan>,
    on_close: Action,
    on_refresh: Action,
    on_created: Option<Pick<SharedString>>,
    title: Entity<EditableTextState>,
    description: Entity<EditableTextState>,
    due: String,
    busy: bool,
}

/// An empty due date clears it; otherwise it is `YYYY-MM-DD`, the value of `type="date"`.
fn valid_due(due: &str) -> bool {
    let parts: Vec<&str> = due.split('-').collect();
    let digits =
        |part: &str, len: usize| part.len() == len && part.bytes().all(|b| b.is_ascii_digit());
    due.is_empty()
        || matches!(parts.as_slice(), [year, month, day]
            if digits(year, 4) && digits(month, 2) && digits(day, 2)
                && matches!(month.parse::<u32>(), Ok(1..=12))
                && matches!(day.parse::<u32>(), Ok(1..=31)))
}

impl PlanFormDialog {
    pub(crate) fn new(
        project: SharedString,
        plan: Option<CanonPlan>,
        on_close: Action,
        on_refresh: Action,
        on_created: Option<Pick<SharedString>>,
        cx: &mut Context<Self>,
    ) -> Self {
        let text = |value: &str, cx: &mut Context<Self>| {
            let state = cx.new(|cx| EditableTextState::new(StringStorage::from(value), cx));
            cx.subscribe(&state, |_, _, _: &TextChanged, cx| cx.notify())
                .detach();
            state
        };
        let title = text(plan.as_ref().map_or("", |plan| &plan.title), cx);
        let description = text(plan.as_ref().map_or("", |plan| &plan.description), cx);
        let due = plan
            .as_ref()
            .and_then(|plan| plan.due_on.clone())
            .unwrap_or_default();
        Self {
            project,
            plan,
            on_close,
            on_refresh,
            on_created,
            title,
            description,
            due,
            busy: false,
        }
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let title = self.title.read(cx).as_str().trim().to_owned();
        if title.is_empty() || self.busy || !valid_due(&self.due) {
            return;
        }
        let mut body = json!({
            "title": title,
            "description": self.description.read(cx).as_str(),
            "due_on": (!self.due.is_empty()).then_some(self.due.as_str()),
        });
        let plan = self.plan.as_ref().map(|plan| plan.id.clone());
        if let (Some(plan), Some(fields)) = (&self.plan, body.as_object_mut()) {
            fields.insert("expected_revision".into(), json!(plan.revision));
        }
        let project = self.project.to_string();
        let handle = window.window_handle();
        self.busy = true;
        cx.notify();
        fetch(
            cx,
            move |client| async move {
                match plan {
                    Some(id) => client.edit_canon_plan(&id, &body).await,
                    None => client.create_canon_plan(&project, &body).await,
                }
            },
            move |this: &mut Self, result: Result<PlanDetail, Error>, cx| {
                this.busy = false;
                let (refresh, close) = (this.on_refresh.clone(), this.on_close.clone());
                let created = this.on_created.clone().zip(
                    result
                        .as_ref()
                        .ok()
                        .filter(|_| this.plan.is_none())
                        .map(|detail| SharedString::from(detail.cards.plan.id.clone())),
                );
                let conflict = match &result {
                    Ok(_) => false,
                    // A conflict reloads the board and closes the dialog (`apiErrorCode`).
                    Err(error) => write_failure(error, cx),
                };
                let done = result.is_ok();
                let _ = handle.update(cx, move |_, window, cx| {
                    if done || conflict {
                        refresh(window, cx);
                    }
                    if let Some((on_created, id)) = created {
                        on_created(id, window, cx);
                    }
                    if done || conflict {
                        close(window, cx);
                    }
                });
            },
        );
    }
}

impl Render for PlanFormDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let busy = self.busy;
        let close = self.on_close.clone();
        let editing = self.plan.is_some();
        let (submit, due) = (cx.entity(), cx.entity());
        let on_submit: Action = Rc::new(move |window: &mut Window, cx: &mut App| {
            submit.update(cx, |this, cx| this.submit(window, cx));
        });
        let footer = form_footer_submit(
            self.title.read(cx).as_str(),
            busy,
            if editing { copy.save } else { copy.create }.into(),
            close.clone(),
            on_submit,
            cx,
        );
        // CARVE-OUT(G-ds): React's due date is a native `type="date"` input; the DS has no date
        // control, so it is a text field that takes `YYYY-MM-DD`.
        let mut input = Input::new("canon-plan-due")
            .default_value(self.due.clone())
            .placeholder("YYYY-MM-DD")
            .on_change(move |value: &str, _: &mut Window, cx: &mut App| {
                let value = value.to_owned();
                due.update(cx, |this, cx| {
                    this.due = value;
                    cx.notify();
                });
            });
        if self.busy {
            input = input.disabled();
        }
        if !valid_due(&self.due) {
            input = input.invalid();
        }
        let fields = form_fields(
            "canon-plan",
            &self.title,
            &self.description,
            None,
            window,
            cx,
        );
        let due_field = Field::new("canon-plan-due-field")
            .child(FieldLabel::new().child(format!("{} · {}", copy.due_on, copy.optional)))
            .child(input);
        let heading = if editing { copy.edit } else { copy.new_plan };
        let form = DialogForm::new(heading)
            .footer(footer)
            .child(fields)
            .child(due_field);
        Dialog::new("canon-plan-dialog", window, cx)
            .open(true)
            .on_open_change(move |open, window, cx| {
                if !open && !busy {
                    close(window, cx);
                }
            })
            .content(
                DialogContent::new().size(DialogSize::Md).child(form),
                window,
                cx,
            )
    }
}
