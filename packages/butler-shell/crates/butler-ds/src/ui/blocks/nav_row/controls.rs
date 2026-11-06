//! The control region of a NavRow (`.controlRegion`, `.badge`, `.actions`, `.hoverActions`): a
//! badge, then the actions, which a hover-only row lays over the badge's place and fades in.
use gpui::{
    AnyElement, Div, IntoElement as _, ParentElement as _, Pixels, SharedString, Styled as _, div,
    prelude::FluentBuilder as _, px,
};

use super::{ActionsVisibility, Look};
use crate::tokens::{Color, Length};
use crate::ui::blocks::scope::{self, ActionScale, Spec};
use crate::ui::context::Ds;

/// The icon an action button draws (`--nav-row-action-icon-size`).
const ACTION_ICON: f32 = 14.; // DS: NavRow.module.css:131
/// The hover actions arrive from this far right (`translate(2px, -50%)`).
const ACTION_TRAVEL: f32 = 2.; // DS: NavRow.module.css:233
/// `min-width: 4ch` of a region that holds hover actions, in px at the row's text size.
const FOUR_CH: f32 = 28.; // DS: NavRow.module.css:200

pub(super) struct Controls {
    pub(super) badge: Option<SharedString>,
    pub(super) actions: Option<AnyElement>,
    pub(super) visibility: ActionsVisibility,
    /// The region's height when the row is multiline with a meta line.
    pub(super) fixed_height: Option<Pixels>,
}

impl Controls {
    pub(super) fn build(self, look: &Look, ds: &Ds) -> Option<AnyElement> {
        if self.badge.is_none() && self.actions.is_none() {
            return None;
        }
        Some(self.region(look, ds).into_any_element())
    }

    fn region(self, look: &Look, ds: &Ds) -> Div {
        let hover = self.actions.is_some() && self.visibility != ActionsVisibility::Visible;
        let mut region = div()
            .relative()
            .flex()
            .flex_none()
            .items_center()
            .justify_end()
            .gap(ds.len(Length::Space1));
        if let Some(height) = self.fixed_height {
            region = region.h(height);
        }
        if hover {
            region = region.min_w(px(FOUR_CH));
        }
        if look.sidebar && self.actions.is_some() {
            // `--nav-action-edge-offset`: the actions reach into the row's inline padding.
            region = region.mr(-ds.len(Length::SpaceSm));
        }
        region
            .children(self.badge.map(|badge| {
                badge_cell(badge, ds).opacity(if hover { 1. - look.reveal } else { 1. })
            }))
            .children(self.actions.map(|actions| {
                let actions = in_action_scale(actions, look);
                if hover {
                    let hidden =
                        self.visibility == ActionsVisibility::HoverCompactHidden && look.compact;
                    hover_actions(actions, look, hidden)
                } else {
                    div()
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_end()
                        .gap(px(1.)) // DS: NavRow.module.css:213
                        .child(actions)
                        .into_any_element()
                }
            }))
    }
}

/// A button in a row is one line tall (`.clickable [data-slot="button"][data-size^="icon"]`,
/// Clickable.module.css:129-139), its glyph `min(--icon-size-md, 0.78lh)`; a SidebarShell sets
/// `--clickable-action-size` and `--clickable-action-icon-size` to the density's action and
/// icon sizes (SidebarShell.module.css:7).
fn in_action_scale(actions: AnyElement, look: &Look) -> AnyElement {
    let (side, glyph) = if look.sidebar {
        (look.m.action, look.m.icon)
    } else {
        (look.line, look.icon_md.min(look.line * 0.78)) // DS: Clickable.module.css:137
    };
    let spec = Spec {
        action: Some(ActionScale {
            side,
            icon: glyph,
            fixed: true,
        }),
        ..Spec::default()
    };
    scope::scoped(spec, actions).into_any_element()
}

/// The right-aligned caption of a row (`.badge`).
fn badge_cell(badge: SharedString, ds: &Ds) -> Div {
    div()
        .flex_none()
        .overflow_hidden()
        .text_right()
        .text_color(ds.color(Color::TextTertiary))
        .font_family(ds.body_font().clone())
        .text_size(ds.len(Length::FontSize1))
        .line_height(ds.len(Length::TypoCaptionLineHeight))
        .child(badge)
}

/// `.hoverActions`: centred on the region's end, past the badge's place; they and the badge
/// swap as the row's reveal (read in `fade`) runs, the actions arriving from 2px right.
fn hover_actions(actions: AnyElement, look: &Look, compact_hidden: bool) -> AnyElement {
    let target = look.m.action;
    let offset = (target - ACTION_ICON) / -2. - 3.; // DS: NavRow.module.css:132
    let shown = look.reveal > 0.001 && !compact_hidden;
    let travel = ACTION_TRAVEL * (1. - look.reveal);
    div()
        .absolute()
        .top_0()
        .bottom_0()
        .right(px(offset - travel))
        .min_w(px(target))
        .flex()
        .items_center()
        .justify_center()
        .opacity(look.reveal)
        .when(!shown, gpui::Styled::invisible)
        .child(actions)
        .into_any_element()
}
