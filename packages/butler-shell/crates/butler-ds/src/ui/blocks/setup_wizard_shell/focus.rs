//! The focus variant (`.focusScroll`, `.focusScrollContent`, `.focusColumn` of
//! SetupWizardShell.module.css): one centred column on the backdrop; the whole window scrolls.
use gpui::{
    AnyElement, App, ElementId, IntoElement as _, ParentElement as _, Styled as _, div, px,
};

use super::SetupWizardAnchor;
use crate::tokens::Length;
use crate::ui::context::Ds;
use crate::ui::scroll::ScrollArea;

/// `anchor="top"`: the card's top edge sits at this share of the window, at most
/// [`TOP_MAX`]. // DS: SetupWizardShell.module.css:143-147
const TOP_SHARE: f32 = 0.2;
const TOP_MAX: f32 = 240.;
/// The ScrollArea's narrowest scrollbar lane (`--scroll-area-scrollbar-offset`).
/// // DS: ScrollArea.module.css:18-21
const LANE_MIN: f32 = 10.;

/// `column` (the card or the stage) in the window-wide scroller.
pub(super) fn body(
    id: &ElementId,
    anchor: SetupWizardAnchor,
    narrow: bool,
    column: AnyElement,
    cx: &App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let edge = f32::from(ds.len(Length::TitlebarHeight) + ds.len(Length::SpaceLg));
    let side = ds.len(if narrow {
        Length::SpaceLg
    } else {
        Length::Space2xl
    });
    let top = match anchor {
        SetupWizardAnchor::Center => edge,
        SetupWizardAnchor::Top => {
            let viewport = f32::from(ds.len(Length::AdaptiveViewportBlockSize));
            (TOP_SHARE * viewport).min(TOP_MAX).max(edge)
        }
    };
    // The column is the scroll area's content element (`contentClassName`), so its padding
    // replaces the area's: no edge padding above and below, no ring room at the inline start;
    // the lane past the column stays. // DS: SetupWizardShell.tsx:107-110, ScrollArea.module.css:95-105
    let (fade, room) = (
        ds.len(Length::ScrollFadeSize),
        ds.len(Length::FocusRingRoom),
    );
    // Stretched, not `w_full`: the negative start margin widens it like the content's
    // `calc(100% - lane)` width.
    let mut content = div()
        .min_h_full()
        .flex()
        .flex_col()
        .items_center()
        .mt(-fade)
        .mb(-fade)
        .ml(-room)
        .pt(px(top))
        .pb(px(edge))
        .px(side);
    if anchor == SetupWizardAnchor::Center {
        content = content.justify_center();
    }
    let column = div()
        .w_full()
        .max_w(ds.len(Length::PageContainerNarrow))
        .flex()
        .flex_col()
        .items_center()
        .child(column);
    let scroll = ScrollArea::new((id.clone(), "scroll"))
        .fill()
        .child(content.child(column));
    // `.screen`'s `place-items: center` still holds in the focus variant's block layout, so the
    // scroll frame, a scrollbar lane wider than the screen, overflows by half the lane on each
    // side. // DS: SetupWizardShell.module.css:3-5, ScrollArea.module.css:18-21
    let lane = px(LANE_MIN).max(room);
    div()
        .relative()
        .left(-lane / 2.)
        .flex()
        .flex_col()
        .h_full()
        .child(scroll)
        .into_any_element()
}
