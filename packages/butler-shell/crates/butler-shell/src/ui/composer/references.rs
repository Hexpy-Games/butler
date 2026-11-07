//! The references in the composer's text: the `@` mention menu (`ComposerMentionMenu`), the
//! chips drawn over the atoms' reserved characters (`ProjectReferenceNode`,
//! `SessionReferenceNode`, `ProjectSourceNode`) and a session dropped from the sidebar.
use std::cell::Cell;
use std::rc::Rc;

use butler_ds::ui::popover::{Density, Popover, PopoverContent};
use butler_ds::ui::tooltip::{Align, Side};
use gpui::{AnyElement, Bounds, Context, Focusable as _, Pixels, SharedString, Window, div, prelude::*, px};

use super::Composer;
use super::editor::atoms::atom_chip;
use super::editor::drop::SessionDrag;
use super::editor::mentions::{
    MentionCandidate, MentionMenu, mention_candidates, mention_list, rank_mentions,
};
use super::editor::{Atom, is_atom_char};
use super::state::ComposerState;
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::NavigationView;

/// The keys the open mention menu takes (`useMentionKeys`).
#[derive(Clone, Copy)]
pub(super) enum MentionKey {
    Up,
    Down,
    /// Enter or Tab.
    Choose,
    Escape,
}

/// What the `@` menu and the chips know of the space: the navigation, the candidates drawn from
/// it for the open draft, and the menu's own state.
#[derive(Default)]
pub(super) struct References {
    menu: MentionMenu,
    navigation: Option<NavigationView>,
    candidates: Vec<MentionCandidate>,
    /// The draft the candidates leave out (the conversation being written in).
    candidates_for: Option<String>,
    items: Vec<MentionCandidate>,
    /// The field's bounds as last drawn, in window coordinates.
    pub(super) field: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// Where the chips were last placed; a change draws once more with the settled layout.
    marks: Vec<(i32, i32)>,
}

impl References {
    fn open(&self) -> bool {
        self.menu.is_open(self.items.len())
    }
}

impl Composer {
    /// The `@` word under the caret and the rows it ranks, for this frame.
    pub(super) fn sync_mentions(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let draft = ComposerState::read(cx, |draft| draft.draft_session_id.clone());
        if self.references.candidates_for.as_ref() != Some(&draft) {
            self.references.candidates_for = Some(draft);
            self.rebuild_candidates();
        }
        let focused = self.focus_handle(cx).is_focused(window);
        let token = if focused && self.engaged {
            self.editor.active_mention(window, cx)
        } else {
            None
        };
        let opened = token.is_some() && self.references.menu.token().is_none();
        self.references.menu.set_token(token.clone());
        self.references.items = token
            .map(|token| rank_mentions(&self.references.candidates, &token.query))
            .unwrap_or_default();
        if opened {
            self.load_navigation(cx);
        }
    }

    fn rebuild_candidates(&mut self) {
        let (Some(navigation), Some(draft)) = (
            self.references.navigation.as_ref(),
            self.references.candidates_for.as_deref(),
        ) else {
            return;
        };
        self.references.candidates =
            mention_candidates(navigation, draft, self.theme.strings.general);
    }

    /// The navigation the candidates and chips read; read again when the menu opens.
    pub(super) fn load_navigation(&mut self, cx: &mut Context<Self>) {
        let fetch = Jobs::run(cx, |client| async move { client.list_navigation().await });
        cx.spawn(async move |this, cx| {
            let Some(Ok(raw)) = fetch.await else {
                return;
            };
            let Ok(navigation) = serde_json::from_value::<NavigationView>(raw) else {
                return;
            };
            let _ = this.update(cx, |this, cx| {
                this.references.navigation = Some(navigation);
                this.rebuild_candidates();
                cx.notify();
            });
        })
        .detach();
    }

    /// A key for the open menu; false when it is not the menu's (closed, or the IME composes).
    pub(super) fn mention_key(
        &mut self,
        key: MentionKey,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.references.open() || self.composing(window, cx) {
            return false;
        }
        let rows = self.references.items.len();
        match key {
            MentionKey::Up => self.references.menu.step(-1, rows),
            MentionKey::Down => self.references.menu.step(1, rows),
            MentionKey::Escape => self.references.menu.dismiss(),
            MentionKey::Choose => {
                let now = self.editor.active_mention(window, cx);
                let picked = self.references.menu.pick(
                    now.as_ref(),
                    &self.references.items,
                    &self.references.candidates,
                );
                let Some(item) = picked else {
                    return false;
                };
                self.choose_mention(&item, window, cx);
            }
        }
        cx.notify();
        true
    }

