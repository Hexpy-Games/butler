//! PopoverContent (shadcn/ui/popover.tsx, Popover.module.css): its props and the surface it
//! draws. The sizing the CSS writes with `calc()` and `min()` of the viewport is resolved here
//! against the window; the mobile attached sheet (width <= 640px) replaces the width, caps the
//! height by the room left and travels instead of scaling.
use gpui::{
    AnyElement, InteractiveElement as _, IntoElement as _, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, div, px,
};

use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::overlay::Presentation;
use crate::ui::overlay::place::{Align, Padding, Resolved, Side};
use crate::ui::overlay::theme::Theme;
use crate::ui::tinted_glass::{GlassPadding, GlassRadius, TintedGlass};

/// `width`: the default 18rem, a narrow readout, or exactly as wide as the anchor.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Width {
    #[default]
    Default,
    Narrow,
    Anchor,
}

/// `density`: `List` has a 4px inset and no gap, for rows that bring their own padding.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Density {
    #[default]
    Default,
    List,
}

/// `data-menu-size`, used by the blocks that fill a popover with a menu or list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuSize {
    Compact,
    Content,
    Wide,
    Fit,
}

/// 1rem, as the DS View's root sets it. // DS: Popover.module.css:4 (`18rem`)
const REM: f32 = 16.;

pub struct PopoverContent {
    pub(super) side: Option<Side>,
    pub(super) align: Align,
    pub(super) side_offset: f32,
    pub(super) width: Width,
    pub(super) density: Density,
    pub(super) menu_size: Option<MenuSize>,
    pub(super) presentation: Option<Presentation>,
    pub(super) theme: Option<Theme>,
    pub(super) auto_focus: bool,
    children: Vec<AnyElement>,
}

impl PopoverContent {
    pub fn new() -> Self {
        Self {
            side: None,
            align: Align::Center,
            side_offset: 4., // DS: popover.tsx:36
            width: Width::Default,
            density: Density::Default,
            menu_size: None,
            presentation: None,
            theme: None,
            auto_focus: false,
            children: Vec::new(),
        }
    }

    /// Radix default: bottom.
    pub fn side(mut self, side: Side) -> Self {
        self.side = Some(side);
        self
    }

    pub fn align(mut self, align: Align) -> Self {
        self.align = align;
        self
    }

    pub fn side_offset(mut self, offset: f32) -> Self {
        self.side_offset = offset;
        self
    }

    pub fn width(mut self, width: Width) -> Self {
        self.width = width;
        self
    }

    pub fn density(mut self, density: Density) -> Self {
        self.density = density;
        self
    }

    pub fn menu_size(mut self, size: MenuSize) -> Self {
        self.menu_size = Some(size);
        self
    }

    /// Defaults to popover, except `Width::Anchor`, which always stays attached to its field.
    pub fn presentation(mut self, presentation: Presentation) -> Self {
        self.presentation = Some(presentation);
        self
    }

    /// The theme of the layer; by default the trigger's.
    pub fn theme(mut self, theme: Theme) -> Self {
        self.theme = Some(theme);
        self
    }

    /// Lets focus move into the popover on open and back to the trigger on close. The DS
    /// prevents both by default (`onOpenAutoFocus`, `onCloseAutoFocus`), so focus stays put.
    pub fn auto_focus(mut self) -> Self {
        self.auto_focus = true;
        self
    }
}

impl PopoverContent {
    /// The children, for a presentation that lays them out itself (the sheet's body).
    pub(super) fn into_children(self) -> Vec<AnyElement> {
        self.children
    }
}

impl Default for PopoverContent {
    fn default() -> Self {
        Self::new()
    }
}

