//! DS StatusCapsule (StatusCapsule.tsx / StatusCapsule.module.css): a glass pill that
//! summarises running work above the composer: title · detail · progress, each part
//! truncating within its own cap (`--status-capsule-title-max`, `-detail-max`).
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, IntoElement, ParentElement, RenderOnce, SharedString,
    Styled as _, Window, div,
};

use crate::tokens::Length;
use crate::ui::context::Ds;
use crate::ui::pill_button::{PillButton, Surface};
use crate::ui::typo::{Tone, Typo, Weight, Wrap};

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct StatusCapsule {
    id: ElementId,
    icon: Option<AnyElement>,
    title: SharedString,
    detail: Option<SharedString>,
    progress: Option<SharedString>,
    on_click: Option<Handler>,
}

impl StatusCapsule {
    /// `title` is what the work is; it truncates first.
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            icon: None,
            title: title.into(),
            detail: None,
            progress: None,
            on_click: None,
        }
    }

    /// A leading mark (an animated thinking mark, a spinner).
    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    /// What it is doing now (secondary).
    pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// A step count such as 2/3 (tabular).
    pub fn progress(mut self, progress: impl Into<SharedString>) -> Self {
        self.progress = Some(progress.into());
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

/// The `·` between parts.
fn dot() -> Typo {
    Typo::text("·").tone(Tone::Tertiary).wrap(Wrap::Nowrap)
}

impl RenderOnce for StatusCapsule {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let (title_max, detail_max) = (
            ds.len(Length::StatusCapsuleTitleMax),
            ds.len(Length::StatusCapsuleDetailMax),
        );
        let (has_detail, has_progress) = (self.detail.is_some(), self.progress.is_some());
        let title = div()
            .flex_auto()
            .min_w_0()
            .max_w(title_max)
            .child(Typo::text(self.title).truncate().weight(Weight::Regular));
        let detail = self.detail.map(|detail| {
            div()
                .flex_none()
                .min_w_0()
                .max_w(detail_max)
                .child(Typo::text(detail).truncate().tone(Tone::Secondary))
        });
        let content = div()
            .flex()
            .flex_auto()
            .items_center()
            .min_w_0()
            .max_w_full()
            .gap(ds.len(Length::Space1))
            .child(title)
            .children(has_detail.then(dot))
            .children(detail)
            .children(has_progress.then(dot))
            .children(self.progress.map(|progress| {
                Typo::text(progress)
                    .tabular()
                    .tone(Tone::Tertiary)
                    .wrap(Wrap::Nowrap)
            }));
        let mut pill = PillButton::new(self.id)
            .surface(Surface::Glass)
            .child(content);
        if let Some(icon) = self.icon {
            pill = pill.icon(icon);
        }
        if let Some(handler) = self.on_click {
            pill = pill.on_click(move |event, window, cx| handler(event, window, cx));
        }
        pill
    }
}