    /// `choose`: the chip replaces the `@word` under the caret.
    fn choose_mention(
        &mut self,
        item: &MentionCandidate,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.editor.apply_mention(&item.atom(), window, cx);
        cx.notify();
    }

    /// The menu, anchored above the `@` (`side="top"`, `align="start"`, 6px offset).
    pub(super) fn mention_menu(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let token = self.references.menu.token()?.clone();
        let field = self.references.field.get()?;
        let at = self
            .editor
            .range_bounds(token.start..token.start + 1, field, window, cx)?;
        let this = cx.entity().downgrade();
        let dismissed = this.clone();
        let popover = Popover::new("composer-mention-menu", window, cx)
            .open(self.references.open())
            .on_open_change(move |open, _, cx| {
                if !open {
                    let _ = dismissed.update(cx, |this, cx| {
                        this.references.menu.dismiss();
                        cx.notify();
                    });
                }
            });
        let list = mention_list(
            &self.references.items,
            &token.query,
            self.references.menu.active(),
            self.theme.strings.locale,
            move |item, window, cx| {
                let item = item.clone();
                let _ = this.update(cx, |this, cx| this.choose_mention(&item, window, cx));
            },
            cx,
        );
        let content = popover.content(
            PopoverContent::new()
                .side(Side::Top)
                .align(Align::Start)
                .side_offset(6.)
                .density(Density::List)
                .child(list),
            window,
            cx,
        );
        let anchor = div().w(at.size.width.max(px(1.))).h(at.size.height);
        Some(
            div()
                .absolute()
                .left(at.origin.x - field.origin.x)
                .top(at.origin.y - field.origin.y)
                .child(popover.anchor(anchor))
                .child(content)
                .into_any_element(),
        )
    }

    /// A chip over each atom's reserved character. Its place comes from the field's last layout,
    /// so a change of place draws one more frame.
    pub(super) fn atom_chips(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let Some(field) = self.references.field.get() else {
            return Vec::new();
        };
        let text = self.editor.text(cx);
        let mut chips = Vec::new();
        let mut marks = Vec::new();
        for (at, c) in text.char_indices().filter(|(_, c)| is_atom_char(*c)) {
            let Some(atom) = self.editor.atom_for(c).cloned() else {
                continue;
            };
            let range = at..at + c.len_utf8();
            let Some(bounds) = self.editor.range_bounds(range, field, window, cx) else {
                continue;
            };
            let (left, top) = (
                bounds.origin.x - field.origin.x,
                bounds.origin.y - field.origin.y,
            );
            marks.push((left.as_f32().round() as i32, top.as_f32().round() as i32));
            let chip = atom_chip(
                SharedString::from(format!("composer-atom-{at}")),
                &atom,
                self.references.navigation.as_ref(),
                self.theme.strings.general,
                None,
            );
            chips.push(
                div()
                    .absolute()
                    .left(left)
                    .top(top)
                    .child(chip)
                    .into_any_element(),
            );
        }
        if marks != self.references.marks {
            self.references.marks = marks;
            let this = cx.entity();
            window.on_next_frame(move |_, cx| this.update(cx, |_, cx| cx.notify()));
        }
        chips
    }

    /// A session dragged from the sidebar and dropped on the composer: its chip goes in at the
    /// character under the pointer, or at the caret when the pointer is outside the field.
    pub(super) fn drop_session(
        &mut self,
        drag: &SessionDrag,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let pointer = window.mouse_position();
        let inside = (self.references.field.get()).is_some_and(|field| field.contains(&pointer));
        if inside && let Some(offset) = self.editor.offset_at(pointer, window, cx) {
            self.editor.place_caret(offset, cx);
        }
        let atom = Atom::Session {
            id: drag.id.clone(),
            label: drag.title.clone(),
        };
        self.editor.insert_atom_at_caret(&atom, window, cx);
        self.engage(window, cx);
    }
}