impl gpui::ParentElement for PopoverContent {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// What the surface needs from the window and the position of the last frame.
pub(super) struct Context {
    pub viewport: (f32, f32),
    pub anchor_width: f32,
    pub resolved: Option<Resolved>,
    pub sheet: bool,
}

/// The sheet's insets: left, right, bottom safe areas.
pub(super) fn insets(ds: &Ds) -> (f32, f32, f32) {
    (
        f32::from(ds.len(Length::SafeAreaLeft)),
        f32::from(ds.len(Length::SafeAreaRight)),
        f32::from(ds.len(Length::SafeAreaBottom)),
    )
}

/// A sheet spans the screen, so a left or right side opens below instead (`sheetSide`).
pub(super) fn sheet_side(sheet: bool, side: Side) -> Side {
    if sheet && matches!(side, Side::Left | Side::Right) {
        Side::Bottom
    } else {
        side
    }
}

pub(super) fn collision_padding(ds: &Ds, sheet: bool) -> Padding {
    let base = Padding::content(f32::from(ds.len(Length::TitlebarSafeAreaTop)));
    if sheet {
        let (left, right, bottom) = insets(ds);
        base.with_insets(left, right, bottom)
    } else {
        base
    }
}

/// The widths of the surface: `(width, min, max)`, `None` for CSS `auto` and `max-content`.
type Widths = (Option<f32>, f32, Option<f32>);

impl PopoverContent {
    fn widths(&self, ds: &Ds, cx: &Context) -> Widths {
        let vw = cx.viewport.0;
        let page = |gap: f32| vw - gap;
        if cx.sheet {
            let (left, right, _) = insets(ds);
            let gutter = f32::from(ds.len(Length::PopoverSheetGutter));
            return (Some(vw - 2. * gutter - left - right), 0., None);
        }
        match (self.width, self.menu_size) {
            (Width::Anchor, _) => (Some(cx.anchor_width), 0., Some(page(24.))),
            (_, Some(MenuSize::Compact)) => {
                let w = 340_f32.min(page(24.));
                (Some(w), 0., Some(w))
            }
            (_, Some(MenuSize::Content)) => (None, 0., Some(page(24.))),
            (_, Some(MenuSize::Wide)) => {
                (None, 340_f32.min(page(24.)), Some(420_f32.min(page(24.))))
            }
            (_, Some(MenuSize::Fit)) => {
                (None, 320_f32.min(page(24.)), Some(540_f32.min(page(24.))))
            }
            (Width::Narrow, None) => {
                let w = 280_f32.min(page(32.));
                (Some(w), 0., Some(w))
            }
            (Width::Default, None) => (Some(18. * REM), 0., Some(page(24.))),
        }
    }

    /// The tallest the surface may be on a sheet: the room Radix measured, kept inside the
    /// viewport below the titlebar and above the bottom safe area.
    fn sheet_height(ds: &Ds, cx: &Context) -> f32 {
        let (_, _, bottom) = insets(ds);
        let gutter = f32::from(ds.len(Length::PopoverSheetGutter));
        let fits =
            cx.viewport.1 - f32::from(ds.len(Length::TitlebarSafeAreaTop)) - bottom - 2. * gutter;
        cx.resolved
            .map_or(fits, |resolved| resolved.available_height.min(fits))
    }

    /// The glass surface with its content, sized for this frame.
    pub(super) fn surface(self, ds: &Ds, cx: &Context) -> AnyElement {
        let (width, min, max) = self.widths(ds, cx);
        let (gap, pad) = match (self.menu_size, self.density) {
            (Some(_), _) => (px(0.), ds.len(Length::Space1)),
            (None, Density::List) => (px(0.), ds.len(Length::SpaceXs)),
            (None, Density::Default) => (ds.len(Length::SpaceMd), ds.len(Length::SpaceMd)),
        };
        let body = div()
            .flex()
            .flex_col()
            .gap(gap)
            .p(pad)
            .text_color(ds.color(Color::TextPrimary))
            .children(self.children);
        let body = if cx.sheet {
            // The border is 1px each side of the glass; the content scrolls inside it.
            let height = Self::sheet_height(ds, cx) - 2.;
            div()
                .id("popover-sheet-scroll")
                .max_h(px(height))
                .overflow_y_scroll()
                .child(body)
                .into_any_element()
        } else {
            body.into_any_element()
        };
        let glass = TintedGlass::new()
            .radius(GlassRadius::Popover)
            .padding(GlassPadding::None)
            .child(body);
        let mut sized = div().flex().flex_col().min_w(px(min));
        if let Some(width) = width {
            sized = sized.w(px(width));
        }
        if let Some(max) = max {
            sized = sized.max_w(px(max));
        }
        sized
            .child(glass)
            .debug_selector(|| "popover-content".to_owned())
            .into_any_element()
    }
}
