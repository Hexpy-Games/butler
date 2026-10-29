//! The chat list: spaces with their chats then root chats (전체보기), or one flat list newest
//! first (최신, 진행중), each capped with a "show more" row.
use gpui::{Animation, AnimationExt as _, AnyElement, Context, SharedString, div, prelude::*, px};

use super::Click;
use super::row::{RowSpec, Trailing};
use crate::ui::shell::Shell;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::ui::source::{ChatSummary, Space, Timestamp};

/// Rows shown per space before its "show more" row.
const SPACE_ROWS: usize = 5;

impl Shell {
    /// How long ago `at` was, in the UI's words (formatted when drawn, so it stays current).
    fn age(&self, at: Timestamp) -> String {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        let now = i64::try_from(now).unwrap_or(i64::MAX);
        self.theme
            .strings
            .relative_age(now.saturating_sub(at.0).max(0) / 1000)
    }

    fn chat_row(&mut self, chat: &ChatSummary, flat: bool, cx: &mut Context<Self>) -> AnyElement {
        let key = format!("c-{}-{flat}", chat.chat.chat.0);
        let mut spec = RowSpec::new(key, Some("message"), chat.title.clone());
        spec.active = self.store.selected() == Some(&chat.chat);
        if chat.running {
            spec.trailing = Trailing::Spinner;
        }
        if flat {
            let place = chat
                .space
                .as_ref()
                .map_or_else(|| self.theme.strings.general.into(), |s| s.title.clone());
            spec.meta = Some((place, self.age(chat.updated_at).into()));
        }
        self.nav_row(spec, Click::Chat(Some(chat.chat.clone())), cx)
    }

    fn more_row(
        &mut self,
        key: String,
        remaining: usize,
        space: Option<SharedString>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let label = if remaining > 0 {
            format!("{} ({remaining})", self.theme.strings.show_more)
        } else {
            self.theme.strings.show_more.to_owned()
        };
        let mut spec = RowSpec::new(key, None, label);
        spec.muted = true;
        self.nav_row(spec, Click::More(space), cx)
    }

    /// Spaces in the order their first chat appears.
    fn spaces(&self) -> Vec<Space> {
        let mut spaces: Vec<Space> = Vec::new();
        for space in self.store.chats.iter().filter_map(|c| c.space.as_ref()) {
            if !spaces.iter().any(|s| s.id == space.id) {
                spaces.push(space.clone());
            }
        }
        spaces
    }

    fn space_block(&mut self, space: &Space, cx: &mut Context<Self>) -> AnyElement {
        let open = !self.sidebar.folded.get(&space.id).copied().unwrap_or(false);
        let glyph = if space.project { "briefcase" } else { "folder" };
        let mut spec = RowSpec::new(format!("g-{}", space.id), Some(glyph), space.title.clone());
        spec.trailing = Trailing::Chevron(open);
        spec.gap = 8.;
        let header = self.nav_row(spec, Click::Space(space.id.clone()), cx);
        let block = div().flex().flex_col().w_full().child(header);
        if !open {
            return block.into_any_element();
        }
        let members: Vec<ChatSummary> = (self.store.chats.iter())
            .filter(|c| c.space.as_ref().is_some_and(|s| s.id == space.id))
            .cloned()
            .collect();
        // The open chat stays visible even below the limit.
        let selected = members
            .iter()
            .position(|m| Some(&m.chat) == self.store.selected());
        let base = self
            .sidebar
            .space_limit
            .get(&space.id)
            .copied()
            .unwrap_or(SPACE_ROWS);
        let limit = base.max(selected.map_or(0, |p| p + 1));
        let mut items = div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .pt(px(4.))
            .pl(px(8.))
            .pb(px(8.));
        for m in members.iter().take(limit) {
            items = items.child(self.chat_row(m, false, cx));
        }
        if members.len() > limit {
            let more = self.more_row(
                format!("more-{}", space.id),
                members.len() - limit,
                Some(space.id.clone()),
                cx,
            );
            items = items.child(more);
        }
        let opened = items.with_animation(
            SharedString::from(format!("open-{}", space.id)),
            Animation::new(crate::ui::motion::BASE),
            gpui::Styled::opacity,
        );
        block.child(opened).into_any_element()
    }

    pub(super) fn tree(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let mut out: Vec<AnyElement> = Vec::new();
        for space in self.spaces() {
            out.push(self.space_block(&space, cx));
        }
        let roots: Vec<ChatSummary> = self
            .store
            .chats
            .iter()
            .filter(|c| c.space.is_none())
            .cloned()
            .collect();
        let limit = self.sidebar.root_limit;
        for chat in roots.iter().take(limit) {
            out.push(self.chat_row(chat, false, cx));
        }
        if roots.len() > limit || self.store.chats_next.is_some() {
            out.push(self.more_row(
                "more-root".into(),
                roots.len().saturating_sub(limit),
                None,
                cx,
            ));
        }
        out
    }

    pub(super) fn flat(&mut self, running_only: bool, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let chats: Vec<ChatSummary> = (self.store.chats.iter())
            .filter(|c| !running_only || c.running)
            .cloned()
            .collect();
        chats.iter().map(|c| self.chat_row(c, true, cx)).collect()
    }
}
