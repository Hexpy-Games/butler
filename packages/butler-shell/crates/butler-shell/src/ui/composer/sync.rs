//! The editor and the composer state (`saveDraftFromEditor`, `syncEditorFromStore`,
//! `composerFocus`), and the context donut's inputs and requests.
use gpui::{Context, Entity, Window};

use super::context::{ComposerContextControl, ComposerContextEvent, load_quota, load_usage};
use super::editor::FocusPlacement;
use super::editor::serialize::{content_json, content_text, draft_parts, has_atoms};
use super::state::{ComposerState, runtime_models};
use super::wire::usage_model;
use super::{Composer, ComposerEvent};
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::MessageContent;

impl Composer {
    /// `saveDraftFromEditor`: the field changed; the draft (and its cache) follows.
    pub(super) fn on_text_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.editor.on_text_changed(window, cx) {
            return;
        }
        let parts = self.editor.parts().to_vec();
        let text = content_text(&parts);
        let content = has_atoms(&parts)
            .then(|| serde_json::from_value::<MessageContent>(content_json(&parts)).ok())
            .flatten();
        let revision = ComposerState::update(cx, |draft| {
            match content {
                Some(content) => draft.set_content_parts(content),
                None => draft.set_text(&text),
            }
            draft.draft_revision
        });
        self.synced_revision = revision;
        self.recompute(cx);
        cx.notify();
    }

    /// `syncEditorFromStore`: a draft written from outside the field (a sent draft, a queued
    /// message loaded for editing, a project source) goes into it.
    pub(super) fn pull_state(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (revision, parts) = ComposerState::read(cx, |draft| {
            (
                draft.draft_revision,
                draft_parts(draft.content_parts.as_ref(), &draft.text),
            )
        });
        if revision == self.synced_revision {
            return;
        }
        self.synced_revision = revision;
        self.editor.write(parts, window, cx);
        self.recompute(cx);
    }

    /// `focusComposer`: the request of `ComposerState::request_focus` is taken once.
    pub(super) fn take_focus_request(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let requested =
            ComposerState::update(cx, |draft| std::mem::take(&mut draft.focus_requested));
        if requested && self.disabled.is_none() {
            self.fold.engaged = true;
            self.editor.focus(FocusPlacement::End, window, cx);
        }
    }

    /// The composer store's `context`, `models` and `activeModel` for the donut.
    pub(super) fn feed_context(&mut self, cx: &mut Context<Self>) {
        let models = runtime_models(&self.controls.catalog)
            .into_iter()
            .map(usage_model)
            .collect();
        let active = self.active_model().map(usage_model);
        let (context, chat) = (self.inputs.context.clone(), self.inputs.session_id.clone());
        self.context_control.update(cx, |control, cx| {
            control.set_input(context, models, active, chat, cx);
        });
    }

    /// What the donut asks of its owner: usage and quota reads run on the agent worker.
    pub(super) fn on_context_event(
        &mut self,
        _: Entity<ComposerContextControl>,
        event: &ComposerContextEvent,
        cx: &mut Context<Self>,
    ) {
        match event {
            ComposerContextEvent::LoadUsage {
                session_id,
                revision,
            } => {
                let (session, revision) = (session_id.clone(), revision.clone());
                let requested = session.clone();
                let fetch = Jobs::run(cx, move |client| async move {
                    load_usage(&client, &requested).await
                });
                let control = self.context_control.clone();
                cx.spawn(async move |_, cx| {
                    let view = fetch.await.flatten();
                    control.update(cx, |control, cx| {
                        control.usage_loaded(&session, &revision, view, cx);
                    });
                })
                .detach();
            }
            ComposerContextEvent::LoadQuota { provider_id } => {
                let provider = provider_id.clone();
                let requested = provider.clone();
                let fetch = Jobs::run(cx, move |client| async move {
                    load_quota(&client, &requested).await
                });
                let control = self.context_control.clone();
                cx.spawn(async move |_, cx| {
                    let quota = fetch.await.flatten();
                    control.update(cx, |control, cx| {
                        control.quota_loaded(&provider, quota, cx);
                    });
                })
                .detach();
            }
            ComposerContextEvent::OpenChanged(open) => {
                let open = *open;
                ComposerState::update(cx, |draft| draft.context_popover_open = open);
                cx.notify();
            }
            ComposerContextEvent::OpenUsageSettings => cx.emit(ComposerEvent::OpenUsageSettings),
        }
    }
}
