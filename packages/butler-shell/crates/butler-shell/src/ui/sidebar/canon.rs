//! CanonSidebarGroups / useCanonSidebar: read on expansion, refresh on changes.
pub(super) mod forms;
mod group_menu;
use super::Shell;
use crate::ui::{
    Icon,
    source::{
        sidebar::Mutation,
        wire::{CanonSidebarGroup, EpicCard},
    },
};
use butler_ds::ui::{
    avatar::Avatar,
    blocks::{
        collapsible_nav_group::CollapsibleNavGroup,
        drag_preview::DragPreview,
        nav_drop::{DragRules, DropZone, DropZoneRules, NavDropScope, NavDropTarget},
        nav_row::NavRow,
    },
    typo::Typo,
};
use gpui::{AnyElement, Context, SharedString, div, prelude::*};
use std::rc::Rc;
#[derive(Clone)]
struct CanonDrag {
    project: String,
    group: String,
    epic: EpicCard,
}
impl Shell {
    pub(super) fn refresh_canon(&mut self, cx: &mut Context<Self>) {
        if self.sidebar.pending {
            return;
        }
        let projects = self.expanded_canon_projects();
        for project in projects {
            self.load_canon_sidebar(project, cx);
        }
    }
    pub(super) fn ensure_canon(&mut self, cx: &mut Context<Self>) {
        for project in self.expanded_canon_projects() {
            if !self.sidebar.canon.contains_key(&project) {
                self.load_canon_sidebar(project, cx);
            }
        }
    }
    fn expanded_canon_projects(&self) -> Vec<String> {
        self.store
            .navigation
            .view
            .as_ref()
            .into_iter()
            .flat_map(|v| &v.projects)
            .filter(|p| {
                self.sidebar.canon_visible.contains(&p.id)
                    && !p.archived
                    && self
                        .store
                        .navigation
                        .rows
                        .get(&format!("p:{}", p.id))
                        .is_some_and(|row| {
                            !self.sidebar.collapsed.contains(&row.node.key)
                                && row
                                    .ancestors
                                    .iter()
                                    .all(|key| !self.sidebar.collapsed.contains(key))
                        })
            })
            .map(|p| p.id.clone())
            .collect()
    }
    pub(super) fn load_canon_sidebar(&mut self, project: String, cx: &mut Context<Self>) {
        if !self.sidebar.canon_loading.insert(project.clone()) {
            return;
        }
        let Some(source) = self.source.clone() else {
            self.sidebar.canon_loading.remove(&project);
            return;
        };
        let epoch = self.store.epoch();
        let generation = self.sidebar.canon_generation;
        Self::run(source.canon_sidebar(&project), cx, move |s, result, cx| {
            if epoch != s.store.epoch() {
                return;
            }
            s.sidebar.canon_loading.remove(&project);
            if !s.sidebar.canon_visible.contains(&project) {
                return;
            }
            if let Ok(view) = result {
                if generation == s.sidebar.canon_generation {
                    s.sidebar.remember_sidebar(view);
                } else if !s.sidebar.pending {
                    s.load_canon_sidebar(project, cx);
                }
                cx.notify();
            }
        });
    }
    pub(super) fn canon_sidebar_groups(
        &mut self,
        project: &str,
        pin: Option<super::row::Pin<'_>>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let groups = self
            .sidebar
            .canon
            .get(project)
            .map(|s| s.groups.clone())
            .unwrap_or_default();
        let mut list = div().flex().flex_col();
        for group in groups {
            list = list.child(self.canon_sidebar_group(project, &group, pin, cx));
        }
        list.into_any_element()
    }
    pub(super) fn canon_sidebar_group(
        &mut self,
        project: &str,
        group: &CanonSidebarGroup,
        pin: Option<super::row::Pin<'_>>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = format!("canon:{project}:{}", group.key);
        let expanded = !self.sidebar.collapsed.contains(&key);
        let toggle = key.clone();
        let actions = self.canon_group_actions(project, group, &key, expanded, cx);
        let mut branch = CollapsibleNavGroup::new(
            SharedString::from(key.clone()),
            if group.kind == "backlog" {
                self.copy("Backlog", "백로그").to_owned()
            } else {
                group.title.clone()
            },
            expanded,
        )
        .glyph(if group.kind == "backlog" {
            Icon::Folder
        } else {
            Icon::Flag
        })
        .indented()
        .actions(actions)
        .on_toggle(cx.listener(move |s, _, _, cx| {
            if s.sidebar.take_long_press(&toggle) {
                return;
            }
            s.sidebar.toggle(&toggle);
            cx.notify();
        }));
        if let Some(pin) = pin {
            branch = branch.sticky(pin.scroll, pin.depth);
        }
        for epic in &group.rows {
            branch = branch.child(self.canon_epic_row(project, &group.key, epic, cx));
        }
        let content = Self::row_gestures(
            div().id(SharedString::from(format!("canon-group-{key}"))),
            key.clone(),
            key.clone(),
            cx,
        )
        .child(branch);
        let target = NavDropTarget::new(key.clone(), content).indicator(0., 30.);
        let project = project.to_owned();
        let group_key = group.key.clone();
        let valid_project = project.clone();
        let valid_group = group.key.clone();
        let weak = cx.entity().downgrade();
        NavDropScope::new(SharedString::from(format!("drop-{key}")))
            .row(target)
            .drag(DragRules::<CanonDrag> {
                rules: Rc::new(move |source, _| {
                    (source.project == valid_project && source.group != valid_group).then_some(
                        DropZoneRules {
                            combine: true,
                            after: false,
                        },
                    )
                }),
                can_drop: Rc::new(|_, hit| hit.zone == DropZone::Combine),
                on_drop: Rc::new(move |source, _, _, cx| {
                    if source.project == project && source.group != group_key {
                        let _ = weak.update(cx, |s, cx| {
                            let plan_id = (group_key != "backlog").then_some(group_key.clone());
                            let body = serde_json::json!({
                                "expected_revision": source.epic.revision, "plan_id": plan_id,
                            });
                            s.mutate(Mutation::CanonEdit(source.epic.id.clone(), body), cx);
                        });
                    }
                }),
            })
            .into_any_element()
    }
    pub(super) fn canon_epic_row(
        &mut self,
        project: &str,
        group: &str,
        epic: &EpicCard,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let payload = CanonDrag {
            project: project.to_owned(),
            group: group.to_owned(),
            epic: epic.clone(),
        };
        let nav = self.canon_epic_navigation(epic, cx);
        let title = epic.title.clone();
        let target = epic.id.clone();
        let project = project.to_owned();
        let group = group.to_owned();
        let content = crate::ui::widgets::anchor(div(), &format!("sidebar-epic-{target}"))
            .id(SharedString::from(format!("canon-epic-{target}")));
        let content = if let Some(row) = epic
            .home_session_id
            .as_ref()
            .and_then(|id| self.store.navigation.rows.get(&format!("s:{id}")))
        {
            Self::row_gestures(
                content,
                row.node.key.clone(),
                format!("canon:{}", epic.id),
                cx,
            )
        } else {
            content
        };
        let row = NavDropTarget::new(target.clone(), content.child(nav)).draggable(
            payload,
            move |_, _| DragPreview::tab("canon-drag-preview", title.clone()).into_any_element(),
            |_| {},
        );
        let drag = NavDropScope::new(SharedString::from(format!("canon-epic-drop-{target}")))
            .row(row)
            .drag(Self::canon_epic_drag_rules(project, group, target, cx))
            .into_any_element();
        div()
            .child(drag)
            .child(self.canon_bound_chats(epic, cx))
            .into_any_element()
    }
    fn canon_bound_chats(&mut self, epic: &EpicCard, cx: &mut Context<Self>) -> AnyElement {
        let rows: Vec<_> = epic
            .session_ids
            .iter()
            .filter(|id| Some(id.as_str()) != epic.home_session_id.as_deref())
            .filter_map(|id| self.store.navigation.rows.get(&format!("s:{id}")).cloned())
            .collect();
        let mut list = div()
            .flex()
            .flex_col()
            .pl(butler_ds::ui::context::Ds::get(cx).len(butler_ds::tokens::Length::SpaceLg));
        for row in rows {
            list = list.child(self.space_row(
                &row,
                false,
                true,
                &format!("canon-bound:{}", epic.id),
                cx,
            ));
        }
        list.into_any_element()
    }
    fn canon_epic_navigation(&mut self, epic: &EpicCard, cx: &mut Context<Self>) -> NavRow {
        let shown = epic.clone();
        let instance = format!("canon:{}", epic.id);
        let click_instance = instance.clone();
        let mut nav = NavRow::new(
            SharedString::from(format!("epic-{}", epic.id)),
            epic.title.clone(),
        )
        .glyph(Icon::Notebook)
        .on_click(cx.listener(move |s, _, w, cx| {
            if s.sidebar.take_long_press(&click_instance) {
                return;
            }
            if let Some(id) = &shown.home_session_id {
                s.open_sidebar_session(id, w, cx);
            } else {
                s.mutate(Mutation::CanonConversation(shown.id.clone()), cx);
            }
        }));
        if self
            .store
            .selected()
            .is_some_and(|c| Some(c.session.0.as_ref()) == epic.home_session_id.as_deref())
        {
            nav = nav.active();
        }
        if let Some(row) = epic
            .home_session_id
            .as_ref()
            .and_then(|id| self.store.navigation.rows.get(&format!("s:{id}")))
            .cloned()
        {
            let menu = self.space_row_menu(&row, &instance, cx);
            let rest = if !self.sidebar.carries_session_state(epic) {
                div().into_any_element()
            } else if epic
                .queue
                .as_ref()
                .is_some_and(|q| q.state == "running" && q.hold)
            {
                butler_ds::ui::icon::icon(
                    Icon::CircleAlert,
                    butler_ds::ui::icon::IconSize::Sm,
                    butler_ds::ui::context::Ds::get(cx),
                )
                .into_any_element()
            } else {
                self.space_activity(&row, false, cx)
            };
            nav = nav.icon(self.space_identity(&row, cx)).actions(
                butler_ds::ui::blocks::nav_row::NavRowSwap::new(
                    SharedString::from(format!("epic-menu-{}", epic.id)),
                    menu,
                )
                .rest(rest)
                .open(self.sidebar.menus.contains(&instance)),
            );
        } else if epic
            .queue
            .as_ref()
            .is_some_and(|q| q.state == "running" && q.hold)
        {
            nav = nav.actions(butler_ds::ui::icon::icon(
                Icon::CircleAlert,
                butler_ds::ui::icon::IconSize::Sm,
                butler_ds::ui::context::Ds::get(cx),
            ));
        }
        if let Some(label) = self.canon_epic_label(epic, cx) {
            nav = nav.label_element(label);
        }
        nav
    }
    fn canon_epic_label(&self, epic: &EpicCard, cx: &Context<Self>) -> Option<AnyElement> {
        let avatar = self.canon_avatar(epic)?;
        Some(
            div()
                .flex()
                .min_w_0()
                .items_center()
                .gap(butler_ds::ui::context::Ds::get(cx).len(butler_ds::tokens::Length::SpaceSm))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(Typo::text(epic.title.clone()).truncate()),
                )
                .child(div().flex_none().child(avatar))
                .into_any_element(),
        )
    }
    fn canon_avatar(&self, epic: &EpicCard) -> Option<Avatar> {
        let person = epic
            .agent
            .as_ref()
            .map(|a| a.person.as_str())
            .or(epic.assignee.as_deref())?;
        let own = person == "app-user";
        let name = if own {
            self.store
                .navigation
                .view
                .as_ref()
                .map(|v| v.settings_summary.profile_label.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(self.copy("Me", "나"))
        } else {
            person
        };
        let label = epic.agent.as_ref().map_or_else(
            || name.to_owned(),
            |agent| format!("{name} · {} {}", agent.via, self.copy("working", "작업 중")),
        );
        Some(
            Avatar::new(
                SharedString::from(format!("epic-avatar-{}", epic.id)),
                name.to_owned(),
            )
            .tone(if own {
                butler_ds::ui::avatar::AvatarTone::Own
            } else {
                butler_ds::ui::avatar::AvatarTone::Other
            })
            .badge(epic.agent.as_ref().map(|_| Icon::Bot))
            .label(label),
        )
    }
    fn canon_epic_drag_rules(
        project: String,
        group: String,
        target: String,
        cx: &Context<Self>,
    ) -> DragRules<CanonDrag> {
        let target_epic = target.clone();
        let check_project = project.clone();
        let check_group = group.clone();
        let weak = cx.entity().downgrade();
        DragRules::<CanonDrag> {
            rules: Rc::new(|_, _| {
                Some(DropZoneRules {
                    combine: false,
                    after: true,
                })
            }),
            can_drop: Rc::new(move |source, _| {
                source.project == check_project
                    && source.group == check_group
                    && source.epic.id != target_epic
            }),
            on_drop: Rc::new(move |source, hit, _, cx| {
                let _ = weak.update(cx, |s, cx| {
                    let Some(sidebar) = s.sidebar.canon.get(&project) else {
                        return;
                    };
                    let Some(rows) = sidebar
                        .groups
                        .iter()
                        .find(|g| g.key == group)
                        .map(|g| &g.rows)
                    else {
                        return;
                    };
                    let mut ids: Vec<_> = rows
                        .iter()
                        .filter(|r| r.id != source.epic.id)
                        .map(|r| r.id.clone())
                        .collect();
                    let Some(index) = ids.iter().position(|id| id == &target) else {
                        return;
                    };
                    ids.insert(
                        index + usize::from(hit.zone == DropZone::After),
                        source.epic.id.clone(),
                    );
                    s.mutate(
                        Mutation::CanonOrder(
                            project.clone(),
                            serde_json::json!({"group_key":group,"work_ids":ids}),
                        ),
                        cx,
                    );
                });
            }),
        }
    }
}
