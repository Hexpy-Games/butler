//! ManagementPagePanel and the page-background context (ManagementPage.tsx `PageBackgroundContext`,
//! `ManagementPagePanel`): a content group of a page. Over a page background it is a TintedGlass
//! surface so its text stays readable; on a plain page it is a bare column at the page's gap.
use gpui::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement,
    LayoutId, ParentElement, Pixels, RenderOnce, Styled as _, Window, div,
};

use crate::ui::context::Ds;
use crate::ui::layout::Space;
use crate::ui::strut;
use crate::ui::tinted_glass::{GlassPadding, TintedGlass};

/// The viewport width at or under which a page uses its compact rhythm (`width <= 700px`).
pub(super) const COMPACT_AT: f32 = 700.; // DS: ManagementPage.module.css:62

/// `.pageContent { gap }`: the gap between a page's children.
pub(super) fn page_gap(compact: bool) -> Space {
    if compact { Space::Lg } else { Space::Xxl }
}

#[derive(Default)]
struct Backdrops(Vec<bool>);

impl gpui::Global for Backdrops {}

/// Whether the content being laid out sits on a page with a background.
fn over_background(cx: &App) -> bool {
    cx.try_global::<Backdrops>()
        .and_then(|stack| stack.0.last().copied())
        .unwrap_or(false)
}

/// `child` laid out with the page-background flag set, as the React context provider does.
pub(super) struct Backdrop {
    on: bool,
    child: Option<AnyElement>,
}

impl Backdrop {
    pub(super) fn new(on: bool, child: impl IntoElement) -> Self {
        Self {
            on,
            child: Some(child.into_any_element()),
        }
    }
}

impl IntoElement for Backdrop {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for Backdrop {
    type RequestLayoutState = AnyElement;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, AnyElement) {
        let mut child = self
            .child
            .take()
            .unwrap_or_else(|| gpui::Empty.into_any_element());
        cx.default_global::<Backdrops>().0.push(self.on);
        let layout = child.request_layout(window, cx);
        cx.default_global::<Backdrops>().0.pop();
        (layout, child)
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        child: &mut AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) {
        cx.default_global::<Backdrops>().0.push(self.on);
        child.prepaint(window, cx);
        cx.default_global::<Backdrops>().0.pop();
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        child: &mut AnyElement,
        &mut (): &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        cx.default_global::<Backdrops>().0.push(self.on);
        child.paint(window, cx);
        cx.default_global::<Backdrops>().0.pop();
    }
}

#[derive(IntoElement, Default)]
pub struct ManagementPagePanel {
    children: Vec<AnyElement>,
}

impl ManagementPagePanel {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ParentElement for ManagementPagePanel {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for ManagementPagePanel {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let compact = f32::from(window.viewport_size().width) <= COMPACT_AT;
        let glass = over_background(cx);
        let gap = if glass { Space::Xl } else { page_gap(compact) };
        let column = div().flex().flex_col().min_w_0().gap(gap.px(ds));
        let column = strut::flex_scope(true, column.children(self.children));
        if !glass {
            return column.into_any_element();
        }
        let padding = if compact { Space::Lg } else { Space::Xxl };
        TintedGlass::new()
            .padding(GlassPadding::None)
            .child(div().p(padding.px(ds)).child(column))
            .into_any_element()
    }
}
