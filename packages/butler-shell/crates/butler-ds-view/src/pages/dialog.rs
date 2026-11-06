//! Dialog.showcase.tsx: the window dialogs. The anchored (container) demos are in
//! `dialog_contained.rs`. Each story shows its trigger; the live harness opens the dialog.
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::dialog::{
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Layout,
    MaxHeight, Motion, Size as DialogSize,
};
use butler_ds::ui::field::{Field, FieldLabel};
use butler_ds::ui::layout::{Justify, Stack};
use butler_ds::ui::scroll::ScrollArea;
use butler_ds::ui::text::{Input, Textarea};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

pub(super) struct Copy {
    pub(super) rename: &'static str,
    pub(super) rename_title: &'static str,
    pub(super) field: &'static str,
    pub(super) value: &'static str,
    pub(super) cancel: &'static str,
    pub(super) save: &'static str,
    pub(super) description: &'static str,
    pub(super) description_value: &'static str,
    pub(super) edit: &'static str,
    pub(super) confirm: &'static str,
    pub(super) confirm_body: &'static str,
    pub(super) archive: &'static str,
    pub(super) discard_title: &'static str,
    pub(super) keep: &'static str,
    pub(super) discard: &'static str,
}

pub(super) fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            rename: "Rename",
            rename_title: "Rename conversation",
            field: "Name",
            value: "Token page review",
            cancel: "Cancel",
            save: "Save",
            description: "Project description",
            description_value: "Butler desktop app: Electron shell, React UI and the Rust agent gateway.",
            edit: "Edit description",
            confirm: "Archive conversation?",
            confirm_body: "You can restore it from Archived conversations.",
            archive: "Archive",
            discard_title: "Save your changes?",
            keep: "Keep editing",
            discard: "Don't save",
        },
        Copy {
            rename: "이름 바꾸기",
            rename_title: "대화 이름 바꾸기",
            field: "이름",
            value: "토큰 페이지 검토",
            cancel: "취소",
            save: "저장",
            description: "프로젝트 설명",
            description_value: "버틀러 데스크톱 앱: Electron 셸, React UI, Rust 에이전트 게이트웨이.",
            edit: "설명 편집",
            confirm: "대화를 보관할까요?",
            confirm_body: "보관된 대화에서 다시 복원할 수 있습니다.",
            archive: "보관",
            discard_title: "변경 내용을 저장할까요?",
            keep: "계속 편집",
            discard: "저장 안 함",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    let story = |name, render| Story { name, render };
    vec![
        story("Rename conversation", rename),
        story("Edit project description", edit),
        story("Confirmation with footer close", confirmation),
        story("Title-only confirmation (minimum height)", title_only),
        story("Palette motion", palette),
        story("Wide reader (size xl, scroll-body, maxHeight 3/5)", reader),
        story(
            "Anchored in a page card (container)",
            super::dialog_contained::anchored,
        ),
        story(
            "Full height with a nearly empty body (height full)",
            super::dialog_contained::full_height,
        ),
    ]
}

/// A trigger Button for `dialog`.
fn trigger(
    dialog: &Dialog,
    id: &'static str,
    variant: Variant,
    size: Size,
    text: &'static str,
) -> AnyElement {
    dialog.trigger(|toggle| {
        Button::new(id)
            .variant(variant)
            .size(size)
            .text(text)
            .on_click(toggle.on_click())
            .into_any_element()
    })
}

/// A Button that closes `dialog` (`DialogClose asChild`).
fn closing(
    dialog: &Dialog,
    id: &'static str,
    variant: Variant,
    size: Size,
    text: &'static str,
) -> Button {
    Button::new(id)
        .variant(variant)
        .size(size)
        .text(text)
        .on_click(dialog.closer().on_click())
}

/// SessionRenameDialog: header, one field, footer with cancel and submit.
fn rename(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let dialog = Dialog::new("dialog-rename", window, cx);
    let open = trigger(
        &dialog,
        "dialog-rename-trigger",
        Variant::Outline,
        Size::Default,
        c.rename,
    );
    let actions = button::container(Size::Default)
        .justify(Justify::End)
        .child(closing(
            &dialog,
            "dialog-rename-cancel",
            Variant::Outline,
            Size::Default,
            c.cancel,
        ))
        .child(closing(
            &dialog,
            "dialog-rename-save",
            Variant::Default,
            Size::Default,
            c.save,
        ));
    let content = dialog.content(
        DialogContent::new()
            .header(DialogHeader::new().child(DialogTitle::new(c.rename_title)))
            .child(
                Field::new("dialog-rename-field")
                    .child(FieldLabel::new().child(c.field))
                    .child(Input::new("dialog-rename-input").default_value(c.value)),
            )
            .footer(DialogFooter::new().child(actions)),
        window,
        cx,
    );
    Stack::new().child(open).child(content).into_any_element()
}

