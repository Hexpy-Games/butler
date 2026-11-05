//! Token value types to gpui values: colours, lengths, shadows and easing curves.
use gpui::{
    Background, BoxShadow, ColorSpace, Hsla, Pixels, linear_color_stop, linear_gradient, point, px,
};

use crate::tokens::{Ease, Gradient, Len, Rgba, ShadowLayer, TokenContext};

pub fn hsla(color: Rgba) -> Hsla {
    gpui::rgb_to_hsla(gpui::Rgba::new(color.r, color.g, color.b, color.a))
}

pub fn pixels(len: Len, context: &TokenContext) -> Pixels {
    px(len.resolve(context.ui_scale, context.viewport))
}

pub fn box_shadows(layers: &[ShadowLayer], context: &TokenContext) -> Vec<BoxShadow> {
    layers
        .iter()
        .map(|layer| BoxShadow {
            color: hsla(layer.color).into(),
            offset: point(pixels(layer.x, context), pixels(layer.y, context)),
            blur_radius: pixels(layer.blur, context),
            spread_radius: pixels(layer.spread, context),
            inset: layer.inset,
        })
        .collect()
}

/// CSS cubic-bezier(x1, y1, x2, y2) solved for y at progress x.
pub fn cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32, x: f32) -> f32 {
    if x <= 0. {
        return 0.;
    }
    if x >= 1. {
        return 1.;
    }
    let bez = |t: f32, a: f32, b: f32| {
        let u = 1. - t;
        3. * u * u * t * a + 3. * u * t * t * b + t * t * t
    };
    let (mut lo, mut hi) = (0f32, 1f32);
    let mut t = x;
    for _ in 0..24 {
        let v = bez(t, x1, x2);
        if (v - x).abs() < 1e-4 {
            break;
        }
        if v < x {
            lo = t;
        } else {
            hi = t;
        }
        t = f32::midpoint(lo, hi);
    }
    bez(t, y1, y2)
}

/// CSS `linear()`: the output at progress `x`, interpolated between (output, input) stops.
pub fn linear_table(stops: &[(f32, f32)], x: f32) -> f32 {
    let (Some(first), Some(last)) = (stops.first(), stops.last()) else {
        return x;
    };
    if x <= first.1 {
        return first.0;
    }
    let right = stops.partition_point(|(_, input)| *input <= x);
    let b = stops.get(right).unwrap_or(last);
    let a = stops.get(right.saturating_sub(1)).unwrap_or(first);
    if a.1 == b.1 {
        b.0
    } else {
        a.0 + (b.0 - a.0) * (x - a.1) / (b.1 - a.1)
    }
}

/// The eased progress of an easing token at linear progress `x` (0..=1).
pub fn ease_at(ease: Ease, at: f32) -> f32 {
    match ease {
        Ease::Bezier([x1, y1, x2, y2]) => cubic_bezier(x1, y1, x2, y2, at),
        Ease::Linear(stops) => linear_table(stops, at),
    }
}

/// An easing token as a gpui animation easing function.
pub fn easing(ease: Ease) -> impl Fn(f32) -> f32 + Clone + 'static {
    move |x| ease_at(ease, x)
}

/// CSS `color-mix(in srgb, a p%, b)`: premultiplied interpolation, `p` in 0..=1.
pub fn mix(a: Hsla, b: Hsla, p: f32) -> Hsla {
    let (a, b) = (gpui::hsla_to_rgba(a), gpui::hsla_to_rgba(b));
    let alpha = a.alpha * p + b.alpha * (1. - p);
    if alpha <= 0. {
        return gpui::transparent_black();
    }
    let channel = |x: f32, y: f32| (x * a.alpha * p + y * b.alpha * (1. - p)) / alpha;
    gpui::rgb_to_hsla(gpui::Rgba::new(
        channel(a.red, b.red),
        channel(a.green, b.green),
        channel(a.blue, b.blue),
        alpha,
    ))
}

/// `color` at `factor` of its alpha (`color-mix(in srgb, color p%, transparent)`).
pub fn with_alpha(color: Hsla, factor: f32) -> Hsla {
    Hsla {
        alpha: color.alpha * factor,
        ..color
    }
}

/// A gradient token as a gpui background. gpui gradients have two stops: the first and last of
/// the token are used (`--conversation-bg` has exactly two).
pub fn gradient(gradient: Gradient) -> Background {
    let stop = |(color, at): (Rgba, f32)| linear_color_stop(hsla(color), at);
    match (gradient.stops.first(), gradient.stops.last()) {
        (Some(from), Some(to)) => linear_gradient(gradient.angle_deg, stop(*from), stop(*to))
            .color_space(ColorSpace::Srgb),
        _ => gpui::transparent_black().into(),
    }
}
