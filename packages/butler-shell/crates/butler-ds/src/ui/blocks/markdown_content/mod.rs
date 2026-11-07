//! DS MarkdownContent (MarkdownContent.tsx, MarkdownLink.tsx, MarkdownParts.tsx, CodeFrame.tsx,
//! streamingReveal.ts, MarkdownContent.module.css): Butler document typography for rendered
//! markdown. React's block takes the tree react-markdown rendered; here the block takes the
//! markdown source and renders it through [`crate::ui::markdown`] (GFM, the punctuation-bold fix,
//! syntax colours), with the same components: `MarkdownLink`, `MarkdownTable`,
//! `MarkdownCodeFrame` and the streaming reveal.
mod code;
mod flow;
mod image;
mod inline;
mod layout;
mod link;
mod marker;
mod reveal;
mod table;

use std::rc::Rc;

use gpui::{
    App, ElementId, ImageSource, IntoElement, ParentElement as _, Pixels, RenderOnce, SharedString,
    Styled as _, Window, div,
};

pub use code::{CodeFrame, MarkdownCodeFrame, code_text};
pub use reveal::{Reveal, track as track_reveal};

use crate::tokens::{Color, Length};
use crate::ui::context::{Ds, Lang, keep_words};
use crate::ui::markdown::{Block, parse};

/// `density`: `document` is the reading rhythm of a reply; `compact` is for a dense pane (a detail
/// aside, a card): body line height, block gaps one step down.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Density {
    #[default]
    Document,
    Compact,
}

/// A text face: its size and line height.
#[derive(Clone, Copy)]
pub(super) struct Face {
    pub(super) size: Pixels,
    pub(super) line: Pixels,
}

/// Maps an external href to a favicon (`MarkdownFaviconSource`); `None` shows the globe.
pub type Favicon = Rc<dyn Fn(&str) -> Option<ImageSource>>;

/// Resolves a Markdown image `src` to what gpui loads (`MessageInlineImage`: a message file
/// fetched through the app's client); `None` falls back to loading `src` as it is.
pub type ImageResolver = Rc<dyn Fn(&str) -> Option<ImageSource>>;

/// What the blocks below share while one document renders.
#[derive(Clone)]
pub(super) struct Env {
    pub(super) reveal: Option<Reveal>,
    pub(super) favicon: Option<Favicon>,
    pub(super) image: Option<ImageResolver>,
    /// The copy button's label and its copied label; no button without them.
    pub(super) copy: Option<(SharedString, SharedString)>,
    pub(super) density: Density,
    pub(super) viewport_height: f32,
    /// The token the text is drawn in (`--text-primary`, secondary inside a quote).
    pub(super) ink: Color,
    /// How many lists the item being drawn sits in.
    pub(super) depth: usize,
}

impl Env {
    pub(super) fn ink(&self, ink: Color) -> Self {
        Self {
            ink,
            ..self.clone()
        }
    }
}

#[derive(IntoElement)]
pub struct MarkdownContent {
    id: ElementId,
    source: SharedString,
    density: Density,
    favicon: Option<Favicon>,
    image: Option<ImageResolver>,
    streaming: Option<bool>,
    copy: Option<(SharedString, SharedString)>,
}

impl MarkdownContent {
    pub fn new(id: impl Into<ElementId>, source: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            source: source.into(),
            density: Density::Document,
            favicon: None,
            image: None,
            streaming: None,
            copy: None,
        }
    }

    pub fn density(mut self, density: Density) -> Self {
        self.density = density;
        self
    }

    /// Favicons of external links (`faviconSrc`); omitted, every link shows the globe.
    pub fn favicon(mut self, favicon: impl Fn(&str) -> Option<ImageSource> + 'static) -> Self {
        self.favicon = Some(Rc::new(favicon));
        self
    }

    /// Image sources (`MessageInlineImage`): the app resolves message-file `src`s it can load.
    pub fn image_source(mut self, resolve: impl Fn(&str) -> Option<ImageSource> + 'static) -> Self {
        self.image = Some(Rc::new(resolve));
        self
    }

    /// `useStreamingReveal(text, streaming)`: while `streaming`, each chunk the source grows by
    /// fades in.
    pub fn streaming(mut self, streaming: bool) -> Self {
        self.streaming = Some(streaming);
        self
    }

    /// The copy action of a fenced block's header: its label and its copied label.
    pub fn copy_code(
        mut self,
        label: impl Into<SharedString>,
        copied: impl Into<SharedString>,
    ) -> Self {
        self.copy = Some((label.into(), copied.into()));
        self
    }
}

/// The parsed document of the source last seen.
#[derive(Default)]
struct Parsed {
    source: SharedString,
    blocks: Rc<Vec<Block>>,
}

impl RenderOnce for MarkdownContent {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let state =
            window.use_keyed_state((self.id.clone(), "parsed"), cx, |_, _| Parsed::default());
        if state.read(cx).source != self.source || state.read(cx).blocks.is_empty() {
            let blocks = Rc::new(parse(&self.source));
            state.update(cx, |parsed, _| {
                parsed.source = self.source.clone();
                parsed.blocks = blocks;
            });
        }
        let blocks = state.read(cx).blocks.clone();
        let reveal = self
            .streaming
            .map(|on| track_reveal(self.id.clone(), &self.source, on, window, cx));
        let viewport_height = f32::from(window.viewport_size().height);
        let env = Env {
            reveal,
            favicon: self.favicon,
            image: self.image,
            copy: self.copy,
            density: self.density,
            viewport_height,
            ink: Color::TextPrimary,
            depth: 0,
        };
        let key = format!("{:?}", self.id);
        let body = layout::blocks(
            &blocks,
            layout::Nest {
                top: true,
                item: false,
            },
            &env,
            &key,
            window,
            cx,
        );
        let ds = Ds::get(cx);
        let line = match self.density {
            Density::Document => Length::TypoBodyLineHeightDocument,
            Density::Compact => Length::TypoBodyLineHeight,
        };
        let root = div().min_w_0();
        let root = if ds.lang() == Lang::Ko {
            keep_words(root)
        } else {
            root
        };
        root.text_color(ds.color(Color::TextPrimary))
            .text_size(ds.len(Length::FontSize3))
            .line_height(ds.len(line))
            .child(body)
    }
}
