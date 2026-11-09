//! `CanonStatusGlyph.tsx`, `CanonEpicStatus.tsx` and `CriteriaProgress.tsx`.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::progress_meter::ProgressMeter;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::spinner::Spinner;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Styled as _, div};

use super::copy::words;
use crate::ui::source::wire::{CanonStatus, CriteriaCount, EpicCard};
use crate::ui::widgets::anchor;

/// `CanonStatusGlyph`
pub(crate) fn status_glyph(status: CanonStatus, cx: &App) -> AnyElement {
    let glyph = match status {
        CanonStatus::InProgress => Icon::Play,
        CanonStatus::Done => Icon::CheckCircle2,
        CanonStatus::InReview => Icon::Eye,
        CanonStatus::Blocked => Icon::AlertCircle,
        CanonStatus::Cancelled => Icon::CircleX,
        CanonStatus::Planned | CanonStatus::Unknown => Icon::Circle,
    };
    icon(glyph, IconSize::Sm, Ds::get(cx)).into_any_element()
}

fn spinner(epic: &EpicCard) -> Spinner {
    Spinner::new(SharedString::from(format!(
        "canon-epic-spinner-{}",
        epic.id
    )))
    .size(16.)
}

/// `CanonEpicStatus`: the Spinner while the epic's conversation works, else the status glyph.
pub(crate) fn epic_status(epic: &EpicCard, cx: &App) -> AnyElement {
    if epic.running {
        spinner(epic).into_any_element()
    } else {
        status_glyph(epic.canon_status, cx)
    }
}

/// `CanonEpicActivity`: the Spinner while the epic's conversation works; nothing otherwise (the
/// board lane shows the status).
pub(crate) fn epic_activity(epic: &EpicCard, _cx: &App) -> Option<AnyElement> {
    epic.running
        .then(|| div().flex_none().child(spinner(epic)).into_any_element())
}

/// `CriteriaProgress`. The meter's id carries the counts and the label: the seam has no
/// element id, and two cards must not share one meter's fill animation.
pub(crate) fn criteria_progress(
    criteria: Option<&CriteriaCount>,
    label: Option<SharedString>,
    cx: &App,
) -> Option<AnyElement> {
    let criteria = criteria?;
    let count = SharedString::from((words(Ds::get(cx).lang()).criteria_count)(
        criteria.confirmed,
        criteria.total,
    ));
    let small = |n: i64| u16::try_from(n).map_or(0., f32::from);
    let value = if criteria.total > 0 {
        small(criteria.confirmed) / small(criteria.total) * 100.
    } else {
        0.
    };
    let id = SharedString::from(format!(
        "canon-criteria-{}-{}-{}",
        criteria.confirmed,
        criteria.total,
        label.as_deref().unwrap_or_default()
    ));
    let meter = match label {
        Some(label) => ProgressMeter::new(id, value).label(label).meta(count),
        None => ProgressMeter::new(id, value).label(count).meta(""),
    };
    Some(
        anchor(div(), "canon-criteria-progress")
            .child(meter)
            .into_any_element(),
    )
}
