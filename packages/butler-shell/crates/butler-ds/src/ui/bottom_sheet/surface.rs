//! The sheet surface (BottomSheet.module.css `.surface`, `.title`, `.body`): a glass along the
//! bottom edge, full width, the grabber row, an optional title and a body that scrolls. Shared by
//! the BottomSheet and by the sheet presentation of Popover, DropdownMenu and Select.
use gpui::{
    AnyElement, Div, ElementId, FontWeight, InteractiveElement as _, IntoElement as _,
    ParentElement as _, ScrollHandle, SharedString, Stateful, StatefulInteractiveElement as _,
    Styled as _, div, px,
};

use super::state::SheetState;
use crate::tokens::{Length, Number};
use crate::ui::context::Ds;
use crate::ui::focus;
use crate::ui::tinted_glass::{GlassPadding, GlassRadius, TintedGlass};

/// A box in the column of the surface that gives up height when the surface is at its maximum,
/// so that its own content can scroll.
pub(crate) fn shrinking(el: Div) -> Div {
    el.flex().flex_col().flex_auto().min_h_0()
}

/// The scrolling body (`.body`): the rows scroll here, and its padding leaves room for the
/// focus rings of the rows. `scroll` is the handle of an owner that scrolls it itself.
pub fn body(id: impl Into<ElementId>, scroll: Option<&ScrollHandle>, ds: &Ds) -> Stateful<Div> {
    let el = shrinking(div())
        .id(id)
        .px(ds.len(Length::Space2))
        .pt(focus::room(ds))
        .pb(ds.len(Length::Space2))
        .overflow_y_scroll();
    match scroll {
        Some(handle) => el.track_scroll(handle),
        None => el,
    }
}

/// An expandable sheet rests at half the window. // DS: BottomSheet.module.css:49 (`50vh`)
const REST_SHARE: f32 = 0.5;

/// The surface's size from the window: the tallest it may be, and its detent.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Metrics {
    /// `100vh - --titlebar-safe-area-top - --sheet-keyboard-inset - --space-6`.
    pub max: f32,
    /// The resting maximum: half the window (`min(50vh, max)`) while an expandable sheet rests.
    pub resting: f32,
    pub inset: f32,
}

impl Metrics {
    pub(crate) fn new(window: (f32, f32), ds: &Ds) -> Self {
        let inset = ds.keyboard_inset();
        let max = window.1
            - f32::from(ds.len(Length::TitlebarSafeAreaTop))
            - inset
            - f32::from(ds.len(Length::Space6));
        Self {
            max: max.max(0.),
            resting: (window.1 * REST_SHARE).min(max).max(0.),
            inset,
        }
    }
}

/// What a surface is made of.
pub(crate) struct Surface {
    pub handle: AnyElement,
    pub title: Option<SharedString>,
    pub content: Vec<AnyElement>,
    /// `Some(expanded)` for an expandable sheet.
    pub expandable: Option<bool>,
    /// The `debug_selector` of the surface's box, for the geometry tables.
    pub selector: &'static str,
}

impl Surface {
    pub(crate) fn build(self, state: &SheetState, metrics: Metrics, ds: &Ds) -> AnyElement {
        let mut glass = TintedGlass::new()
            .radius(GlassRadius::Popover)
            .padding(GlassPadding::None)
            .square_bottom();
        glass = match self.expandable {
            Some(true) => glass.height(px(metrics.max)).column(px(metrics.max)),
            Some(false) => glass.column(px(metrics.resting)),
            None => glass.column(px(metrics.max)),
        };
        let title = self.title.map(|title| {
            div()
                .flex_none()
                .pt(ds.len(Length::Space1))
                .px(ds.len(Length::Space4))
                .pb(ds.len(Length::Space2))
                .text_size(ds.len(Length::TypoPanelTitleSize))
                .line_height(ds.len(Length::TypoPanelTitleLineHeight))
                .font_weight(FontWeight(ds.number(Number::TypoPanelTitleWeight)))
                .child(title)
        });
        let safe = ds.len(Length::SafeAreaBottom);
        let glass = glass
            .child(self.handle)
            .children(title)
            .children(self.content)
            .children((safe > px(0.)).then(|| div().flex_none().h(safe)));
        let selector = self.selector;
        div()
            .relative()
            .flex()
            .flex_col()
            .w_full()
            .mb(px(metrics.inset))
            .child(glass)
            .child(state.surface.probe())
            .debug_selector(|| selector.to_owned())
            .into_any_element()
    }
}
