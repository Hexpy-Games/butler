//! SettingsSecretRows.showcase.tsx: the HTTP headers block (default-source toolbar, then one row
//! per secret) and an empty environment block.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::settings_secret_rows::{
    SettingsSecretRow, SettingsSecretRows, source_cell,
};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::native_select::{NativeSelect, Size as SelectSize};
use butler_ds::ui::text::Input;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString};

use super::Story;
use crate::copy::Lang;

struct Copy {
    headers: &'static str,
    env: &'static str,
    literal: &'static str,
    env_var: &'static str,
    keychain: &'static str,
    apply: &'static str,
    add: &'static str,
    add_env: &'static str,
    remove: &'static str,
    empty: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            headers: "Headers",
            env: "Environment",
            literal: "Literal value",
            env_var: "Environment variable",
            keychain: "Keychain",
            apply: "Apply to all",
            add: "Add header",
            add_env: "Add variable",
            remove: "Delete row",
            empty: "No entries yet.",
        },
        Copy {
            headers: "헤더",
            env: "환경",
            literal: "직접 입력",
            env_var: "환경 변수",
            keychain: "키체인",
            apply: "모두에 적용",
            add: "헤더 추가",
            add_env: "변수 추가",
            remove: "행 삭제",
            empty: "아직 항목이 없습니다.",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "HTTP headers",
            render: |lang, _, cx| {
                let c = copy(lang);
                block(
                    lang,
                    ("ssr-headers", c.headers, c.add),
                    &[
                        ("Authorization", "BUTLER_GITHUB_TOKEN"),
                        ("X-Org", "butler"),
                    ],
                    cx,
                )
            },
        },
        Story {
            name: "Empty environment",
            render: |lang, _, cx| {
                let c = copy(lang);
                block(lang, ("ssr-env", c.env, c.add_env), &[], cx)
            },
        },
    ]
}

fn id(key: &str, part: &str) -> SharedString {
    SharedString::from(format!("{key}-{part}"))
}

/// The value-source select, stretched to fill its column.
fn source_select(key: &str, part: &str, c: &Copy, size: SelectSize) -> NativeSelect {
    NativeSelect::new(id(key, part))
        .size(size)
        .stretch()
        .default_value("env")
        .option("literal", c.literal)
        .option("env", c.env_var)
        .option("keychain", c.keychain)
}

/// McpSecretRows: the default-source toolbar, then one row per secret.
fn block(
    lang: Lang,
    (key, title, add): (&'static str, &'static str, &'static str),
    rows: &[(&'static str, &'static str)],
    cx: &mut App,
) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let mut apply = Button::new(id(key, "apply"))
        .size(Size::Xs)
        .variant(Variant::Outline)
        .text(c.apply);
    if rows.is_empty() {
        apply = apply.disabled();
    }
    let add = Button::new(id(key, "add"))
        .size(Size::Xs)
        .variant(Variant::Outline)
        .icon_start(icon(Icon::Plus, IconSize::Sm, ds))
        .text(add);
    let mut block = SettingsSecretRows::new(key, title)
        .action(source_cell(source_select(
            key,
            "default-source",
            &c,
            SelectSize::Sm,
        )))
        .action(button::container(Size::Xs).child(apply).child(add));
    if rows.is_empty() {
        block = block.empty_state(c.empty);
    }
    for (name, value) in rows {
        block = block.row(SettingsSecretRow::new(
            source_cell(source_select(
                key,
                &format!("{name}-source"),
                &c,
                SelectSize::Default,
            )),
            Input::new(id(key, &format!("{name}-key")))
                .placeholder("KEY")
                .default_value(*name),
            Input::new(id(key, &format!("{name}-value")))
                .placeholder("GITHUB_TOKEN")
                .default_value(*value),
            IconButton::new(id(key, &format!("{name}-remove")), c.remove).glyph(Icon::Trash2),
        ));
    }
    block.into_any_element()
}
