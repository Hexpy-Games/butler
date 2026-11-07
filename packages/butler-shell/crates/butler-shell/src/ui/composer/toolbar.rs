//! `ComposerToolbar` and `ComposerCompactPreview`: the attach, mode and model controls, the
//! send/stop button and the folded one-line preview.
use butler_ds::ui::blocks::composer_card::{
    CompactPreview, ExpandedControls, SendButton, SendMode, Toolbar, ToolbarSpacer,
};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::tooltip::Tooltip;
use gpui::{AnyElement, ClickEvent, Context, IntoElement, ParentElement as _, SharedString};
use gpui::{Styled as _, div};

use super::{Composer, ComposerEvent, Submit};

/// `agentNotice` of the store: why the agent cannot take messages right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AgentNotice {
    Stopped,
    Restarting,
    Reset,
    RestartFailed,
}

/// The controls the menus, the context donut and the attachments own. Each is `None` until
/// the owning unit's entry is wired.
#[derive(Default)]
pub(super) struct ToolbarSlots {
    /// `ComposerAttachmentMenu`.
    pub(super) attach: Option<AnyElement>,
    /// `AccessModeMenu`.
    pub(super) access: Option<AnyElement>,
    /// `ComposerWorkspaceSelect`.
    pub(super) workspace: Option<AnyElement>,
    /// `ComposerPlanModeBadge`.
    pub(super) plan: Option<AnyElement>,
    /// `ComposerContextControl`.
    pub(super) context: Option<AnyElement>,
    /// `ModelMenu`.
    pub(super) model: Option<AnyElement>,
}

/// `appCopy.composer` and `appCopy.feedback` strings the toolbar reads.
struct Words {
    reconnecting: &'static str,
    agent_stopped: &'static str,
    agent_restarting: &'static str,
    agent_restart_failed: &'static str,
    agent_reset: &'static str,
}

const KO: Words = Words {
    reconnecting: "실시간 연결 복구 중",
    agent_stopped: "에이전트 중지됨",
    agent_restarting: "재시작 중",
    agent_restart_failed: "에이전트 재시작 실패",
    agent_reset: "버틀러를 초기화했습니다",
};

const EN: Words = Words {
    reconnecting: "Reconnecting to live updates",
    agent_stopped: "Agent stopped",
    agent_restarting: "Restarting",
    agent_restart_failed: "Agent restart failed",
    agent_reset: "Butler was reset",
};

fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

/// `agentNoticeLabel`.
fn notice_label(lang: Lang, notice: AgentNotice) -> &'static str {
    let words = words(lang);
    match notice {
        AgentNotice::Stopped => words.agent_stopped,
        AgentNotice::Restarting => words.agent_restarting,
        AgentNotice::Reset => words.agent_reset,
        AgentNotice::RestartFailed => words.agent_restart_failed,
    }
}

impl Composer {
    /// The draft has something to send.
    fn has_draft(&self, cx: &Context<Self>) -> bool {
        !self.input.read(cx).as_str().trim().is_empty()
    }

    /// `ComposerCompactPreview`: the folded composer's one line, the draft or the placeholder.
    fn compact_preview(&self, cx: &mut Context<Self>) -> AnyElement {
        let draft = self.input.read(cx).as_str().trim().to_owned();
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
        let sendable = self.has_draft(cx) && self.disabled.is_none() && !self.streaming;
        let id = "send-button";
        let button = if let Some(notice) = self.agent_notice {
            let button = SendButton::new(id).disabled();
            if notice == AgentNotice::Restarting {
                button.busy()
            } else {
                button.disabled_reason(notice_label(lang, notice))
            }
        } else if self.reconnecting {
            SendButton::new(id).busy()
        } else if self.streaming && !sendable {
            SendButton::new(id)
                .mode(SendMode::Stop)
                .on_click(cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(ComposerEvent::Stop)))
        } else {
            // TODO(integration: composer state): send while a turn runs queues the message
            // (`useComposerQueue`); until then a running turn offers only stop.
            let mut button = SendButton::new(id).on_click(
                cx.listener(|this, _: &ClickEvent, window, cx| this.submit(&Submit, window, cx)),
            );
            if !sendable {
                button = button.disabled();
            }
            match self.send_blocked.clone() {
                Some(reason) => button.disabled_reason(reason),
                None => button,
            }
        };
        let button = crate::ui::widgets::anchor(div().flex_none(), "send-button").child(button);
        let expanded_only =
            self.agent_notice.is_none() && !self.reconnecting && !(self.streaming && !sendable);
        if expanded_only {
            // The send button shows with the expanded controls only.
            return ExpandedControls::new().child(button).into_any_element();
        }
        button.into_any_element()
    }

    /// `ComposerToolbar`.
    pub(super) fn toolbar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = Ds::get(cx).lang();
        let slots = self.control_slots(cx);
        let mut controls = ExpandedControls::new();
        for control in [slots.access, slots.workspace, slots.plan]
            .into_iter()
            .flatten()
        {
            controls = controls.child(control);
        }
        controls = controls.child(ToolbarSpacer);
        for control in [slots.context, slots.model].into_iter().flatten() {
            controls = controls.child(control);
        }
        Toolbar::new()
            .children(slots.attach)
            .child(self.compact_preview(cx))
            .child(controls)
            .child(self.send_slot(lang, cx))
    }

    /// The menu, context and attachment controls.
    fn control_slots(&mut self, _cx: &mut Context<Self>) -> ToolbarSlots {
        // TODO(integration: menus, context, attachments): `ComposerAttachmentMenu`,
        // `AccessModeMenu`, `ComposerWorkspaceSelect`, `ComposerPlanModeBadge`,
        // `ComposerContextControl` and `ModelMenu` entries of the SW20-SW22 units.
        ToolbarSlots::default()
    }
}
