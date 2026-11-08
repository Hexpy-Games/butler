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
    let mut content = div()
        .w_full()
        .min_h_full()
        .flex()
        .flex_col()
        .items_center()
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
    div()
        .relative()
        .flex()
        .flex_col()
        .h_full()
        .child(scroll)
        .into_any_element()
}
