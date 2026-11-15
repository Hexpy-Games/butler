//! A page's dialog, contained by its PageCard.
use super::{
    engine::TabId,
    model::BrowserState,
    page_dialog::{DialogAnswer, DialogKind, PageDialog},
};
use crate::ui::{i18n::browser::BrowserStrings, widgets::anchor};
use butler_ds::{
    tokens::Length,
    ui::{
        button::{Button, Size, Variant},
        context::Ds,
        dialog::{
            Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
        },
        layout::{Space, Stack},
        text::Input,
        tooltip::Tooltip,
        typo::Typo,
    },
};
use gpui::{AnyElement, App, Entity, IntoElement, ParentElement, Window, div, prelude::*};

pub(super) fn show(
    tab: &TabId,
    value: &PageDialog,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let key = gpui::ElementId::Name(format!("page-dialog:{}:{}", tab.0, value.id).into());
    let state = window.use_keyed_state((key.clone(), "answer"), cx, |_, _| DialogAnswer {
        text: value.default_prompt.clone(),
        ..DialogAnswer::default()
    });
    let cancel_tab = tab.clone();
    let id = value.id;
    let dialog = Dialog::new(key, window, cx)
        .modal(false)
        .open(true)
        .on_open_change(move |open, _, cx| {
            if !open {
                answer(&cancel_tab, id, DialogAnswer::default(), cx);
            }
        });
    let c = BrowserStrings::get(cx);
    let title = match value.kind {
        DialogKind::BeforeUnload => c.leave_title,
        DialogKind::Auth => c.auth_needed,
        DialogKind::File => c.choose_file,
        _ => c.page_says,
    };
    let host = url::Url::parse(&value.origin)
        .ok()
        .map(|u| u[url::Position::BeforeHost..url::Position::AfterPort].to_owned())
        .unwrap_or_default();
    let content = DialogContent::new()
        .contained(Ds::get(cx).len(Length::RadiusPopover))
        .header(
            DialogHeader::new()
                .child(DialogTitle::new(title))
                .child(DialogDescription::new(host)),
        )
        .child(body(value, &state, cx))
        .footer(footer(tab, value, &state, cx));
    anchor(div(), "browser-page-dialog")
        .size_full()
        .relative()
        .child(dialog.container_probe())
        .child(dialog.content(content, window, cx))
        .into_any_element()
}
fn answer(tab: &TabId, id: u64, value: DialogAnswer, cx: &mut App) {
    cx.global_mut::<BrowserState>()
        .answer_dialog(tab, id, value);
    cx.refresh_windows();
}
fn body(value: &PageDialog, state: &Entity<DialogAnswer>, cx: &App) -> AnyElement {
    let c = BrowserStrings::get(cx);
    let mut body = Stack::new()
        .gap(Space::Sm)
        .child(Typo::body(format!("“{}”", value.message)));
    if value.kind == DialogKind::Prompt {
        let state = state.clone();
        let input = Input::new("browser-dialog-input")
            .value(state.read(cx).text.clone())
            .on_change(move |text, _, cx| state.update(cx, |s, _| text.clone_into(&mut s.text)));
        body = body.child(anchor(div(), "browser-dialog-input").child(input));
    }
    if value.kind == DialogKind::Auth {
        for (password, label) in [(false, c.username), (true, c.password)] {
            let state = state.clone();
            let current = if password {
                &state.read(cx).password
            } else {
                &state.read(cx).username
            };
            let input = Input::new(if password {
                "browser-dialog-password"
            } else {
                "browser-dialog-username"
            })
            .placeholder(label)
            .value(current.clone())
            .on_change(move |text, _, cx| {
                state.update(cx, |s, _| {
                    if password {
                        text.clone_into(&mut s.password);
                    } else {
                        text.clone_into(&mut s.username);
                    }
                });
            });
            body = body.child(if password { input.masked() } else { input });
        }
    }
    if value.kind == DialogKind::File {
        body = body.child(Typo::caption(
            state
                .read(cx)
                .files
                .iter()
                .filter_map(|p| p.file_name())
                .map(|n| n.to_string_lossy())
                .collect::<Vec<_>>()
                .join(", "),
        ));
        let state = state.clone();
        let value = value.clone();
        body = body.child(
            Button::new("browser-dialog-choose-file")
                .text(c.choose_file)
                .size(Size::Sm)
                .variant(Variant::Outline)
                .on_click(move |_, _, cx| choose(&state, &value, cx)),
        );
    }
    body.into_any_element()
}
fn footer(tab: &TabId, value: &PageDialog, state: &Entity<DialogAnswer>, cx: &App) -> DialogFooter {
    let c = BrowserStrings::get(cx);
    let mut footer = DialogFooter::new();
    let id = value.id;
    if value.kind != DialogKind::Alert {
        let tab = tab.clone();
        footer = footer.child(
            anchor(div(), "browser-dialog-cancel").child(
                Button::new("browser-dialog-cancel")
                    .size(Size::Sm)
                    .variant(Variant::Outline)
                    .text(if value.kind == DialogKind::BeforeUnload {
                        c.stay
                    } else {
                        c.cancel
                    })
                    .on_click(move |_, _, cx| answer(&tab, id, DialogAnswer::default(), cx)),
            ),
        );
    }
    let tab = tab.clone();
    let state = state.clone();
    let disabled = value.kind == DialogKind::File && state.read(cx).files.is_empty();
    let label = match value.kind {
        DialogKind::BeforeUnload => c.leave,
        DialogKind::Auth => c.sign_in,
        _ => c.ok,
    };
    let ok = Button::new("browser-dialog-ok")
        .size(Size::Sm)
        .text(label)
        .on_click(move |_, _, cx| {
            let mut value = state.read(cx).clone();
            value.accept = true;
            answer(&tab, id, value, cx);
        });
    if disabled {
        footer = footer.child(
            Tooltip::new("browser-dialog-files-required")
                .label(c.choose_file)
                .child(ok.disabled()),
        );
    } else {
        footer = footer.child(anchor(div(), "browser-dialog-ok").child(ok));
    }
    footer
}
fn choose(state: &Entity<DialogAnswer>, value: &PageDialog, cx: &mut App) {
    let chosen = cx.prompt_for_paths(gpui::PathPromptOptions {
        files: true,
        directories: false,
        multiple: value.multiple,
        prompt: Some(BrowserStrings::get(cx).choose_file.into()),
    });
    let accept = value.accept_types.clone();
    let state = state.downgrade();
    cx.spawn(async move |cx| {
        let files = chosen
            .await
            .ok()
            .and_then(Result::ok)
            .flatten()
            .unwrap_or_default();
        // CEF supplies MIME expansions alongside extension filters.
        let extensions: Vec<_> = accept
            .iter()
            .flat_map(|s| s.split(';'))
            .filter(|s| s.starts_with('.'))
            .collect();
        if !extensions.is_empty()
            && files.iter().any(|p| {
                !extensions.iter().any(|ext| {
                    p.to_string_lossy()
                        .to_lowercase()
                        .ends_with(&ext.to_lowercase())
                })
            })
        {
            return;
        }
        let _ = state.update(cx, |state, cx| {
            state.files = files;
            cx.notify();
        });
        cx.update(App::refresh_windows);
    })
    .detach();
}
