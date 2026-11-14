//! What the shell tells the composer about the open chat, and what a change of it sets off:
//! a chat change restores its draft and rereads its controls, an attach reads the catalog.
use gpui::{Context, Window};

use super::notice::git_missing;
use super::state::{ComposerState, is_active_turn_state, worker_visible_in_composer};
use super::{Composer, state};
use crate::ui::source::wire::{
    ContextDetailsView, ProgressRow, SessionSummaryView, TurnProgressSnapshot,
    WorkerActivitySummary,
};

/// The Git facts the composer reads.
#[derive(Clone, Copy, Default, PartialEq)]
pub(crate) struct GitInputs {
    /// A new chat can start in a Git worktree (`selectIsGitProject`).
    pub(crate) project: bool,
    /// The open chat's Git dependency is missing.
    pub(crate) missing: bool,
}

/// The open chat and the agent as the composer needs them.
#[derive(Clone, Default, PartialEq)]
pub(crate) struct Inputs {
    /// An agent is attached and compatible.
    pub(crate) connected: bool,
    /// The open chat; `None` for a new chat.
    pub(crate) chat_id: Option<String>,
    pub(crate) session_id: Option<String>,
    /// The draft the composer edits in place of the open chat's (the dashboard's
    /// `dashboard:<project>`, D4).
    pub(crate) draft_key: Option<String>,
    /// The open chat's project, which gates plan mode and the project documents.
    pub(crate) project_id: Option<String>,
    /// Git facts of the open or new chat.
    pub(crate) git: GitInputs,
    /// The chat summary's `turn_state` and `latest_turn_cancellable`.
    pub(crate) turn_state: Option<String>,
    pub(crate) latest_turn_cancellable: Option<bool>,
    pub(crate) context: Option<ContextDetailsView>,
    pub(crate) workers: Vec<WorkerActivitySummary>,
    /// The summary's latest turn progress.
    pub(crate) progress: Option<TurnProgressSnapshot>,
    /// `liveConnectionLost`.
    pub(crate) reconnecting: bool,
    /// Electron `useActiveCanonEpic`: the session belongs to an Epic.
    pub(crate) epic: bool,
}

impl Inputs {
    /// The inputs the open chat's summary carries; the shell fills in the rest.
    pub(crate) fn from_summary(summary: Option<&SessionSummaryView>) -> Self {
        Self {
            turn_state: summary.and_then(|s| s.turn_state.clone()),
            latest_turn_cancellable: summary.and_then(|s| s.latest_turn_cancellable),
            context: summary.and_then(|s| s.context_details.clone()),
            workers: summary
                .and_then(|s| s.worker_activity.clone())
                .unwrap_or_default(),
            progress: summary.and_then(|s| s.latest_progress.clone()),
            git: GitInputs {
                project: false,
                missing: git_missing(summary),
            },
            ..Self::default()
        }
    }

    /// `activeTurnProgressSnapshot`: the progress while its turn runs.
    pub(super) fn active_progress(&self) -> Option<&TurnProgressSnapshot> {
        self.progress
            .as_ref()
            .filter(|p| p.state.as_deref().is_some_and(is_active_turn_state))
    }

    /// `taskRows`: the work-ledger todo rows of the active turn.
    pub(super) fn task_rows(&self) -> Vec<ProgressRow> {
        (self.active_progress().into_iter())
            .flat_map(|p| p.safe_progress_rows.iter())
            .filter(|row| {
                row.kind.as_deref() == Some("todo")
                    && row.bridge_phase.as_deref() == Some("btcc_work_ledger")
            })
            .cloned()
            .collect()
    }
}

impl Composer {
    /// The shell's view of the chat changed: applies it and what follows from it.
    pub(crate) fn set_inputs(
        &mut self,
        mut inputs: Inputs,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        inputs.workers.retain(worker_visible_in_composer);
        if self.inputs == inputs {
            return;
        }
        let previous = std::mem::replace(&mut self.inputs, inputs);
        let chat_changed = self.inputs.session_id != previous.session_id
            || self.inputs.draft_key != previous.draft_key;
        if chat_changed {
            self.switch_chat(window, cx);
        }
        if self.inputs.connected && !previous.connected {
            self.load_controls(cx);
        } else if chat_changed {
            self.load_session_controls(false, cx);
        } else if self.inputs.project_id != previous.project_id {
            self.resolve(cx);
        }
        if self.inputs.context != previous.context || chat_changed {
            self.feed_context(cx);
        }
        self.recompute(cx);
        cx.notify();
    }

    /// `useComposerDraftSession` and the effects on `activeChatId`: the chat's draft becomes the
    /// composer's, its attachments and controls start over.
    fn switch_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let key = (self.inputs.draft_key.clone()).or_else(|| self.inputs.session_id.clone());
        state::use_draft_session(key.as_deref().unwrap_or(state::NEW_CHAT_DRAFT), cx);
        ComposerState::update(cx, |draft| {
            draft.attachments.clear();
            draft.blocked_attachments.clear();
            draft.uploading_count = 0;
        });
        self.attachments.reset();
        self.controls.reset_chat();
        self.context_control
            .update(cx, |control, _| control.reset_usage_cache());
        self.pull_state(window, cx);
    }

    /// `useComposerState`: the visible workers, the task rows of the active turn and the send
    /// and stop gates, from the shell's inputs and the draft.
    pub(super) fn recompute(&mut self, cx: &mut Context<Self>) {
        let active_worker = !self.inputs.workers.is_empty();
        let turn_active = (self.inputs.turn_state.as_deref()).is_some_and(is_active_turn_state);
        let parent_active = turn_active || self.inputs.active_progress().is_some();
        let model_state = self.controls.shown.state;
        let latest_turn_cancellable = self.inputs.latest_turn_cancellable;
        let active_model = self.active_model().cloned();
        ComposerState::update(cx, |draft| {
            let (send, blocked) = state::send_state(&state::SendInputs {
                model_state,
                text: &draft.text,
                attachments: &draft.attachments,
                is_sending: false,
                uploading_count: draft.uploading_count,
                active_model: active_model.as_ref(),
                parent_active,
                active_worker,
                latest_turn_cancellable,
            });
            draft.send = send;
            draft.blocked_attachments = blocked;
        });
    }
}

impl Composer {
    /// Electron `ComposerInputSurface.tsx`: authority, plan instruction, Epic, default.
    pub(super) fn input_placeholder(
        &self,
        plan: Option<&'static str>,
        cx: &gpui::App,
    ) -> &'static str {
        let authority = self.decision_view.as_deref().is_some_and(|view| {
            crate::ui::decisions::authority_pending(crate::ui::decisions::DecisionCtx { view })
        });
        if authority {
            return self.theme.strings.placeholder;
        }
        plan.unwrap_or_else(|| self.empty_placeholder(cx))
    }

    /// Electron `ComposerCompactPreview.tsx`: an Epic supplies the empty draft's copy.
    pub(super) fn empty_placeholder(&self, cx: &gpui::App) -> &'static str {
        if self.inputs.epic {
            crate::ui::i18n::composer::words(butler_ds::ui::context::Ds::get(cx).lang())
                .epic_placeholder
        } else {
            self.theme.strings.placeholder
        }
    }
}
