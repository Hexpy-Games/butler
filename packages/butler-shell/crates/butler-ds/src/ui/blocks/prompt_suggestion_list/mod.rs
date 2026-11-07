//! DS PromptSuggestionList (PromptSuggestionList.tsx, PromptSuggestionCard.tsx,
//! usePromptContentRect.ts, PromptSuggestionList.module.css): the new-chat empty state. A header
//! (moment, title icon, title, description), an optional wallpaper behind it and a horizontal
//! rail of tall tinted-glass suggestion cards.
//!
//! The wallpaper is given as a builder that receives the rect the header and the visible cards
//! take, which the wallpaper keeps readable (`Wallpaper contentRect`). A caller that draws the
//! wallpaper elsewhere (ConversationShell `background`) takes the same rect through
//! [`PromptSuggestionList::on_content_rect`].
mod card;
mod content_rect;
mod glass;
mod header;
mod metrics;
mod rail;
mod text;

use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement as _, Pixels, RenderOnce, SharedString,
    Styled as _, Window, div, px,
};

pub use content_rect::ContentRect;

use super::measure;
use crate::tokens::Length;
use crate::ui::context::Ds;
use metrics::Metrics;

/// `--prompt-card-lift`: how far a hovered or focused card rises.
const LIFT: f32 = 2.; // DS: PromptSuggestionList.module.css:157

type Select = Rc<dyn Fn(&mut Window, &mut App)>;
type TitleIcon = Rc<dyn Fn(Pixels) -> AnyElement>;
type Wallpaper = Rc<dyn Fn(Option<ContentRect>, &App) -> AnyElement>;
type Report = Rc<dyn Fn(Option<ContentRect>, &mut Window, &mut App)>;

/// One suggestion (`PromptSuggestionItem`).
#[derive(Clone)]
pub struct PromptSuggestionItem {
    id: SharedString,
    title: SharedString,
    description: SharedString,
    text: SharedString,
    meta: Option<SharedString>,
    disabled: bool,
    on_select: Option<Select>,
}

impl PromptSuggestionItem {
    /// `id` is stable; `text` is the prompt the suggestion stands for.
    pub fn new(
        id: impl Into<SharedString>,
        title: impl Into<SharedString>,
        description: impl Into<SharedString>,
        text: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            description: description.into(),
            text: text.into(),
            meta: None,
            disabled: false,
            on_select: None,
        }
    }

    /// The marker on top of the card, in place of its two-digit ordinal.
    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    pub fn on_select(mut self, on_select: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_select = Some(Rc::new(on_select));
        self
    }

    /// The prompt the suggestion stands for.
    pub fn text(&self) -> &SharedString {
        &self.text
    }
}

#[derive(IntoElement)]
pub struct PromptSuggestionList {
    id: SharedString,
    title: SharedString,
    suggestions: Vec<PromptSuggestionItem>,
    description: Option<SharedString>,
    moment: Option<SharedString>,
    title_icon: Option<TitleIcon>,
    wallpaper: Option<Wallpaper>,
    on_content_rect: Option<Report>,
}

impl PromptSuggestionList {
    pub fn new(
        id: impl Into<SharedString>,
        title: impl Into<SharedString>,
        suggestions: Vec<PromptSuggestionItem>,
    ) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            suggestions,
            description: None,
            moment: None,
            title_icon: None,
            wallpaper: None,
            on_content_rect: None,
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// The time label beside the three-dot marker.
    pub fn moment(mut self, moment: impl Into<SharedString>) -> Self {
        self.moment = Some(moment.into());
        self
    }

    /// The icon beside the title (in the moment row when compact), drawn at the side it is
    /// given.
    pub fn title_icon(mut self, icon: impl Fn(Pixels) -> AnyElement + 'static) -> Self {
        self.title_icon = Some(Rc::new(icon));
        self
    }

    /// A full-size wallpaper behind the prompt, drawn from the rect the text takes (`None`
    /// until measured).
    pub fn wallpaper(
        mut self,
        wallpaper: impl Fn(Option<ContentRect>, &App) -> AnyElement + 'static,
    ) -> Self {
        self.wallpaper = Some(Rc::new(wallpaper));
        self
    }

    /// External wallpaper: the caller draws it and gets the text to keep readable, as
    /// `Wallpaper contentRect` wants it, each new value once.
    pub fn on_content_rect(
        mut self,
        report: impl Fn(Option<ContentRect>, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_content_rect = Some(Rc::new(report));
        self
    }

    fn element_id(&self, name: &'static str) -> ElementId {
        (ElementId::from(self.id.clone()), name).into()
    }
}

impl RenderOnce for PromptSuggestionList {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (size, tracker) = measure::track(self.element_id("root"), window, cx);
        // Nothing is measured without a wallpaper or a report to hand it to.
        let recording = (self.wallpaper.is_some() || self.on_content_rect.is_some())
            .then(content_rect::Recording::default);
        let rect_id = self.element_id("rect");
        let rect = content_rect::last(&rect_id, window, cx);
        let m = Metrics::new(f32::from(size.width), Ds::get(cx), cx);
        let header = header::render(&self, &m, recording.as_ref(), cx);
        let rail = rail::render(&self, &m, recording.as_ref(), window, cx);
        let wallpaper = self.wallpaper.as_ref().map(|draw| {
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(draw(rect, cx))
        });
        let reporter = recording.map(|recording| {
            content_rect::reporter(
                recording,
                &rect_id,
                self.on_content_rect.clone(),
                window,
                cx,
            )
        });
        let gap = Ds::get(cx).len(Length::SpaceLg);
        let mut root = div()
            .relative()
            .flex()
            .flex_col()
            .flex_none()
            .w_full()
            .min_w_0()
            .gap(gap)
            .pt(px(m.top));
        if let Some(height) = m.height {
            root = root.h(px(height));
        }
        root.children(wallpaper)
            .child(header)
            .child(rail)
            .child(tracker)
            .children(reporter)
    }
}
