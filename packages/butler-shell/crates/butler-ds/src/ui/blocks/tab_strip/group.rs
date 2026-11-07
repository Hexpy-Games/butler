//! One group (TabStripGroup.tsx). Beside other groups it is an outline pill: its title (which
//! folds it), its tabs and its own new-tab button. A group shown without its title is just its
//! tabs, as flat items of the scroller.
use gpui::{
    AnyElement, ElementId, InteractiveElement as _, IntoElement as _, ParentElement as _,
    SharedString, Styled as _, div, px,
};

use super::model::{Group, GroupKind, chip_key, tab_key};
use super::parts::{chip, group_new};
use super::tab::{Place, slot};
use super::{GAP, Scope};
use crate::tokens::{Color, Length};
use crate::ui::context::Ds;

/// The group's elements for the scroller. `titled`: it is a pill; `lone`: the only group of a
/// strip that hides its title (the pane's own tabs, at full strength like "my tabs").
pub(super) fn view(
    group: &Group,
    scope: &Scope,
    titled: bool,
    lone: bool,
    ds: &Ds,
) -> Vec<AnyElement> {
    let muted = group.kind == GroupKind::Conversation && (titled || !lone);
    let mut prev = titled.then(|| chip_key(&group.id));
    let mut slots = Vec::new();
    if !group.collapsed {
        for tab in &group.tabs {
            let place = Place {
                group,
                tab,
                prev: prev.clone(),
                muted,
                pill: titled,
            };
            slots.push(slot(&place, scope, ds));
            prev = Some(tab_key(&tab.id));
        }
    }
    if !titled {
        return slots;
    }
    let measure = SharedString::from(format!("pill:{}", group.id));
    let id = ElementId::from((scope.id.clone(), measure.clone()));
    // Folded tabs and the + leave with the fold.
    let body = (!group.collapsed).then(|| {
        div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(GAP))
            .pl(px(GAP))
            .children(slots)
            .children((scope.group_new).then(|| group_new(group, scope, ds)))
    });
    vec![
        div()
            .id(id)
            .relative()
            .flex()
            .flex_none()
            .items_center()
            .p(px(GAP))
            .border(ds.len(Length::BorderHairline))
            .border_color(ds.color(Color::Line))
            .rounded(ds.len(Length::RadiusPill))
            .child(chip(group, scope, ds))
            .children(body)
            .children(scope.recorder(&measure))
            .into_any_element(),
    ]
}
