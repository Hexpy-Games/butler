//! Canon sidebar forms. Tag, file and date controls await their DS controls.
use super::super::dialogs::SpaceDialog;
use crate::ui::{
    shell::Shell,
    source::{sidebar::Mutation, wire::CanonPlan},
};
use butler_ds::ui::{
    button::Button,
    dialog::{DialogContent, DialogHeader, DialogTitle},
    field::{Field, FieldLabel},
    native_select::NativeSelect,
    text::{Input, Textarea},
    tooltip::Tooltip,
};
use gpui::{AnyElement, Context, SharedString, Window, div, prelude::*};

pub(crate) enum CanonFormRequest {
    Create {
        project: String,
        plan: Option<String>,
    },
    Edit(String),
}
#[derive(Clone)]
pub(crate) struct CanonFormState {
    project: String,
    editing: Option<CanonPlan>,
    plans: Vec<CanonPlan>,
    selected_plan: Option<String>,
    assignee: Option<String>,
}
impl Shell {
    pub(in crate::ui::sidebar) fn start_canon_form(
        &mut self,
        request: CanonFormRequest,
        cx: &mut Context<Self>,
    ) {
        let Some(source) = self.source.clone() else {
            return;
        };
        self.sidebar.dialog_serial += 1;
        let serial = self.sidebar.dialog_serial;
        let client = source.clone();
        let fetch = Box::pin(async move {
            match request {
                CanonFormRequest::Create { project, plan } => {
                    let overview = client.canon_overview(&project).await?;
                    Ok(CanonFormState {
                        project,
                        editing: None,
                        plans: overview.plans.into_iter().map(|cards| cards.plan).collect(),
                        selected_plan: plan,
                        assignee: Some("app-user".to_owned()),
                    })
                }
                CanonFormRequest::Edit(id) => {
                    let plan = client.canon_plan(&id).await?;
                    Ok(CanonFormState {
                        project: plan.project_id.clone(),
                        editing: Some(plan),
                        plans: Vec::new(),
                        selected_plan: None,
                        assignee: None,
                    })
                }
            }
        });
        Self::run(fetch, cx, move |s, result, cx| {
            if s.sidebar.dialog_serial != serial
                || s.source
                    .as_ref()
                    .is_none_or(|current| !std::rc::Rc::ptr_eq(current, &source))
            {
                return;
            }
            match result {
                Ok(form) => {
                    s.sidebar.canon_form = Some(form);
                    s.sidebar.set_dialog(Some(SpaceDialog::Canon));
                }
                Err(error) => s.failed(&error, s.theme.strings.load_failed, cx),
            }
            cx.notify();
        });
    }
    pub(in crate::ui::sidebar) fn canon_form_dialog(
        &self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> DialogContent {
        let Some(form) = self.sidebar.canon_form.clone() else {
            return DialogContent::new();
        };
        let editing = form.editing.as_ref();
        let title = if editing.is_some() {
            self.copy("Edit plan", "계획 수정")
        } else {
            self.copy("New epic", "새 과제")
        };
        let mut content = DialogContent::new()
            .header(DialogHeader::new().child(DialogTitle::new(title)))
            .children(self.canon_form_fields(editing, cx));
        if editing.is_none() {
            content = content.child(self.canon_create_options(&form, cx));
            for (id, label) in [
                ("canon-tags", self.copy("Tags", "태그")),
                ("canon-attach", self.copy("Attach file", "파일 첨부")),
            ] {
                content = content.child(
                    Tooltip::new(id)
                        .label(self.theme.strings.not_yet)
                        .child(Button::new(id).text(label).disabled()),
                );
            }
        }
        let weak = cx.entity().downgrade();
        let save = Button::new("canon-form-save")
            .text(if editing.is_some() {
                self.copy("Save", "저장")
            } else {
                self.copy("Create", "만들기")
            })
            .when(
                self.sidebar.pending
                    || self
                        .sidebar_field_value(&self.canon_input("title"), cx)
                        .trim()
                        .is_empty(),
                Button::disabled,
            )
            .on_click(move |_, _, cx| {
                let _ = weak.update(cx, crate::ui::shell::Shell::submit_canon_form);
            });
        content.footer(self.space_dialog_footer(save, cx))
    }
    fn canon_form_fields(
        &self,
        editing: Option<&CanonPlan>,
        cx: &Context<Self>,
    ) -> Vec<AnyElement> {
        let title = Input::new(self.canon_input("title"))
            .default_value(editing.map_or(String::new(), |p| p.title.clone()))
            .when(self.sidebar.pending, Input::disabled);
        let description = Textarea::new(self.canon_input("description"))
            .default_value(editing.map_or(String::new(), |p| p.description.clone()))
            .when(self.sidebar.pending, Textarea::disabled);
        let mut fields = vec![
            Field::new("canon-title-field")
                .child(FieldLabel::new().child(self.copy("Title", "제목")))
                .child(
                    div()
                        .id("canon-title-input")
                        .capture_key_down(cx.listener(|s, event: &gpui::KeyDownEvent, _, cx| {
                            if event.keystroke.key == "enter" {
                                cx.stop_propagation();
                                s.submit_canon_form(cx);
                            }
                        }))
                        .child(self.bind_sidebar_field(self.canon_input("title"), title, cx)),
                )
                .into_any_element(),
            Field::new("canon-description-field")
                .child(FieldLabel::new().child(self.copy("Description", "설명")))
                .child(self.bind_sidebar_field(self.canon_input("description"), description, cx))
                .into_any_element(),
        ];
        if let Some(plan) = editing {
            let due = Input::new(self.canon_input("due"))
                .default_value(plan.due_on.clone().unwrap_or_default())
                .placeholder("YYYY-MM-DD")
                .disabled();
            fields.push(
                Field::new("canon-due-field")
                    .child(FieldLabel::new().child(self.copy("Due date", "완료 예정일")))
                    .child(
                        Tooltip::new("canon-due-tip")
                            .label(self.theme.strings.not_yet)
                            .child(due),
                    )
                    .into_any_element(),
            );
        }
        fields
    }
    fn canon_input(&self, field: &str) -> SharedString {
        format!("canon-{field}-{}", self.sidebar.dialog_serial).into()
    }
    fn canon_create_options(&self, form: &CanonFormState, cx: &Context<Self>) -> AnyElement {
        let weak = cx.entity().downgrade();
        let mut plans = NativeSelect::new(self.canon_input("plan"))
            .stretch()
            .value(
                form.selected_plan
                    .clone()
                    .unwrap_or_else(|| "backlog".to_owned()),
            )
            .option("backlog", self.copy("Backlog", "백로그"))
            .on_change(move |value, _, cx| {
                let _ = weak.update(cx, |s, cx| {
                    if let Some(form) = &mut s.sidebar.canon_form {
                        form.selected_plan = (value != "backlog").then(|| value.to_owned());
                    }
                    cx.notify();
                });
            });
        for plan in &form.plans {
            if plan.status == "open" || form.selected_plan.as_ref() == Some(&plan.id) {
                plans = plans.option(plan.id.clone(), plan.title.clone());
            }
        }
        plans = plans.when(self.sidebar.pending, NativeSelect::disabled);
        let weak = cx.entity().downgrade();
        let people = NativeSelect::new(self.canon_input("assignee"))
            .stretch()
            .value(form.assignee.clone().unwrap_or_default())
            .when(self.sidebar.pending, NativeSelect::disabled)
            .option("", self.copy("None", "없음"))
            .option("app-user", self.copy("Me", "나"))
            .on_change(move |value, _, cx| {
                let _ = weak.update(cx, |s, cx| {
                    if let Some(form) = &mut s.sidebar.canon_form {
                        form.assignee = (!value.is_empty()).then(|| value.to_owned());
                    }
                    cx.notify();
                });
            });
        div()
            .flex()
            .flex_col()
            .child(
                Field::new("canon-plan-field")
                    .child(FieldLabel::new().child(self.copy("Plan", "계획")))
                    .child(plans),
            )
            .child(
                Field::new("canon-assignee-field")
                    .child(FieldLabel::new().child(self.copy("Assignee", "담당자")))
                    .child(people),
            )
            .into_any_element()
    }
    fn submit_canon_form(&mut self, cx: &mut Context<Self>) {
        if self.sidebar.pending {
            return;
        }
        let Some(form) = self.sidebar.canon_form.clone() else {
            return;
        };
        let title = self
            .sidebar_field_value(&self.canon_input("title"), cx)
            .trim()
            .to_owned();
        if title.is_empty() {
            return;
        }
        let description = self.sidebar_field_value(&self.canon_input("description"), cx);
        let mutation = if let Some(plan) = form.editing {
            Mutation::CanonPlanEdit(
                plan.id,
                serde_json::json!({"title":title,"description":description,"due_on":plan.due_on,"expected_revision":plan.revision}),
            )
        } else {
            Mutation::CanonCreate(
                form.project,
                serde_json::json!({"title":title,"description":description,"plan_id":form.selected_plan,"assignee":form.assignee,"tags":[]}),
            )
        };
        self.mutate(mutation, cx);
    }
}
