//! DialogForm.showcase.tsx: the form body, the form inside a dialog, and a confirm whose long
//! title wraps before the close button. Each dialog story shows its trigger; the live harness
//! opens the dialog.
use butler_ds::ui::blocks::dialog_form::DialogForm;
use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::dialog::{Dialog, DialogContent};
use butler_ds::ui::layout::{Justify, Stack};
use butler_ds::ui::text::Input;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    title: &'static str,
    description: &'static str,
    name: &'static str,
    folder: &'static str,
    value: &'static str,
    path: &'static str,
    cancel: &'static str,
    create: &'static str,
    open: &'static str,
    delete_title: &'static str,
    delete_detail: &'static str,
    delete_action: &'static str,
    open_delete: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            title: "New project",
            description: "Name the project and pick its folder.",
            name: "Project name",
            folder: "Folder",
            value: "butler-site",
            path: "~/code/butler-site",
            cancel: "Cancel",
            create: "Create",
            open: "New project",
            delete_title: "Delete task \u{2018}Delete check · Long task titles wrap across several lines without overlapping the task menu\u{2019}",
            delete_detail: "Deletes it on this device. Linked conversations stay.",
            delete_action: "Delete task",
            open_delete: "Delete task",
        },
        Copy {
            title: "새 프로젝트",
            description: "프로젝트 이름을 정하고 폴더를 고르세요.",
            name: "프로젝트 이름",
            folder: "폴더",
            value: "butler-site",
            path: "~/code/butler-site",
            cancel: "취소",
            create: "만들기",
            open: "새 프로젝트",
            delete_title: "\u{2018}삭제 확인 · 긴 과제 제목이 여러 줄로 이어져도 작업 메뉴와 겹치지 않고 올바르게 표시됩니다\u{2019} 과제 삭제",
            delete_detail: "이 기기에서 삭제합니다. 연결된 대화는 남습니다.",
            delete_action: "과제 삭제",
            open_delete: "과제 삭제",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    let story = |name, render| Story { name, render };
    vec![
        story("Form body", form_body),
        story("Inside a dialog", inside_dialog),
        story("Long title beside the close button", long_title),
    ]
}

/// The project form; `dialog` closes on both actions.
fn project_form(c: &Copy, dialog: Option<&Dialog>) -> DialogForm {
    let action = |id: &'static str, variant, text| {
        let button = Button::new(id).variant(variant).text(text);
        match dialog {
            Some(dialog) => button.on_click(dialog.closer().on_click()),
            None => button,
        }
    };
    DialogForm::new(c.title)
        .description(c.description)
        .child(
            SettingsField::new(c.name)
                .setting_id("dialog-form-name")
                .control(Input::new("dialog-form-name-input").default_value(c.value)),
        )
        .child(
            SettingsField::new(c.folder)
                .setting_id("dialog-form-folder")
                .control(
                    Input::new("dialog-form-folder-input")
                        .default_value(c.path)
                        .read_only(),
                ),
        )
        .footer(
            button::container(Size::Default)
                .justify(Justify::End)
                .child(action("dialog-form-cancel", Variant::Outline, c.cancel))
                .child(action("dialog-form-create", Variant::Default, c.create)),
        )
}

fn form_body(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    project_form(&copy(lang), None).into_any_element()
}

fn inside_dialog(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let dialog = Dialog::new("dialog-form-dialog", window, cx);
    let open = dialog.trigger(|toggle| {
        Button::new("dialog-form-dialog-trigger")
            .variant(Variant::Outline)
            .text(c.open)
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let content = dialog.content(
        DialogContent::new().child(project_form(&c, Some(&dialog))),
        window,
        cx,
    );
    Stack::new().child(open).child(content).into_any_element()
}

fn long_title(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let dialog = Dialog::new("dialog-form-long", window, cx);
    let open = dialog.trigger(|toggle| {
        Button::new("dialog-form-long-trigger")
            .variant(Variant::Outline)
            .text(c.open_delete)
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let form = DialogForm::new(c.delete_title)
        .description(c.delete_detail)
        .footer(
            button::container(Size::Sm)
                .justify(Justify::End)
                .child(
                    Button::new("dialog-form-long-cancel")
                        .size(Size::Sm)
                        .variant(Variant::Ghost)
                        .text(c.cancel)
                        .on_click(dialog.closer().on_click()),
                )
                .child(
                    Button::new("dialog-form-long-delete")
                        .size(Size::Sm)
                        .variant(Variant::Destructive)
                        .text(c.delete_action)
                        .on_click(dialog.closer().on_click()),
                ),
        );
    let content = dialog.content(DialogContent::new().child(form), window, cx);
    Stack::new().child(open).child(content).into_any_element()
}
