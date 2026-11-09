//! `EpicInspector.tsx` and the selected-epic half of `useCanonBoard.ts`: one epic's detail, its
//! plans and its task progress, read again when the project's canon topic moves, and the one
//! write path (`write`) every edit goes through.
use std::collections::{HashMap, HashSet};

use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::Error;
use gpui::{Context, SharedString, Window};
use serde::Deserialize;
use serde_json::{Value, json};

use super::activity::Activity;
use super::copy::{Words, words};
use super::delete::Delete;
use super::guard::Inline;
use crate::ui::manage::{ManageCtx, Topic};
use crate::ui::source::fetch::{Flight, fetch, fetch_if};
use crate::ui::source::wire::{
    CanonOverview, EpicDetail, EpicInput, EpicProgressSnapshot, PlanCards,
};

/// What a write answers, once the epic is read again (or at once when it failed).
pub(super) type Done = Box<dyn FnOnce(bool, &mut EpicInspector, &mut Context<EpicInspector>)>;
pub(super) type Waiter = Box<dyn FnOnce(&mut EpicInspector, &mut Context<EpicInspector>)>;

#[expect(
    clippy::struct_excessive_bools,
    reason = "embedded, missing, failed and busy are independent flags"
)]
pub(crate) struct EpicInspector {
    pub(super) ctx: ManageCtx,
    pub(super) project: SharedString,
    pub(super) epic: SharedString,
    /// `embedded`: the session info's compact form (no conversation link).
    pub(super) embedded: bool,
    pub(super) plans: Option<Vec<PlanCards>>,
    pub(super) detail: Option<EpicDetail>,
    pub(super) tasks: Option<EpicProgressSnapshot>,
    pub(super) missing: bool,
    pub(super) failed: bool,
    pub(super) busy: bool,
    flight: Flight,
    seen: u64,
    waiters: Vec<Waiter>,
    pub(super) inline: Inline,
    pub(super) activity: Activity,
    pub(super) delete: Delete,
    /// Spec rows the owner folded, by node id and `node:part`.
    pub(super) folded: HashSet<SharedString>,
    /// Criteria whose check is in flight, and proposals being resolved.
    pub(super) pending: HashSet<SharedString>,
    pub(super) tags: super::detail::TagsCache,
    /// Each loaded proposal's changed lines, by proposal id (built on load, read by render).
    pub(super) diffs: HashMap<String, Vec<super::proposals::Row>>,
}

/// `getCanon`, `getCanonEpic` and `getEpicProgress` together.
#[derive(Deserialize)]
struct Loaded {
    board: CanonOverview,
    epic: Option<EpicDetail>,
    progress: Option<EpicProgressSnapshot>,
}

impl EpicInspector {
    pub(crate) fn new(
        ctx: ManageCtx,
        project: SharedString,
        epic: SharedString,
        embedded: bool,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let topic = Topic::Canon(project.clone());
        let seen = ctx.live.read(cx).revision(&topic);
        cx.observe(&ctx.live.clone(), move |this, live, cx| {
            let revision = live.read(cx).revision(&topic);
            if revision != this.seen {
                this.seen = revision;
                this.refresh(cx);
            }
        })
        .detach();
        let mut inspector = Self {
            ctx,
            project,
            epic,
            embedded,
            plans: None,
            detail: None,
            tasks: None,
            missing: false,
            failed: false,
            busy: false,
            flight: Flight::default(),
            seen,
            waiters: Vec::new(),
            inline: Inline::default(),
            activity: Activity::default(),
            delete: Delete::default(),
            folded: HashSet::new(),
            pending: HashSet::new(),
            tags: super::detail::TagsCache::default(),
            diffs: HashMap::new(),
        };
        inspector.refresh(cx);
        inspector
    }

