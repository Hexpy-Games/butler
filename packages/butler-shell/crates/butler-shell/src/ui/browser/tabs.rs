//! BrowserArea's ordered owner groups and TabStrip callbacks.
use super::{
    area::{AreaState, create, owner_key, result, title},
    engine::TabId,
    model::{BrowserState, Owner, Tab, TabStatus},
};
use crate::ui::{i18n::browser::BrowserStrings, widgets::anchor};
use butler_ds::ui::blocks::tab_strip::{
    Favicon, Group, GroupKind, GroupState, Tab as StripTab, TabState, TabStrip, TabStripLabels,
};
use gpui::{AnyElement, App, Entity, div, prelude::*};
fn groups(tabs: &[Tab], state: &AreaState, cx: &App) -> Vec<Group> {
    let copy = BrowserStrings::get(cx);
    let mut groups: Vec<Group> = Vec::new();
    for tab in tabs {
        let key = owner_key(&tab.owner);
        let index = groups
            .iter()
            .position(|g| g.id().as_ref() == key)
            .unwrap_or_else(|| {
                let (kind, label) = match &tab.owner {
                    Owner::Mine => (GroupKind::Mine, copy.my_tabs.to_owned()),
                    Owner::Conversation(id) => {
                        (GroupKind::Conversation, title(id, cx).unwrap_or_default())
                    }
                };
                groups.push(
                    Group::new(key.clone(), kind)
                        .label(label)
                        .collapsed(state.collapsed.contains(&key)),
                );
                groups.len() - 1
            });
        let mut item = StripTab::new(tab.id.0.clone(), tab.title.clone());
        if !tab.favicon.is_empty() {
            item = item.favicon(Favicon::Image(tab.favicon.clone().into()));
        }
        item = match tab.status {
            TabStatus::Loading => item.state(TabState::Loading),
            TabStatus::Crashed => item.state(TabState::Crashed),
            TabStatus::Idle => item,
        };
        if tab.status == TabStatus::Crashed {
            groups[index] = groups[index].clone().state(GroupState::Crashed);
        }
        groups[index].push_tab(item);
    }
    let mut index = 0;
    for group in &mut groups {
        let tabs = group
            .tabs_ref()
            .iter()
            .map(|tab| {
                let tab = tab.clone().anchor(format!("browser-tab-{index}"));
                index += 1;
                tab
            })
            .collect::<Vec<_>>();
        group.truncate_tabs(0);
        *group = group.clone().tabs(tabs);
    }
    groups
}
pub(super) fn strip(
    tabs: &[Tab],
    session: Option<&str>,
    state: &Entity<AreaState>,
    cx: &App,
) -> AnyElement {
    let pane_owner = session.map_or(Owner::Mine, |s| Owner::Conversation(s.to_owned().into()));
    let collapse = state.clone();
    let mut strip = TabStrip::new("browser-tabs", groups(tabs, state.read(cx), cx))
        .active(cx.global::<BrowserState>().active().map(|id| id.0.clone()))
        .labels(labels(cx))
        .on_activate(|id, _, cx| {
            cx.global_mut::<BrowserState>()
                .activate(&TabId(id.to_owned().into()));
            cx.refresh_windows();
        })
        .on_close(|id, _, cx| {
            cx.global_mut::<BrowserState>()
                .close(&TabId(id.to_owned().into()));
            cx.refresh_windows();
        })
        .on_move(|mv, _, cx| {
            let value = Owner::parse(&mv.to_group).and_then(|owner| {
                cx.global_mut::<BrowserState>().move_tab(
                    &TabId(mv.tab_id.clone()),
                    owner,
                    isize::try_from(mv.index).unwrap_or(isize::MAX),
                )
            });
            result(&value, cx);
        })
        .on_toggle_group(move |id, folded, _, cx| {
            collapse.update(cx, |s, _| {
                if folded {
                    s.collapsed.insert(id.into());
                } else {
                    s.collapsed.remove(id);
                }
            });
            cx.refresh_windows();
        });
    if cx.global::<BrowserState>().enabled() {
        strip = strip.on_new_tab(move |_, cx| create(pane_owner.clone(), cx));
        if session.is_none() {
            strip = strip.on_new_tab_in_group(|owner, _, cx| match Owner::parse(owner) {
                Ok(owner) => create(owner, cx),
                Err(error) => result(&Err::<(), _>(error), cx),
            });
        }
    }
    if session.is_some() {
        strip = strip.hide_chip();
    }
    anchor(div(), "browser-tabs")
        .w_full()
        .child(strip)
        .into_any_element()
}

fn labels(cx: &App) -> TabStripLabels {
    let c = BrowserStrings::get(cx);
    TabStripLabels {
        my_tabs: c.my_tabs.into(),
        new_tab: c.new_tab.into(),
        close_tab: c.close_tab.into(),
        untitled: c.new_tab.into(),
        crashed: c.crashed.into(),
        working: c.agent_control.into(),
        waiting: c.waiting.into(),
        new_tab_in: if butler_ds::ui::context::Ds::get(cx).lang()
            == butler_ds::ui::context::Lang::Ko
        {
            |g| {
                BrowserStrings::words(butler_ds::ui::context::Lang::Ko)
                    .new_tab_in
                    .replace("{group}", g)
            }
        } else {
            |g| {
                BrowserStrings::words(butler_ds::ui::context::Lang::En)
                    .new_tab_in
                    .replace("{group}", g)
            }
        },
        more_tabs: if butler_ds::ui::context::Ds::get(cx).lang() == butler_ds::ui::context::Lang::Ko
        {
            |n| {
                BrowserStrings::words(butler_ds::ui::context::Lang::Ko)
                    .more_tabs
                    .replace("{count}", &n.to_string())
            }
        } else {
            |n| {
                BrowserStrings::words(butler_ds::ui::context::Lang::En)
                    .more_tabs
                    .replace("{count}", &n.to_string())
            }
        },
    }
}
