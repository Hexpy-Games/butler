//! ProjectCreateDialog. Folder browsing awaits the Breadcrumb DS batch.
use super::Shell;
use crate::ui::source::sidebar::Mutation;
use butler_ds::ui::{
    button::Button,
    dialog::{DialogContent, DialogHeader, DialogTitle},
    field::{Field, FieldError, FieldLabel},
    text::Input,
    tooltip::Tooltip,
    typo::Typo,
};
use gpui::{AnyElement, Context, Window, prelude::*};
impl Shell {
    pub(super) fn project_create_dialog(
        &self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> DialogContent {
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
            .on_click(cx.listener(|s, _, _, cx| s.submit_project_create(cx)));
        let mut content = DialogContent::new()
            .header(DialogHeader::new().child(DialogTitle::new(
                self.copy("Create a project", "새 프로젝트 만들기"),
            )))
            .children(self.project_create_fields(cx));
        if let Some(error) = &self.sidebar.error {
            content = content.child(FieldError::new().child(error.clone()));
        }
        content.footer(self.space_dialog_footer(save, cx))
    }
    fn project_create_fields(&self, cx: &Context<Self>) -> Vec<AnyElement> {
        vec![
            Field::new("project-name-field")
                .child(FieldLabel::new().child(self.copy("Project name", "프로젝트 이름")))
                .child(
                    crate::ui::widgets::anchor(gpui::div(), "sidebar-dialog-input")
                        .id("project-name-input")
                        .capture_key_down(cx.listener(|s, event: &gpui::KeyDownEvent, _, cx| {
                            if event.keystroke.key == "enter" {
                                cx.stop_propagation();
                                s.submit_project_create(cx);
                            }
                        }))
                        .child(
                            self.bind_sidebar_field(
                                self.sidebar_input(),
                                Input::new(self.sidebar_input())
                                    .when(self.sidebar.pending, Input::disabled),
                                cx,
                            ),
                        ),
                )
                .into_any_element(),
            Field::new("project-folder-field")
                .child(FieldLabel::new().child(self.copy("Project folder", "프로젝트 폴더")))
                .child(Typo::body(
                    self.copy("Creates a new folder", "새 폴더 자동 생성"),
                ))
                .into_any_element(),
            Tooltip::new("project-browse-tip")
                .label(self.theme.strings.not_yet)
                .child(
                    Button::new("project-browse")
                        .text(self.copy("Browse", "찾아보기"))
                        .disabled(),
                )
                .into_any_element(),
        ]
    }
    fn submit_project_create(&mut self, cx: &mut Context<Self>) {
        let name = self
            .sidebar_field_value(&self.sidebar_input(), cx)
            .trim()
            .to_owned();
        if !name.is_empty() {
            self.mutate(
                Mutation::CreateProject(
                    serde_json::json!({"source":"scratch","display_name":name}),
                ),
                cx,
            );
        }
    }
}
