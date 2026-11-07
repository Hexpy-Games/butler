//! DS Breadcrumb family (shadcn/ui/breadcrumb.tsx / Breadcrumb.module.css): a trail that shows
//! where a nested page sits. `Breadcrumb` is the landmark, `BreadcrumbList` lays the items out
//! (wrapping, 6px apart, secondary text), `BreadcrumbButton` / `BreadcrumbLink` are the steps
//! that go back up, `BreadcrumbPage` is the current page, `BreadcrumbSeparator` the chevron and
//! `BreadcrumbEllipsis` a collapsed run of steps.
use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement, RenderOnce,
    SharedString, Styled as _, Window, div, px,
};

use crate::tokens::{Color, Length, Number};
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::control::{Blend, Control, Ring};
use crate::ui::icon::{IconSize, icon, icon_px};

/// The gap between items (`.list` `gap`).
const LIST_GAP: f32 = 6.; // DS: Breadcrumb.module.css:5
/// The separator chevron's side (`.separator svg`).
const SEPARATOR_ICON: f32 = 14.; // DS: Breadcrumb.module.css:49-50
/// The ellipsis box's side (`.ellipsis`).
const ELLIPSIS_BOX: f32 = 20.; // DS: Breadcrumb.module.css:60-61

/// The `nav` landmark. `label` is the trail's accessible name (app copy `common.breadcrumb`);
/// gpui has no accessibility tree here, so it names the element for the harness.
#[derive(IntoElement)]
pub struct Breadcrumb {
    label: SharedString,
    children: Vec<AnyElement>,
}

impl Breadcrumb {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            children: Vec::new(),
        }
    }
}

impl ParentElement for Breadcrumb {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for Breadcrumb {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        div().id(self.label).children(self.children)
    }
}

/// The `ol`: items in a wrapping row, centred on each other, in `--text-secondary`.
#[derive(IntoElement, Default)]
pub struct BreadcrumbList {
    children: Vec<AnyElement>,
}

impl BreadcrumbList {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ParentElement for BreadcrumbList {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for BreadcrumbList {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(LIST_GAP))
            .text_color(ds.color(Color::TextSecondary))
            .text_size(ds.len(Length::FontSize3))
            .font_family(ds.body_font().clone())
            .children(self.children)
    }
}

/// One `li` of content: an inline-flex box on a line height of 1.
fn line_box(ds: &Ds) -> gpui::Div {
    div()
        .flex()
        .flex_none()
        .items_center()
        .line_height(ds.len(Length::FontSize3))
}

/// The `li` holding a step or the current page.
#[derive(IntoElement, Default)]
pub struct BreadcrumbItem {
    children: Vec<AnyElement>,
}

impl BreadcrumbItem {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ParentElement for BreadcrumbItem {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for BreadcrumbItem {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        line_box(Ds::get(cx)).children(self.children)
    }
}

type Handler = std::rc::Rc<dyn Fn(&gpui::ClickEvent, &mut Window, &mut App)>;

/// A step that goes back up the trail: secondary text that turns primary on hover and keyboard
/// focus and back to secondary while pressed, with the default 2px outline on keyboard focus.
/// gpui has no URL to follow, so `BreadcrumbLink` is this same step.
#[derive(IntoElement)]
pub struct BreadcrumbButton {
    id: ElementId,
    on_click: Option<Handler>,
    children: Vec<AnyElement>,
}

/// The `a` form of a step (`BreadcrumbLink`); it looks and acts as [`BreadcrumbButton`].
pub type BreadcrumbLink = BreadcrumbButton;

impl BreadcrumbButton {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            on_click: None,
            children: Vec::new(),
        }
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(std::rc::Rc::new(handler));
        self
    }
}

impl ParentElement for BreadcrumbButton {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for BreadcrumbButton {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let secondary = ds.color(Color::TextSecondary);
        let mut control = Control::new(self.id, ds);
        control.fg = Blend {
            rest: secondary,
            hover: ds.color(Color::TextPrimary),
            active: Some(secondary),
        };
        control.scale = false;
        // The global outline: 2px at `--focus-ring-room` minus the width.
        control.ring = Ring::Outline(
            f32::from(ds.len(Length::FocusRingRoom)) - f32::from(ds.len(Length::FocusRingWidth)),
        );
        control.line_height = Some(ds.len(Length::FontSize3));
        control.on_click(self.on_click);
        control.children = self.children;
        control
    }
}

/// The current page: primary, strong text, not a link.
#[derive(IntoElement, Default)]
pub struct BreadcrumbPage {
    children: Vec<AnyElement>,
}

impl BreadcrumbPage {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ParentElement for BreadcrumbPage {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for BreadcrumbPage {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        line_box(ds)
            .text_color(ds.color(Color::TextPrimary))
            .font_weight(gpui::FontWeight(ds.number(Number::FontWeightStrong)))
            .children(self.children)
    }
}

/// The divider between items: a 14px chevron, or the content given.
#[derive(IntoElement, Default)]
pub struct BreadcrumbSeparator {
    children: Vec<AnyElement>,
}

impl BreadcrumbSeparator {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ParentElement for BreadcrumbSeparator {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for BreadcrumbSeparator {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let content = if self.children.is_empty() {
            vec![icon_px(Icon::ChevronRight, px(SEPARATOR_ICON)).into_any_element()]
        } else {
            self.children
        };
        line_box(Ds::get(cx)).children(content)
    }
}

/// A collapsed run of steps: a 20px box holding the more glyph. `label` names the run.
#[derive(IntoElement)]
pub struct BreadcrumbEllipsis {
    label: SharedString,
}

impl BreadcrumbEllipsis {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
        }
    }
}

impl RenderOnce for BreadcrumbEllipsis {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        div()
            .id(self.label)
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(ELLIPSIS_BOX))
            .child(icon(Icon::MoreHorizontal, IconSize::Md, Ds::get(cx)))
    }
}
