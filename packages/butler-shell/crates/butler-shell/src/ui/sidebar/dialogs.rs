//! SpaceDialogs and forms, using the DS Dialog and Field/Input.
use super::{
    Shell,
    drag::{Position, can_drop},
};
use crate::ui::source::{
    sidebar::{Mutation, ProjectCommand, SessionCommand, SpaceCommand},
    wire::SpaceNodeKind,
};
use butler_ds::ui::{
    blocks::nav_row::NavRow,
    button::{Button, Variant},
    dialog::{Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle},
    field::{Field, FieldLabel},
    scroll::ScrollArea,
    text::{self, Input},
    typo::Typo,
};
use gpui::{AnyElement, App, Context, SharedString, WeakEntity, Window, div, prelude::*};

/// Bind a DS editor while it renders; keyed-state lookup is invalid in input callbacks.
#[derive(IntoElement)]
pub(super) struct FormField<F: RenderOnce + 'static> {
    id: SharedString,
    control: F,
    shell: WeakEntity<Shell>,
    serial: u64,
}
impl<F: RenderOnce + 'static> RenderOnce for FormField<F> {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let element = self.control.render(window, cx).into_any_element();
        let editor = text::state(self.id.clone(), window, cx);
        cx.defer(move |cx| {
            let _ = self.shell.update(cx, |s, cx| {
                if s.sidebar.dialog_serial != self.serial
                    || s.sidebar
                        .fields
                        .get(&self.id)
                        .is_some_and(|(old, _)| old == &editor)
                {
                    return;
                }
                let subscription = cx.observe(&editor, |_, _, cx| cx.notify());
                s.sidebar.fields.insert(self.id, (editor, subscription));
                cx.notify();
            });
        });
        element
    }
}
#[derive(Clone)]
pub(super) enum SpaceDialog {
    Create(Option<String>),
    Group(String, String),
    Rename(String, String),
    Move(String),
    Favorites,
    Relocate {
        source: String,
        target: Option<String>,
        position: String,
        operation: String,
    },
    CreateProject,
    Clear,
    Canon,
    Delete(String),
}
impl Shell {
    pub(super) fn bind_sidebar_field<F: RenderOnce + 'static>(
        &self,
        id: SharedString,
        control: F,
        cx: &Context<Self>,
    ) -> FormField<F> {
        FormField {
            id,
            control,
            shell: cx.entity().downgrade(),
            serial: self.sidebar.dialog_serial,
        }
    }
    pub(in crate::ui::sidebar) fn sidebar_field_value(
        &self,
        id: &SharedString,
        cx: &App,
    ) -> String {
        self.sidebar
            .fields
            .get(id)
            .map_or_else(String::new, |(state, _)| state.read(cx).as_str().to_owned())
    }
    pub(crate) fn space_dialogs(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let weak = cx.entity().downgrade();
        let dialog = Dialog::new("space-dialog", window, cx)
            .open(self.sidebar.dialog.is_some())
            .on_open_change(move |open, _, cx| {
                if !open {
                    let _ = weak.update(cx, |s, cx| {
                        if !s.sidebar.pending {
                            s.sidebar.set_dialog(None);
                            cx.notify();
                        }
                    });
                }
            });
        let Some(form) = self.sidebar.dialog.clone() else {
            return dialog.content(DialogContent::new(), window, cx);
        };
        if matches!(form, SpaceDialog::Clear)
            && !self.sidebar.general_ready
            && !self.sidebar.general_loading
        {
            self.load_general_menu(cx);
        }
        let content = match &form {
            SpaceDialog::Move(source) => self.space_move_form(source, window, cx),
            SpaceDialog::Favorites => self.favorites_form(cx),
            SpaceDialog::CreateProject => self.project_create_dialog(window, cx),
            SpaceDialog::Canon => self.canon_form_dialog(window, cx),
            SpaceDialog::Clear => self.clear_general_dialog(cx),
            SpaceDialog::Relocate { .. } => self.space_relocation_form(&form, cx),
            SpaceDialog::Rename(key, _)
                if self
                    .store
                    .navigation
                    .rows
                    .get(key)
                    .is_some_and(|row| row.project.is_some()) =>
            {
                self.project_rename_dialog(&form, cx)
            }
            SpaceDialog::Rename(key, _)
                if self
                    .store
                    .navigation
                    .rows
                    .get(key)
                    .is_some_and(|row| row.session.is_some()) =>
            {
                self.session_rename_dialog(&form, cx)
            }
            _ => self.space_group_form(&form, cx),
        };
        dialog.content(content, window, cx)
    }
    pub(super) fn favorites_form(&mut self, cx: &mut Context<Self>) -> DialogContent {
        let rows: Vec<_> = self
            .store
            .navigation
            .rows()
            .into_iter()
            .filter(|r| r.pinned)
            .collect();
        let mut list = div().flex().flex_col();
        for row in &rows {
            list = list.child(self.space_row(row, false, true, "favorites-dialog", cx));
        }
        DialogContent::new()
            .header(DialogHeader::new().child(DialogTitle::new(self.theme.strings.favorites)))
            .child(ScrollArea::new("favorites-scroll").child(list))
    }
    fn space_group_form(&self, form: &SpaceDialog, cx: &mut Context<Self>) -> DialogContent {
        self.space_edit_form(form, cx)
    }
    fn space_relocation_form(&self, form: &SpaceDialog, cx: &mut Context<Self>) -> DialogContent {
        let SpaceDialog::Relocate { source, target, .. } = form else {
            return DialogContent::new();
        };
        let rows = &self.store.navigation.rows;
        let source = rows.get(source).map_or("", |row| row.title.as_str());
        let target = target
            .as_ref()
            .and_then(|key| rows.get(key))
            .map_or(self.copy("Top level", "최상위"), |row| {
                row.title.as_str()
            });
        let description = if self.theme.strings.locale == crate::ui::i18n::Locale::En {
            format!(
                "Move {source} to {target}. Conversation history and existing files are preserved. Future work will use the new workspace and project knowledge. Active work must finish before moving."
            )
        } else {
            format!(
                "{source} 대화를 {target}(으)로 이동합니다. 대화 기록과 기존 파일은 보존되며, 이후 작업은 새 소속의 작업 폴더와 프로젝트 지식을 사용합니다. 진행 중인 작업이 있으면 완료한 뒤 이동할 수 있습니다."
            )
        };
        self.space_edit_form(form, cx)
            .child(DialogDescription::new(description))
    }
    pub(super) fn space_edit_form(
        &self,
        form: &SpaceDialog,
        cx: &mut Context<Self>,
    ) -> DialogContent {
        let mut content = DialogContent::new().header(self.space_form_header(form));
        if matches!(
            form,
            SpaceDialog::Create(_) | SpaceDialog::Group(_, _) | SpaceDialog::Rename(_, _)
        ) {
            let initial = match form {
                SpaceDialog::Rename(_, title) => title.clone(),
                _ => String::new(),
            };
            content = content.child(self.space_form_input(form, initial, cx));
        }

        if let SpaceDialog::Delete(key) = form
            && let Some(row) = self.store.navigation.rows.get(key)
        {
            content = content.child(DialogDescription::new(format!(
                "{}: {}",
                self.copy("Permanently delete", "완전히 삭제"),
                row.title
            )));
        }
        if let Some(error) = &self.sidebar.error {
            content = content.child(Typo::body(error.clone()));
        }
        let input = self.sidebar_input();
        let form = form.clone();
        let weak = cx.entity().downgrade();
        let pending = self.sidebar.pending;
        let can_submit =
            self.space_form_can_submit(&form, self.sidebar_field_value(&input, cx).trim());
        let destructive = matches!(form, SpaceDialog::Delete(_));
        let label = match form {
            SpaceDialog::Delete(_) => self.copy("Delete", "삭제"),
            SpaceDialog::Relocate { .. } => self.copy("Move", "이동"),
            _ => self.copy("Save", "저장"),
        };
        let save = Button::new("space-save")
            .text(label)
            .when(destructive, |b| b.variant(Variant::Destructive))
            .when(pending || !can_submit, Button::disabled)
            .on_click(move |_, _, cx| {
                let _ = weak.update(cx, |s, cx| {
                    let value = s.sidebar_field_value(&input, cx).trim().to_owned();
                    s.submit_space_dialog(form.clone(), value, cx);
                });
            });
        content.footer(self.space_dialog_footer(save, cx))
    }
    fn space_form_labels(&self, form: &SpaceDialog) -> (&'static str, &'static str) {
        match form {
            SpaceDialog::Rename(key, _) => {
                match self.store.navigation.rows.get(key).map(|r| &r.node.kind) {
                    Some(SpaceNodeKind::Project) => (
                        self.copy("Rename project", "프로젝트 이름 바꾸기"),
                        self.copy("Project name", "프로젝트 이름"),
                    ),
                    Some(SpaceNodeKind::Session) => (
                        self.copy("Rename session", "세션 이름 바꾸기"),
                        self.copy("Session name", "세션 이름"),
                    ),
                    _ => (
                        self.copy("Rename group", "그룹 이름 변경"),
                        self.copy("Group name", "그룹 이름"),
                    ),
                }
            }
            SpaceDialog::Relocate { .. } => (
                self.copy(
                    "Change this conversation's workspace?",
                    "대화의 작업 위치를 변경할까요?",
                ),
                "",
            ),
            SpaceDialog::Delete(_) => (self.copy("Delete", "삭제"), ""),
            _ => (
                self.copy("Create group", "그룹 만들기"),
                self.copy("Group name", "그룹 이름"),
            ),
        }
    }
    fn space_form_header(&self, form: &SpaceDialog) -> DialogHeader {
        let title = self.space_form_labels(form).0;
        let group = match form {
            SpaceDialog::Create(_) | SpaceDialog::Group(_, _) => true,
            SpaceDialog::Rename(key, _) => self
                .store
                .navigation
                .rows
                .get(key)
                .is_some_and(|r| r.node.kind == SpaceNodeKind::Group),
            _ => false,
        };
        let header = DialogHeader::new().child(DialogTitle::new(title));
        if group {
            header.child(DialogDescription::new(self.copy(
                "Organize conversations and projects under a name you choose.",
                "대화와 프로젝트를 원하는 이름으로 정리합니다.",
            )))
        } else {
            header
        }
    }
    fn space_form_can_submit(&self, form: &SpaceDialog, value: &str) -> bool {
        match form {
            SpaceDialog::Create(_) | SpaceDialog::Group(_, _) => !value.is_empty(),
            SpaceDialog::Rename(key, original) => {
                !value.is_empty()
                    && (value != original
                        || self
                            .store
                            .navigation
                            .rows
                            .get(key)
                            .is_some_and(|r| r.node.kind == SpaceNodeKind::Group))
            }
            _ => true,
        }
    }
    fn space_form_input(
        &self,
        form: &SpaceDialog,
        initial: String,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let input = self.sidebar_input();
        let label = self.space_form_labels(form).1;
        let form = form.clone();
        let wrapper = crate::ui::widgets::anchor(div(), "sidebar-dialog-input")
            .id("space-form-input")
            .capture_key_down(cx.listener(move |s, event: &gpui::KeyDownEvent, _, cx| {
                if event.keystroke.key == "enter" {
                    cx.stop_propagation();
                    let value = s.sidebar_field_value(&input, cx).trim().to_owned();
                    s.submit_space_dialog(form.clone(), value, cx);
                }
            }))
            .child(
                self.bind_sidebar_field(
                    self.sidebar_input(),
                    Input::new(self.sidebar_input())
                        .default_value(initial)
                        .when(self.sidebar.pending, Input::disabled),
                    cx,
                ),
            );
        Field::new("space-title-field")
            .child(FieldLabel::new().child(label))
            .child(wrapper)
            .into_any_element()
    }
    pub(super) fn space_dialog_footer(&self, save: Button, cx: &Context<Self>) -> DialogFooter {
        let weak = cx.entity().downgrade();
        DialogFooter::new()
            .child(
                Button::new("space-cancel")
                    .text(self.theme.strings.cancel)
                    .variant(Variant::Ghost)
                    .when(self.sidebar.pending, Button::disabled)
                    .on_click(move |_, _, cx| {
                        let _ = weak.update(cx, |s, cx| {
                            if !s.sidebar.pending {
                                s.sidebar.set_dialog(None);
                                cx.notify();
                            }
                        });
                    }),
            )
            .child(crate::ui::widgets::anchor(div(), "sidebar-dialog-save").child(save))
    }
    pub(super) fn submit_space_dialog(
        &mut self,
        form: SpaceDialog,
        title: String,
        cx: &mut Context<Self>,
    ) {
        if !self.space_form_can_submit(&form, &title) {
            return;
        }
        let mut body = serde_json::json!({"title":title});
        let command = match form {
            SpaceDialog::Create(parent) => {
                body["action"] = "create".into();
                body["parentKey"] = serde_json::json!(parent);
                SpaceCommand::Create
            }
            SpaceDialog::Group(source, target) => {
                body["action"] = "group".into();
                body["sourceKey"] = source.into();
                body["targetKey"] = target.into();
                SpaceCommand::Group
            }
            SpaceDialog::Rename(key, _) => {
                self.rename_space_row(&key, title, cx);
                return;
            }
            SpaceDialog::Relocate {
                source,
                target,
                position,
                operation,
            } => {
                let Some(row) = self.store.navigation.rows.get(&source) else {
                    return;
                };
                body = serde_json::json!({"action":"relocate","sessionId":row.node.entityId,"targetKey":target,"position":position,"operationId":operation});
                SpaceCommand::Relocate
            }
            SpaceDialog::Delete(key) => {
                if let Some(row) = self.store.navigation.rows.get(&key) {
                    let id = row.node.entityId.clone();
                    self.mutate(
                        if row.project.is_some() {
                            Mutation::Project(id, ProjectCommand::Delete)
                        } else {
                            Mutation::Session(id, SessionCommand::Delete)
                        },
                        cx,
                    );
                }
                return;
            }
            _ => return,
        };
        self.space_mutate(command, body, cx);
    }
    fn rename_space_row(&mut self, key: &str, title: String, cx: &mut Context<Self>) {
        let Some(row) = self.store.navigation.rows.get(key) else {
            return;
        };
        let id = row.node.entityId.clone();
        if row.session.is_some() {
            self.mutate(Mutation::Session(id, SessionCommand::Rename(title)), cx);
        } else if row.project.is_some() {
            self.mutate(Mutation::Project(id, ProjectCommand::Rename(title)), cx);
        } else {
            self.space_mutate(
                SpaceCommand::Rename(id.clone()),
                serde_json::json!({"action":"rename","groupId":id,"title":title}),
                cx,
            );
        }
    }
    pub(super) fn space_move_form(
        &mut self,
        source: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> DialogContent {
        let query = self
            .sidebar_field_value(&self.sidebar_input(), cx)
            .to_lowercase();
        let rows = &self.store.navigation.rows;
        let targets: Vec<_> = rows
            .values()
            .filter(|r| {
                r.node.kind != SpaceNodeKind::Session
                    && format!("{} {}", r.title, r.location)
                        .to_lowercase()
                        .contains(&query)
                    && can_drop(rows, source, Some(&r.node.key), Position::Inside)
            })
            .map(|r| (Some(r.node.key.clone()), r.title.clone()))
            .collect();
        let mut list = div().flex().flex_col();
        let root = can_drop(rows, source, None, Position::Inside)
            .then(|| (None, self.copy("Top level", "최상위").to_owned()));
        for (target, title) in root.into_iter().chain(targets) {
            let source = source.to_owned();
            let weak = cx.entity().downgrade();
            list = list.child(
                NavRow::new(
                    gpui::SharedString::from(format!("destination-{target:?}")),
                    title,
                )
                .on_click(move |_, _, cx| {
                    let _ = weak.update(cx, |s, cx| {
                        s.request_space_move(source.clone(), target.clone(), Position::Inside, cx);
                    });
                }),
            );
        }
        DialogContent::new()
            .header(
                DialogHeader::new().child(DialogTitle::new(self.copy("Move to", "이동할 위치"))),
            )
            .child(self.bind_sidebar_field(
                self.sidebar_input(),
                Input::new(self.sidebar_input()),
                cx,
            ))
            .child(ScrollArea::new("move-targets").child(list))
    }
}
