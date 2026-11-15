//! DS BrowserPane (BrowserPane.tsx / BrowserPane.module.css): the browser sheet, a tinted pane
//! whose top corners match the page card, holding the tab row, the toolbar and the page card
//! flush with its edges. Pure layout; the app owns tabs, navigation and pages.
//!
//! One edge, one hairline: the sheet's leading hairline is the chat | pane divider, and its
//! trailing and bottom edges meet the window frame, so it tucks its own trailing border under
//! that frame (negative margins). In the cards frame (docked) the sheet is a card of its own:
//! four shell-card corners, one quiet edge, nothing tucked.
//!
//! While Butler holds the tab (`holder`), the sheet's own edge takes the riso inks on all its
//! edges, turning slowly like the page card's edge did. The CSS finds the holder with `:has()`;
//! gpui cannot ask a child, so the screen passes the same holder to the pane and its card.
//! gpui paints children into a rectangle, so in the cards frame the pane paints the shell colour
//! outside its rounded corners and its edge over its children, which clips the flush page.
mod toolbar;

use gpui::{
    AnyElement, App, Bounds, Corners, Edges, ElementId, Hsla, InteractiveElement as _, IntoElement,
    ParentElement as _, Pixels, RenderOnce, SharedString, Styled as _, Window, canvas, div,
};

pub use toolbar::BrowserToolbar;

use super::page_card::{
    PageCard, PageCardHolder, PaneFrame, Ring, corner_caps, inks, riso_fill, riso_ring,
};
use super::scope;
use crate::tokens::{Color, Length, Percent};
use crate::ui::context::Ds;
use crate::ui::convert::mix;

/// `conversation`: beside the chat column (an AdaptiveShellSplit pane). `standalone`: the
/// Browser view under its own title bar.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PanePlacement {
    #[default]
    Conversation,
    Standalone,
}

#[derive(IntoElement)]
pub struct BrowserPane {
    id: ElementId,
    label: SharedString,
    placement: PanePlacement,
    holder: PageCardHolder,
    tabs: AnyElement,
    toolbar: AnyElement,
    page: PageCard,
}

impl BrowserPane {
    /// `label`: the accessible name of the region ("Browser"). `tabs` is the tab row (a
    /// TabStrip with its `trailing` controls), `toolbar` a BrowserToolbar, `page` a PageCard.
    pub fn new(
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        tabs: impl IntoElement,
        toolbar: impl IntoElement,
        page: PageCard,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            placement: PanePlacement::Conversation,
            holder: PageCardHolder::None,
            tabs: tabs.into_any_element(),
            toolbar: toolbar.into_any_element(),
            page,
        }
    }

    /// The accessible name of the region (gpui draws none of it).
    pub fn aria_label(&self) -> &SharedString {
        &self.label
    }

    pub fn placement(mut self, placement: PanePlacement) -> Self {
        self.placement = placement;
        self
    }

    /// Who holds the page card's tab: Butler turns the pane's edge into the riso edge.
    pub fn holder(mut self, holder: PageCardHolder) -> Self {
        self.holder = holder;
        self
    }
}

/// The edges and tints one pane is drawn with.
struct Look {
    docked: bool,
    bg: Hsla,
    radius: Pixels,
    hairline: Pixels,
}

fn look(ds: &Ds, cx: &App) -> Look {
    let docked = scope::vars(cx).is_some_and(|vars| vars.cards_docked);
    let (bg, radius) = if docked {
        // `--browser-pane-bg`: a faint ink tint of the card surface.
        let tint = ds.tokens().percent(Percent::ShellSheetTint);
        (
            mix(
                ds.color(Color::TextPrimary),
                ds.color(Color::ShellCardBg),
                tint,
            ),
            ds.len(Length::ShellCardRadius),
        )
    } else {
        (
            ds.color(Color::BrowserPaneBg),
            ds.len(Length::BrowserPaneRadius),
        )
    };
    Look {
        docked,
        bg,
        radius,
        hairline: ds.len(Length::BorderHairline),
    }
}

impl BrowserPane {
    fn tab_row(look: &Look, ds: &Ds) -> gpui::Div {
        let inset = ds.len(Length::BrowserCardInset);
        let row = div().flex().min_w_0().flex_none();
        if look.docked {
            // The first tab sits `--browser-card-inset` off the card's top and left edges; the
            // tab strip pads itself by the focus ring's width.
            let ring = ds.len(Length::FocusRingWidth);
            row.items_start()
                .pt(inset - ring)
                .pl(inset - ring)
                .pr(inset)
        } else {
            row.items_center()
                .min_h(ds.menu_item_height() + ds.len(Length::SpaceXs))
                .px(inset)
                .pb(ds.len(Length::SpaceXs))
        }
    }

