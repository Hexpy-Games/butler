//! `useComposerSubmit` and `useComposerQueue`: what Send does with the draft. A message sent
//! while a turn runs is queued; any other goes to the shell, which sends it (or first creates
//! the chat).
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use gpui::{Context, Window};
use serde_json::{Value, json};

use super::editor::serialize::content_text;
use super::queue::{access_wire, controls_body, effort_wire, queue_message};
use super::state::{ComposerState, QueuePolicy, Submission, SubmitInput};
use super::references::MentionKey;
use super::{Composer, ComposerEvent, Submit, SubmitWithModifier};
use crate::ui::i18n::composer::words;
use crate::ui::source::agent::Jobs;

/// A draft taken to send.
#[derive(Clone)]
pub(crate) struct Outgoing {
    pub(crate) text: String,
    submission: Submission,
}

impl From<String> for Outgoing {
    fn from(text: String) -> Self {
        Self {
            submission: Submission::plain(text.clone()),
            text,
        }
    }
}

impl Outgoing {
    /// The `POST /messages` body of `sendMessage`: the text, content parts, attachments and
    /// controls, and the queue policy the submission was made under.
    pub(crate) fn body(&self, chat_id: &str, client_message_id: &str) -> Value {
        let mut body = controls_body(&self.text, &self.submission.controls);
        body.insert("chat_id".into(), json!(chat_id));
        body.insert("client_message_id".into(), json!(client_message_id));
        let policy = match self.submission.controls.queue_policy {
            QueuePolicy::EnqueueIfBusy => "enqueue_if_busy",
            QueuePolicy::SendNow => "send_now",
        };
        body.insert("queue_policy".into(), json!(policy));
        Value::Object(body)
    }
}

impl Outgoing {
    /// `draftSessionControls`: the controls a new chat starts with, when the owner chose some.
    pub(crate) fn session_controls(&self) -> Option<Value> {
        let controls = &self.submission.controls;
        let model = controls.model.as_ref()?;
        Some(json!({
            "model": model,
            "reasoning_effort": controls.reasoning_effort.as_ref().and_then(effort_wire),
            "access_mode": controls.access_mode.as_ref().and_then(access_wire),
            "plan_mode": controls.plan_mode.unwrap_or(false),
        }))
    }
}

impl Composer {
    /// Enter: chooses the open mention menu's row, otherwise sends.
    pub(super) fn submit(&mut self, _: &Submit, window: &mut Window, cx: &mut Context<Self>) {
        if self.mention_key(MentionKey::Choose, window, cx) {
            return;
        }
        self.send_draft(window, cx);
    }

    /// Enter with a modifier is never the menu's (`useMentionKeys`).
    pub(super) fn submit_with_modifier(
        &mut self,
        _: &SubmitWithModifier,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.send_draft(window, cx);
    }

    fn send_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.disabled.is_some() || self.composing(window, cx) {
            return;
        }
        self.on_text_changed(window, cx);
        let Some(outgoing) = self.begin_send(cx) else {
            return;
        };
        let queued = outgoing.submission.controls.queue_policy == QueuePolicy::EnqueueIfBusy;
        if let (true, Some(chat)) = (queued, self.inputs.chat_id.clone()) {
            self.queue(chat, outgoing, cx);
            return;
        }
        ComposerState::update(cx, |draft| draft.submission_accepted(&outgoing.submission));
        self.pull_state(window, cx);
        window.invalidate_character_coordinates();
        cx.emit(ComposerEvent::Send(Box::new(outgoing)));
    }

    fn begin_send(&mut self, cx: &mut Context<Self>) -> Option<Outgoing> {
        let shown = &self.controls.shown;
        let text = content_text(self.editor.parts());
        let (active_turn, uploading_count) =
            ComposerState::read(cx, |draft| (draft.send.active_turn, draft.uploading_count));
        let input = SubmitInput {
            text: text.clone(),
            model: shown.model.clone(),
            reasoning: shown.reasoning.clone(),
            access_mode: shown.access_mode.clone(),
            plan_mode: shown.plan_mode,
            controls_touched: self.controls.touched(),
            is_sending: false,
            active_turn,
            uploading_count,
            live_connection_lost: self.inputs.reconnecting,
        };
        let submission = ComposerState::update(cx, |draft| draft.begin_submit(input))?;
        Some(Outgoing { text, submission })
    }

    /// `queueMessage` of a started chat: the draft leaves the editor once the queue took it and
    /// stays when it did not.
    fn queue(&mut self, chat: String, outgoing: Outgoing, cx: &mut Context<Self>) {
        let (text, controls) = (outgoing.text.clone(), outgoing.submission.controls.clone());
        let fetch = Jobs::run(cx, move |client| async move {
            queue_message(&client, &chat, &text, &controls).await
        });
        cx.spawn(async move |this, cx| {
            let queued = fetch.await.is_some_and(|result| result.is_ok());
            let _ = this.update(cx, |this, cx| {
                if queued {
                    ComposerState::update(cx, |draft| {
                        draft.submission_accepted(&outgoing.submission);
                    });
                } else {
                    let lang = Ds::get(cx).lang();
                    toast::show(cx, Toast::error(words(lang).queue_failed));
                }
                this.recompute(cx);
                cx.notify();
            });
        })
        .detach();
    }
}
