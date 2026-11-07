//! `composerStore*`, `composerModelResolution`, `composerImagePolicy`, `composerProjectContext`, the `useComposer*` hooks.
//!
//! The React zustand store becomes one [`ComposerState`] global. The editor, attachments,
//! menus and toolbar read and write it through [`ComposerState::update`]. The fields React's
//! `useComposerStoreBridge` copies in from hooks (`canSend`, `activeModel`, ...) are plain
//! fields the composer sets from [`send_state`] and [`resolve_composer_model_truth`].
#![allow(dead_code, reason = "P2 shell-wave: wired by Opus at wave integration")]
use std::collections::HashMap;

use gpui::{App, Global};

use crate::ui::source::wire::{
    AccessMode, MessageContent, MessageContentPart, MessageFileKind, MessageFileRef,
    NavigationView, ReasoningEffort, WorkerActivitySummary,
};
use crate::ui::store::drafts::DraftCache;

mod image_policy;
mod model;

#[allow(
    unused_imports,
    reason = "the wave's other composer units import these through `composer::state`"
)]
pub(crate) use image_policy::{
    AttachmentPickerFilter, AttachmentPickerKind, ComposerImagePolicy, FileLike, ImageRefusal,
    ModelImageBlock, attachment_picker_filter, blocked_image_attachment_ids, composer_image_policy,
    image_refusal, image_refusal_label, is_image_file,
};
#[allow(
    unused_imports,
    reason = "the wave's other composer units import these through `composer::state`"
)]
pub(crate) use model::{
    CatalogState, ComposerModelResolution, ComposerModelState, ComposerSettings, ControlsLoadState,
    ModelCatalog, ModelSummary, ModelTruthInput, resolve_composer_model_truth, runtime_models,
};

/// `ComposerStore.draftSessionId`'s initial value.
const NEW_CHAT_DRAFT: &str = "draft:chat";

/// `workspaceMode`
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum WorkspaceMode {
    #[default]
    Local,
    Worktree,
}

/// `ComposerAttachment` (`useFileAttachments`).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ComposerAttachment {
    pub(crate) id: String,
    pub(crate) file: MessageFileRef,
    pub(crate) kind: MessageFileKind,
}

/// `messageContentText`
pub(crate) fn message_content_text(content: &MessageContent) -> String {
    content
        .parts
        .iter()
        .map(|part| match part {
            MessageContentPart::Text { text } => text.clone(),
            MessageContentPart::SessionRef { titleSnapshot, .. }
            | MessageContentPart::ProjectRef { titleSnapshot, .. }
            | MessageContentPart::ProjectSourceRef { titleSnapshot, .. } => {
                format!("@{titleSnapshot}")
            }
        })
        .collect()
}

/// The composer's state: `useComposerStore`.
pub(crate) struct ComposerState {
    pub(crate) workspace_mode: WorkspaceMode,
    pub(crate) draft_revision: u64,
    pub(crate) draft_session_id: String,
    pub(crate) engaged: bool,
    pub(crate) text: String,
    pub(crate) content_parts: Option<MessageContent>,
    pub(crate) attachments: Vec<ComposerAttachment>,
    /// Attached images the selected model refuses; kept, but they block send.
    pub(crate) blocked_attachments: HashMap<String, ImageRefusal>,
    pub(crate) picker_kind: AttachmentPickerKind,
    /// `openAttachmentPicker` asked for the file dialog; the attachments unit takes it.
    pub(crate) picker_requested: bool,
    pub(crate) uploading_count: usize,
    pub(crate) model_menu_open: bool,
    pub(crate) access_menu_open: bool,
    pub(crate) context_popover_open: bool,
    pub(crate) model: Option<ComposerModelResolution>,
    pub(crate) send: SendState,
    /// `focusComposer` was asked for; the editor takes it on its next frame.
    pub(crate) focus_requested: bool,
    pub(crate) drafts: DraftCache,
}