fn edit(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let dialog = Dialog::new("dialog-edit", window, cx);
    let open = trigger(
        &dialog,
        "dialog-edit-trigger",
        Variant::Borderless,
        Size::Sm,
        c.edit,
    );
    let actions = button::container(Size::Sm)
        .child(closing(
            &dialog,
            "dialog-edit-cancel",
            Variant::Borderless,
            Size::Sm,
            c.cancel,
        ))
        .child(closing(
            &dialog,
            "dialog-edit-save",
            Variant::Default,
            Size::Sm,
            c.save,
        ));
    let content = dialog.content(
        DialogContent::new()
            .header(DialogHeader::new().child(DialogTitle::new(c.description)))
            .child(Textarea::new("dialog-edit-text").default_value(c.description_value))
            .child(actions),
        window,
        cx,
    );
    Stack::new().child(open).child(content).into_any_element()
}

fn confirmation(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let dialog = Dialog::new("dialog-confirm", window, cx);
    let open = trigger(
        &dialog,
        "dialog-confirm-trigger",
        Variant::Destructive,
        Size::Sm,
        c.archive,
    );
    let footer = DialogFooter::new()
        .close_button(c.cancel, {
            let close = dialog.clone();
            move |window, cx| close.set_open(false, window, cx)
        })
        .child(closing(
            &dialog,
            "dialog-confirm-archive",
            Variant::Destructive,
            Size::Default,
            c.archive,
        ));
    let content = dialog.content(
        DialogContent::new()
            .show_close_button(false)
            .header(
                DialogHeader::new()
                    .child(DialogTitle::new(c.confirm))
                    .child(DialogDescription::new(c.confirm_body)),
            )
            .footer(footer),
        window,
        cx,
    );
    Stack::new().child(open).child(content).into_any_element()
}

/// The inline-edit unsaved-change confirm: a header with only a title and the actions.
fn title_only(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let dialog = Dialog::new("dialog-title-only", window, cx);
    let open = trigger(
        &dialog,
        "dialog-title-only-trigger",
        Variant::Outline,
        Size::Sm,
        c.discard_title,
    );
    let actions = button::container(Size::Sm)
        .justify(Justify::End)
        .child(closing(
            &dialog,
            "dialog-keep",
            Variant::Ghost,
            Size::Sm,
            c.keep,
        ))
        .child(closing(
            &dialog,
            "dialog-discard",
            Variant::Ghost,
            Size::Sm,
            c.discard,
        ))
        .child(closing(
            &dialog,
            "dialog-save",
            Variant::Default,
            Size::Sm,
            c.save,
        ));
    let content = dialog.content(
        DialogContent::new()
            .show_close_button(false)
            .header(DialogHeader::new().child(DialogTitle::new(c.discard_title)))
            .footer(DialogFooter::new().child(actions)),
        window,
        cx,
    );
    Stack::new().child(open).child(content).into_any_element()
}

fn palette(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let dialog = Dialog::new("dialog-palette", window, cx);
    let open = trigger(
        &dialog,
        "dialog-palette-trigger",
        Variant::Outline,
        Size::Sm,
        "⌘K",
    );
    let content = dialog.content(
        DialogContent::new()
            .motion(Motion::Palette)
            .child(DialogTitle::new(c.rename))
            .child(
                Typo::caption("--motion-palette · --motion-scale-palette").tone(Tone::Secondary),
            ),
        window,
        cx,
    );
    Stack::new().child(open).child(content).into_any_element()
}

/// ProjectDocumentDialog / SessionObserverDialog: a wide reader with one scrolling body.
fn reader(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let dialog = Dialog::new("dialog-reader", window, cx);
    let open = trigger(
        &dialog,
        "dialog-reader-trigger",
        Variant::Outline,
        Size::Default,
        c.description,
    );
    let mut body = ScrollArea::new("dialog-reader-scroll").fill();
    for _ in 0..12 {
        body = body.child(Typo::body(c.description_value));
    }
    let content = dialog.content(
        DialogContent::new()
            .size(DialogSize::Xl)
            .layout(Layout::ScrollBody)
            .max_height(MaxHeight::ThreeFifths)
            .header(
                DialogHeader::new()
                    .child(DialogTitle::new(c.description))
                    .child(DialogDescription::new(c.description_value)),
            )
            .child(body)
            .footer(DialogFooter::new().child(closing(
                &dialog,
                "dialog-reader-cancel",
                Variant::Outline,
                Size::Default,
                c.cancel,
            ))),
        window,
        cx,
    );
    Stack::new().child(open).child(content).into_any_element()
}
