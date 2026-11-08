//! One toast drawn (Toast.module.css over sonner's `[data-sonner-toast][data-styled]`): the
//! surface, the status icon, the title, the cancel and action buttons and the close button.
use std::time::Instant;

use gpui::{
    AnyElement, Bounds, Corners, Edges, FontWeight, Hsla, InteractiveElement as _,
    IntoElement as _, MouseButton, ParentElement as _, PathBuilder, Pixels, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, canvas, div, point, px, svg,
};

use super::layout::Resolved;
use super::state::Item;
use super::{Action, Kind, Store, Toast};
use crate::tokens::{Color, Length, Number};
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::liquid_glass::{self, LiquidGlass};

/// sonner's font sizes and the box it gives each part.
const TITLE_LINE: f32 = 1.5; // DS: sonner styles.css `[data-title]`
const ICON_BOX: f32 = 16.; // DS: sonner styles.css `[data-icon]`
const CLOSE: f32 = 20.; // DS: sonner styles.css `[data-close-button]`
const BUTTON_HEIGHT: f32 = 24.; // DS: sonner styles.css `[data-button]`
const BUTTON_SIZE: f32 = 12.; // DS: sonner styles.css `[data-button]`
const SPINNER_BARS: usize = 12;
/// `--gray11` of sonner's light theme, the loading bars' colour.
const SPINNER_GRAY: f32 = 0.435; // DS: sonner styles.css `.sonner-loading-bar`

/// The colours of a toast's tone (the glass behind it is the same for every kind).
struct Tone {
    text: Hsla,
    icon: Hsla,
    /// The kind's translucent fill and border over the glass; none for a plain message.
    tint: Option<(Hsla, Hsla)>,
}

fn tone(kind: Kind, ds: &Ds) -> Tone {
    let normal = Tone {
        text: ds.color(Color::TextPrimary),
        icon: ds.color(Color::TextPrimary),
        tint: None,
    };
    // Toast.module.css:45-61 `--normal-bg` / `--normal-border` / `--normal-text` per kind. React
    // lays the bg token over the popover; here it lies translucent over the glass.
    let toned = |bg, border, text| Tone {
        text: ds.color(text),
        icon: ds.color(text),
        tint: Some((ds.color(bg), ds.color(border))),
    };
    match kind {
        Kind::Success => toned(
            Color::ColorSuccessBg,
            Color::ColorSuccessBorder,
            Color::ColorSuccess,
        ),
        Kind::Warning => toned(
            Color::ColorWarningBg,
            Color::ColorWarningBorder,
            Color::ColorWarningText,
        ),
        Kind::Error => toned(
            Color::ColorDangerBg,
            Color::ColorDangerBorder,
            Color::ColorDangerText,
        ),
        Kind::Message | Kind::Loading => normal,
    }
}

