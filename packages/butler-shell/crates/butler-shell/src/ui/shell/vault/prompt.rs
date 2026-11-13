//! Electron `ButlerVaultPrompt.tsx`, mounted after the root confirmation dialog.
use super::{Vault, copy::words};
use crate::ui::settings::{SectionCtx, confirm};
use butler_ds::ui::{
    button::{Button, Variant},
    context::Ds,
    dialog::{Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle},
};
use gpui::{
    AnyElement, AppContext as _, Context, Entity, ParentElement as _, Subscription, Window,
    prelude::FluentBuilder as _,
};

pub(crate) struct Prompt {
    vault: Entity<Vault>,
    pub(crate) confirm: SectionCtx,
    existing: Option<bool>,
    offered: bool,
    open: bool,
    result: &'static str,
    _subscriptions: Vec<Subscription>,
}

impl Prompt {
    pub(crate) fn new(cx: &mut Context<Self>) -> Self {
        let vault = cx.new(Vault::new);
        let confirm = confirm::host(cx);
        let subscriptions = vec![
            cx.observe(&vault, |_, _, cx| cx.notify()),
            cx.observe(&confirm.state, |_, _, cx| cx.notify()),
        ];
        Self {
            vault,
            confirm,
            existing: None,
            offered: false,
            open: false,
            result: "intro",
            _subscriptions: subscriptions,
        }
    }

    pub(crate) fn dialog(
        &mut self,
        settings: Option<&serde_json::Value>,
        setup_visible: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if self.existing.is_none()
            && let Some(settings) = settings
        {
            self.existing = Some(
                settings
                    .pointer("/onboarding/completed_at")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|value| !value.is_empty()),
            );
        }
        if !self.offered
            && self.existing == Some(true)
            && !setup_visible
            && self.vault.read(cx).offered()
        {
            self.offered = true;
            self.open = true;
        }
        if !self.open || setup_visible {
            return None;
        }
        let copy = words(Ds::get(cx).lang());
        let description = match self.result {
            "done" => copy.done,
            "failed" => copy.failed,
            _ => copy.intro,
        };
        let content = DialogContent::new()
            .show_close_button(false)
            .header(
                DialogHeader::new()
                    .child(DialogTitle::new(copy.name))
                    .child(DialogDescription::new(description)),
            )
            .footer(self.footer(cx));
        let weak = cx.entity().downgrade();
        Some(
            Dialog::new("butler-vault-prompt", window, cx)
                .open(true)
                .on_open_change(move |open, _, cx| {
                    if !open {
                        let _ = weak.update(cx, |this, cx| {
                            this.open = false;
                            cx.notify();
                        });
                    }
                })
                .content(content, window, cx),
        )
    }

    fn footer(&self, cx: &mut Context<Self>) -> DialogFooter {
        let copy = words(Ds::get(cx).lang());
        let busy = self.vault.read(cx).busy;
        let done = self.result == "done";
        let mut footer = DialogFooter::new();
        if !done {
            footer = footer.child(
                Button::new("butler-vault-skip")
                    .text(copy.skip)
                    .variant(Variant::Secondary)
                    .when(busy, Button::disabled)
                    .on_click(cx.listener(|this, _, _, cx| {
                        let weak = cx.entity().downgrade();
                        Vault::decline(
                            &this.vault,
                            &this.confirm,
                            Ds::get(cx).lang(),
                            move |ok, cx| {
                                if ok {
                                    let _ = weak.update(cx, |this, cx| {
                                        this.open = false;
                                        cx.notify();
                                    });
                                }
                            },
                            cx,
                        );
                    })),
            );
        }
        footer.child(
            Button::new("butler-vault-continue")
                .text(copy.continue_)
                .when(busy, Button::disabled)
                .on_click(cx.listener(move |this, _, _, cx| {
                    if done {
                        this.open = false;
                        cx.notify();
                        return;
                    }
                    let weak = cx.entity().downgrade();
                    this.vault.update(cx, |vault, cx| {
                        vault.enable(
                            move |ok, cx| {
                                let _ = weak.update(cx, |this, cx| {
                                    this.result = if ok { "done" } else { "failed" };
                                    cx.notify();
                                });
                            },
                            cx,
                        );
                    });
                })),
        )
    }
}

impl super::super::Shell {
    pub(crate) fn new_vault_prompt(
        subscriptions: &mut Vec<Subscription>,
        cx: &mut Context<Self>,
    ) -> Entity<Prompt> {
        let prompt = cx.new(Prompt::new);
        subscriptions.push(cx.observe(&prompt, |_, _, cx| cx.notify()));
        prompt
    }

    /// Electron `AppDialogs.tsx`: vault and its confirmation remain root dialogs.
    pub(crate) fn vault_dialogs(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> (Option<AnyElement>, Option<AnyElement>) {
        let visible = self.onboarding.gate != crate::ui::onboarding::gate::Gate::Workspace
            || self.onboarding.shows();
        let prompt = self.vault_prompt.update(cx, |prompt, cx| {
            prompt.dialog(self.settings_raw.as_deref(), visible, window, cx)
        });
        let state = self.vault_prompt.read(cx).confirm.state.clone();
        (prompt, confirm::dialog(&state, window, cx))
    }
}