impl Default for ComposerState {
    fn default() -> Self {
        Self {
            workspace_mode: WorkspaceMode::Local,
            draft_revision: 0,
            draft_session_id: NEW_CHAT_DRAFT.to_owned(),
            engaged: false,
            text: String::new(),
            content_parts: None,
            attachments: Vec::new(),
            blocked_attachments: HashMap::new(),
            picker_kind: AttachmentPickerKind::Files,
            picker_requested: false,
            uploading_count: 0,
            model_menu_open: false,
            access_menu_open: false,
            context_popover_open: false,
            model: None,
            send: SendState::default(),
            focus_requested: false,
            drafts: DraftCache::default(),
        }
    }
}

impl Global for ComposerState {}

impl ComposerState {
    /// The composer state of this app; created on first use.
    pub(crate) fn update<R>(cx: &mut App, change: impl FnOnce(&mut Self) -> R) -> R {
        change(cx.default_global::<Self>())
    }

    pub(crate) fn read<R>(cx: &mut App, read: impl FnOnce(&Self) -> R) -> R {
        read(cx.default_global::<Self>())
    }

    /// `activateDraftSession`: returns the new draft revision.
    pub(crate) fn activate_draft_session(
        &mut self,
        session_id: &str,
        text: String,
        content_parts: Option<MessageContent>,
    ) -> u64 {
        self.draft_revision += 1;
        session_id.clone_into(&mut self.draft_session_id);
        self.text = text;
        self.content_parts = content_parts;
        self.workspace_mode = WorkspaceMode::Local;
        self.draft_revision
    }

    /// `restoreDraftSession`: false when the draft moved on since `revision`.
    pub(crate) fn restore_draft_session(
        &mut self,
        revision: u64,
        session_id: &str,
        text: String,
        content_parts: Option<MessageContent>,
    ) -> bool {
        if self.draft_revision != revision || self.draft_session_id != session_id {
            return false;
        }
        self.text = text;
        self.content_parts = content_parts;
        true
    }

    /// `setContentParts`
    pub(crate) fn set_content_parts(&mut self, content: MessageContent) {
        let text = message_content_text(&content);
        let rich = content
            .parts
            .iter()
            .any(|part| !matches!(part, MessageContentPart::Text { .. }));
        self.draft_revision += 1;
        self.drafts
            .write(&self.draft_session_id, &text, rich.then_some(&content));
        self.text = text;
        self.content_parts = rich.then_some(content);
    }

    /// `setText`
    pub(crate) fn set_text(&mut self, text: &str) {
        self.draft_revision += 1;
        self.drafts.write(&self.draft_session_id, text, None);
        text.clone_into(&mut self.text);
        self.content_parts = None;
    }

    /// `removeAttachment`
    pub(crate) fn remove_attachment(&mut self, id: &str) {
        self.attachments.retain(|attachment| attachment.id != id);
    }

    /// `openAttachmentPicker`
    pub(crate) fn open_attachment_picker(&mut self, kind: AttachmentPickerKind) {
        self.picker_kind = kind;
        self.picker_requested = true;
    }

    /// `focusComposer`: the editor takes the request on its next frame.
    pub(crate) fn request_focus(&mut self) {
        self.focus_requested = true;
    }
}

/// `useComposerDraftSession`: the draft of `session_id` becomes the composer's.
pub(crate) fn use_draft_session(session_id: &str, cx: &mut App) {
    ComposerState::update(cx, |state| {
        let cached = state.drafts.read(session_id);
        let text = cached.map(|draft| draft.text.clone()).unwrap_or_default();
        let parts = cached.and_then(|draft| draft.content_parts.clone());
        state.activate_draft_session(session_id, text, parts);
    });
}

