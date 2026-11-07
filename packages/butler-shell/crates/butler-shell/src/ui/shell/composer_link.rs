//! The shell's side of the composer: what it tells the composer about the open chat, what it
//! does with the composer's events, and the handlers the composer installs once.
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use gpui::{Context, Entity, Window};

use super::{Shell, image_viewer};
use crate::ui::composer::queue::on_delete_queued;
use crate::ui::composer::{Composer, ComposerEvent, Inputs};
use crate::ui::i18n::composer::words;
use crate::ui::source::agent::Jobs;

impl Shell {
    /// What the composer needs of the open chat and the agent.
    fn composer_inputs(&self) -> Inputs {
        let chat = self.store.selected();
        let mut inputs = Inputs::from_summary(self.session_menu.summary.as_ref());
        inputs.connected = self.source.is_some() && !self.incompatible;
        inputs.chat_id = chat.map(|c| c.chat.0.to_string());
        inputs.session_id = chat.map(|c| c.session.0.to_string());
        inputs.project_id = chat
            .and_then(|c| self.store.summary(c))
            .and_then(|row| row.space.as_ref())
            .filter(|space| space.project)
            .map(|space| space.id.to_string());
        inputs.reconnecting = self.source.is_some() && self.attention.disconnected;
        inputs
    }

    /// Tells the composer about the chat; it acts only on what changed.
    pub(super) fn feed_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let inputs = self.composer_inputs();
        self.composer
            .update(cx, |composer, cx| composer.set_inputs(inputs, window, cx));
    }

    pub(super) fn on_composer(
        &mut self,
        _: &Entity<Composer>,
        event: &ComposerEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            ComposerEvent::Send(outgoing) => self.send(outgoing.text.clone(), cx),
            ComposerEvent::Stop => self.stop(cx),
            ComposerEvent::Answer(request, decision) => self.answer(request, decision.clone(), cx),
            ComposerEvent::Modify(card) => self.open_modify(card, window, cx),
            // Settings is not in the shell yet.
            ComposerEvent::OpenUsageSettings => {
                toast::show(cx, Toast::message(self.theme.strings.not_yet));
            }
        }
    }

    /// Shell init: the image viewer host, and what deletes a queued message that is loaded
    /// into the composer for editing.
    pub(super) fn install_composer(cx: &mut Context<Self>) {
        image_viewer::install(cx);
        on_delete_queued(cx, |id, cx| {
            let id = id.to_owned();
            let fetch = Jobs::run(cx, move |client| async move {
                client.delete_queued_message(&id).await
            });
            cx.spawn(async move |cx| {
                let deleted = fetch.await;
                cx.update(|cx| {
                    if matches!(deleted, Some(Err(_))) {
                        let lang = Ds::get(cx).lang();
                        toast::show(cx, Toast::error(words(lang).queue_failed));
                    }
                    crate::ui::chat::queue::queue_changed(cx);
                });
            })
            .detach();
        });
    }
}
