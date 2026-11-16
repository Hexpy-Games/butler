//! The editor and the composer state (`saveDraftFromEditor`, `syncEditorFromStore`,
//! `composerFocus`), and the context donut's inputs and requests.
use butler_ds::ui::popover::Popover;
use gpui::{Context, Entity, FocusHandle, Focusable as _, Subscription, Window};

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

    /// The settings' `collapse_message_box` (`useComposerPresentation`: `!collapse` keeps the
    /// card unfolded).
    pub(crate) fn set_collapse(&mut self, collapse: bool, cx: &mut Context<Self>) {
        if self.collapse != collapse {
            self.collapse = collapse;
            cx.notify();
        }
    }

    /// `focusComposer`: expands the card and puts the caret back where it was.
    pub(crate) fn engage(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.disabled.is_some() {
            return;
        }
        self.release_focus = false;
        self.fold.engaged = true;
        self.editor.focus(FocusPlacement::Restore, window, cx);
        cx.notify();
    }

    pub(crate) fn fold(&mut self) {
        self.fold.engaged = false;
    }

    /// A chat opened. Electron rebuilds the editor per chat (`Conversation.tsx`
    /// `<ErrorBoundary key={activeChatId}>`), so the card folds and no focus, kept or restored
    /// later (a closing dialog's focus scope), stays in the field.
    pub(crate) fn chat_opened(&mut self, cx: &mut Context<Self>) {
        self.fold.engaged = false;
        self.release_focus = true;
        cx.notify();
    }

    /// While a chat opening asks for it, the focused field hands focus to the shell root.
    pub(super) fn release(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.release_focus
            && self.focus_handle(cx).is_focused(window)
            && let Some(shell) = self.shell_focus.clone()
        {
            self.release_focus = false;
            window.focus(&shell, cx);
        }
    }

    /// `focusComposer`: the request of `ComposerState::request_focus` is taken once; a request
    /// wins over a pending release.
    pub(super) fn take_focus_request(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let requested =
            ComposerState::update(cx, |draft| std::mem::take(&mut draft.focus_requested));
        if requested {
            self.release_focus = false;
        }
        self.release(window, cx);
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

/// The popovers of the toolbar; the composer stays expanded while one is open
/// (`protectedExpanded`).
const POPOVERS: [&str; 4] = [
    "composer-access-menu",
    "composer-model-menu",
    "composer-attachment-menu",
    "composer-documents-menu",
];

/// What keeps the card unfolded.
#[derive(Default)]
pub(super) struct Fold {
    /// The field has been engaged and no click outside has folded it.
    pub(super) engaged: bool,
    /// A toolbar popover is open.
    pub(super) protected: bool,
    /// A decision waits in the transcript (`decision.plan || .authority || .question`).
    pub(super) decision: bool,
}

impl Composer {
    /// `useComposerPresentation`'s `onFocusCapture` and `onBlurCapture`: focus entering the card
    /// engages it; focus leaving the card (not moving between its controls) folds it.
    pub(super) fn focus_listeners(
        field: &FocusHandle,
        within: &FocusHandle,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<Subscription> {
        vec![
            cx.on_blur(field, window, |this: &mut Self, window, cx| {
                this.editor.save_selection(window, cx);
            }),
            // Registered before the card's focus-in: a pending release moves focus out of the
            // card first, and the engage below then sees it gone. Focus resting on the
            // container fires no focus-in when it moves to the field, so the field engages.
            cx.on_focus(field, window, |this: &mut Self, window, cx| {
                this.release(window, cx);
                this.engage_by_focus(window, cx);
            }),
            cx.on_focus_in(within, window, |this: &mut Self, window, cx| {
                this.engage_by_focus(window, cx);
            }),
            // A focused control that goes away (a picked menu row, a removed chip, the card
            // folding) loses focus without a blur in Electron. Here the shell's focus-lost
            // fallback has already put focus on the container when this runs (`window.rs`
            // 3544-3565), and that is not leaving the card.
            cx.on_focus_out(within, window, |this: &mut Self, _, window, cx| {
                if !this.within.is_focused(window) {
                    this.fold.engaged = false;
                    cx.notify();
                }
            }),
        ]
    }

    /// Focus is on a control or the field inside the card (not resting on the container).
    fn engage_by_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.disabled.is_none()
            && self.within.contains_focused(window, cx)
            && !self.within.is_focused(window)
        {
            self.fold.engaged = true;
            cx.notify();
        }
    }

    /// A pointer pressed inside the card.
    pub(super) fn engage_by_pointer(&mut self, cx: &mut Context<Self>) {
        if self.disabled.is_none() {
            self.fold.engaged = true;
            cx.notify();
        }
    }

    /// A toolbar popover is open (the shot harness checks it).
    #[cfg(feature = "shots")]
    #[allow(dead_code, reason = "read by the shot harness (butler-shell-shots)")]
    pub(crate) fn menu_open(&self) -> bool {
        self.fold.protected
    }

    /// `useComposerPresentation`'s `protectedExpanded`.
    pub(super) fn popover_open(window: &mut Window, cx: &mut Context<Self>) -> bool {
        let popover = POPOVERS
            .iter()
            .any(|id| Popover::new(*id, window, cx).is_open(cx));
        // A session dragged over the composer keeps it open (`referenceDragging`).
        popover
            || cx.has_active_drag()
            || ComposerState::read(cx, |draft| draft.context_popover_open)
    }
}
