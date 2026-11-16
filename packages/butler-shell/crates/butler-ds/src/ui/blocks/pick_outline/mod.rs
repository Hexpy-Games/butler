//! DS PickOutline (PickOutline.tsx / PickOutline.module.css): the user's pick marks, drawn in the
//! transparent overlay layer above a page (never in the page): a dashed outline with a size tag
//! on the element under the pointer, and solid tinted outlines with an index badge on the picks,
//! numbered in pick order. Every mark is the pick ink between white keylines, so it reads 3:1 on
//! white, black and photo pages (`pickOutlineContrast.test.ts`; the tokens are the same in both
//! themes, so the marks are always the light inks).
//!
//! Pure presenter: the caller passes rects in page coordinates and the scale from page pixels to
//! layer pixels, and keeps them current as the page scrolls or re-lays out. The hover tag sits
//! above the outline's end, inside the outline at the layer's top edge and at the outline's start
//! near the left edge; badges stay inside the layer. The hover outline fades in and a new badge
//! pops in once; reduced motion (the DS setting or `reduced_motion`) drops both.
//!
//! CSS `box-shadow` keylines (outside and inset) are two bordered boxes around and inside the
//! stroke: gpui shadows have no inset form and paint under a translucent tint.
mod marks;

use gpui::{
    App, ElementId, IntoElement, ParentElement as _, RenderOnce, SharedString, Styled as _, Window,
    div, px,
};

use crate::ui::context::Ds;
use crate::ui::strut;
use marks::Scaled;

/// A rectangle in page coordinates (CSS pixels of the page).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PickRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl PickRect {
    pub fn new(x: f32, y: f32, width: f32, height: f32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
}

/// A picked element.
#[derive(Clone, Debug)]
pub struct PickOutlinePick {
    /// Stable per pick (its badge pops in once).
    pub id: SharedString,
    pub rect: PickRect,
    /// Scrolled out of view: no outline or badge, and the other picks keep their numbers.
    pub hidden: bool,
}

impl PickOutlinePick {
    pub fn new(id: impl Into<SharedString>, rect: PickRect) -> Self {
        Self {
            id: id.into(),
            rect,
            hidden: false,
        }
    }

    pub fn hidden(mut self, hidden: bool) -> Self {
        self.hidden = hidden;
        self
    }
}

#[derive(IntoElement)]
pub struct PickOutline {
    id: ElementId,
    width: f32,
    height: f32,
    scale: f32,
    hover: Option<PickRect>,
    hover_label: Option<SharedString>,
    picks: Vec<PickOutlinePick>,
    reduced_motion: bool,
}

impl PickOutline {
    /// `width` and `height`: the layer's size in layer pixels (badges stay inside it).
    pub fn new(id: impl Into<ElementId>, width: f32, height: f32) -> Self {
        Self {
            id: id.into(),
            width,
            height,
            scale: 1.,
            hover: None,
            hover_label: None,
            picks: Vec::new(),
            reduced_motion: false,
        }
    }

    /// Layer pixels per page pixel; every rect is multiplied by it. Default 1.
    pub fn scale(mut self, scale: f32) -> Self {
        self.scale = scale;
        self
    }

    /// The element under the pointer while picking: a dashed outline.
    pub fn hover(mut self, rect: PickRect) -> Self {
        self.hover = Some(rect);
        self
    }

    /// The hover tag ("div.card · 158 × 236"); omit for no tag.
    pub fn hover_label(mut self, label: impl Into<SharedString>) -> Self {
        self.hover_label = Some(label.into());
        self
    }

    /// Picked elements in pick order: solid outlines with their 1-based index.
    pub fn picks(mut self, picks: impl IntoIterator<Item = PickOutlinePick>) -> Self {
        self.picks.extend(picks);
        self
    }

    /// Forces reduced motion (no fade or pop); otherwise the DS setting applies.
    pub fn reduced_motion(mut self) -> Self {
        self.reduced_motion = true;
        self
    }
}

impl RenderOnce for PickOutline {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let still = self.reduced_motion || Ds::get(cx).reduced_motion();
        let layer = marks::Layer {
            id: self.id.clone(),
            width: self.width,
            height: self.height,
            still,
        };
        let scaled = |rect: PickRect| Scaled::new(rect, self.scale);
        let mut children = Vec::new();
        for pick in self.picks.iter().filter(|pick| !pick.hidden) {
            children.push(marks::picked(&layer, scaled(pick.rect), Ds::get(cx)));
        }
        if let Some(rect) = self.hover {
            let label = self.hover_label.clone();
            children.push(marks::hover(&layer, (scaled(rect), label), window, cx));
        }
        // The number counts hidden picks too: they keep their place in the order.
        for (index, pick) in self.picks.iter().enumerate() {
            if !pick.hidden {
                let at = (&pick.id, index + 1, scaled(pick.rect));
                children.push(marks::badge(&layer, at, window, cx));
            }
        }
        strut::scope(
            false,
            div()
                .absolute()
                .top(px(0.))
                .left(px(0.))
                .size_full()
                .overflow_hidden()
                .children(children),
        )
    }
}