    /// The edge as a ring: the riso inks while Butler holds the tab, else the quiet shell-card edge.
    fn ring(&self, look: &Look, ds: &Ds) -> Ring {
        let butler = self.holder == PageCardHolder::Butler;
        let hair = look.hairline;
        let (radii, widths) = if look.docked {
            (Corners::all(look.radius), Edges::all(hair))
        } else {
            (
                Corners {
                    top_left: look.radius,
                    top_right: look.radius,
                    bottom_right: Pixels::ZERO,
                    bottom_left: Pixels::ZERO,
                },
                Edges {
                    top: hair,
                    left: hair,
                    right: hair,
                    bottom: Pixels::ZERO,
                },
            )
        };
        let edge = ds.color(Color::ShellCardEdge);
        Ring {
            radii,
            widths,
            inks: if butler { inks(ds) } else { [edge; 3] },
        }
    }

    /// The pane's border box, as an absolute layer (absolute boxes are placed from the padding
    /// box: reach back over the border).
    fn layer(look: &Look, child: AnyElement) -> AnyElement {
        let hair = look.hairline;
        let bottom = if look.docked { -hair } else { Pixels::ZERO };
        div()
            .absolute()
            .top(-hair)
            .left(-hair)
            .right(-hair)
            .bottom(bottom)
            .child(child)
            .into_any_element()
    }

    /// While Butler holds the tab: the conic under the (94%) surface, so it tints it as the CSS
    /// border-box background does.
    fn fill(&self, look: &Look, ds: &Ds) -> Option<AnyElement> {
        (self.holder == PageCardHolder::Butler).then(|| {
            Self::layer(
                look,
                riso_fill(self.ring(look, ds), look.bg).into_any_element(),
            )
        })
    }

    /// The pane's own edge, painted over its children: the riso ring while Butler holds the
    /// tab, else (cards frame) the quiet shell-card edge; the cards frame also clips the corners.
    fn edge(&self, look: &Look, ds: &Ds) -> Vec<AnyElement> {
        if !look.docked && self.holder != PageCardHolder::Butler {
            return Vec::new();
        }
        let mut layers = Vec::new();
        if look.docked {
            let shell = ds.color(Color::ShellBg);
            let radius = look.radius;
            layers.push(Self::layer(
                look,
                canvas(
                    |bounds: Bounds<Pixels>, _, _| bounds,
                    move |_, bounds, window, _| corner_caps(window, bounds, [radius; 4], shell),
                )
                .absolute()
                .size_full()
                .into_any_element(),
            ));
        }
        layers.push(Self::layer(
            look,
            riso_ring(self.ring(look, ds)).into_any_element(),
        ));
        layers
    }
}

impl RenderOnce for BrowserPane {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let look = look(ds, cx);
        let butler = self.holder == PageCardHolder::Butler;
        let hair = look.hairline;
        let mut pane = div()
            .id(self.id.clone())
            .relative()
            .flex()
            .flex_col()
            .flex_auto()
            .min_w_0()
            .min_h_0()
            .h_full()
            .overflow_hidden();
        // While Butler holds the tab the surface is painted over the conic fill (see `fill`).
        pane = if butler { pane } else { pane.bg(look.bg) };
        pane = if look.docked {
            // Painted by the edge layer over the children, so it is transparent here.
            pane.border(hair)
                .border_color(gpui::transparent_black())
                .rounded(look.radius)
        } else {
            let edge = if butler {
                gpui::transparent_black()
            } else {
                ds.color(Color::Line)
            };
            let pane = pane
                .pt(ds.len(Length::SpaceXs))
                .border_t(hair)
                .border_l(hair)
                .border_r(hair)
                .border_color(edge)
                .rounded_t(look.radius)
                .mr(-hair);
            match self.placement {
                PanePlacement::Standalone => pane.ml(-hair),
                PanePlacement::Conversation => pane,
            }
        };
        let row = Self::tab_row(&look, ds);
        let edge = self.edge(&look, ds);
        let fill = self.fill(&look, ds);
        let page = self.page.in_pane(PaneFrame {
            radius: if look.docked {
                ds.len(Length::ShellCardRadius)
            } else {
                Pixels::ZERO
            },
            page_shadow: look.docked,
            backdrop: look.bg,
        });
        let stage = div()
            .flex()
            .flex_col()
            .flex_auto()
            .min_w_0()
            .min_h_0()
            .ml(-hair)
            .mr(-hair)
            .mb(-hair)
            .child(page);
        let tabs = row.child(div().flex().flex_auto().min_w_0().child(self.tabs));
        pane.children(fill)
            .child(tabs)
            .child(self.toolbar)
            .child(stage)
            .children(edge)
    }
}