/// `composerProjectContext.activeProjectId`
pub(crate) fn active_project_id(
    navigation: &NavigationView,
    active_chat_id: &str,
) -> Option<String> {
    if let Some(project) = active_chat_id.strip_prefix("dashboard:") {
        return Some(project.to_owned());
    }
    if let Some(project) = active_chat_id.strip_prefix("draft:project:") {
        return Some(project.to_owned());
    }
    navigation
        .projects
        .iter()
        .find(|project| {
            (project.sessions.iter().flatten()).any(|session| session.id == active_chat_id)
        })
        .map(|project| project.id.clone())
}

/// What `useComposerState` derives for send and stop.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct SendState {
    pub(crate) active_turn: bool,
    pub(crate) can_stop: bool,
    pub(crate) can_send: bool,
}

pub(crate) struct SendInputs<'a> {
    pub(crate) model_state: ComposerModelState,
    pub(crate) text: &'a str,
    pub(crate) attachments: &'a [ComposerAttachment],
    pub(crate) is_sending: bool,
    pub(crate) uploading_count: usize,
    pub(crate) active_model: Option<&'a ModelSummary>,
    /// An active turn progress snapshot exists, or the summary's `turn_state` is active.
    pub(crate) parent_active: bool,
    /// A visible, cancellable worker exists (`firstCancellableWorker`).
    pub(crate) active_worker: bool,
    /// `summary.latest_turn_cancellable`
    pub(crate) latest_turn_cancellable: Option<bool>,
}

/// `ACTIVE_TURN_STATES`
pub(crate) fn is_active_turn_state(state: &str) -> bool {
    matches!(
        state,
        "accepted"
            | "thinking"
            | "streaming"
            | "waiting_for_form"
            | "waiting_for_tool"
            | "cancelling"
            | "retrying"
    )
}

/// `isWorkerVisibleInComposer`
pub(crate) fn worker_visible_in_composer(worker: &WorkerActivitySummary) -> bool {
    let phase = worker.semantic_phase.as_ref().unwrap_or(&worker.phase);
    let inactive = matches!(
        phase.as_str(),
        "blocked" | "complete" | "failed" | "cancelled" | "recoverable"
    );
    !worker.terminal && !inactive
}

/// `useComposerState`: the send and stop gates, and the images the model refuses.
pub(crate) fn send_state(input: &SendInputs) -> (SendState, HashMap<String, ImageRefusal>) {
    let has_sendable_draft = !input.text.trim().is_empty() || !input.attachments.is_empty();
    let active_turn = input.parent_active || input.active_worker;
    let synthesis_locked = input.parent_active && input.latest_turn_cancellable == Some(false);
    let can_stop =
        !synthesis_locked && (input.is_sending || input.parent_active || input.active_worker);
    let policy = composer_image_policy(input.active_model);
    let blocked = blocked_image_attachment_ids(input.attachments, &policy);
    let can_send = input.model_state == ComposerModelState::Ready
        && has_sendable_draft
        && input.uploading_count == 0
        && blocked.is_empty()
        && (!input.is_sending || active_turn);
    let state = SendState {
        active_turn,
        can_stop,
        can_send,
    };
    (state, blocked)
}

/// The reasoning efforts the model offers (`availableReasoning`).
pub(crate) fn available_reasoning(active_model: Option<&ModelSummary>) -> Vec<ReasoningEffort> {
    active_model
        .map(|model| model.reasoning_efforts.clone())
        .filter(|efforts| !efforts.is_empty())
        .unwrap_or_else(|| vec![ReasoningEffort::None])
}

/// `ComposerControls.queuePolicy`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QueuePolicy {
    EnqueueIfBusy,
    SendNow,
}

/// `ComposerControls`, as `composerControlsForSubmit` builds them.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ComposerControls {
    pub(crate) model: Option<String>,
    pub(crate) reasoning_effort: Option<ReasoningEffort>,
    pub(crate) access_mode: Option<AccessMode>,
    pub(crate) plan_mode: Option<bool>,
    pub(crate) queue_policy: QueuePolicy,
    pub(crate) attachments: Vec<MessageFileRef>,
    pub(crate) content_parts: Option<MessageContent>,
    pub(crate) workspace_mode: WorkspaceMode,
}

