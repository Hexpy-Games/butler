//! DS ArtifactList (ArtifactList.tsx / ArtifactList.module.css): files an answer made, one row
//! each in a bordered, raised box: an icon tile, the name over its description and the row's
//! actions. The actions share the name's row while the name keeps a readable width; on a
//! narrower card they wrap to their own row at the right edge. The list's own width decides
//! the row's icon size, as the container query does.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _, Window,
    div, px,
};

use super::measure;
use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::button::{Button, Size, Variant};
use crate::ui::context::Ds;
use crate::ui::focus;
use crate::ui::icon::{IconSize, icon};
use crate::ui::typo::{Tone, Typo, Weight};

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// `@container artifact-list (width <= 25rem)`: the smaller icon tile and gap.
const NARROW: f32 = 400.; // DS: ArtifactList.module.css:131
/// `--artifact-name-min`: `calc(var(--space-4xl) * 3)`.
const NAME_MIN: f32 = 144.; // DS: ArtifactList.module.css:6

/// One action of a row: a small outline button that never opens the row.
pub struct ArtifactAction {
    label: SharedString,
    icon: Option<Icon>,
    on_click: Option<Handler>,
}

impl ArtifactAction {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            icon: None,
            on_click: None,
        }
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
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

pub struct ArtifactItem {
    title: SharedString,
    description: Option<SharedString>,
    icon: Icon,
    actions: Vec<ArtifactAction>,
    on_open: Option<Handler>,
}

impl ArtifactItem {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            description: None,
            icon: Icon::FileText,
            actions: Vec::new(),
            on_open: None,
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = icon;
        self
    }

    pub fn action(mut self, action: ArtifactAction) -> Self {
        self.actions.push(action);
        self
    }

    /// Makes the row a button that opens the artifact.
    pub fn on_open(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_open = Some(Rc::new(handler));
        self
    }
}

#[derive(IntoElement)]
pub struct ArtifactList {
    id: ElementId,
    items: Vec<ArtifactItem>,
}

impl ArtifactList {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            items: Vec::new(),
        }
    }

    pub fn item(mut self, item: ArtifactItem) -> Self {
        self.items.push(item);
        self
    }
}

/// The name over its description: it takes the room left beside the icon and the actions.
fn text_column(title: SharedString, description: Option<SharedString>, ds: &Ds) -> gpui::Div {
    let mut text = div()
        .flex()
        .flex_col()
        .flex_grow(1.)
        .flex_shrink(1.)
        .flex_basis(px(NAME_MIN))
        .min_w_0()
        .gap(ds.len(Length::Space1))
        .child(
            Typo::body(title)
                .tone(Tone::Primary)
                .weight(Weight::Medium)
                .truncate(),
        );
    if let Some(description) = description {
        text = text.child(Typo::caption(description).tone(Tone::Secondary).truncate());
    }
    text
}

/// The row's actions at the right edge; a press on one never starts the row's click.
fn actions_column(actions: Vec<ArtifactAction>, row_id: &ElementId, ds: &Ds) -> gpui::Div {
    let buttons = actions.into_iter().enumerate().map(|(n, action)| {
        let mut button = Button::new((row_id.clone(), format!("action-{n}")))
            .variant(Variant::Outline)
            .size(Size::Sm)
            .text(action.label);
        if let Some(glyph) = action.icon {
            button = button.icon_start(icon(glyph, IconSize::Sm, ds));
        }
        if let Some(handler) = action.on_click {
            button = button.on_click(move |event, window, cx| handler(event, window, cx));
        }
        button
    });
    div()
        .flex()
        .flex_none()
        .flex_wrap()
        .items_center()
        .justify_end()
        .max_w_full()
        .ml_auto()
        .gap(ds.len(Length::Space1))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .children(buttons)
}

/// The row as a button: hover fill, keyboard focus with its inset ring.
fn button_row(
    line: gpui::Div,
    row_id: ElementId,
    open: Handler,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let handle = window
        .use_keyed_state((row_id.clone(), "focus"), cx, |_, cx| cx.focus_handle())
        .read(cx)
        .clone();
    let ds = Ds::get(cx);
    let ring = focus::visible(ds, handle.is_focused(window), false).then(|| {
        div()
            .absolute()
            .size_full()
            .top_0()
            .left_0()
            .border(ds.len(Length::FocusRingWidth))
            .border_color(ds.color(Color::ColorActionPrimary))
    });
    let hover = ds.color(Color::Selection);
    line.children(ring)
        .id(row_id)
        .track_focus(&focus::tab_stop(&handle, true))
        .cursor_pointer()
        .hover_style(move |style| style.bg(hover))
        .on_click(move |event, window, cx| open(event, window, cx))
        .into_any_element()
}

fn row(
    id: &ElementId,
    index: usize,
    item: ArtifactItem,
    narrow: bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let tile = if narrow { 32. } else { 40. };
    let gap = ds.len(if narrow {
        Length::SpaceSm
    } else {
        Length::SpaceMd
    });
    let row_id: ElementId = (id.clone(), format!("row-{index}")).into();
    let tile_box = div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(tile))
        .rounded(ds.len(Length::RadiusControl))
        .bg(ds.color(Color::Surface))
        .text_color(ds.color(Color::TextSecondary))
        .child(icon(item.icon, IconSize::Lg, ds));
    let mut line = div()
        .relative()
        .flex()
        .flex_wrap()
        .items_center()
        .w_full()
        .min_h(px(if index == 0 { 68. } else { 67. })) // 68px border-box with the row rule inside
        .gap_x(gap)
        .gap_y(ds.len(Length::SpaceSm))
        .px(ds.len(Length::SpaceMd))
        .py(ds.len(Length::SpaceSm))
        .child(tile_box)
        .child(text_column(item.title, item.description, ds));
    if !item.actions.is_empty() {
        line = line.child(actions_column(item.actions, &row_id, ds));
    }
    match item.on_open {
        Some(open) => button_row(line, row_id, open, window, cx),
        None => line.into_any_element(),
    }
}

impl RenderOnce for ArtifactList {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let (size, recorder) = measure::track((self.id.clone(), "size"), window, cx);
        let narrow = f32::from(size.width) <= NARROW && f32::from(size.width) > 0.;
        let rows: Vec<AnyElement> = self
            .items
            .into_iter()
            .enumerate()
            .map(|(index, item)| row(&self.id, index, item, narrow, window, cx))
            .collect();
        let ds = Ds::get(cx);
        let mut list = div()
            .relative()
            .flex()
            .flex_col()
            .w_full()
            .overflow_hidden()
            .border(ds.len(Length::BorderHairline))
            .border_color(ds.color(Color::Line))
            .rounded(ds.len(Length::RadiusPopover))
            .bg(ds.color(Color::SurfaceRaised))
            .child(recorder);
        for (index, row) in rows.into_iter().enumerate() {
            let mut cell = div().w_full().child(row);
            // `.row + .row { border-top }`: the rule sits on the following row.
            if index > 0 {
                cell = cell
                    .border_t(ds.len(Length::BorderHairline))
                    .border_color(ds.color(Color::Line));
            }
            list = list.child(cell);
        }
        list
    }
}
