//! `CodeFrame` and `MarkdownCodeFrame` (`CodeFrame.tsx`, `MarkdownParts.tsx`): the hairline frame
//! a fenced block sits in, with its header bar (language and actions) over a `pre` that scrolls
//! sideways with edge fades. The highlighted code is memoized per language and text.
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, FontStyle, Global, HighlightStyle, IntoElement, ParentElement,
    RenderOnce, SharedString, Styled as _, StyledText, Window, div, relative,
};

use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::markdown::{Role, Token, highlight};
use crate::ui::scroll::engine::{self, Axis, Config};

/// The code frame alone: border, panel radius, raised surface (`CodeFrame.module.css`).
#[derive(IntoElement)]
pub struct CodeFrame {
    children: Vec<AnyElement>,
}

impl CodeFrame {
    pub fn new() -> Self {
        Self {
            children: Vec::new(),
        }
    }
}

impl Default for CodeFrame {
    fn default() -> Self {
        Self::new()
    }
}

impl ParentElement for CodeFrame {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for CodeFrame {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        div()
            .min_w_0()
            .overflow_hidden()
            .border(ds.len(Length::BorderHairline))
            .border_color(ds.color(Color::Line))
            .rounded(ds.len(Length::RadiusPanel))
            .bg(ds.color(Color::SurfaceRaised))
            .children(self.children)
    }
}

/// The highlighted tokens of recent code blocks, by language and text.
#[derive(Default)]
struct Cache(HashMap<(String, String), Option<Rc<Vec<Token>>>>);

impl Global for Cache {}

/// Entries kept: a chat shows a handful of blocks at once.
const CACHE_LIMIT: usize = 64;

fn tokens(code: &str, language: &str, cx: &mut App) -> Option<Rc<Vec<Token>>> {
    let cache = cx.default_global::<Cache>();
    let key = (language.to_owned(), code.to_owned());
    if let Some(found) = cache.0.get(&key) {
        return found.clone();
    }
    if cache.0.len() >= CACHE_LIMIT {
        cache.0.clear();
    }
    let found = highlight(code, language).map(Rc::new);
    cache.0.insert(key, found.clone());
    found
}

fn role_color(role: Role) -> Color {
    match role {
        Role::Keyword => Color::SyntaxKeyword,
        Role::String => Color::SyntaxString,
        Role::Comment => Color::SyntaxComment,
        Role::Number => Color::SyntaxNumber,
        Role::Title => Color::SyntaxTitle,
        Role::Type => Color::SyntaxType,
        Role::Variable => Color::SyntaxVariable,
        Role::Meta => Color::SyntaxMeta,
        Role::Addition => Color::SyntaxAddition,
        Role::Deletion => Color::SyntaxDeletion,
    }
}

/// The text of a code block and its syntax colours (`data-syntax` spans): comments italic.
fn code_highlights(
    code: &str,
    language: Option<&str>,
    cx: &mut App,
) -> (SharedString, Vec<(Range<usize>, HighlightStyle)>) {
    let shown = code.strip_suffix('\n').unwrap_or(code);
    let found = language.and_then(|language| tokens(code, language, cx));
    let ds = Ds::get(cx);
    let highlights = found
        .iter()
        .flat_map(|tokens| tokens.iter())
        .filter(|token| token.range.start < shown.len())
        .map(|token| {
            let range = token.range.start..token.range.end.min(shown.len());
            let style = HighlightStyle {
                color: Some(ds.color(role_color(token.role))),
                font_style: (token.role == Role::Comment).then_some(FontStyle::Italic),
                ..HighlightStyle::default()
            };
            (range, style)
        })
        .collect();
    (SharedString::from(shown.to_owned()), highlights)
}

/// The text of a code block with its syntax colours.
pub fn code_text(code: &str, language: Option<&str>, cx: &mut App) -> StyledText {
    let (text, highlights) = code_highlights(code, language, cx);
    StyledText::new(text).with_highlights(highlights)
}

/// A fenced code block: the frame, a header bar with the language and `actions`, and the code.
#[derive(IntoElement)]
pub struct MarkdownCodeFrame {
    id: ElementId,
    language: Option<SharedString>,
    actions: Option<AnyElement>,
    code: SharedString,
}

impl MarkdownCodeFrame {
    pub fn new(id: impl Into<ElementId>, code: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            language: None,
            actions: None,
            code: code.into(),
        }
    }

    /// The language label of the header and the grammar the code is highlighted with.
    pub fn language(mut self, language: impl Into<SharedString>) -> Self {
        self.language = Some(language.into());
        self
    }

    /// Header actions, usually one copy button.
    pub fn actions(mut self, actions: impl IntoElement) -> Self {
        self.actions = Some(actions.into_any_element());
        self
    }
}

impl RenderOnce for MarkdownCodeFrame {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let language = self.language.clone();
        let (text, highlights) = code_highlights(&self.code, language.as_deref(), cx);
        let body = crate::ui::selectable::selectable(
            (self.id.clone(), "select"),
            &text,
            highlights,
            gpui::IntoElement::into_any_element,
            window,
            cx,
        );
        let ds = Ds::get(cx);
        let code_font = ds.code_font().clone();
        let header = div()
            .flex()
            .items_center()
            .justify_between()
            .gap(ds.len(Length::Space2))
            .min_h(ds.len(Length::ControlHeightMd))
            .pl(ds.len(Length::Space4))
            .pr(ds.len(Length::Space1))
            .border_b(ds.len(Length::BorderHairline))
            .border_color(ds.color(Color::Line))
            .text_color(ds.color(Color::TextTertiary))
            .text_size(ds.len(Length::FontSize2))
            .line_height(ds.len(Length::TypoLabelLineHeight))
            .child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .text_size(ds.len(Length::TypoCodeSize))
                    .line_height(ds.len(Length::TypoCodeLineHeight))
                    .font_family(code_font.family.clone())
                    .child(language.unwrap_or_default()),
            )
            .children(self.actions);
        let mut pre = div()
            .flex_none()
            .min_w(relative(1.))
            .p(ds.len(Length::Space4))
            .whitespace_nowrap()
            .text_size(ds.len(Length::TypoCodeSize))
            .line_height(ds.len(Length::TypoCodeLineHeight))
            .font_family(code_font.family.clone())
            .child(body);
        pre.text_style()
            .font_fallbacks
            .clone_from(&code_font.fallbacks);
        let config = Config {
            id: (self.id.clone(), "code").into(),
            axis: Axis::X,
            size: ds.len(Length::ScrollFadeSize),
            guard: ds.len(Length::SpaceXs),
        };
        let scroller = engine::scroller(&config, pre, window, cx);
        CodeFrame::new().child(header).child(scroller.element)
    }
}