/// What `useComposerSubmit` closes over.
pub(crate) struct SubmitInput {
    /// `readText?.() ?? text`
    pub(crate) text: String,
    pub(crate) model: String,
    pub(crate) reasoning: ReasoningEffort,
    pub(crate) access_mode: AccessMode,
    pub(crate) plan_mode: bool,
    pub(crate) controls_touched: bool,
    pub(crate) is_sending: bool,
    pub(crate) active_turn: bool,
    pub(crate) uploading_count: usize,
    /// `liveConnectionLost`
    pub(crate) live_connection_lost: bool,
}

/// An accepted-to-send draft: its text, controls and where it came from.
pub(crate) struct Submission {
    pub(crate) text: String,
    pub(crate) controls: ComposerControls,
    session_id: String,
    revision: u64,
    attachments: Vec<ComposerAttachment>,
}

impl ComposerState {
    /// `useComposerSubmit`: the checks, then the submission to send (`onSend`). `None` when the
    /// draft is empty, blocked, or a send is already in flight without a running turn.
    pub(crate) fn begin_submit(&mut self, input: SubmitInput) -> Option<Submission> {
        if input.live_connection_lost {
            return None;
        }
        let value = input.text.trim();
        if (value.is_empty() && self.attachments.is_empty())
            || !self.blocked_attachments.is_empty()
            || (input.is_sending && !input.active_turn)
            || input.uploading_count > 0
        {
            return None;
        }
        self.model_menu_open = false;
        self.access_menu_open = false;
        let controls = ComposerControls {
            model: input.controls_touched.then_some(input.model),
            reasoning_effort: input.controls_touched.then_some(input.reasoning),
            access_mode: input.controls_touched.then_some(input.access_mode),
            plan_mode: input.controls_touched.then_some(input.plan_mode),
            queue_policy: if input.active_turn {
                QueuePolicy::EnqueueIfBusy
            } else {
                QueuePolicy::SendNow
            },
            attachments: (self.attachments.iter())
                .map(|attachment| attachment.file.clone())
                .collect(),
            content_parts: self.content_parts.clone(),
            workspace_mode: self.workspace_mode,
        };
        Some(Submission {
            text: input.text,
            controls,
            session_id: self.draft_session_id.clone(),
            revision: self.draft_revision,
            attachments: self.attachments.clone(),
        })
    }

    /// `onAccepted`: the sent draft leaves the editor, unless the owner typed on since.
    pub(crate) fn submission_accepted(&mut self, sent: &Submission) {
        if self.draft_session_id == sent.session_id && self.draft_revision == sent.revision {
            self.workspace_mode = WorkspaceMode::Local;
            self.set_text("");
            if self.attachments == sent.attachments {
                self.attachments.clear();
            }
        } else if self.draft_session_id != sent.session_id {
            // Session creation changes the active ID before the send is acknowledged. Only
            // clear the submitted cache, never the newly active editor.
            let unchanged = self.drafts.read(&sent.session_id).is_some_and(|cached| {
                cached.text == sent.text && cached.content_parts == sent.controls.content_parts
            });
            if unchanged {
                self.drafts.write(&sent.session_id, "", None);
            }
        }
    }

    /// `onRejected`: the draft comes back when the composer still shows the target chat empty.
    pub(crate) fn submission_rejected(&mut self, sent: &Submission, target_session_id: &str) {
        if target_session_id == sent.session_id
            || self.draft_session_id != target_session_id
            || !self.text.is_empty()
        {
            return;
        }
        match sent.controls.content_parts.clone() {
            Some(content) => self.set_content_parts(content),
            None => self.set_text(&sent.text),
        }
        if self.attachments.is_empty() {
            self.attachments.clone_from(&sent.attachments);
        }
    }
}
