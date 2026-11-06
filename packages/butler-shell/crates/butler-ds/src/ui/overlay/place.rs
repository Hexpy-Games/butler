//! The popper positioning of the anchored overlays: what Radix Popper asks floating-ui for. The
//! middleware order is offset, shift (the align axis, limited so the surface stays beside its
//! reference), flip, size (available width and height) and the transform origin. All in window
//! pixels, against the window as the clipping boundary.
pub use crate::ui::tooltip::place::{Align, Rect, Side};

/// `collisionPadding` per edge (`DS/lib/floatingConstraints.ts`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Padding {
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
    pub left: f32,
}

impl Padding {
    /// `floatingContentCollisionPadding`: the titlebar safe area on top, 8px elsewhere.
    pub fn content(safe_top: f32) -> Self {
        Self {
            top: safe_top,
            right: 8.,  // DS: floatingConstraints.ts:7
            bottom: 8., // DS: floatingConstraints.ts:8
            left: 8.,   // DS: floatingConstraints.ts:9
        }
    }

    /// The same padding with `left`, `right` and `bottom` grown by the safe-area insets.
    pub fn with_insets(self, left: f32, right: f32, bottom: f32) -> Self {
        Self {
            top: self.top,
            right: self.right + right,
            bottom: self.bottom + bottom,
            left: self.left + left,
        }
    }
}

/// The Radix content props that steer the position.
#[derive(Clone, Copy, Debug)]
pub struct Options {
    pub side: Side,
    pub align: Align,
    pub side_offset: f32,
    pub padding: Padding,
    /// `avoidCollisions` (Radix default true): flip and shift.
    pub avoid_collisions: bool,
}

/// Where the surface ended up and what the content may use of the window.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Resolved {
    pub left: f32,
    pub top: f32,
    /// The side used after flipping, and the alignment after flipping it.
    pub side: Side,
    pub align: Align,
    /// `--radix-popper-available-width` and `-height`.
    pub available_width: f32,
    pub available_height: f32,
    /// `--radix-popper-transform-origin`, in px from the surface's top-left.
    pub origin: (f32, f32),
}

type Placement = (Side, Align);

fn opposite(side: Side) -> Side {
    match side {
        Side::Top => Side::Bottom,
        Side::Bottom => Side::Top,
        Side::Left => Side::Right,
        Side::Right => Side::Left,
    }
}

fn opposite_align(align: Align) -> Align {
    match align {
        Align::Start => Align::End,
        Align::End => Align::Start,
        Align::Center => Align::Center,
    }
}

fn vertical(side: Side) -> bool {
    matches!(side, Side::Top | Side::Bottom)
}

/// floating-ui's `flip` placements: the opposite side; for an aligned placement also the
/// opposite alignment (`flipAlignment`), in `getExpandedPlacements` order.
fn candidates((side, align): Placement) -> Vec<Placement> {
    let mut list = vec![(side, align)];
    if align == Align::Center {
        list.push((opposite(side), align));
    } else {
        list.push((side, opposite_align(align)));
        list.push((opposite(side), align));
        list.push((opposite(side), opposite_align(align)));
    }
    list
}

/// The surface's top-left for a placement, before any shift.
fn coords(reference: Rect, size: (f32, f32), (side, align): Placement, offset: f32) -> (f32, f32) {
    let (w, h) = size;
    let along = |start: f32, length: f32, own: f32| match align {
        Align::Start => start,
        Align::End => start + length - own,
        Align::Center => start + length / 2. - own / 2.,
    };
    let (right, bottom) = (
        reference.left + reference.width,
        reference.top + reference.height,
    );
    match side {
        Side::Top => (
            along(reference.left, reference.width, w),
            reference.top - h - offset,
        ),
        Side::Bottom => (along(reference.left, reference.width, w), bottom + offset),
        Side::Left => (
            reference.left - w - offset,
            along(reference.top, reference.height, h),
        ),
        Side::Right => (right + offset, along(reference.top, reference.height, h)),
    }
}

/// `within(min, value, max)`: `max(min, min(value, max))`.
fn within(min: f32, value: f32, max: f32) -> f32 {
    min.max(value.min(max))
}

/// `shift({ mainAxis: true, crossAxis: false, limiter: limitShift() })`: slides along the side,
/// into the padded window, but never farther than the reference's own extent.
fn shift(
    reference: Rect,
    size: (f32, f32),
    viewport: (f32, f32),
    pad: Padding,
    side: Side,
    at: (f32, f32),
) -> (f32, f32) {
    let (w, h) = size;
    if vertical(side) {
        let moved = within(pad.left, at.0, viewport.0 - pad.right - w);
        let limited = within(reference.left - w, moved, reference.left + reference.width);
        (limited, at.1)
    } else {
        let moved = within(pad.top, at.1, viewport.1 - pad.bottom - h);
        let limited = within(reference.top - h, moved, reference.top + reference.height);
        (at.0, limited)
    }
}

/// How far the surface reaches past the padded window, per edge (positive: past it).
#[derive(Clone, Copy)]
struct Overflow {
    top: f32,
    right: f32,
    bottom: f32,
    left: f32,
}

