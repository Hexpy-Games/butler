//! app/space/drag.ts and move.ts, with typed gpui payloads instead of MIME strings.
use super::{Shell, dialogs::SpaceDialog};
use crate::ui::{
    source::{sidebar::SpaceCommand, wire::SpaceNodeKind},
    store::navigation::SpaceRowData,
};
use butler_ds::ui::blocks::{
    drag_preview::DragPreview,
    nav_drop::{
        DragRules, DropZone, DropZoneHit, DropZoneRules, NavDropScope, NavDropTarget,
        NavRootDropZone,
    },
};
use gpui::{AnyElement, Context, SharedString, Window, div, prelude::*};
use std::{collections::BTreeMap, rc::Rc};

/// Node: application/x-butler-space-node; SessionReference: application/x-butler-session-reference.
/// C4 consumes SessionReference when dropped on the composer.
#[derive(Clone, Debug)]
pub(crate) enum SpaceDragPayload {
    Node(String),
    SessionReference(String),
}
impl SpaceDragPayload {
    #[expect(
        dead_code,
        reason = "C4 consumes the shared sidebar-to-composer payload"
    )]
    pub(crate) fn session_id(&self) -> Option<&str> {
        match self {
            Self::Node(key) => key.strip_prefix("s:"),
            Self::SessionReference(id) => Some(id),
        }
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Position {
    Before,
    After,
    Inside,
    Group,
}
impl Position {
    pub(super) fn value(self) -> &'static str {
        match self {
            Self::Before => "before",
            Self::After => "after",
            Self::Inside => "inside",
            Self::Group => "group",
        }
    }
}
pub(super) fn can_drop(
    rows: &BTreeMap<String, SpaceRowData>,
    source: &str,
    target: Option<&str>,
    position: Position,
) -> bool {
    if source == "s:general" || target == Some("s:general") || target == Some(source) {
        return false;
    }
    let Some(source) = rows.get(source) else {
        return false;
    };
    let target_row = target.and_then(|k| rows.get(k));
    if target.is_some() && target_row.is_none() {
        return false;
    }
    if position == Position::Group {
        return target_row.is_some_and(|t| {
            source.session.is_some()
                && t.session.is_some()
                && source.node.scopeProjectId == t.node.scopeProjectId
        });
    }
    if position == Position::Inside && target_row.is_some_and(|t| t.session.is_some()) {
        return false;
    }
    let parent_key = if position == Position::Inside {
        target
    } else {
        target_row.and_then(|r| r.node.parentKey.as_deref())
    };
    let mut parent = parent_key.and_then(|k| rows.get(k));
    let scope = parent.and_then(|p| {
        if p.node.kind == SpaceNodeKind::Project {
            Some(p.node.entityId.as_str())
        } else {
            p.node.scopeProjectId.as_deref()
        }
    });
    if scope != source.node.scopeProjectId.as_deref() && source.node.kind != SpaceNodeKind::Session
    {
        return false;
    }
    while let Some(ancestor) = parent {
        if ancestor.node.key == source.node.key {
            return false;
        }
        parent = ancestor.node.parentKey.as_deref().and_then(|k| rows.get(k));
    }
    true
}
fn position(hit: &DropZoneHit<SharedString>, rows: &BTreeMap<String, SpaceRowData>) -> Position {
    match hit.zone {
        DropZone::Before => Position::Before,
        DropZone::After => Position::After,
        DropZone::Combine
            if rows
                .get(hit.key.as_ref())
                .is_some_and(|r| r.session.is_some()) =>
        {
            Position::Group
        }
        DropZone::Combine => Position::Inside,
    }
}
impl Shell {
    pub(super) fn space_drag_rules(&self, cx: &Context<Self>) -> DragRules<SpaceDragPayload> {
        let rows = self.store.navigation.drag_rows.clone();
        let zones = rows.clone();
        let check = rows.clone();
        let weak = cx.entity().downgrade();
        let collapsed = self.sidebar.collapsed.clone();
        let children = self.store.navigation.drag_children.clone();
        DragRules {
            rules: Rc::new(move |payload, key| {
                let SpaceDragPayload::Node(source) = payload else {
                    return None;
                };
                let row = zones.get(key)?;
                if source == key || key == "s:general" {
                    return None;
                }
                Some(DropZoneRules {
                    combine: can_drop(
                        &zones,
                        source,
                        Some(key),
                        if row.session.is_some() {
                            Position::Group
                        } else {
                            Position::Inside
                        },
                    ),
                    after: row.session.is_some()
                        || collapsed.contains(key)
                        || children
                            .get(&Some(key.to_owned()))
                            .is_none_or(Vec::is_empty),
                })
            }),
            can_drop: Rc::new(move |payload, hit| match payload {
                SpaceDragPayload::Node(source) => can_drop(
                    &check,
                    source,
                    Some(hit.key.as_ref()),
                    position(hit, &check),
                ),
                SpaceDragPayload::SessionReference(_) => false,
            }),
            on_drop: Rc::new(move |payload, hit, _, cx| {
                if let SpaceDragPayload::Node(source) = payload {
                    cx.stop_propagation();
                    let _ = weak.update(cx, |s, cx| {
                        s.request_space_move(
                            source.clone(),
                            Some(hit.key.to_string()),
                            position(&hit, &rows),
                            cx,
                        );
                        s.sidebar.drag_source = None;
                    });
                }
            }),
        }
    }
    pub(super) fn space_drag_row(
        &self,
        row: &SpaceRowData,
        content: AnyElement,
        enabled: bool,
        instance: &str,
        cx: &Context<Self>,
    ) -> AnyElement {
        let key = row.node.key.clone();
        let title = row.title.clone();
        let weak = cx.entity().downgrade();
        let source = key.clone();
        let started_instance = instance.to_owned();
        let content = if self.sidebar.reveal_scroll.as_deref() == Some(key.as_str()) {
            super::gestures::reveal_row(content, self.sidebar.scroll.clone(), weak.clone())
        } else {
            content
        };
        let target = NavDropTarget::new(key.clone(), content)
            .row_header()
            .dragging(self.sidebar.drag_instance.as_deref() == Some(instance))
            .draggable(
                SpaceDragPayload::Node(key.clone()),
                move |_, _| {
                    DragPreview::tab("space-drag-preview", title.clone()).into_any_element()
                },
                move |cx| {
                    let _ = weak.update(cx, |s, cx| {
                        s.sidebar.cancel_long_press();
                        s.sidebar.drag_source = Some(source.clone());
                        s.sidebar.drag_instance = Some(started_instance.clone());
                        cx.notify();
                    });
                },
            );
        let target = if row.session.is_some() {
            target.hint(self.copy("Group together", "그룹으로 묶기"))
        } else {
            target
        };
        let scope = NavDropScope::new(SharedString::from(format!("drop-{instance}")))
            .combine_as(if row.session.is_some() {
                butler_ds::ui::blocks::nav_drop::NavDropPosition::Group
            } else {
                butler_ds::ui::blocks::nav_drop::NavDropPosition::Inside
            })
            .row(target);
        if enabled {
            scope.drag(self.space_drag_rules(cx)).into_any_element()
        } else {
            scope.into_any_element()
        }
    }
    pub(super) fn space_drop_scope(
        &self,
        body: Vec<AnyElement>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut scope = NavDropScope::new("space-drop-scope");
        if let Some(handle) = self.sidebar.scroll.borrow().clone() {
            scope = scope.scroll(handle);
        }
        for element in body {
            scope = scope.other(element);
        }
        if self.sidebar.drag_source.as_deref().is_some_and(|source| {
            can_drop(&self.store.navigation.rows, source, None, Position::Inside)
        }) && self.sidebar.tab == super::Tab::All
        {
            scope = scope.other(self.space_root_drop(cx));
        }
        scope.drag(self.space_drag_rules(cx)).into_any_element()
    }
    fn space_root_drop(&self, cx: &Context<Self>) -> AnyElement {
        let weak = cx.entity().downgrade();
        let over = cx.entity().downgrade();
        div()
            .id("space-root-drop")
            .on_drag_move::<SpaceDragPayload>(move |event, _, cx| {
                let active = event.bounds.contains(&event.event.position);
                if active {
                    cx.stop_propagation();
                }
                let _ = over.update(cx, |s, cx| {
                    if s.sidebar.root_drop_active != active {
                        s.sidebar.root_drop_active = active;
                        cx.notify();
                    }
                });
            })
            .on_drop::<SpaceDragPayload>(move |payload, _, cx| {
                if let SpaceDragPayload::Node(source) = payload {
                    let _ = weak.update(cx, |s, cx| {
                        if can_drop(&s.store.navigation.rows, source, None, Position::Inside) {
                            s.request_space_move(source.clone(), None, Position::Inside, cx);
                        }
                        s.sidebar.drag_source = None;
                    });
                }
            })
            .child(
                NavRootDropZone::new(self.copy("Move to top level", "최상위로 이동"))
                    .active(self.sidebar.root_drop_active),
            )
            .into_any_element()
    }
    pub(super) fn request_space_move(
        &mut self,
        source: String,
        target: Option<String>,
        position: Position,
        cx: &mut Context<Self>,
    ) {
        if !can_drop(
            &self.store.navigation.rows,
            &source,
            target.as_deref(),
            position,
        ) {
            return;
        }
        if position == Position::Group {
            self.sidebar
                .set_dialog(Some(SpaceDialog::Group(source, target.unwrap_or_default())));
            cx.notify();
            return;
        }
        let rows = &self.store.navigation.rows;
        let target_row = target.as_ref().and_then(|k| rows.get(k));
        let parent_key = if position == Position::Inside {
            target.as_deref()
        } else {
            target_row.and_then(|r| r.node.parentKey.as_deref())
        };
        let scope = parent_key.and_then(|k| rows.get(k)).and_then(|p| {
            if p.project.is_some() {
                Some(p.node.entityId.clone())
            } else {
                p.node.scopeProjectId.clone()
            }
        });
        let Some(row) = rows.get(&source) else {
            return;
        };
        if scope != row.node.scopeProjectId && row.session.is_some() {
            self.sidebar.set_dialog(Some(SpaceDialog::Relocate {
                source,
                target,
                position: position.value().to_owned(),
                operation: uuid::Uuid::new_v4().to_string(),
            }));
        } else {
            let body = serde_json::json!({
                "action": "move",
                "sourceKey": source,
                "targetKey": target,
                "position": position.value(),
            });
            self.space_mutate(SpaceCommand::Move, body, cx);
        }
        cx.notify();
    }
}
