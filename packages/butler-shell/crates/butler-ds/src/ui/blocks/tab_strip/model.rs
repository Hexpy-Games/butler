//! The TabStrip data model (tabStripModel.ts): groups of tabs, the focus stops of the strip, and
//! the pure moves (keyboard reorder, applying a move).
use gpui::SharedString;

use crate::ui::Icon;

/// Per-tab activity shown in the favicon slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TabState {
    Loading,
    Working,
    Crashed,
}

/// Group-level attention shown on the group's title.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GroupState {
    Working,
    Waiting,
    Crashed,
}

/// `mine`: tabs the user opened. `conversation`: tabs a conversation (or its agent) opened; muted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GroupKind {
    Mine,
    Conversation,
}

/// A site icon. A missing or broken one shows a globe.
#[derive(Clone)]
pub enum Favicon {
    /// A site tile: a rounded square of `0xRRGGBB` with one white letter (the showcase's
    /// data-URI favicons).
    Letter { rgb: u32, letter: char },
    /// An image the app loads; a failed load shows the globe.
    Image(gpui::ImageSource),
    /// A broken icon: the globe.
    Broken,
}

/// One tab.
#[derive(Clone)]
pub struct Tab {
    pub(super) id: SharedString,
    pub(super) title: SharedString,
    pub(super) favicon: Option<Favicon>,
    pub(super) icon: Option<Icon>,
    pub(super) state: Option<TabState>,
    pub(super) closable: bool,
    pub(super) anchor: Option<SharedString>,
}

impl Tab {
    pub fn new(id: impl Into<SharedString>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            favicon: None,
            icon: None,
            state: None,
            closable: true,
            anchor: None,
        }
    }

    /// Names the tab for the live harness (`debug_selector`).
    pub fn anchor(mut self, name: impl Into<SharedString>) -> Self {
        self.anchor = Some(name.into());
        self
    }

    pub fn id(&self) -> &SharedString {
        &self.id
    }

    /// The site icon; falls back to a globe when missing or broken.
    pub fn favicon(mut self, favicon: Favicon) -> Self {
        self.favicon = Some(favicon);
        self
    }

    /// The tab's own glyph in place of the favicon (a file type icon); activity still replaces it.
    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn state(mut self, state: TabState) -> Self {
        self.state = Some(state);
        self
    }

    /// No close button; middle-click and Delete do not close it either.
    pub fn locked(mut self) -> Self {
        self.closable = false;
        self
    }
}

/// "My tabs" or one conversation's tabs.
#[derive(Clone)]
pub struct Group {
    pub(super) id: SharedString,
    pub(super) kind: GroupKind,
    pub(super) label: Option<SharedString>,
    pub(super) tabs: Vec<Tab>,
    pub(super) collapsed: bool,
    pub(super) state: Option<GroupState>,
}

impl Group {
    pub fn new(id: impl Into<SharedString>, kind: GroupKind) -> Self {
        Self {
            id: id.into(),
            kind,
            label: None,
            tabs: Vec::new(),
            collapsed: false,
            state: None,
        }
    }

    pub fn id(&self) -> &SharedString {
        &self.id
    }

    pub fn tabs_ref(&self) -> &[Tab] {
        &self.tabs
    }

    pub fn is_collapsed(&self) -> bool {
        self.collapsed
    }

    /// The conversation title; the `mine` group reads `labels.my_tabs` when omitted.
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn tab(mut self, tab: Tab) -> Self {
        self.tabs.push(tab);
        self
    }

    pub fn tabs(mut self, tabs: impl IntoIterator<Item = Tab>) -> Self {
        self.tabs.extend(tabs);
        self
    }

    /// A folded group shows only its title, a few favicons and the count of the rest.
    pub fn collapsed(mut self, collapsed: bool) -> Self {
        self.collapsed = collapsed;
        self
    }

    pub fn state(mut self, state: GroupState) -> Self {
        self.state = Some(state);
        self
    }

    /// Keeps only the first `count` tabs.
    pub fn truncate_tabs(&mut self, count: usize) {
        self.tabs.truncate(count);
    }

    /// Removes the tab `tab_id`, if the group has it.
    pub fn remove_tab(&mut self, tab_id: &str) {
        self.tabs.retain(|tab| tab.id != tab_id);
    }

    pub fn set_collapsed(&mut self, collapsed: bool) {
        self.collapsed = collapsed;
    }

    pub fn push_tab(&mut self, tab: Tab) {
        self.tabs.push(tab);
    }

    pub fn is_mine(&self) -> bool {
        self.kind == GroupKind::Mine
    }
}

/// A tab's new place: `index` is its final position inside the target group.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Move {
    pub tab_id: SharedString,
    pub from_group: SharedString,
    pub to_group: SharedString,
    pub index: usize,
}