fn overflow(at: (f32, f32), size: (f32, f32), viewport: (f32, f32), pad: Padding) -> Overflow {
    Overflow {
        top: pad.top - at.1,
        bottom: at.1 + size.1 - viewport.1 + pad.bottom,
        left: pad.left - at.0,
        right: at.0 + size.0 - viewport.0 + pad.right,
    }
}

impl Overflow {
    fn of(self, side: Side) -> f32 {
        match side {
            Side::Top => self.top,
            Side::Right => self.right,
            Side::Bottom => self.bottom,
            Side::Left => self.left,
        }
    }
}

/// The overflows `flip` weighs for a placement: its side, then the two sides along the align
/// axis.
fn weighed(overflow: Overflow, side: Side) -> [f32; 3] {
    let (a, b) = if vertical(side) {
        (Side::Left, Side::Right)
    } else {
        (Side::Top, Side::Bottom)
    };
    [overflow.of(side), overflow.of(a), overflow.of(b)]
}

struct Attempt {
    placement: Placement,
    at: (f32, f32),
    overflow: Overflow,
    weights: [f32; 3],
}

fn attempt(
    reference: Rect,
    size: (f32, f32),
    viewport: (f32, f32),
    options: Options,
    placement: Placement,
) -> Attempt {
    let mut at = coords(reference, size, placement, options.side_offset);
    if options.avoid_collisions {
        at = shift(reference, size, viewport, options.padding, placement.0, at);
    }
    let overflow = overflow(at, size, viewport, options.padding);
    Attempt {
        placement,
        at,
        overflow,
        weights: weighed(overflow, placement.0),
    }
}

/// floating-ui's flip: the first placement without overflow, else the one with a clear side
/// edge and the least overflow along the align axis, else the least overflow in all.
fn choose(mut attempts: Vec<Attempt>) -> Option<Attempt> {
    let positive = |a: &Attempt| a.weights.iter().filter(|w| **w > 0.).sum::<f32>();
    if let Some(fits) = attempts
        .iter()
        .position(|a| a.weights.iter().all(|w| *w <= 0.))
    {
        return Some(attempts.swap_remove(fits));
    }
    let clear_side = attempts
        .iter()
        .enumerate()
        .filter(|(_, a)| a.weights[0] <= 0.)
        .min_by(|(_, a), (_, b)| a.weights[1].total_cmp(&b.weights[1]))
        .map(|(index, _)| index);
    let least = attempts
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| positive(a).total_cmp(&positive(b)))
        .map(|(index, _)| index);
    clear_side.or(least).map(|pick| attempts.swap_remove(pick))
}

/// `size()`: the room the content may take on the chosen side, kept inside the padded window.
fn available(chosen: &Attempt, size: (f32, f32), avoid_collisions: bool) -> (f32, f32) {
    let ((side, align), o) = (chosen.placement, chosen.overflow);
    let (w, h) = size;
    let (clip_w, clip_h) = (w - o.left - o.right, h - o.top - o.bottom);
    let (width_side, height_side) = if vertical(side) {
        (
            if align == Align::End {
                Side::Left
            } else {
                Side::Right
            },
            side,
        )
    } else {
        (
            side,
            if align == Align::End {
                Side::Top
            } else {
                Side::Bottom
            },
        )
    };
    let along_w = (w - o.of(width_side)).min(clip_w);
    let along_h = (h - o.of(height_side)).min(clip_h);
    match (avoid_collisions, vertical(side)) {
        (true, true) => (clip_w, along_h),
        (true, false) => (along_w, clip_h),
        (false, _) => (along_w, along_h),
    }
}

/// `--radix-popper-transform-origin` without an arrow: the edge facing the reference, at the
/// alignment along it.
fn origin((side, align): Placement, (w, h): (f32, f32)) -> (f32, f32) {
    let along = match align {
        Align::Start => 0.,
        Align::Center => 0.5,
        Align::End => 1.,
    };
    match side {
        Side::Bottom => (along * w, 0.),
        Side::Top => (along * w, h),
        Side::Right => (0., along * h),
        Side::Left => (w, along * h),
    }
}

/// Places a `size` surface against `reference` in a `viewport` (window size).
pub fn resolve(
    reference: Rect,
    size: (f32, f32),
    viewport: (f32, f32),
    options: Options,
) -> Resolved {
    let initial = (options.side, options.align);
    let placements = if options.avoid_collisions {
        candidates(initial)
    } else {
        vec![initial]
    };
    let attempts = placements
        .into_iter()
        .map(|placement| attempt(reference, size, viewport, options, placement))
        .collect();
    let Some(chosen) = choose(attempts) else {
        return Resolved {
            left: reference.left,
            top: reference.top,
            side: options.side,
            align: options.align,
            available_width: size.0,
            available_height: size.1,
            origin: (0., 0.),
        };
    };
    let (available_width, available_height) = available(&chosen, size, options.avoid_collisions);
    Resolved {
        left: chosen.at.0,
        top: chosen.at.1,
        side: chosen.placement.0,
        align: chosen.placement.1,
        available_width,
        available_height,
        origin: origin(chosen.placement, size),
    }
}
