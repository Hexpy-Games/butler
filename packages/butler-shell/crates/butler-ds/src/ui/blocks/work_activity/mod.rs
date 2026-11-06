//! DS WorkActivityBlock (WorkActivityBlock.tsx, WorkActivityToolGroup.tsx, WorkActivityToolRow.tsx,
//! WorkActivityDisclosure.tsx, WorkActivityOutput.tsx and their CSS): a step of the work a turn
//! did, on a timeline. A dot (or an activity icon) sits on a hairline that bridges to the next
//! block; the title, the description and the toolchain share one content column.
mod disclosure;
mod marker;
mod tools;

use gpui::{
    AnyElement, App, ElementId, Hsla, IntoElement, ParentElement as _, Pixels, RenderOnce,
    SharedString, Styled as _, Window, div, px,
};

pub use disclosure::WorkActivityDisclosure;
pub use tools::ToolItem;

use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::layout::{Space, Stack};
use crate::ui::typo::{Tone, Typo, Weight, Wrap};

/// The metrics a density sets.
#[derive(Clone, Copy)]
pub(super) struct Look {
    pub(super) compact: bool,
    pub(super) tool_pad_y: f32,
    line: f32,
}

impl Look {
    fn new(compact: bool, ds: &Ds) -> Self {
        Self {
            compact,
            tool_pad_y: if compact { 2. } else { 5. }, // DS: WorkActivityBlock.module.css:221
            line: f32::from(ds.len(Length::TypoBodyLineHeight)),
        }
    }

    /// `1lh`: the body line height, which the dots, icons and chevrons are sized in.
    pub(super) fn line(self) -> Pixels {
        px(self.line)
    }

    /// `--work-activity-muted-text`: tertiary text at 78%.
    pub(super) fn muted(ds: &Ds) -> Hsla {
        convert::with_alpha(ds.color(Color::TextTertiary), 0.78)
    }
}

/// `.block`: the timeline column, the dot's x and the line's start, per density. // DS:
/// WorkActivityBlock.module.css:2
struct Geometry {
    line_x: f32,
    content_x: f32,
    line_start: f32,
    bridge: f32,
    dot_top: f32,
}

impl Geometry {
    fn of(compact: bool, ds: &Ds) -> Self {
        let (space, line_x, content_x, line_start, dot_top) = if compact {
            (Length::Space3, 9., 28., 6., 0.36)
        } else {
            (Length::Space4, 15., 44., 8., 0.4)
        };
        Self {
            line_x,
            content_x,
            line_start,
            bridge: f32::from(ds.len(space)) + line_start,
            dot_top,
        }
    }
}

#[derive(IntoElement)]
pub struct WorkActivityBlock {
    id: SharedString,
    title: SharedString,
    description: Option<SharedString>,
    icon: Option<AnyElement>,
    live: bool,
    connected: bool,
    compact: bool,
    tools: Vec<ToolItem>,
}

impl WorkActivityBlock {
    pub fn new(id: impl Into<SharedString>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            description: None,
            icon: None,
            live: false,
            connected: false,
            compact: false,
            tools: Vec::new(),
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// An activity-specific icon in place of the dot.
    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    /// The newest activity of work that is still running: its dot fills and pulses. No effect
    /// with an icon.
    pub fn live(mut self) -> Self {
        self.live = true;
        self
    }

    /// The line bridges the gap to the next block (also what `:not(:last-child)` does).
    pub fn connected(mut self) -> Self {
        self.connected = true;
        self
    }

    pub fn compact(mut self) -> Self {
        self.compact = true;
        self
    }

    pub fn tools(mut self, tools: Vec<ToolItem>) -> Self {
        self.tools = tools;
        self
    }
}

impl RenderOnce for WorkActivityBlock {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let look = Look::new(self.compact, ds);
        let geo = Geometry::of(self.compact, ds);
        let marker = if self.icon.is_some() {
            None
        } else {
            Some(marker::dot(
                (ElementId::from(self.id.clone()), "dot"),
                self.live,
                window,
                cx,
            ))
        };
        let ds = Ds::get(cx);
        let line = look.line();
        let lead = lead(self.icon, marker, &geo, line, ds);
        let heading = if self.compact {
            Typo::caption(self.title)
        } else {
            Typo::body(self.title)
        }
        .tone(Tone::Secondary)
        .weight(Weight::Regular)
        .wrap(Wrap::Anywhere);
        let header = div()
            .relative()
            .min_w_0()
            .min_h(line)
            .child(lead)
            .child(heading);
        let description = self.description.map(|text| {
            let typo = if self.compact {
                Typo::caption(text)
            } else {
                Typo::body(text)
            };
            div().text_color(Look::muted(ds)).child(
                typo.tone(Tone::Inherit)
                    .weight(Weight::Regular)
                    .wrap(Wrap::Anywhere),
            )
        });
        let tools = (!self.tools.is_empty()).then(|| {
            let group = tools::group(&self.id, self.tools, look, window, cx);
            div().max_w_full().child(group)
        });
        let ds = Ds::get(cx);
        let rule = rule(&geo, self.connected, ds);
        let gap = if self.compact { Space::Xs } else { Space::Sm };
        div()
            .relative()
            .max_w_full()
            .min_w_0()
            .pl(px(geo.content_x))
            .child(rule)
            .child(
                Stack::new()
                    .gap(gap)
                    .child(header)
                    .children(description)
                    .children(tools),
            )
    }
}

/// WorkActivityOutput: a tool's output in a bounded, wrapping, monospace block.
pub fn output(text: impl Into<SharedString>, cx: &App) -> impl IntoElement {
    let ds = Ds::get(cx);
    div()
        .max_h(px(320.)) // DS: WorkActivityBlock.module.css:131
        .overflow_hidden()
        .p(ds.len(Length::Space2))
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .rounded(ds.len(Length::RadiusControl))
        .bg(ds.color(Color::SurfaceRaised))
        .text_color(ds.color(Color::TextSecondary))
        .child(Typo::code(text).wrap(Wrap::Pre).tone(Tone::Inherit))
}

/// The icon (or the dot) that marks the activity on the line, left of the content column.
fn lead(
    icon: Option<AnyElement>,
    dot: Option<AnyElement>,
    geo: &Geometry,
    line: Pixels,
    ds: &Ds,
) -> gpui::Div {
    match (icon, dot) {
        (Some(icon), _) => div()
            .absolute()
            .top_0()
            .left(px(-geo.content_x + geo.line_x) - line / 2.)
            .size(line)
            .flex()
            .items_center()
            .justify_center()
            .bg(ds.color(Color::Surface))
            .text_color(ds.color(Color::TextTertiary))
            .child(icon),
        (None, Some(dot)) => div()
            .absolute()
            .top(line * geo.dot_top)
            .left(px(-geo.content_x + geo.line_x - 3.))
            .child(dot),
        (None, None) => div(),
    }
}

/// The timeline line; `connected` runs it on across the gap to the next block.
fn rule(geo: &Geometry, connected: bool, ds: &Ds) -> gpui::Div {
    let bottom = if connected { px(-geo.bridge) } else { px(2.) };
    div()
        .absolute()
        .top(px(geo.line_start))
        .bottom(bottom)
        .left(px(geo.line_x))
        .w(px(1.))
        .rounded(ds.len(Length::RadiusPill))
        .bg(convert::with_alpha(ds.color(Color::Line), 0.82))
}
