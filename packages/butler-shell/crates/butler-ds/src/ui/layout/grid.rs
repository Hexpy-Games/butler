//! DS Grid (Grid.tsx / Grid.module.css). gpui has no grid tracks, so rows are flex rows whose
//! cells get explicit widths computed from the measured container width, with CSS grid's
//! auto-placement, track sizing (`1fr`, `auto-fit`, `minmax`) and `gap`.
use gpui::{
    AnyElement, App, Div, ElementId, IntoElement, ParentElement, Pixels, RenderOnce, Styled as _,
    Window, canvas, div, px,
};

use super::{ItemProps, Space, Span, WithItem};
use crate::ui::context::Ds;
use crate::ui::strut;

/// `repeat(auto-fit, minmax(min(100%, 240px), 1fr))`: the minimum track width.
const AUTO_TRACK_MIN: f32 = 240.; // DS: Grid.module.css:41
/// `min(7rem, 40%)`: the label track of `label-value` (rem is 16px).
const LABEL_TRACK_MIN: f32 = 112.; // DS: Grid.module.css:50
const LABEL_TRACK_MAX_SHARE: f32 = 0.4; // DS: Grid.module.css:50
/// `0.28fr` against `1fr`.
const LABEL_TRACK_FR: f32 = 0.28; // DS: Grid.module.css:50
/// Viewport fallbacks for the fixed presets.
const MEDIUM_VIEWPORT: f32 = 960.; // DS: Grid.module.css
const SMALL_VIEWPORT: f32 = 700.; // DS: Grid.module.css
/// `@container page (min-width: 48rem)` and `(max-width: 36rem)`.
const WIDE_CONTAINER: f32 = 768.; // DS: Grid.module.css
const COMPACT_CONTAINER: f32 = 576.; // DS: Grid.module.css

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preset {
    /// `repeat(n, minmax(0, 1fr))`: 1, 2, 3, 4, 6 or 12.
    Fixed(u8),
    AutoFit,
    AutoFill,
    MainAside,
    LabelValue,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Columns {
    Preset(Preset),
    Responsive(Responsive),
}

impl Columns {
    pub const AUTO_FIT: Self = Self::Preset(Preset::AutoFit);
    pub const AUTO_FILL: Self = Self::Preset(Preset::AutoFill);
    pub const MAIN_ASIDE: Self = Self::Preset(Preset::MainAside);
    pub const LABEL_VALUE: Self = Self::Preset(Preset::LabelValue);

    pub const fn fixed(count: u8) -> Self {
        Self::Preset(Preset::Fixed(count))
    }
}

/// `{ compact?, base, wide? }` column counts, switched by the container's width.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Responsive {
    pub compact: Option<u8>,
    pub base: Preset,
    pub wide: Option<Preset>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum GridCross {
    #[default]
    Stretch,
    Start,
}

#[derive(IntoElement)]
pub struct GridItem {
    span: Span,
    item: ItemProps,
    children: Vec<AnyElement>,
}

impl GridItem {
    pub fn new() -> Self {
        Self {
            span: Span::One,
            item: ItemProps::default(),
            children: Vec::new(),
        }
    }

    pub fn span(mut self, span: Span) -> Self {
        self.span = span;
        self
    }
}

impl Default for GridItem {
    fn default() -> Self {
        Self::new()
    }
}

impl WithItem for GridItem {
    fn item_mut(&mut self) -> &mut ItemProps {
        &mut self.item
    }
}

impl ParentElement for GridItem {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for GridItem {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        strut::scope(
            true,
            strut::container(self.item.apply(div().min_w_0(), Ds::get(cx)), Ds::get(cx))
                .children(self.children),
        )
    }
}

#[derive(IntoElement)]
pub struct Grid {
    id: ElementId,
    columns: Columns,
    gap: Space,
    cross: GridCross,
    page_container: bool,
    cells: Vec<(Span, AnyElement)>,
}

impl Grid {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            columns: Columns::AUTO_FIT,
            gap: Space::Md,
            cross: GridCross::Stretch,
            page_container: false,
            cells: Vec::new(),
        }
    }

    pub fn columns(mut self, columns: Columns) -> Self {
        self.columns = columns;
        self
    }

    pub fn gap(mut self, gap: Space) -> Self {
        self.gap = gap;
        self
    }

    pub fn cross(mut self, cross: GridCross) -> Self {
        self.cross = cross;
        self
    }

    /// The grid sits inside a PageContainer (`container: page`). Only then do the `compact` and
    /// `wide` columns of a responsive choice apply (`@container page`); outside one the query
    /// matches no container and `base` always applies.
    pub fn page_container(mut self) -> Self {
        self.page_container = true;
        self
    }

    pub fn child(mut self, child: impl IntoElement) -> Self {
        // The child is the grid item itself (blockified), so it has no strut.
        let cell = strut::scope(false, div().min_w_0().child(child));
        self.cells.push((Span::One, cell.into_any_element()));
        self
    }

    pub fn children(mut self, children: impl IntoIterator<Item = impl IntoElement>) -> Self {
        for child in children {
            self = self.child(child);
        }
        self
    }

    pub fn item(mut self, item: GridItem) -> Self {
        self.cells.push((item.span, item.into_any_element()));
        self
    }
}

/// The resolved tracks of one layout: widths in px, and whether items align to baselines.
struct Tracks {
    widths: Vec<f32>,
    baseline: bool,
}

