//! `useCanonBoard.ts` and `useCanonMove.ts`: the board's reads (one at a time, stale answers
//! dropped) and the optimistic move.
use std::rc::Rc;

use butler_ds::ui::blocks::kanban_board::KanbanMove;
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::Error;
use gpui::Context;
use serde_json::Value;

use super::CanonBoard;
use super::copy::words;
use super::lanes::{Spec, can_complete, find_card, optimistic_canon_move};
use super::moves::persist_move;
use crate::ui::manage::Topic;
use crate::ui::source::fetch::{fetch, fetch_if};
use crate::ui::source::wire::CanonOverview;

impl CanonBoard {
    /// `refresh` (`singleFlight(read)`): one read at a time; a change during a read runs exactly
    /// one more afterwards.
    pub(super) fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.flight.begin() {
            self.read(cx);
        }
    }

    fn read_done(&mut self, cx: &mut Context<Self>) {
        if self.flight.end() {
            self.read(cx);
        }
    }

    /// `read`: skipped while a move is in flight; an answer that a move or a newer read
    /// overtook is dropped. The board redraws only when the answer differs.
    fn read(&mut self, cx: &mut Context<Self>) {
        if self.moving {
            self.read_done(cx);
            return;
        }
        self.generation += 1;
        let epoch = self.generation;
        let project = self.project.to_string();
        fetch_if(
            cx,
            move |client| async move { client.get_canon(&project).await },
            move |this: &mut Self, result: Result<CanonOverview, Error>, cx| {
                let changed = epoch == this.generation && this.apply(result);
                this.read_done(cx);
                changed
            },
        );
    }

    /// Whether the answer changed what the board shows.
    fn apply(&mut self, result: Result<CanonOverview, Error>) -> bool {
        match result {
            Ok(canon) => {
                let changed = self.failed || self.canon.as_deref() != Some(&canon);
                if changed {
                    self.canon = Some(Rc::new(canon));
                }
                self.failed = false;
                changed
            }
            Err(_) => {
                let changed = !self.failed;
                self.failed = true;
                changed
            }
        }
    }

    /// `subscribeCanonChanges`: the canon topic moved.
    pub(super) fn live_moved(&mut self, cx: &mut Context<Self>) {
        let revision = self
            .ctx
            .live
            .read(cx)
            .revision(&Topic::Canon(self.project.clone()));
        if revision != self.seen {
            self.seen = revision;
            self.refresh(cx);
        }
    }

    /// `useCanonMove.move`: the board takes the move at once, the write follows, and a refusal
    /// puts the board back.
    pub(super) fn move_card(&mut self, mv: &KanbanMove, cx: &mut Context<Self>) {
        let Some(canon) = self.canon.clone() else {
            return;
        };
        if self.moving {
            return;
        }
        let words = words(Ds::get(cx).lang());
        let spec = Spec::of(mv);
        if !can_complete(find_card(&canon, &spec.item), &spec.to) {
            toast::show(cx, Toast::error(words.running));
            return;
        }
        let Some((write, message)) = persist_move(&canon, mv, words) else {
            return;
        };
        self.moving = true;
        self.generation += 1;
        if let Some(next) = optimistic_canon_move(&canon, mv) {
            self.canon = Some(Rc::new(next));
        }
        cx.notify();
        fetch(
            cx,
            move |client| write.send(client),
            move |this: &mut Self, result: Result<Value, Error>, cx| {
                match result {
                    Ok(_) => {
                        toast::show(cx, Toast::message(message));
                    }
                    Err(_) => {
                        // CARVE-OUT(G-codes): `canonWriteFailure` words a `conflict` or `running`
                        // refusal on its own; without codes every refusal gets the fallback.
                        this.canon = Some(canon);
                        toast::show(cx, Toast::error(words.request_failed));
                    }
                }
                this.moving = false;
                this.refresh(cx);
            },
        );
    }
}
