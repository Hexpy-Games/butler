//! ChoiceCard.showcase.tsx: top choices, the equal-size tile grid, radio rows (local models, with
//! and without a server row) and the loading and error rows. ProviderLogo is a stand-in
//! (`standins_overlay.rs`). The React state matrix has no counterpart in the viewer.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::choice_card::{
    ChoiceCard, ChoiceCardList, ChoiceState, ChoiceTile, ChoiceTileGrid, glyph,
};
use butler_ds::ui::tag::{Tag, Tone};
use gpui::{AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Window};

use super::{Story, sub};
use crate::copy::Lang;
use crate::standins_overlay::provider_logo;

struct Copy {
    sign_in: &'static str,
    claude: &'static str,
    gemini: &'static str,
    computer: &'static str,
    models: &'static str,
    zai: &'static str,
    zai_key: &'static str,
    other: &'static str,
    own: &'static str,
    grok: &'static str,
    kimi: &'static str,
    in_use: &'static str,
    openai_key: &'static str,
    connecting: &'static str,
    failed: &'static str,
    custom: &'static str,
    custom_body: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            sign_in: "Sign in with ChatGPT",
            claude: "Use an Anthropic API key",
            gemini: "Use a Google AI Studio key",
            computer: "This computer",
            models: "2 models · Ollama",
            zai: "Z.AI Coding Plan",
            zai_key: "Coding Plan key",
            other: "Other (OpenAI-compatible)",
            own: "Your own server",
            grok: "xAI API key",
            kimi: "Moonshot API key",
            in_use: "In use",
            openai_key: "OpenAI API key",
            connecting: "Connecting…",
            failed: "Key didn't work",
            custom: "Enter a server",
            custom_body: "Address of an OpenAI-compatible server",
        },
        Copy {
            sign_in: "ChatGPT 계정으로 로그인",
            claude: "Anthropic API 키로 연결",
            gemini: "Google AI Studio 키로 연결",
            computer: "이 컴퓨터",
            models: "모델 2개 · Ollama",
            zai: "Z.AI 코딩 플랜",
            zai_key: "코딩 플랜 키",
            other: "기타 (OpenAI 호환)",
            own: "직접 서버 입력",
            grok: "xAI API 키",
            kimi: "Moonshot API 키",
            in_use: "사용 중",
            openai_key: "OpenAI API 키",
            connecting: "연결 중…",
            failed: "키를 확인하지 못했습니다",
            custom: "직접 서버 입력",
            custom_body: "OpenAI 호환 서버 주소",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Top choices",
            render: top_choices,
        },
        Story {
            name: "More choices grid (equal-size tiles, long names wrap to two lines)",
            render: tile_grid,
        },
        Story {
            name: "Radio rows (local models)",
            render: |lang, window, cx| picker(lang, "cc-radio", false, window, cx),
        },
        Story {
            name: "Mixed one-line and two-line rows (Other: local models and a server)",
            render: |lang, window, cx| picker(lang, "cc-mixed", true, window, cx),
        },
        Story {
            name: "Loading and error (trailing spinner and mark centered)",
            render: loading_and_error,
        },
    ]
}

fn top_choices(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    ChoiceCardList::new()
        .child(
            ChoiceCard::new("cc-top-chatgpt", provider_logo("openai"), "ChatGPT")
                .description(c.sign_in),
        )
        .child(
            ChoiceCard::new("cc-top-claude", provider_logo("claude"), "Claude")
                .description(c.claude),
        )
        .child(
            ChoiceCard::new("cc-top-gemini", provider_logo("gemini"), "Gemini")
                .description(c.gemini),
        )
        .child(
            ChoiceCard::new("cc-top-other", glyph(Icon::Server, cx), c.other)
                .tag(Tag::new("cc-top-tag", c.in_use).tone(Tone::Accent))
                .selected(true)
                .description(c.models),
        )
        .into_any_element()
}

fn tile_grid(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    ChoiceTileGrid::new("cc-grid")
        .child(
            ChoiceTile::new("cc-tile-openai", provider_logo("openai"), "OpenAI API")
                .description(c.openai_key),
        )
        .child(ChoiceTile::new("cc-tile-grok", provider_logo("grok"), "Grok").description(c.grok))
        .child(
            ChoiceTile::new("cc-tile-kimi", provider_logo("kimi"), "Kimi")
                .description(c.kimi)
                .state(ChoiceState::Loading),
        )
        .child(ChoiceTile::new("cc-tile-zai", provider_logo("zai"), c.zai).description(c.zai_key))
        .child(
            ChoiceTile::new("cc-tile-other", glyph(Icon::Server, cx), c.other).description(c.own),
        )
        .into_any_element()
}

fn choose(
    entity: &Entity<SharedString>,
    value: &'static str,
) -> impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static {
    let entity = entity.clone();
    move |_, _, cx| {
        entity.update(cx, |current, cx| {
            *current = value.into();
            cx.notify();
        });
    }
}

/// Radio rows: a model per row with its size, and optionally a row for a server.
fn picker(
    lang: Lang,
    id: &'static str,
    server: bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let c = copy(lang);
    let selected = window.use_keyed_state(sub(id, "selected"), cx, |_, _| {
        SharedString::new_static("Local 8B")
    });
    let current = selected.read(cx).clone();
    let mut list = ChoiceCardList::new();
    for (model, size) in [("Local 8B", "5.2 GB"), ("Local 12B", "8.1 GB")] {
        list = list.child(
            ChoiceCard::new(sub(id, model), provider_logo("ollama"), model)
                .chevron(false)
                .meta(size)
                .selected(current == model)
                .on_click(choose(&selected, model)),
        );
    }
    if server {
        list = list.child(
            ChoiceCard::new(sub(id, "server"), glyph(Icon::Server, cx), c.custom)
                .chevron(false)
                .description(c.custom_body)
                .selected(current == "server")
                .on_click(choose(&selected, "server")),
        );
    }
    list.into_any_element()
}

fn loading_and_error(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    ChoiceCardList::new()
        .child(
            ChoiceCard::new("cc-load-claude", provider_logo("claude"), "Claude")
                .description(c.connecting)
                .state(ChoiceState::Loading),
        )
        .child(
            ChoiceCard::new("cc-load-computer", glyph(Icon::Server, cx), c.computer)
                .state(ChoiceState::Loading),
        )
        .child(
            ChoiceCard::new("cc-load-gemini", provider_logo("gemini"), "Gemini")
                .description(c.failed)
                .state(ChoiceState::Error),
        )
        .child(
            ChoiceCard::new("cc-load-ollama", provider_logo("ollama"), "Local 8B")
                .chevron(false)
                .meta("5.2 GB"),
        )
        .into_any_element()
}
