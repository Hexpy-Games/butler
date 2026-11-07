//! The one tab width inside group pills (useTabStripFit.ts): the row's room after each pill's
//! chrome (border, padding, title, + button, gaps), divided by the open tabs, between the min
//! and max tokens. The chrome is a pill's measured width less its tabs' measured widths, all
//! from the same frame, so the width settles in one more frame and a resize refits it.
use std::collections::HashMap;

use gpui::SharedString;

use super::model::{Group, tab_key};
use crate::tokens::Length;
use crate::ui::context::Ds;

/// What the width is fitted against.
pub(super) struct Row<'a> {
    pub(super) widths: &'a HashMap<SharedString, f32>,
    /// The pills (titled groups), in order.
    pub(super) pills: &'a [&'a Group],
    /// The row's other children (new-tab button, trailing slot) with their gaps.
    pub(super) others: f32,
    pub(super) active: Option<&'a SharedString>,
}

/// The shared tab width, or `None` until the strip, every pill and its tabs are measured.
pub(super) fn fit_width(row: &Row, ds: &Ds) -> Option<f32> {
    let root = row
        .widths
        .get("root")
        .copied()
        .filter(|width| *width > 0.)?;
    let pad = 2. * f32::from(ds.len(Length::FocusRingWidth));
    let gaps = row.pills.len().saturating_sub(1) as f32 * f32::from(ds.len(Length::SpaceXs));
    let mut room = root - row.others - pad - gaps;
    let mut count = 0usize;
    let mut active_open = false;
    for group in row.pills {
        let pill = row
            .widths
            .get(format!("pill:{}", group.id).as_str())
            .copied()
            .filter(|width| *width > 0.)?;
        let open: &[_] = if group.collapsed { &[] } else { &group.tabs };
        let inner: f32 = open
            .iter()
            .map(|tab| row.widths.get(&tab_key(&tab.id)).copied().unwrap_or(0.))
            .sum();
        room -= pill - inner;
        count += open.len();
        active_open |= open.iter().any(|tab| row.active == Some(&tab.id));
    }
    if count == 0 {
        return None;
    }
    let min = f32::from(ds.len(Length::TabStripTabMinWidth));
    let max = f32::from(ds.len(Length::TabStripTabMaxWidth));
    let active_min = min + f32::from(ds.len(Length::Space2xl));
    let mut share = room / count as f32;
    // The selected tab keeps its larger minimum; the others share what is left.
    if active_open && count > 1 && share < active_min {
        share = (room - active_min) / (count - 1) as f32;
    }
    Some(share.clamp(min, max).floor())
}