/// The glass behind a toast: Liquid Glass over the content, materialized by `progress` (the
/// toast's presence; the lens draws its own shadow, rim and hairline), then the kind's
/// translucent fill and 1px border (Toast.module.css:45-80) over it. The glass is not faded
/// with the content: it ramps its lensing instead (LG research §5, §8.1.6).
fn surface(tone: &Tone, progress: f32, ds: &Ds) -> gpui::Canvas<()> {
    let radius = ds.len(Length::RadiusPanel);
    let dark = ds.dark();
    let glass = LiquidGlass::over_content().materialize(progress).adapt(ds);
    let tint = tone.tint;
    canvas(
        |_, _, _| (),
        move |bounds: Bounds<Pixels>, (), window: &mut Window, _| {
            let r = radius
                .min(bounds.size.height / 2.)
                .min(bounds.size.width / 2.);
            let radii = Corners::all(r);
            liquid_glass::paint(bounds, radii, dark, glass, window);
            if let Some((fill, border)) = tint {
                let fade = progress.clamp(0., 1.);
                window.paint_quad(
                    gpui::PaintQuad::new(bounds)
                        .background(convert::with_alpha(fill, fade))
                        .corner_radii(radii),
                );
                window.paint_quad(
                    gpui::PaintQuad::new(bounds)
                        .corner_radii(radii)
                        .border_widths(Edges::all(px(1.))) // DS: sonner styles.css `border: 1px`
                        .border_color(convert::with_alpha(border, fade)),
                );
            }
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// sonner's loader: twelve bars on a ring that fade in turn over 1.2s. Under reduced motion they
/// stand still (`animation: none`).
fn spinner(animate: bool, now: Instant, epoch: Instant) -> AnyElement {
    let seconds = now.saturating_duration_since(epoch).as_secs_f32();
    let color = gpui::hsla(0., 0., SPINNER_GRAY, 1.);
    canvas(
        |_, _, _| (),
        move |bounds: Bounds<Pixels>, (), window: &mut Window, _| {
            let side = f32::from(bounds.size.width);
            // The ring's centre and the bar size, in the loader's 16px box.
            let (cx, cy) = (side * 0.52, side * 0.5);
            let (half_w, half_h) = (side * 0.12, side * 0.04);
            for k in 0..SPINNER_BARS {
                #[expect(clippy::cast_precision_loss, reason = "a bar index")]
                let k = k as f32;
                let theta = k * 30_f32.to_radians();
                let (sin, cos) = theta.sin_cos();
                let (mx, my) = (cx + side * 0.35 * cos, cy + side * 0.35 * sin);
                let corner = |dx: f32, dy: f32| {
                    point(
                        bounds.origin.x + px(mx + dx * cos - dy * sin),
                        bounds.origin.y + px(my + dx * sin + dy * cos),
                    )
                };
                let phase = if animate {
                    ((seconds + 1.2 - 0.1 * k) / 1.2).fract()
                } else {
                    0.
                };
                let mut path = PathBuilder::fill();
                path.move_to(corner(-half_w, -half_h));
                path.line_to(corner(half_w, -half_h));
                path.line_to(corner(half_w, half_h));
                path.line_to(corner(-half_w, half_h));
                path.close();
                if let Ok(path) = path.build() {
                    window.paint_path(path, convert::with_alpha(color, 1. - 0.85 * phase));
                }
            }
        },
    )
    .size(px(ICON_BOX))
    .into_any_element()
}

fn icon_file(kind: Kind) -> Option<&'static str> {
    match kind {
        Kind::Success => Some("toast/success.svg"),
        Kind::Warning => Some("toast/warning.svg"),
        Kind::Error => Some("toast/error.svg"),
        Kind::Message | Kind::Loading => None,
    }
}

/// The status icon: a 16px box whose 20px glyph overhangs it (`margin-left: -3px` and `4px`).
fn icon(
    item: &Toast,
    tone: &Tone,
    (now, epoch): (Instant, Instant),
    ds: &Ds,
) -> Option<AnyElement> {
    let glyph = match (item.kind, icon_file(item.kind)) {
        (Kind::Loading, _) => spinner(!ds.reduced_motion(), now, epoch),
        (_, Some(path)) => svg()
            .path(SharedString::from(path))
            .size(px(20.)) // DS: sonner icons `height="20" width="20"`
            .flex_none()
            .ml(px(-1.))
            .text_color(tone.icon)
            .into_any_element(),
        _ => return None,
    };
    Some(
        div()
            .relative()
            .flex()
            .flex_none()
            .items_center()
            .h(px(ICON_BOX))
            .w(px(ICON_BOX))
            .ml(px(-3.)) // DS: sonner styles.css `--toast-icon-margin-start`
            .mr(px(4.)) // DS: sonner styles.css `--toast-icon-margin-end`
            .child(glyph)
            .into_any_element(),
    )
}

/// A cancel or action button: 24px high, `--radius-control`, 12px type.
fn button(
    id: String,
    action: &Action,
    (fill, text): (Hsla, Hsla),
    store: &Store,
    toast: u64,
    ds: &Ds,
) -> AnyElement {
    let (on_click, store) = (action.on_click.clone(), store.clone());
    div()
        .id(SharedString::from(id))
        .flex()
        .flex_none()
        .items_center()
        .h(px(BUTTON_HEIGHT))
        .px(px(8.)) // DS: sonner styles.css `[data-button]`
        .ml_auto()
        .rounded(ds.len(Length::RadiusControl))
        .bg(fill)
        .text_color(text)
        .text_size(px(BUTTON_SIZE))
        .font_weight(FontWeight(ds.number(Number::FontWeightMedium)))
        .cursor_pointer()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |_, window, cx| {
            on_click(cx);
            store.dismiss(toast, cx);
            window.refresh();
        })
        .child(action.label.clone())
        .into_any_element()
}

/// The close button: a 20px circle on the toast's top start corner, `translate(-35%, -35%)`.
fn close(item_id: u64, store: &Store, ds: &Ds) -> AnyElement {
    let store = store.clone();
    let shift = px(-CLOSE * 0.35);
    div()
        .id(SharedString::from(format!("toast-{item_id}-close")))
        .absolute()
        .top(shift)
        .left(shift)
        .flex()
        .items_center()
        .justify_center()
        .size(px(CLOSE))
        .rounded(px(CLOSE / 2.))
        .border(px(1.))
        .border_color(ds.color(Color::Line))
        .bg(ds.color(Color::Popover))
        .text_color(ds.color(Color::TextSecondary))
        .cursor_pointer()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(move |_, window, cx| {
            store.dismiss(item_id, cx);
            window.refresh();
        })
        .child(
            svg()
                .path(SharedString::from("toast/close.svg"))
                .size(px(12.))
                .text_color(ds.color(Color::TextSecondary)),
        )
        .into_any_element()
}

/// How the toast is placed and sized this frame.
pub(super) struct Place {
    pub left: f32,
    pub width: f32,
}

/// Measures the toast's natural height for the stack (not while it is forced to another size).
fn measure(item: &Item, forced: bool) -> gpui::Canvas<()> {
    let measured = item.height.clone();
    canvas(
        move |bounds: Bounds<Pixels>, _, _| {
            if !forced {
                measured.set(f32::from(bounds.size.height));
            }
        },
        |_, (), _, _| {},
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// The toast's row: icon, title, cancel and action buttons and the close button.
fn content(
    item: &Item,
    resolved: &Resolved,
    tone: &Tone,
    store: &Store,
    clock: (Instant, Instant),
    ds: &Ds,
) -> gpui::Div {
    let toast = &item.toast;
    let id = item.id;
    let size = ds.len(Length::TypoLabelSize);
    let title = div()
        .font_weight(FontWeight(ds.number(Number::FontWeightMedium)))
        .line_height(px(f32::from(size) * TITLE_LINE))
        .child(toast.title.clone());
    let row = div()
        .relative()
        .flex()
        .items_center()
        .gap(px(6.)) // DS: sonner styles.css `gap: 6px`
        .p(px(17.)) // DS: sonner styles.css `padding: 16px` and the 1px border
        .text_color(tone.text)
        .font_family(ds.body_font().clone())
        .text_size(size)
        .line_height(ds.len(Length::TypoLabelLineHeight))
        .opacity(resolved.content)
        .children(icon(toast, tone, clock, ds))
        .child(title)
        .children(toast.cancel.as_ref().map(|cancel| {
            let colors = (ds.color(Color::Selection), ds.color(Color::TextPrimary));
            button(format!("toast-{id}-cancel"), cancel, colors, store, id, ds)
        }))
        .children(toast.action.as_ref().map(|action| {
            let colors = (ds.color(Color::Primary), ds.color(Color::PrimaryForeground));
            button(format!("toast-{id}-action"), action, colors, store, id, ds)
        }));
    if toast.kind == Kind::Loading {
        row
    } else {
        row.child(close(id, store, ds))
    }
}

/// The toast: positioned in the stack, scaled about its centre when it sits behind the front
/// one, with its content faded by `resolved.content`.
pub(super) fn render(
    item: &Item,
    resolved: &Resolved,
    place: &Place,
    front: bool,
    store: &Store,
    (now, epoch): (Instant, Instant),
    ds: &Ds,
) -> AnyElement {
    let tone = tone(item.toast.kind, ds);
    let scale = resolved.scale;
    let forced = scale < 1. || resolved.height != item.height.get();
    let probe = measure(item, forced);
    let content = content(item, resolved, &tone, store, (now, epoch), ds);
    let id = item.id;
    let down = store.clone();
    let mut outer = div()
        .absolute()
        .top(px(resolved.y + resolved.swipe))
        .left(px(place.left))
        .w(px(place.width))
        .scale(scale)
        .on_mouse_down(MouseButton::Left, move |event, window, cx| {
            let now = cx.background_executor().now();
            down.begin_swipe(id, event.position, now, cx);
            window.refresh();
        })
        .debug_selector(move || format!("toast-{id}"));
    if forced {
        outer = outer.h(px(resolved.height)).overflow_hidden();
    }
    // The front toast's box, for a harness that reports geometry.
    let marker = front.then(|| {
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .debug_selector(|| "toast-front".to_owned())
    });
    outer
        .child(surface(&tone, resolved.opacity, ds))
        .child(content)
        .child(probe)
        .children(marker)
        .into_any_element()
}
