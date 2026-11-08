//! The import step's three screens: the detected tools, one tool's items, and the result
//! (`FirstRunAgentStep`, `FirstRunAgentItems`, `FirstRunAgentResult`, `AgentGlyph`).
use butler_ds::ui::blocks::check_card::{CheckCard, CheckCardList};
use butler_ds::ui::blocks::empty_line::EmptyLine;
use butler_ds::ui::blocks::list_row::ListRow;
use butler_ds::ui::blocks::setup_wizard_step_card::SetupWizardStepAction;
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Inline, Space, Stack};
use butler_ds::ui::provider_logo::{ProviderLogo, ProviderLogoName};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::tooltip::Tooltip;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, App, Context, IntoElement as _, ParentElement as _, SharedString, Styled as _,
    Window,
};

use super::copy::{Words, added, found, items_progress, items_title, needs_key, words};
use super::{Counts, Source};
use crate::ui::Icon;
use crate::ui::onboarding::Onboarding;
use crate::ui::onboarding::card::step_card;
use crate::ui::onboarding::copy::words as shared;

pub(crate) fn screen(
    view: &Onboarding,
    window: &mut Window,
    cx: &mut Context<Onboarding>,
) -> AnyElement {
    let _ = window;
    let imports = view.imports.read(cx);
    if imports.done() {
        return result(view, cx);
    }
    match imports.current() {
        Some(source) => items(view, &source, cx),
        None => tools(view, cx),
    }
}

/// `AgentGlyph`: the brand logo of a tool Butler imports from, or the neutral bot icon.
fn glyph(key: &str, cx: &App) -> AnyElement {
    let logo = match key {
        "claude-code" => ProviderLogoName::Claude,
        "codex" => ProviderLogoName::OpenAi,
        "opencode" => ProviderLogoName::OpenCode,
        _ => return icon(Icon::Bot, IconSize::Md, Ds::get(cx)).into_any_element(),
    };
    ProviderLogo::new(logo).into_any_element()
}

fn failed(text: &Words) -> AnyElement {
    Typo::caption(text.failed)
        .tone(Tone::Danger)
        .into_any_element()
}

/// The detected tools as pick cards, picked when they hold something.
fn tools(view: &Onboarding, cx: &mut Context<Onboarding>) -> AnyElement {
    let (sources, chosen, busy, error, picked) = {
        let imports = view.imports.read(cx);
        (
            imports.sources.clone(),
            imports.chosen(),
            imports.busy,
            imports.error,
            imports.tools().len(),
        )
    };
    let lang = view.lang;
    let text = words(lang);
    let empty = sources
        .as_ref()
        .is_some_and(|list| !error && !list.iter().any(Source::importable));
    let mut body = Vec::new();
    match &sources {
        None => body.push(
            Inline::new()
                .child(Spinner::new("first-run-agents-spinner").size(14.))
                .child(Typo::caption(text.searching).tone(Tone::Secondary))
                .into_any_element(),
        ),
        Some(_) if empty => body.push(EmptyLine::new(text.agents_empty).into_any_element()),
        Some(list) => {
            let cards = list
                .iter()
                .map(|source| tool_card(view, source, &chosen, busy, lang, cx));
            body.push(CheckCardList::new().children(cards).into_any_element());
        }
    }
    if error {
        body.push(failed(text));
    }
    let next = SetupWizardStepAction::new("first-run-agents-next", text.next)
        .forward()
        .on_click(cx.listener(move |view, _, _, cx| {
            if empty {
                view.finish_import(cx);
            } else {
                view.imports
                    .update(cx, |imports, cx| imports.open(Some(0), cx));
            }
        }));
    let next = if !empty && picked == 0 {
        next.disabled()
    } else {
        next
    };
    let card = step_card(view, "agents", text.agents_title, body, cx)
        .description(text.agents_body)
        .on_back(
            shared(lang).back,
            cx.listener(|view, _, _, cx| view.back_from_import(cx)),
        );
    // The harness's way past the step: Skip, or Next when nothing was found.
    let leave = |action| {
        crate::ui::widgets::control_anchor(gpui::div().flex(), "first-run-agents-skip", true)
            .child(action)
    };
    if empty {
        return card.action(leave(next)).into_any_element();
    }
    let skip = leave(
        SetupWizardStepAction::new("first-run-agents-skip", text.skip)
            .on_click(cx.listener(|view, _, _, cx| view.finish_import(cx))),
    );
    let next = if picked == 0 {
        Tooltip::new("first-run-agents-pick-one")
            .label(text.pick_one)
            .child(next)
            .into_any_element()
    } else {
        next.into_any_element()
    };
    card.action(skip).action(next).into_any_element()
}

fn tool_card(
    view: &Onboarding,
    source: &Source,
    chosen: &[String],
    busy: bool,
    lang: Lang,
    cx: &App,
) -> CheckCard {
    let importable = source.importable();
    let imports = view.imports.clone();
    let key = source.key.clone();
    let mut card = CheckCard::new(
        SharedString::from(format!("first-run-agent-{}", source.key)),
        source.name.clone(),
        importable && chosen.contains(&source.key),
        move |_, _, cx| imports.update(cx, |imports, cx| imports.toggle_tool(&key, cx)),
    )
    .icon(glyph(&source.key, cx))
    .description(found(lang, source.instructions, source.servers));
    if busy {
        card = card.disabled();
    }
    if !importable {
        card = card.disabled_reason(found(lang, false, 0));
    }
    card
}

