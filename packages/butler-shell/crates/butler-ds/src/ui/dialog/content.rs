//! DialogContent (shadcn/ui/dialog.tsx, Dialog.module.css): its props, the geometry the CSS
//! writes with `calc()`, `min()` and `max()` of the viewport (or of the container), and the
//! surface it draws: the glass, the scrolling dialog or the scroll-body grid, and the close
//! button.
use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, Entity, InteractiveElement as _, IntoElement as _, ParentElement as _,
    Pixels, ScrollHandle, StatefulInteractiveElement as _, Styled as _, Window, div, px,
};

use super::parts::{DialogFooter, DialogHeader};
use crate::tokens::{Color, Length};
use crate::ui::button::{Button, Shape, Size as ButtonSize, Variant};
use crate::ui::context::Ds;
use crate::ui::icon::{IconSize, icon};
use crate::ui::scroll::{Axis, bar};
use crate::ui::strut::{self, DialogFrame};
use crate::ui::tinted_glass::{GlassPadding, GlassRadius, TintedGlass};
use crate::ui::{Icon, convert};

/// `size`: the width (`--dialog-width-*`); every size stays inside the viewport gutter.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Size {
    #[default]
    Sm,
    Md,
    Lg,
    Xl,
    Full,
}

/// `flow`: children stack with the dialog gap and the whole dialog scrolls. `scroll-body`:
/// header, one scrolling body (a `ScrollArea fill`) and footer; the dialog itself does not.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Layout {
    #[default]
    Flow,
    ScrollBody,
}

/// `maxHeight`: the viewport less its margins, or `3/5` of it (live transcripts).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MaxHeight {
    #[default]
    Full,
    ThreeFifths,
}

/// `motion`: a dialog, or the command palette's quicker scale-in and backdrop fade.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Motion {
    #[default]
    Dialog,
    Palette,
}

/// One child of the dialog, in order. A header followed by a footer is a confirmation.
pub(super) enum Part {
    Header(DialogHeader),
    Footer(DialogFooter),
    Other(AnyElement),
}

pub struct DialogContent {
    pub(super) size: Size,
    pub(super) layout: Layout,
    pub(super) max_height: MaxHeight,
    pub(super) full_height: bool,
    pub(super) glass_radius: GlassRadius,
    pub(super) show_close_button: bool,
    pub(super) motion: Motion,
    /// The inner corner radius of the card the dialog is anchored in, when it is.
    pub(super) contained: Option<Pixels>,
    parts: Vec<Part>,
}

impl DialogContent {
    pub fn new() -> Self {
        Self {
            size: Size::Sm,
            layout: Layout::Flow,
            max_height: MaxHeight::Full,
            full_height: false,
            glass_radius: GlassRadius::Composer,
            show_close_button: true,
            motion: Motion::Dialog,
            contained: None,
            parts: Vec::new(),
        }
    }

    pub fn size(mut self, size: Size) -> Self {
        self.size = size;
        self
    }

    pub fn layout(mut self, layout: Layout) -> Self {
        self.layout = layout;
        self
    }

    pub fn max_height(mut self, max_height: MaxHeight) -> Self {
        self.max_height = max_height;
        self
    }

    /// `height="full"`: the height is the cap, not the content, so a `scroll-body` with a short
    /// body still fills it.
    pub fn full_height(mut self) -> Self {
        self.full_height = true;
        self
    }

    /// The glass surface's corner radius (`glassRadius`); the composer's by default.
    pub fn glass_radius(mut self, radius: GlassRadius) -> Self {
        self.glass_radius = radius;
        self
    }

    pub fn show_close_button(mut self, show: bool) -> Self {
        self.show_close_button = show;
        self
    }

    pub fn motion(mut self, motion: Motion) -> Self {
        self.motion = motion;
        self
    }

    /// `container`: anchored inside the element carrying [`super::Dialog::container_probe`] (a
    /// page card) near its top, its scrim covering only that element, whose inner corner radius
    /// is `radius`. Pair it with `Dialog::modal(false)`; outside interactions never dismiss it.
    pub fn contained(mut self, radius: Pixels) -> Self {
        self.contained = Some(radius);
        self
    }

