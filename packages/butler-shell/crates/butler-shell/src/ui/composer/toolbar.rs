//! `ComposerToolbar` and `ComposerCompactPreview`: the attach, mode and model controls, the
//! send/stop button and the folded one-line preview.
use butler_ds::ui::blocks::composer_card::{
    CompactPreview, ExpandedControls, SendButton, SendMode, Toolbar, ToolbarSpacer,
};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::tooltip::Tooltip;
use gpui::{
    AnyElement, ClickEvent, Context, IntoElement, ParentElement as _, SharedString, Window,
};
use gpui::{Styled as _, div};

use super::state::{ComposerState, image_refusal_label};
use super::{Composer, ComposerEvent, Submit};
use crate::ui::i18n::composer::words;

/// The controls the menus, the context donut and the attachments own.
pub(super) struct ToolbarSlots {
    /// `ComposerAttachmentMenu`.
    pub(super) attach: AnyElement,
    /// `AccessModeMenu`.
    pub(super) access: AnyElement,
    /// `ComposerWorkspaceSelect`; none unless a new chat can use a worktree.
    pub(super) workspace: Option<AnyElement>,
    /// `ComposerPlanModeBadge`; none unless plan mode is on.
    pub(super) plan: Option<AnyElement>,
    /// `ComposerContextControl`.
    pub(super) context: AnyElement,
    /// `ModelMenu`.
    pub(super) model: AnyElement,
}

impl Composer {
    /// `ComposerCompactPreview`: the folded composer's one line, the draft or the placeholder.
    fn compact_preview(&self, cx: &mut Context<Self>) -> AnyElement {
        let draft = ComposerState::read(cx, |draft| draft.text.trim().to_owned());
        let empty = draft.is_empty();
        let line: SharedString = if empty {
            self.placeholder.into()
        } else {
            draft.into()
        };
        let mut preview = CompactPreview::new("compact-preview", line);
        if empty {
            preview = preview.empty();
        }
        match self.disabled.clone() {
            // Disabled, it says why on hover and does not engage.
            Some(reason) => Tooltip::new("compact-preview-reason")
                .label(reason)
                .child(preview)
                .into_any_element(),
            None => preview
                .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.engage(window, cx)))
                .into_any_element(),
        }
    }

    /// The send, stop or busy button, by the same order as `ComposerToolbar`.
    fn send_slot(&self, lang: Lang, cx: &mut Context<Self>) -> AnyElement {
        let (send, blocked) = ComposerState::read(cx, |draft| {
            (
                draft.send.clone(),
                draft.blocked_attachments.values().next().copied(),
            )
        });
        let sendable = send.can_send && self.disabled.is_none();
        let id = "send-button";
        let button = if let Some(reason) = self.disabled.clone() {
            SendButton::new(id).disabled().disabled_reason(reason)
        } else if self.inputs.reconnecting {
            SendButton::new(id)
                .busy()
                .disabled_reason(words(lang).reconnecting)
        } else if send.active_turn && send.can_stop && !send.can_send {
            SendButton::new(id)
                .mode(SendMode::Stop)
                .on_click(cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(ComposerEvent::Stop)))
        } else {
            let mut button = SendButton::new(id).on_click(
                cx.listener(|this, _: &ClickEvent, window, cx| this.submit(&Submit, window, cx)),
            );
            if !sendable {
                button = button.disabled();
            }
            match blocked {
                Some(refusal) => button.disabled_reason(image_refusal_label(refusal, lang)),
                None => button,
            }
        };
        let button = crate::ui::widgets::anchor(div().flex_none(), "send-button").child(button);
        let expanded_only = self.disabled.is_none()
            && !self.inputs.reconnecting
            && !(send.active_turn && send.can_stop && !send.can_send);
        if expanded_only {
            // The send button shows with the expanded controls only.
            return ExpandedControls::new().child(button).into_any_element();
        }
        button.into_any_element()
    }

    /// `ComposerToolbar`.
    pub(super) fn toolbar(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let lang = Ds::get(cx).lang();
        let slots = self.control_slots(window, cx);
        let mut controls = ExpandedControls::new().child(slots.access);
        for control in [slots.workspace, slots.plan].into_iter().flatten() {
            controls = controls.child(control);
        }
        controls = controls
            .child(ToolbarSpacer)
            .child(slots.context)
            .child(slots.model);
        Toolbar::new()
            .child(slots.attach)
            .child(self.compact_preview(cx))
            .child(controls)
            .child(self.send_slot(lang, cx))
    }
}
