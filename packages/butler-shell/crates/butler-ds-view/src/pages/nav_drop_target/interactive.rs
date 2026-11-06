//! The interactive story of NavDropTarget (NavDropTarget.demo.tsx): a real gpui drag over five
//! rows. Dropping on a row's middle groups the dragged row with it; on an edge it moves it.
use std::rc::Rc;

use butler_ds::tokens::Length;
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::nav_drop::{
    DragRules, DropZone, DropZoneRules, NavDropScope, NavDropTarget,
};
use butler_ds::ui::blocks::nav_row::NavRow;
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::Stack;
use gpui::{
    AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Styled as _, Window, div,
};

use super::super::probe;
use super::HEADER;
use super::copy::copy;
use crate::copy::Lang;

/// One row of the interactive demo.
#[derive(Clone)]
struct DemoRow {
    id: SharedString,
    label: &'static str,
    group: Option<&'static str>,
}

/// The payload of a demo drag: the row's id.
#[derive(Clone)]
struct Dragged(SharedString);

pub(super) fn interactive(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let rows = window.use_keyed_state("ndt-demo-rows", cx, |_, _| {
        c.rows
            .iter()
            .enumerate()
            .map(|(index, label)| DemoRow {
                id: SharedString::from(format!("demo-{index}")),
                label,
                group: None,
            })
            .collect::<Vec<_>>()
    });
    let source = window.use_keyed_state("ndt-demo-source", cx, |_, _| None::<SharedString>);
    let dragging = cx
        .has_active_drag()
        .then(|| source.read(cx).clone())
        .flatten();
    let list = rows.read(cx).clone();
    let drive = demo_rules(rows.clone());
    let mut scope = NavDropScope::new("ndt-demo").drag(drive);
    for row in &list {
        let started = source.clone();
        let key = row.id.clone();
        let label = match row.group {
            Some(group) => format!("{} \u{b7} {} {group}", row.label, c.grouped),
            None => row.label.to_owned(),
        };
        let ghost_label = SharedString::from(label.clone());
        scope = scope.row(
            NavDropTarget::new(
                row.id.clone(),
                NavRow::new(SharedString::from(format!("{}-row", row.id)), label)
                    .glyph(Icon::MessageSquare)
                    .on_click(|_, _, _| {}),
            )
            .dragging(dragging.as_ref() == Some(&row.id))
            .indicator(HEADER.0, HEADER.1)
            .hint(c.group)
            .draggable(
                Dragged(key.clone()),
                move |_, cx| ghost(&ghost_label, cx),
                move |cx| {
                    started.update(cx, |source, cx| {
                        *source = Some(key.clone());
                        cx.notify();
                    });
                },
            ),
        );
    }
    let order = list
        .iter()
        .map(|row| row.id.as_ref())
        .collect::<Vec<_>>()
        .join(",");
    let groups = list
        .iter()
        .filter_map(|row| row.group.map(|group| format!("{}>{group}", row.id)))
        .collect::<Vec<_>>()
        .join(",");
    Stack::new()
        .child(scope)
        .child(probe(format!("ndt-order:{order}")))
        .child(probe(format!("ndt-groups:{groups}")))
        .child(probe(format!("ndt-dragging:{}", dragging.is_some())))
        .into_any_element()
}

/// The rules of the demo's drag: every other row takes a drop in all three zones; a drop
/// moves or groups the dragged row.
fn demo_rules(rows: gpui::Entity<Vec<DemoRow>>) -> DragRules<Dragged> {
    DragRules::<Dragged> {
        rules: Rc::new(|dragged, key| {
            (dragged.0 != key).then_some(DropZoneRules {
                combine: true,
                after: true,
            })
        }),
        can_drop: Rc::new(|dragged, hit| dragged.0 != hit.key),
        on_drop: Rc::new(move |dragged, hit, _, cx| {
            rows.update(cx, |rows, cx| {
                commit(rows, &dragged.0, &hit.key, hit.zone);
                cx.notify();
            });
        }),
    }
}

/// What follows the pointer: the row's label on a raised pill.
fn ghost(label: &SharedString, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    div()
        .px(ds.len(Length::SpaceMd))
        .py(ds.len(Length::SpaceXs))
        .rounded(ds.len(Length::RadiusControl))
        .bg(ds.color(butler_ds::tokens::Color::SurfaceRaised))
        .child(label.clone())
        .into_any_element()
}

/// Applies a committed drop: a `Combine` groups the dragged row with the target; the other
/// zones move it before or after the target.
fn commit(rows: &mut Vec<DemoRow>, source: &SharedString, target: &SharedString, zone: DropZone) {
    let Some(from) = rows.iter().position(|row| &row.id == source) else {
        return;
    };
    if zone == DropZone::Combine {
        let label = rows
            .iter()
            .find(|row| &row.id == target)
            .map(|row| row.label);
        rows[from].group = label;
        return;
    }
    let moving = rows.remove(from);
    let Some(at) = rows.iter().position(|row| &row.id == target) else {
        rows.insert(from, moving);
        return;
    };
    rows.insert(at + usize::from(zone == DropZone::After), moving);
}