    pub fn header(mut self, header: DialogHeader) -> Self {
        self.parts.push(Part::Header(header));
        self
    }

    pub fn footer(mut self, footer: DialogFooter) -> Self {
        self.parts.push(Part::Footer(footer));
        self
    }
}

impl Default for DialogContent {
    fn default() -> Self {
        Self::new()
    }
}

impl gpui::ParentElement for DialogContent {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.parts.extend(elements.into_iter().map(Part::Other));
    }
}

/// Where the dialog goes and how big it may be, in the area it is placed in (the window, or the
/// card it is anchored in).
#[derive(Clone, Copy)]
pub(super) struct Geometry {
    pub width: f32,
    /// The height cap (`--dialog-max-height`), the border included.
    pub cap: f32,
    /// Only the phone command palette: a full-width sheet from the top edge.
    pub top_sheet: bool,
}

impl DialogContent {
    fn dialog_width(&self, ds: &Ds, area_width: f32) -> f32 {
        match self.size {
            Size::Sm => f32::from(ds.len(Length::DialogWidthSm)),
            Size::Md => f32::from(ds.len(Length::DialogWidthMd)),
            Size::Lg => f32::from(ds.len(Length::DialogWidthLg)),
            Size::Xl => f32::from(ds.len(Length::DialogWidthXl)),
            Size::Full => area_width,
        }
    }

    /// Window: `width: min(w, 100% - 32)` and `max-width: 100% - 2 * max(16, safe areas)`;
    /// anchored in a card: both against the card, less `--space-3xl`.
    pub(super) fn geometry(&self, ds: &Ds, area: (f32, f32), in_card: bool) -> Geometry {
        let len = |token| f32::from(ds.len(token));
        let (aw, ah) = area;
        let gutter = len(Length::Space4);
        if in_card {
            let margin = len(Length::Space3xl);
            let width = self.dialog_width(ds, aw).min(aw - margin);
            let cap = ah - 2. * len(Length::Space2xl);
            return Geometry {
                width,
                cap,
                top_sheet: false,
            };
        }
        if self.motion == Motion::Palette && ds.compact() {
            return Geometry {
                width: aw,
                cap: ah,
                top_sheet: true,
            };
        }
        let side = gutter.max(len(Length::SafeAreaLeft).max(len(Length::SafeAreaRight)));
        let width = self
            .dialog_width(ds, aw)
            .min(aw - 2. * gutter)
            .min(aw - 2. * side);
        let margin = gutter
            .max(len(Length::TitlebarSafeAreaTop))
            .max(len(Length::SafeAreaBottom));
        let cap = match self.max_height {
            MaxHeight::Full => ah - 2. * margin,
            MaxHeight::ThreeFifths => ah * 0.6,
        };
        Geometry {
            width,
            cap,
            top_sheet: false,
        }
    }
}

/// How far the close button and its focus ring reach into the content box from its inline end
/// (`--dialog-close-room`; no classic scrollbar is drawn, so `--scrollbar-width` is 0).
fn close_room(ds: &Ds) -> f32 {
    let len = |token| f32::from(ds.len(token));
    let size = if ds.compact() {
        len(Length::ControlHitTarget)
    } else {
        len(Length::ControlHeightSm)
    };
    len(Length::Space2) + size + len(Length::FocusRingRoom) - len(Length::Space4)
}

/// Closes the dialog.
pub(super) type Close = Rc<dyn Fn(&mut Window, &mut App)>;

/// What the surface needs from the dialog: its close action and the scroll state.
pub(super) struct Env {
    pub close: Close,
    pub scroll: ScrollHandle,
    pub grab: Entity<Option<f32>>,
}

impl DialogContent {
    /// The parts in order, each in the dialog's grid, with the header told whether a footer
    /// follows it.
    fn laid_out(&mut self, frame: DialogFrame) -> Vec<AnyElement> {
        let parts = std::mem::take(&mut self.parts);
        let confirm: Vec<bool> = parts
            .iter()
            .enumerate()
            .map(|(i, part)| {
                matches!(part, Part::Header(_)) && matches!(parts.get(i + 1), Some(Part::Footer(_)))
            })
            .collect();
        parts
            .into_iter()
            .zip(confirm)
            .map(|(part, confirm)| match part {
                Part::Header(header) => header.confirmation(confirm).into_any_element(),
                Part::Footer(footer) => footer.into_any_element(),
                Part::Other(element) => element,
            })
            .map(|el| strut::dialog_scope(frame, el).into_any_element())
            .collect()
    }