fn fixed(count: usize, width: f32, gap: f32) -> Vec<f32> {
    let each = (width - gap * (count.saturating_sub(1)) as f32) / count.max(1) as f32;
    vec![each.max(0.); count.max(1)]
}

/// The viewport media fallbacks of the fixed presets (4 and 3 become 2, 6 becomes 3 at <= 960px;
/// 2, 3, 4, 6, 12 and main-aside become 1 at <= 700px).
fn fallback(preset: Preset, viewport: f32) -> Preset {
    let small = viewport <= SMALL_VIEWPORT;
    match preset {
        Preset::MainAside if small => Preset::Fixed(1),
        Preset::Fixed(n) if small && matches!(n, 2 | 3 | 4 | 6 | 12) => Preset::Fixed(1),
        Preset::Fixed(3 | 4) if viewport <= MEDIUM_VIEWPORT => Preset::Fixed(2),
        Preset::Fixed(6) if viewport <= MEDIUM_VIEWPORT => Preset::Fixed(3),
        other => other,
    }
}

/// The preset a responsive choice picks at the container's width (no viewport fallbacks).
fn responsive(r: Responsive, width: f32, page_container: bool) -> Preset {
    if !page_container {
        return r.base;
    }
    if let Some(n) = r.compact.filter(|_| width <= COMPACT_CONTAINER) {
        return Preset::Fixed(n);
    }
    r.wide.filter(|_| width >= WIDE_CONTAINER).unwrap_or(r.base)
}

fn resolve(
    columns: Columns,
    page_container: bool,
    width: f32,
    gap: f32,
    items: usize,
    viewport: f32,
) -> Tracks {
    let preset = match columns {
        Columns::Responsive(r) => responsive(r, width, page_container),
        Columns::Preset(preset) => fallback(preset, viewport),
    };
    let widths = match preset {
        Preset::Fixed(n) => fixed(usize::from(n), width, gap),
        Preset::AutoFit | Preset::AutoFill => {
            let min = AUTO_TRACK_MIN.min(width);
            #[expect(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "a track count from a nonnegative width"
            )]
            let fit = (((width + gap) / (min + gap)).floor() as usize).max(1);
            let count = if preset == Preset::AutoFit {
                fit.min(items.max(1))
            } else {
                fit
            };
            fixed(count, width, gap)
        }
        Preset::MainAside => {
            let free = (width - gap).max(0.);
            vec![free * 2. / 3., free / 3.]
        }
        Preset::LabelValue => {
            let free = (width - gap).max(0.);
            let label_min = LABEL_TRACK_MIN.min(width * LABEL_TRACK_MAX_SHARE);
            let label = (free * LABEL_TRACK_FR / (1. + LABEL_TRACK_FR)).max(label_min);
            vec![label, (free - label).max(0.)]
        }
    };
    Tracks {
        widths,
        baseline: preset == Preset::LabelValue,
    }
}

type Placed = Vec<Vec<(usize, usize, AnyElement)>>;

/// Auto-placement: items fill a row in order; an item that no longer fits starts the next row.
fn place(cells: Vec<(Span, AnyElement)>, tracks: usize) -> Placed {
    let mut rows: Placed = Vec::new();
    let mut used = 0;
    for (span, cell) in cells {
        let span = match span {
            Span::One => 1,
            Span::Two => 2,
            Span::Three => 3,
            Span::Full => tracks,
        }
        .clamp(1, tracks);
        if used + span > tracks || rows.is_empty() {
            rows.push(Vec::new());
            used = 0;
        }
        if let Some(row) = rows.last_mut() {
            row.push((used, span, cell));
        }
        used += span;
    }
    rows
}

fn row(
    cells: Vec<(usize, usize, AnyElement)>,
    tracks: &Tracks,
    gap: Pixels,
    cross: GridCross,
) -> Div {
    let mut row = div().flex().flex_row().gap(gap);
    row = if tracks.baseline {
        row.items_baseline()
    } else if cross == GridCross::Start {
        row.items_start()
    } else {
        row.items_stretch()
    };
    for (start, span, cell) in cells {
        let spanned = tracks.widths.iter().skip(start).take(span).sum::<f32>();
        let width = spanned + f32::from(gap) * (span - 1) as f32;
        row = row.child(div().w(px(width)).flex_none().min_w_0().child(cell));
    }
    row
}

impl RenderOnce for Grid {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let measured = window.use_keyed_state(self.id.clone(), cx, |_, _| 0f32);
        let width = *measured.read(cx);
        let ds = Ds::get(cx);
        let gap = self.gap.px(ds);
        let viewport = ds.tokens().viewport.0;
        let probe = canvas(
            |_, _, _| (),
            move |bounds, (), _, cx| {
                let now = f32::from(bounds.size.width);
                if (now - *measured.read(cx)).abs() > 0.25 {
                    measured.update(cx, |width, cx| {
                        *width = now;
                        cx.notify();
                    });
                }
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();
        let mut grid = div()
            .relative()
            .w_full()
            .flex()
            .flex_col()
            .gap(gap)
            .child(probe);
        if width > 0. {
            let tracks = resolve(
                self.columns,
                self.page_container,
                width,
                f32::from(gap),
                self.cells.len(),
                viewport,
            );
            for cells in place(self.cells, tracks.widths.len()) {
                grid = grid.child(row(cells, &tracks, gap, self.cross));
            }
        }
        grid
    }
}