/// One page per chosen tool: its instruction file and each server as pick cards. Next opens the
/// next tool; the last page imports every tool's choice (or moves on when none is on).
fn items(view: &Onboarding, source: &Source, cx: &mut Context<Onboarding>) -> AnyElement {
    let (index, total, choice, busy, error, any_on) = {
        let imports = view.imports.read(cx);
        (
            imports.page.unwrap_or(0),
            imports.tools().len(),
            imports.choice_of(source),
            imports.busy,
            imports.error,
            imports.any_on(),
        )
    };
    let lang = view.lang;
    let text = words(lang);
    let action = if index + 1 < total {
        SetupWizardStepAction::new("first-run-agents-next", text.next)
            .forward()
            .on_click(cx.listener(move |view, _, _, cx| {
                view.imports
                    .update(cx, |imports, cx| imports.open(Some(index + 1), cx));
            }))
    } else if any_on {
        let label = if busy {
            text.importing
        } else {
            text.import_action
        };
        let import = SetupWizardStepAction::new("first-run-agents-import", label)
            .forward()
            .on_click(cx.listener(|view, _, _, cx| {
                view.imports.update(cx, super::Imports::import_all);
            }));
        if busy { import.disabled() } else { import }
    } else {
        SetupWizardStepAction::new("first-run-agents-next", text.next)
            .forward()
            .on_click(cx.listener(|view, _, _, cx| view.finish_import(cx)))
    };
    let mut body = vec![item_cards(view, source, &choice, busy, text, cx)];
    if error {
        body.push(failed(text));
    }
    step_card(
        view,
        format!("agents:{}", source.key),
        items_title(lang, &source.name),
        body,
        cx,
    )
    .description(items_progress(&source.name, index + 1, total))
    .on_back(
        shared(lang).back,
        cx.listener(move |view, _, _, cx| {
            view.imports
                .update(cx, |imports, cx| imports.open(index.checked_sub(1), cx));
        }),
    )
    .action(action)
    .into_any_element()
}

fn item_cards(
    view: &Onboarding,
    source: &Source,
    choice: &super::Choice,
    busy: bool,
    text: &Words,
    cx: &App,
) -> AnyElement {
    let mut cards = Vec::new();
    let item = source.items.instructions.first();
    let file = item.or(source.instructions_file.as_ref());
    if let Some(file) = file.filter(|file| !file.is_empty()) {
        let reason = match source.instructions_error.as_deref() {
            Some("too_large") => text.file_too_large,
            Some(_) => text.file_unreadable,
            None => text.file_empty,
        };
        let imports = view.imports.clone();
        let target = source.clone();
        let mut card = CheckCard::new(
            SharedString::from(format!("first-run-agent-{}-instructions", source.key)),
            text.item_instructions,
            item.is_some() && choice.instructions,
            move |_, _, cx| {
                imports.update(cx, |imports, cx| imports.toggle_instructions(&target, cx));
            },
        )
        .icon(icon(Icon::FileText, IconSize::Md, Ds::get(cx)))
        .description(if item.is_some() {
            file.clone()
        } else {
            format!("{file} · {reason}")
        });
        if busy {
            card = card.disabled();
        }
        if item.is_none() {
            card = card.disabled_reason(reason);
        }
        cards.push(card);
    }
    for server in &source.items.servers {
        let imports = view.imports.clone();
        let target = source.clone();
        let name = server.name.clone();
        let mut card = CheckCard::new(
            SharedString::from(format!("first-run-agent-{}-{}", source.key, server.name)),
            server.name.clone(),
            choice.servers.contains(&server.name),
            move |_, _, cx| {
                imports.update(cx, |imports, cx| imports.toggle_server(&target, &name, cx));
            },
        )
        .icon(icon(Icon::Server, IconSize::Md, Ds::get(cx)))
        .description(if server.needs_secret {
            format!("{} · {}", text.item_server, text.item_needs_key)
        } else {
            text.item_server.to_owned()
        });
        if busy {
            card = card.disabled();
        }
        cards.push(card);
    }
    CheckCardList::new().children(cards).into_any_element()
}

/// After the run: one row per imported tool, what it added and what still needs a key.
fn result(view: &Onboarding, cx: &mut Context<Onboarding>) -> AnyElement {
    let (sources, by_source) = {
        let imports = view.imports.read(cx);
        (
            imports.sources.clone().unwrap_or_default(),
            imports.by_source.clone(),
        )
    };
    let lang = view.lang;
    let text = words(lang);
    let rows = sources.iter().filter_map(|source| {
        let counts = by_source.get(&source.key)?;
        Some(
            ListRow::new(source.name.clone())
                .icon(glyph(&source.key, cx))
                .description(line(lang, counts, text))
                .into_any_element(),
        )
    });
    let body = Stack::new()
        .gap(Space::Sm)
        .children(rows)
        .into_any_element();
    step_card(view, "agents:done", text.done_title, [body], cx)
        .on_back(
            shared(lang).back,
            cx.listener(|view, _, _, cx| view.back_from_import(cx)),
        )
        .action(
            SetupWizardStepAction::new("first-run-agents-done", text.next)
                .forward()
                .on_click(cx.listener(|view, _, _, cx| view.finish_import(cx))),
        )
        .into_any_element()
}

fn line(lang: Lang, counts: &Counts, text: &Words) -> String {
    let added = if counts.instructions + counts.servers > 0 {
        added(lang, counts.instructions, counts.servers)
    } else {
        text.nothing.to_owned()
    };
    if counts.needs_secret > 0 {
        format!("{added} · {}", needs_key(lang, counts.needs_secret))
    } else {
        added
    }
}