    pub(super) fn words(cx: &gpui::App) -> &'static Words {
        words(Ds::get(cx).lang())
    }

    /// Whether one of this inspector's dialogs holds the keyboard.
    pub(crate) fn dialog_open(&self) -> bool {
        self.inline.guard_open() || self.delete.open
    }

    /// Reads the epic again, then runs `waiter` (`await onRefresh()`).
    pub(super) fn refresh_then(&mut self, waiter: Waiter, cx: &mut Context<Self>) {
        self.waiters.push(waiter);
        self.refresh(cx);
    }

    /// `refresh` (`singleFlight(read)`).
    pub(super) fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.flight.begin() {
            self.read(cx);
        }
    }

    fn read(&mut self, cx: &mut Context<Self>) {
        let (project, epic) = (self.project.to_string(), self.epic.to_string());
        fetch_if(
            cx,
            move |client| async move {
                let board = client.get_canon(&project).await?;
                let overview: CanonOverview =
                    serde_json::from_value(board.clone()).map_err(|_| Error::Protocol)?;
                let listed = overview.backlog.iter().any(|card| card.id == epic)
                    || overview
                        .plans
                        .iter()
                        .any(|plan| plan.works.iter().any(|card| card.id == epic));
                if !listed {
                    return Ok(json!({ "board": board, "epic": null, "progress": null }));
                }
                let detail = client.get_canon_epic(&epic).await?;
                let progress = client.get_epic_progress(&epic).await?;
                Ok::<Value, Error>(json!({ "board": board, "epic": detail, "progress": progress }))
            },
            |this: &mut Self, result: Result<Loaded, Error>, cx| {
                let changed = this.loaded(result);
                if this.flight.end() {
                    this.read(cx);
                } else {
                    for waiter in std::mem::take(&mut this.waiters) {
                        waiter(this, cx);
                    }
                }
                changed
            },
        );
    }

    /// Takes one read's answer; whether the page shows anything new.
    fn loaded(&mut self, result: Result<Loaded, Error>) -> bool {
        match result {
            Ok(read) => {
                let plans = Some(read.board.plans);
                let missing = read.epic.is_none();
                let changed = self.plans != plans
                    || self.detail != read.epic
                    || self.tasks != read.progress
                    || self.missing != missing
                    || self.failed;
                self.plans = plans;
                self.missing = missing;
                self.failed = false;
                self.tasks = read.progress;
                self.detail = read.epic;
                if let Some(detail) = self.detail.clone() {
                    self.activity.merge_detail(&detail);
                    self.sync_draft(&detail);
                }
                self.sync_diffs();
                changed
            }
            // CARVE-OUT(G-codes): `work_model_not_found` is told by its 404.
            Err(Error::Http(404)) => {
                let changed = !self.missing;
                (self.detail, self.tasks, self.missing, self.failed) = (None, None, true, false);
                self.sync_diffs();
                changed
            }
            Err(_) => {
                let changed = !self.failed;
                self.failed = true;
                changed
            }
        }
    }

    /// `canonWriteFailure`: a conflict reloads the epic; anything else is a toast.
    pub(super) fn write_failed(&mut self, error: &Error, cx: &mut Context<Self>) {
        let words = Self::words(cx);
        // CARVE-OUT(G-codes): `conflict` and `running` are told apart by the one 409 status.
        if matches!(error, Error::Http(409)) {
            toast::show(cx, Toast::error(words.conflict));
            self.refresh(cx);
        } else {
            toast::show(cx, Toast::error(words.request_failed));
        }
    }

    /// `write`: PATCH the epic at the revision it was read at (or the input's own). `message`
    /// is the success toast. `done` answers once the epic is read again, or at once on failure.
    pub(super) fn write(
        &mut self,
        mut input: EpicInput,
        message: Option<SharedString>,
        done: Option<Done>,
        cx: &mut Context<Self>,
    ) {
        let answer = |done: Option<Done>, saved: bool, this: &mut Self, cx: &mut Context<Self>| {
            if let Some(done) = done {
                done(saved, this, cx);
            }
        };
        let Some(detail) = self.detail.as_ref().filter(|_| !self.busy) else {
            answer(done, false, self, cx);
            return;
        };
        let id = detail.card.id.clone();
        input.expected_revision = input.expected_revision.or(Some(detail.card.revision));
        let Ok(body) = serde_json::to_value(&input) else {
            answer(done, false, self, cx);
            return;
        };
        self.busy = true;
        cx.notify();
        fetch(
            cx,
            move |client| async move { client.edit_canon_epic(&id, &body).await },
            move |this: &mut Self, result: Result<Value, Error>, cx| {
                this.busy = false;
                match result {
                    Ok(_) => {
                        if let Some(message) = message {
                            toast::show(cx, Toast::message(message));
                        }
                        this.waiters
                            .push(Box::new(move |this, cx| answer(done, true, this, cx)));
                        this.refresh(cx);
                    }
                    Err(error) => {
                        this.write_failed(&error, cx);
                        answer(done, false, this, cx);
                    }
                }
            },
        );
    }
}