    fn close_button(&self, ds: &Ds, env: &Env) -> Option<AnyElement> {
        if !self.show_close_button {
            return None;
        }
        let close = env.close.clone();
        let inset = ds.len(Length::Space2);
        let button = Button::new("dialog-close")
            .variant(Variant::Ghost)
            .size(ButtonSize::IconSm)
            .shape(Shape::Pill)
            .icon_start(icon(Icon::X, IconSize::Md, ds))
            .on_click(move |_, window, cx| close(window, cx));
        Some(
            div()
                .absolute()
                .top(inset)
                .right(inset)
                .child(button)
                .into_any_element(),
        )
    }

    /// The glass with its content, sized for this frame.
    pub(super) fn surface(mut self, ds: &Ds, geo: &Geometry, env: &Env) -> AnyElement {
        let pad = ds.len(Length::Space4);
        let room = if self.show_close_button {
            close_room(ds)
        } else {
            0.
        };
        let scroll_body = self.layout == Layout::ScrollBody;
        let frame = DialogFrame {
            scroll_body,
            close_room: room,
            in_header: false,
        };
        let close = self.close_button(ds, env);
        let children = self.laid_out(frame);
        // The 1px border of the glass stays in layout.
        let inner_cap = px(geo.cap - 2.);
        let (safe_top, safe_left, safe_right) = (
            ds.len(Length::SafeAreaTop),
            ds.len(Length::SafeAreaLeft),
            ds.len(Length::SafeAreaRight),
        );
        let mut body = div().relative().flex().flex_col().min_w_0();
        body = if geo.top_sheet {
            body.pt(pad.max(safe_top)).pl(safe_left).pr(safe_right)
        } else {
            body.p(pad)
        };
        let mut glass = TintedGlass::new()
            .radius(self.glass_radius)
            .padding(GlassPadding::None);
        if geo.top_sheet {
            glass = glass.radius(GlassRadius::Popover).square_top();
        }
        let body = if scroll_body {
            // Header, one scrolling body and footer; the dialog itself never scrolls.
            let body = if self.full_height {
                glass = glass.height(px(geo.cap));
                body.h_full()
            } else {
                body.max_h(inner_cap)
            };
            body.overflow_hidden()
                .children(children)
                .children(close)
                .into_any_element()
        } else {
            let body = body.gap(pad).children(children).children(close);
            scrolling(body, inner_cap, ds, env)
        };
        let glass = glass.child(body);
        div()
            .flex()
            .flex_col()
            .w(px(geo.width))
            .max_w_full()
            .child(glass)
            .debug_selector(|| "dialog-content".to_owned())
            .into_any_element()
    }
}

/// The whole dialog scrolls past its cap, with the thin scrollbar of `.content::-webkit-scrollbar`
/// drawn over the padding at its inline end.
fn scrolling(body: gpui::Div, cap: Pixels, ds: &Ds, env: &Env) -> AnyElement {
    let color = convert::with_alpha(ds.color(Color::LineStrong), 0.7);
    let thumb = bar::thumb(&env.scroll, Axis::Y, color);
    // The lane of the track, 8px at the inline end (DS: Dialog.module.css:240).
    let lane = div()
        .absolute()
        .top_0()
        .right_0()
        .bottom_0()
        .w(px(8.))
        .child(bar::drag_layer(
            env.scroll.clone(),
            Axis::Y,
            env.grab.clone(),
        ));
    div()
        .relative()
        .max_h(cap)
        .child(
            div()
                .id("dialog-scroll")
                .max_h(cap)
                .overflow_y_scroll()
                .track_scroll(&env.scroll)
                .child(body),
        )
        .children(thumb)
        .child(lane)
        .into_any_element()
}

/// The window or card rectangle a dialog is placed in, as `(width, height)`.
pub(super) fn area_of(bounds: Bounds<Pixels>) -> (f32, f32) {
    (f32::from(bounds.size.width), f32::from(bounds.size.height))
}