/// One focusable stop of the strip, in visual order: a group's chip, its tabs, then its own
/// new-tab button.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Stop {
    Chip {
        group: SharedString,
    },
    Tab {
        group: SharedString,
        tab: SharedString,
    },
    New {
        group: SharedString,
    },
}

impl Stop {
    pub(super) fn key(&self) -> SharedString {
        match self {
            Self::Chip { group } => chip_key(group),
            Self::Tab { tab, .. } => tab_key(tab),
            Self::New { group } => new_key(group),
        }
    }
}

pub(super) fn tab_key(tab: &str) -> SharedString {
    format!("tab:{tab}").into()
}

pub(super) fn chip_key(group: &str) -> SharedString {
    format!("chip:{group}").into()
}

pub(super) fn new_key(group: &str) -> SharedString {
    format!("new:{group}").into()
}

/// The `mine` group shows its title only beside other groups. `hide_chip` drops the title of a
/// lone group of any kind (a conversation's own pane, whose title bar already names it).
pub(super) fn shows_chip(group: &Group, groups: &[Group], hide_chip: bool) -> bool {
    if hide_chip && groups.len() == 1 {
        return false;
    }
    group.kind != GroupKind::Mine || groups.len() > 1
}

/// The strip's focus stops. With `group_new_tab`, every titled group that is open ends in its own
/// new-tab button; a folded group hides it with its tabs.
pub(super) fn stops(groups: &[Group], hide_chip: bool, group_new_tab: bool) -> Vec<Stop> {
    let mut stops = Vec::new();
    for group in groups {
        let titled = shows_chip(group, groups, hide_chip);
        if titled {
            stops.push(Stop::Chip {
                group: group.id.clone(),
            });
        }
        if group.collapsed {
            continue;
        }
        stops.extend(group.tabs.iter().map(|tab| Stop::Tab {
            group: group.id.clone(),
            tab: tab.id.clone(),
        }));
        if titled && group_new_tab {
            stops.push(Stop::New {
                group: group.id.clone(),
            });
        }
    }
    stops
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum NavKey {
    Left,
    Right,
    Home,
    End,
}

/// Roving focus target among `count` stops: arrows wrap, Home and End jump to the ends.
pub(super) fn next_focus(count: usize, current: usize, key: NavKey) -> Option<usize> {
    let last = count.checked_sub(1)?;
    Some(match key {
        NavKey::Home => 0,
        NavKey::End => last,
        NavKey::Right => (current + 1) % count,
        NavKey::Left => (current + last) % count,
    })
}

/// Where focus goes when a tab closes: the next stop, else the previous one.
pub(super) fn focus_after_close(count: usize, current: usize) -> Option<usize> {
    if current + 1 < count {
        Some(current + 1)
    } else {
        current.checked_sub(1)
    }
}

/// Where a tab is: its group's position, its index there and the tab.
pub(super) fn locate<'a>(groups: &'a [Group], tab_id: &str) -> Option<(usize, usize, &'a Tab)> {
    groups.iter().enumerate().find_map(|(group_index, group)| {
        group
            .tabs
            .iter()
            .position(|tab| tab.id == tab_id)
            .map(|index| (group_index, index, &group.tabs[index]))
    })
}

/// Keyboard move by one slot; past a group's edge the tab joins the neighbouring group.
pub(super) fn move_by_step(groups: &[Group], tab_id: &str, forward: bool) -> Option<Move> {
    let (group_index, index, tab) = locate(groups, tab_id)?;
    let group = &groups[group_index];
    let to = |to_group: &Group, index: usize| Move {
        tab_id: tab.id.clone(),
        from_group: group.id.clone(),
        to_group: to_group.id.clone(),
        index,
    };
    let inside = if forward {
        Some(index + 1).filter(|at| *at < group.tabs.len())
    } else {
        index.checked_sub(1)
    };
    if let Some(at) = inside {
        return Some(to(group, at));
    }
    let neighbour = if forward {
        groups.get(group_index + 1)?
    } else {
        groups.get(group_index.checked_sub(1)?)?
    };
    Some(to(
        neighbour,
        if forward { 0 } else { neighbour.tabs.len() },
    ))
}

/// Applies a move to the groups: what an app container does in `on_move`.
pub fn apply_move(groups: &[Group], mv: &Move) -> Vec<Group> {
    let Some((_, _, tab)) = locate(groups, &mv.tab_id) else {
        return groups.to_vec();
    };
    let tab = tab.clone();
    groups
        .iter()
        .map(|group| {
            let mut next = group.clone();
            next.tabs.retain(|entry| entry.id != mv.tab_id);
            if group.id == mv.to_group {
                next.tabs.insert(mv.index.min(next.tabs.len()), tab.clone());
            }
            next
        })
        .collect()
}
