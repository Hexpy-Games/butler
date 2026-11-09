//! `conversationAt` (elementDrag.ts): a 서랍 card dropped on the composer card attaches to the
//! open chat.
use gpui::Context;

use super::Composer;
use crate::ui::manage::library::detail::{CardDrag, drop_cards_on_session};

impl Composer {
    /// `conversationAt`: library cards dropped on the composer card attach to the open chat.
    pub(super) fn drop_cards(&mut self, drag: &CardDrag, cx: &mut Context<Self>) {
        let (Some(ctx), Some(chat)) = (self.manage.clone(), self.inputs.chat_id.clone()) else {
            return;
        };
        drop_cards_on_session(&ctx, drag, &chat.into(), cx);
    }
}
