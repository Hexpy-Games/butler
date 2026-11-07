//! OptionMenu.showcase.tsx: the composer add menu, the same menu for a text-only model (the image
//! option explains itself on hover), and the access menu with grants.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::composer_control::PermissionTone;
use butler_ds::ui::blocks::option_menu::{ItemTone, OptionMenu, OptionMenuItem, OptionMenuSection};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Space, Stack};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    add: &'static str,
    attachments: &'static str,
    documents: &'static str,
    attach: &'static str,
    attach_image: &'static str,
    no_images: &'static str,
    mode: &'static str,
    normal: &'static str,
    plan: &'static str,
    permission: &'static str,
    full: &'static str,
    full_hint: &'static str,
    ask: &'static str,
    ask_hint: &'static str,
    read: &'static str,
    read_hint: &'static str,
    allowed: &'static str,
    revoke: &'static str,
    revoke_hint: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            add: "Add to message",
            attachments: "Attachments",
            documents: "Project documents",
            attach: "Attach file",
            attach_image: "Attach image",
            no_images: "Model doesn't accept images",
            mode: "Response mode",
            normal: "Normal",
            plan: "Plan",
            permission: "Permission",
            full: "Full access",
            full_hint: "Can read files, write files, and run commands",
            ask: "Ask first",
            ask_hint: "Ask before changing files or running commands",
            read: "Read only",
            read_hint: "Can only read files",
            allowed: "Allowed in this conversation",
            revoke: "Revoke: run bun test",
            revoke_hint: "Allowed once at 14:02",
        },
        Copy {
            add: "메시지에 추가",
            attachments: "첨부",
            documents: "프로젝트 문서",
            attach: "파일 첨부",
            attach_image: "이미지 첨부",
            no_images: "이미지 미지원 모델",
            mode: "응답 방식",
            normal: "일반",
            plan: "계획",
            permission: "권한",
            full: "전체 권한",
            full_hint: "파일을 읽고 쓰고 명령을 실행할 수 있습니다",
            ask: "먼저 묻기",
            ask_hint: "파일을 바꾸거나 명령을 실행하기 전에 묻습니다",
            read: "읽기 전용",
            read_hint: "파일을 읽기만 합니다",
            allowed: "이 대화에서 허용됨",
            revoke: "허용 취소: bun test 실행",
            revoke_hint: "14:02에 한 번 허용함",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Composer add menu",
            render: add_menu,
        },
        Story {
            name: "Composer add menu, text-only model",
            render: text_only,
        },
        Story {
            name: "Access menu with grants",
            render: access,
        },
    ]
}

fn add_menu(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    OptionMenu::new(c.add)
        .fit()
        .child(
            OptionMenuSection::new(c.attachments)
                .first()
                .child(
                    OptionMenuItem::new("om-documents", c.documents)
                        .icon(icon(Icon::FileText, IconSize::Md, ds))
                        .description(icon(Icon::ChevronRight, IconSize::Sm, ds)),
                )
                .child(OptionMenuItem::new("om-attach", c.attach).icon(icon(
                    Icon::Paperclip,
                    IconSize::Md,
                    ds,
                )))
                .child(OptionMenuItem::new("om-image", c.attach_image).icon(icon(
                    Icon::ImageIcon,
                    IconSize::Md,
                    ds,
                ))),
        )
        .child(
            OptionMenuSection::new(c.mode)
                .child(
                    OptionMenuItem::new("om-normal", c.normal)
                        .selected()
                        .icon(icon(Icon::MessageSquarePlus, IconSize::Md, ds)),
                )
                .child(OptionMenuItem::new("om-plan", c.plan).icon(icon(
                    Icon::ListChecks,
                    IconSize::Md,
                    ds,
                ))),
        )
        .into_any_element()
}

fn text_only(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    OptionMenu::new(c.add)
        .fit()
        .child(
            OptionMenuSection::new(c.attachments)
                .first()
                .child(OptionMenuItem::new("om-t-attach", c.attach).icon(icon(
                    Icon::Paperclip,
                    IconSize::Md,
                    ds,
                )))
                .child(
                    OptionMenuItem::new("om-t-image", c.attach_image)
                        .icon(icon(Icon::ImageIcon, IconSize::Md, ds))
                        .disabled_reason(c.no_images),
                ),
        )
        .into_any_element()
}

fn access(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let permission = OptionMenu::new(c.permission)
        .child(
            OptionMenuItem::new("om-full", c.full)
                .selected()
                .icon(icon(Icon::ShieldCheck, IconSize::Md, ds))
                .tone(ItemTone::Warning)
                .description(c.full_hint)
                .block_description()
                .permission_tone(PermissionTone::Full),
        )
        .child(
            OptionMenuItem::new("om-ask", c.ask)
                .icon(icon(Icon::ShieldQuestion, IconSize::Md, ds))
                .tone(ItemTone::Accent)
                .description(c.ask_hint)
                .block_description()
                .permission_tone(PermissionTone::Ask),
        )
        .child(
            OptionMenuItem::new("om-read", c.read)
                .icon(icon(Icon::Eye, IconSize::Md, ds))
                .description(c.read_hint)
                .block_description()
                .permission_tone(PermissionTone::Read),
        );
    let grants = OptionMenu::new(c.allowed).child(
        OptionMenuItem::new("om-revoke", c.revoke)
            .icon(icon(Icon::X, IconSize::Md, ds))
            .tone(ItemTone::Muted)
            .description(c.revoke_hint),
    );
    Stack::row()
        .gap(Space::Xxl)
        .cross(Cross::Start)
        .wrap(true)
        .child(permission)
        .child(grants)
        .into_any_element()
}
