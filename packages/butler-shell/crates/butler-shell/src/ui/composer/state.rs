//! `composerStore*`, `composerModelResolution`, `composerImagePolicy`, `composerProjectContext`, the `useComposer*` hooks.
//!
//! The React zustand store becomes one [`ComposerState`] global. The editor, attachments,
//! menus and toolbar read and write it through [`ComposerState::update`]. The fields React's
//! `useComposerStoreBridge` copies in from hooks (`canSend`, `activeModel`, ...) are plain
//! fields the composer sets from [`send_state`] and [`resolve_composer_model_truth`].
use std::collections::HashMap;

use gpui::{App, Global};

use crate::ui::composer::menus::ModelChoice;
use crate::ui::source::wire::{
    AccessMode, MessageContent, MessageContentPart, MessageFileKind, MessageFileRef,
    ReasoningEffort, WorkerActivitySummary,
};
use crate::ui::store::drafts::DraftCache;

mod image_policy;
mod model;

pub(crate) use image_policy::{
    AttachmentPickerFilter, AttachmentPickerKind, FileLike, ImageRefusal, attachment_picker_filter,
    blocked_image_attachment_ids, composer_image_policy, image_refusal, image_refusal_label,
};
pub(crate) use model::{
    CatalogState, ComposerModelResolution, ComposerModelState, ComposerSettings, ControlsLoadState,
    ModelCatalog, ModelTruthInput, resolve_composer_model_truth, runtime_models,
};

/// `ComposerStore.draftSessionId`'s initial value.
pub(crate) const NEW_CHAT_DRAFT: &str = "draft:chat";

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
    pub(crate) text: String,
    pub(crate) content_parts: Option<MessageContent>,
    pub(crate) attachments: Vec<ComposerAttachment>,
    /// Attached images the selected model refuses; kept, but they block send.
    pub(crate) blocked_attachments: HashMap<String, ImageRefusal>,
    pub(crate) uploading_count: usize,
    /// The context donut's popover is open (the composer stays expanded meanwhile).
    pub(crate) context_popover_open: bool,
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
            text: String::new(),
            content_parts: None,
            attachments: Vec::new(),
            blocked_attachments: HashMap::new(),
            uploading_count: 0,
            context_popover_open: false,
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

    /// A content part joins the end of the draft (a project source reference).
    pub(crate) fn append_content_part(&mut self, part: MessageContentPart) {
        let mut content = self
            .content_parts
            .clone()
            .unwrap_or_else(|| MessageContent {
                version: 1,
                parts: if self.text.is_empty() {
                    Vec::new()
                } else {
                    vec![MessageContentPart::Text {
                        text: self.text.clone(),
                    }]
                },
                attachment_metadata: None,
            });
        content.parts.push(part);
        self.set_content_parts(content);
    }

    /// `removeAttachment`
    pub(crate) fn remove_attachment(&mut self, id: &str) {
        self.attachments.retain(|attachment| attachment.id != id);
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
    pub(crate) active_model: Option<&'a ModelChoice>,
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
pub(crate) fn available_reasoning(active_model: Option<&ModelChoice>) -> Vec<ReasoningEffort> {
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
#[derive(Clone)]
pub(crate) struct Submission {
    pub(crate) text: String,
    pub(crate) controls: ComposerControls,
    session_id: String,
    revision: u64,
    attachments: Vec<ComposerAttachment>,
}

impl Submission {
    /// A message sent without the composer (an answer's follow-up question): its text and no
    /// controls, as `sendMessage(text)` is called without them.
    pub(crate) fn plain(text: String) -> Self {
        let controls = ComposerControls {
            model: None,
            reasoning_effort: None,
            access_mode: None,
            plan_mode: None,
            queue_policy: QueuePolicy::SendNow,
            attachments: Vec::new(),
            content_parts: None,
            workspace_mode: WorkspaceMode::Local,
        };
        Self {
            text,
            controls,
            session_id: String::new(),
            revision: 0,
            attachments: Vec::new(),
        }
    }
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
}
