//! Canon group actions and disclosure use DS controls and the shared dialog owner.
use super::{super::Shell, forms::CanonFormRequest};
use crate::ui::{Icon, source::wire::CanonSidebarGroup};
use butler_ds::ui::{
    blocks::nav_row::NavRowSwap,
    dropdown_menu::{DropdownMenu, DropdownMenuContent, Item},
    icon_button::IconButton,
};
use gpui::{
    AnyElement, App, Context, IntoElement, ParentElement as _, RenderOnce, SharedString,
    Styled as _, WeakEntity, Window, div,
};
#[derive(IntoElement)]
struct GroupMenu {
    shell: WeakEntity<Shell>,
    key: String,
    plan: Option<String>,
    open: bool,
    label: String,
    overview: &'static str,
    edit: &'static str,
}
impl RenderOnce for GroupMenu {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let id = SharedString::from(format!("canon-menu-{}", self.key));
        let weak = self.shell.clone();
        let key = self.key;
        let menu = DropdownMenu::new(id.clone(), window, cx)
            .open(self.open)
            .on_open_change(move |open, _, cx| {
                let _ = weak.update(cx, |s, cx| {
                    if open {
                        s.sidebar.menus.insert(key.clone());
                    } else {
                        s.sidebar.menus.remove(&key);
                    }
                    cx.notify();
                });
            });
        let trigger = menu.trigger(|toggle| {
            IconButton::new(id, self.label)
                .glyph(Icon::MoreHorizontal)
                .on_click(toggle.on_click())
                .into_any_element()
        });
        let mut content = DropdownMenuContent::new().child(Item::new(self.overview).disabled());
        if let Some(plan) = self.plan {
            let weak = self.shell;
            content = content.child(Item::new(self.edit).on_select(move |_, cx| {
                let _ = weak.update(cx, |s, cx| {
                    s.start_canon_form(CanonFormRequest::Edit(plan.clone()), cx);
                });
            }));
        }
        let content = menu.content(content, window, cx);
        div().flex().child(trigger).child(content)
    }
}
impl Shell {
    pub(in crate::ui::sidebar) fn canon_group_actions(
        &self,
        project: &str,
        group: &CanonSidebarGroup,
        key: &str,
        expanded: bool,
        cx: &Context<Self>,
    ) -> AnyElement {
        let weak = cx.entity().downgrade();
        let project = project.to_owned();
        let plan = (group.kind != "backlog").then(|| group.key.clone());
        let selected = plan.clone();
        let create = IconButton::new(
            SharedString::from(format!("canon-create-{key}")),
            self.copy("New epic", "새 과제"),
        )
        .glyph(Icon::Plus)
        .on_click(move |_, _, cx| {
            let _ = weak.update(cx, |s, cx| {
                s.start_canon_form(
                    CanonFormRequest::Create {
                        project: project.clone(),
                        plan: selected.clone(),
                    },
                    cx,
                );
            });
        });
        let weak = cx.entity().downgrade();
        let toggle = key.to_owned();
        let rest = IconButton::new(
            SharedString::from(format!("canon-toggle-{key}")),
            self.copy("Expand or collapse", "펼치기 또는 접기"),
        )
        .glyph(if expanded {
            Icon::ChevronDown
        } else {
            Icon::ChevronRight
        })
        .on_click(move |_, _, cx| {
            let _ = weak.update(cx, |s, cx| {
                s.sidebar.toggle(&toggle);
                cx.notify();
            });
        });
        let menu = GroupMenu {
            shell: cx.entity().downgrade(),
            key: key.to_owned(),
            plan,
            open: self.sidebar.menus.contains(key),
            label: if group.kind == "backlog" {
                self.copy("Backlog", "백로그").to_owned()
            } else {
                group.title.clone()
            },
            overview: self.copy("Overview", "개요"),
            edit: self.copy("Edit", "수정"),
        };
        div()
            .flex()
            .child(create)
            .child(
                NavRowSwap::new(SharedString::from(format!("canon-swap-{key}")), menu)
                    .rest(rest)
                    .open(self.sidebar.menus.contains(key)),
            )
            .into_any_element()
    }
}
