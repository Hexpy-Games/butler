//! `EpicCreateDialog.tsx`: a new epic's title, description, tags, plan and assignee.
use gpui::AppContext as _;
use std::rc::Rc;

use butler_ds::ui::blocks::dialog_form::DialogForm;
use butler_ds::ui::context::Ds;
use butler_ds::ui::dialog::{Dialog, DialogContent, Size as DialogSize};
use butler_ds::ui::field::{Field, FieldLabel};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::Error;
use gpui::{
    AnyElement, App, Context, Entity, IntoElement, ParentElement as _, Render, SharedString,
    Styled as _, Window, div,
};
use gpui_elements::editable_text::{EditableTextState, StringStorage, TextChanged};
use serde_json::json;

use super::copy::{Words, words};
use super::feedback::write_failure;
use crate::ui::manage::canon::common::{
    LOCAL_PERSON_ID, OnSelect, OnTags, SelectOpts, TagsField, form_fields, form_footer_submit,
    person_select, plan_select,
};
use crate::ui::manage::{Action, ManageCtx, Pick};
use crate::ui::source::fetch::fetch;
use crate::ui::source::wire::{CanonPlan, EpicDetail};

/// `EpicCreateDialog`: callers mount it on open and choose what follows a creation.
pub(crate) struct EpicCreateDialog {
    project: SharedString,
    plans: Vec<CanonPlan>,
    on_close: Action,
    on_created: Pick<EpicDetail>,
    title: Entity<EditableTextState>,
    description: Entity<EditableTextState>,
    tags: Vec<SharedString>,
    tags_field: Entity<TagsField>,
    plan: Option<SharedString>,
    assignee: Option<SharedString>,
    busy: bool,
}

impl EpicCreateDialog {
    #[expect(clippy::too_many_arguments, reason = "EpicCreateDialog's props")]
    pub(crate) fn new(
        ctx: &ManageCtx,
        project: SharedString,
        plans: Vec<CanonPlan>,
        default_plan: Option<SharedString>,
        on_close: Action,
        on_created: Pick<EpicDetail>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let text = |cx: &mut Context<Self>| {
            let state = cx.new(|cx| EditableTextState::new(StringStorage::default(), cx));
            cx.subscribe(&state, |_, _, _: &TextChanged, cx| cx.notify())
                .detach();
            state
        };
        let (title, description) = (text(cx), text(cx));
        let page = cx.weak_entity();
        let on_tags: OnTags = Rc::new(
            move |tags: Vec<SharedString>, _: &mut Window, cx: &mut App| {
                let _ = page.update(cx, |this, cx| {
                    this.tags = tags;
                    cx.notify();
                });
            },
        );
        let tags_field = cx.new(|cx| {
            TagsField::new(
                ctx,
                project.clone(),
                Vec::new(),
                on_tags,
                false,
                false,
                window,
                cx,
            )
        });
        Self {
            project,
            plans,
            on_close,
            on_created,
            title,
            description,
            tags: Vec::new(),
            tags_field,
            plan: default_plan,
            assignee: Some(LOCAL_PERSON_ID.into()),
            busy: false,
        }
    }

    /// `busy` locks the dialog's fields, the tags field included.
    fn set_busy(&mut self, busy: bool, cx: &mut Context<Self>) {
        self.busy = busy;
        self.tags_field
            .update(cx, |field, cx| field.set_disabled(busy, cx));
        cx.notify();
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let title = self.title.read(cx).as_str().trim().to_owned();
        if title.is_empty() || self.busy {
            return;
        }
        let body = json!({
            "title": title,
            "description": self.description.read(cx).as_str(),
            "plan_id": self.plan.as_ref().map(ToString::to_string),
            "assignee": self.assignee.as_ref().map(ToString::to_string),
            "tags": self.tags.iter().map(ToString::to_string).collect::<Vec<_>>(),
        });
        let project = self.project.to_string();
        let handle = window.window_handle();
        self.set_busy(true, cx);
        fetch(
            cx,
            move |client| async move { client.create_canon_epic(&project, &body).await },
            move |this: &mut Self, result: Result<EpicDetail, Error>, cx| {
                this.set_busy(false, cx);
                match result {
                    Ok(epic) => {
                        let copy = words(Ds::get(cx).lang());
                        toast::show(cx, Toast::message(copy.created));
                        let (created, close) = (this.on_created.clone(), this.on_close.clone());
                        let _ = handle.update(cx, move |_, window, cx| {
                            created(epic, window, cx);
                            close(window, cx);
                        });
                    }
                    Err(error) => {
                        write_failure(&error, cx);
                    }
                }
            },
        );
    }

    fn selects(&self, copy: &Words, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let opts = SelectOpts {
            disabled: self.busy,
            stretch: true,
            ..SelectOpts::default()
        };
        let (plan_to, person_to) = (cx.weak_entity(), cx.weak_entity());
        let on_plan: OnSelect = Rc::new(
            move |value: Option<SharedString>, _: &mut Window, cx: &mut App| {
                let _ = plan_to.update(cx, |this, cx| {
                    this.plan = value;
                    cx.notify();
                });
            },
        );
        let on_person: OnSelect = Rc::new(
            move |value: Option<SharedString>, _: &mut Window, cx: &mut App| {
                let _ = person_to.update(cx, |this, cx| {
                    this.assignee = value;
                    cx.notify();
                });
            },
        );
        let plan = Field::new("canon-create-plan-field")
            .child(FieldLabel::new().child(copy.plan))
            .child(plan_select(
                "canon-create-plan",
                &self.plans,
                self.plan.clone(),
                opts,
                on_plan,
                window,
                cx,
            ));
        let assignee = Field::new("canon-create-assignee-field")
            .child(FieldLabel::new().child(format!("{} · {}", copy.assignee, copy.optional)))
            .child(person_select(
                "canon-create-assignee",
                self.assignee.clone(),
                opts,
                on_person,
                window,
                cx,
            ));
        Stack::row()
            .gap(Space::Md)
            .child(div().flex_1().min_w_0().child(plan))
            .child(div().flex_1().min_w_0().child(assignee))
            .into_any_element()
    }
}

impl Render for EpicCreateDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let busy = self.busy;
        let close = self.on_close.clone();
        // CARVE-OUT(G-seam): React's `useEpicAttachments` (the attach button in the description
        // field) belongs to M10 and has no seam; nothing is attached from this dialog.
        let fields = form_fields(
            "canon-create",
            &self.title,
            &self.description,
            None,
            window,
            cx,
        );
        let submit = cx.entity();
        let on_submit: Action = Rc::new(move |window: &mut Window, cx: &mut App| {
            submit.update(cx, |this, cx| this.submit(window, cx));
        });
        let footer = form_footer_submit(
            self.title.read(cx).as_str(),
            busy,
            copy.create.into(),
            close.clone(),
            on_submit,
            cx,
        );
        let form = DialogForm::new(copy.new_epic)
            .footer(footer)
            .child(fields)
            .child(self.tags_field.clone())
            .child(self.selects(copy, window, cx));
        Dialog::new("canon-create-dialog", window, cx)
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
