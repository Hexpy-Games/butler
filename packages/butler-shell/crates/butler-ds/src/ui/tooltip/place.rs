//! `placeTooltip` (shadcn/ui/tooltipPlacement.ts): the side order, the room test, the
//! alignment and the clamps, in window pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Top,
    Right,
    Bottom,
    Left,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Start,
    Center,
    End,
}

/// A rectangle by its edges.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub height: f32,
}

impl Rect {
    fn right(self) -> f32 {
        self.left + self.width
    }

    fn bottom(self) -> f32 {
        self.top + self.height
    }
}

/// The window and the gaps kept from its edges.
#[derive(Clone, Copy, Debug)]
pub struct Bounds {
    pub width: f32,
    pub height: f32,
    /// Gap kept from the left, right and bottom edges.
    pub padding: f32,
    /// Lowest top a tooltip may take (the titlebar safe area).
    pub safe_top: f32,
    /// Gap between the trigger and the tooltip.
    pub offset: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    pub left: f32,
    pub top: f32,
    /// The side used after flipping.
    pub side: Side,
}

impl Side {
    fn opposite(self) -> Self {
        match self {
            Self::Top => Self::Bottom,
            Self::Bottom => Self::Top,
            Self::Left => Self::Right,
            Self::Right => Self::Left,
        }
    }

    fn cross(self) -> [Self; 2] {
        match self {
            Self::Top | Self::Bottom => [Self::Right, Self::Left],
            Self::Left | Self::Right => [Self::Top, Self::Bottom],
        }
    }

    fn vertical(self) -> bool {
        matches!(self, Self::Top | Self::Bottom)
    }
}

/// `Math.max(min, Math.min(value, Math.max(min, max)))`.
fn clamp(value: f32, min: f32, max: f32) -> f32 {
    min.max(value.min(min.max(max)))
}

/// Room between the trigger and the window edge on `side`, minus the gap.
fn room(side: Side, trigger: Rect, bounds: Bounds) -> f32 {
    match side {
        Side::Top => trigger.top - bounds.offset - bounds.safe_top,
        Side::Bottom => bounds.height - bounds.padding - trigger.bottom() - bounds.offset,
        Side::Left => trigger.left - bounds.offset - bounds.padding,
        Side::Right => bounds.width - bounds.padding - trigger.right() - bounds.offset,
    }
}

fn aligned_start(align: Align, start: f32, length: f32, size: f32) -> f32 {
    match align {
        Align::Start => start,
        Align::End => start + length - size,
        Align::Center => start + length / 2. - size / 2.,
    }
}

/// Places a `size` tooltip on `side` of `trigger`, aligned by `align`. Without room it flips to
/// the opposite side, then the cross sides, else takes the side with the most room; the result
/// is shifted so the tooltip stays inside the window and below the titlebar.
pub fn place(
    trigger: Rect,
    size: (f32, f32),
    side: Side,
    align: Align,
    bounds: Bounds,
) -> Placement {
    let (width, height) = size;
    let need = |candidate: Side| if candidate.vertical() { height } else { width };
    let [first, second] = side.cross();
    let order = [side, side.opposite(), first, second];
    let slack = |candidate: Side| room(candidate, trigger, bounds) - need(candidate);
    let resolved = order
        .into_iter()
        .find(|candidate| room(*candidate, trigger, bounds) >= need(*candidate))
        .unwrap_or_else(|| {
            order.into_iter().fold(side, |best, next| {
                if slack(next) > slack(best) {
                    next
                } else {
                    best
                }
            })
        });
    let min_left = bounds.padding;
    let max_left = bounds.width - bounds.padding - width;
    let min_top = bounds.safe_top;
    let max_top = bounds.height - bounds.padding - height;
    if resolved.vertical() {
        let top = if resolved == Side::Top {
            trigger.top - bounds.offset - height
        } else {
            trigger.bottom() + bounds.offset
        };
        Placement {
            side: resolved,
            left: clamp(
                aligned_start(align, trigger.left, trigger.width, width),
                min_left,
                max_left,
            ),
            top: clamp(top, min_top, max_top),
        }
    } else {
        let left = if resolved == Side::Left {
            trigger.left - bounds.offset - width
        } else {
            trigger.right() + bounds.offset
        };
        Placement {
            side: resolved,
            left: clamp(left, min_left, max_left),
            top: clamp(
                aligned_start(align, trigger.top, trigger.height, height),
                min_top,
                max_top,
            ),
        }
    }
}
