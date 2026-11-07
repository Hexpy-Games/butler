//! ProjectCreateDialog: the name, the optional workspace folder and its browser.
mod folders;
use self::folders::FolderPicker;
use super::Shell;
use crate::ui::Icon;
use crate::ui::source::sidebar::Mutation;
use butler_ds::ui::{
    button::{Button, Variant},
    context::Ds,
    dialog::{DialogContent, DialogHeader, DialogTitle},
    field::{Field, FieldError, FieldLabel},
    icon::{IconSize, icon},
    icon_button::IconButton,
    icon_slot::{IconSlot, SlotSize},
    layout::{Cross, Space, Stack},
    text::Input,
    typo::{Tone, Typo},
};
use gpui::{AnyElement, Context, ElementId, Entity, Window, div, prelude::*};
impl Shell {
    pub(super) fn project_rename_dialog(
        &self,
        form: &super::dialogs::SpaceDialog,
        cx: &mut Context<Self>,
    ) -> DialogContent {
        self.space_edit_form(form, cx)
    }
    pub(super) fn session_rename_dialog(
        &self,
        form: &super::dialogs::SpaceDialog,
        cx: &mut Context<Self>,
    ) -> DialogContent {
        self.space_edit_form(form, cx)
    }
    pub(super) fn project_create_dialog(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> DialogContent {
        let picker = self.folder_picker(window, cx);
        if picker.read(cx).browsing {
            return DialogContent::new()
                .header(
                    DialogHeader::new()
                        .child(DialogTitle::new(self.copy("Choose folder", "폴더 선택"))),
                )
                .child(picker);
        }
        let save = Button::new("project-create-save")
            .text(self.copy("Create", "만들기"))
            .when(
                self.sidebar.pending
                    || self
                        .sidebar_field_value(&self.sidebar_input(), cx)
                        .trim()
                        .is_empty(),
                Button::disabled,
            )
            .on_click(cx.listener(|s, _, w, cx| s.submit_project_create(w, cx)));
        let mut content = DialogContent::new()
            .header(DialogHeader::new().child(DialogTitle::new(
                self.copy("Create a project", "새 프로젝트 만들기"),
            )))
            .children(self.project_create_fields(&picker, cx));
        if let Some(error) = &self.sidebar.error {
            content = content.child(FieldError::new().child(error.clone()));
        }
        content.footer(self.space_dialog_footer(save, cx))
    }
    /// The folder state lives with the dialog: a new dialog starts from a fresh picker.
    fn folder_picker(&self, window: &mut Window, cx: &mut Context<Self>) -> Entity<FolderPicker> {
        let shell = cx.entity().downgrade();
        let locale = self.theme.strings.locale;
        let key = ElementId::NamedInteger("project-folder".into(), self.sidebar.dialog_serial);
        window.use_keyed_state(key, cx, move |_, _| FolderPicker::new(shell, locale))
    }
    fn project_create_fields(
        &self,
        picker: &Entity<FolderPicker>,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let name = picker.read(cx).name.clone();
        vec![
            Field::new("project-name-field")
                .child(FieldLabel::new().child(self.copy("Project name", "프로젝트 이름")))
                .child(
                    crate::ui::widgets::anchor(div(), "sidebar-dialog-input")
                        .id("project-name-input")
                        .capture_key_down(cx.listener(|s, event: &gpui::KeyDownEvent, w, cx| {
                            if event.keystroke.key == "enter" {
                                cx.stop_propagation();
                                s.submit_project_create(w, cx);
                            }
                        }))
                        .child(
                            self.bind_sidebar_field(
                                self.sidebar_input(),
                                Input::new(self.sidebar_input())
                                    .default_value(name)
                                    .when(self.sidebar.pending, Input::disabled),
                                cx,
                            ),
                        ),
                )
                .into_any_element(),
            Field::new("project-folder-field")
                .child(FieldLabel::new().child(self.copy("Project folder", "프로젝트 폴더")))
                .child(self.project_folder_line(picker, cx))
                .into_any_element(),
        ]
    }
    /// The chosen folder (or the automatic one) with its Choose/Change and reset buttons.
    fn project_folder_line(
        &self,
        picker: &Entity<FolderPicker>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let chosen = picker.read(cx).chosen.clone();
        let pending = self.sidebar.pending;
        let glyph = if chosen.is_some() {
            Icon::Folder
        } else {
            Icon::FolderPlus
        };
        let text = match &chosen {
            Some(chosen) => {
                let (parent, base) = chosen
                    .folder_path
                    .rsplit_once('/')
                    .unwrap_or(("", chosen.folder_path.as_str()));
                Stack::new()
                    .child(Typo::body(base.to_owned()).truncate())
                    .child(
                        Typo::caption(parent.to_owned())
                            .tone(Tone::Secondary)
                            .truncate(),
                    )
                    .into_any_element()
            }
            None => Typo::body(self.copy("Creates a new folder", "새 폴더 자동 생성"))
                .tone(Tone::Secondary)
                .truncate()
                .into_any_element(),
        };
        let label = if chosen.is_some() {
            self.copy("Change", "변경")
        } else {
            self.copy("Choose folder", "폴더 선택")
        };
        let browse = picker.clone();
        let mut line = Stack::row()
            .cross(Cross::Center)
            .gap(Space::Sm)
            .child(
                IconSlot::new()
                    .size(SlotSize::Md)
                    .child(icon(glyph, IconSize::Md, Ds::get(cx))),
            )
            .child(div().flex_1().min_w_0().child(text))
            .child(
                Button::new("project-create-folder")
                    .variant(Variant::Outline)
                    .text(label)
                    .when(pending, Button::disabled)
                    .on_click(cx.listener(move |s, _, _, cx| {
                        let name = s.sidebar_field_value(&s.sidebar_input(), cx);
                        browse.update(cx, |picker, cx| picker.open(name, cx));
                        cx.notify();
                    })),
            );
        if chosen.is_some() {
            let reset = picker.clone();
            line = line.child(
                IconButton::new(
                    "project-create-folder-reset",
                    self.copy("Use a new folder instead", "새 폴더로 되돌리기"),
                )
                .glyph(Icon::X)
                .when(pending, IconButton::disabled)
                .on_click(move |_, _, cx| reset.update(cx, folders::FolderPicker::reset)),
            );
        }
        line.into_any_element()
    }
    fn submit_project_create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = self
            .sidebar_field_value(&self.sidebar_input(), cx)
            .trim()
            .to_owned();
        if name.is_empty() {
            return;
        }
        let chosen = self.folder_picker(window, cx).read(cx).chosen.clone();
        let body = match chosen {
            Some(folder) => serde_json::json!({
                "source": "workspace_folder",
                "display_name": name,
                "workspace_path": folder.workspace_path,
            }),
            None => serde_json::json!({"source": "scratch", "display_name": name}),
        };
        self.mutate(Mutation::CreateProject(body), cx);
    }
}
