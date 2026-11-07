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
            _ => self.space_group_form(&form, window, cx),
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
    pub(super) fn space_group_form(
        &self,
        form: &SpaceDialog,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> DialogContent {
        let title = match form {
            SpaceDialog::Rename(_, _) => self.copy("Rename", "이름 변경"),
            SpaceDialog::Relocate { .. } => self.copy("Move conversation", "대화 이동"),
            SpaceDialog::Delete(_) => self.copy("Delete", "삭제"),
            _ => self.copy("New group", "새 그룹"),
        };
        let mut content =
            DialogContent::new().header(DialogHeader::new().child(DialogTitle::new(title)));
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

        if let SpaceDialog::Relocate { source, target, .. } = form {
            let rows = &self.store.navigation.rows;
            content = content.child(DialogDescription::new(format!(
                "{} → {}",
                rows.get(source).map_or("", |r| r.title.as_str()),
                target
                    .as_ref()
                    .and_then(|k| rows.get(k))
                    .map_or(self.copy("Top level", "최상위"), |r| r.title.as_str())
            )));
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
        let destructive = matches!(form, SpaceDialog::Delete(_));
        let label = match form {
            SpaceDialog::Delete(_) => self.copy("Delete", "삭제"),
            SpaceDialog::Relocate { .. } => self.copy("Move", "이동"),
            _ => self.copy("Save", "저장"),
        };
        let save = Button::new("space-save")
            .text(label)
            .when(destructive, |b| b.variant(Variant::Destructive))
            .when(pending, Button::disabled)
            .on_click(move |_, _, cx| {
                let _ = weak.update(cx, |s, cx| {
                    let value = s.sidebar_field_value(&input, cx).trim().to_owned();
                    s.submit_space_dialog(form.clone(), value, cx);
                });
            });
        content.footer(self.space_dialog_footer(save, cx))
    }
    fn space_form_input(
        &self,
        form: &SpaceDialog,
        initial: String,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let input = self.sidebar_input();
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
            .child(FieldLabel::new().child(self.copy("Name", "이름")))
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
        let mut body = serde_json::json!({"title":title});
        let command = match form {
            SpaceDialog::Create(parent) => {
                if title.is_empty() {
                    return;
                }
                body["action"] = "create".into();
                body["parentKey"] = serde_json::json!(parent);
                SpaceCommand::Create
            }
            SpaceDialog::Group(source, target) => {
                if title.is_empty() {
                    return;
                }
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
        if title.is_empty() {
            return;
        }
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
