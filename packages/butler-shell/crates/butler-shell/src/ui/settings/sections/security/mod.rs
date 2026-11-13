//! Settings: Security (`SecuritySettings.tsx`, `useSecuritySettings.ts`): LAN access and remote
//! pairing (clients on this computer only), then the approved actions, keys and accounts that
//! U15 owns, then the allowed hosts under Advanced. React event bus skipped (F4):
//! `securityDeviceEvents` (the device list refreshes on load and after this page's own actions).
pub(crate) mod authority;
mod copy;
mod devices;
mod hosts;
mod pairing;
mod remote;

use butler_ds::ui::blocks::settings_section::{SettingsPage, SettingsSection};
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast, ToastId};
use butler_shell_client::Error;
use gpui::{
    AnyView, App, AppContext as _, Context, Entity, IntoElement, Render, Subscription, Window,
};
use serde_json::{Value, json};

use self::authority::SecurityAuthority;
use self::copy::words;
use crate::ui::i18n::settings::words as frame_words;
use crate::ui::settings::SectionCtx;
use crate::ui::settings::state::fetch;

struct SecurityPage {
    ctx: SectionCtx,
    authority: Entity<SecurityAuthority>,
    vault: Entity<crate::ui::shell::vault::Vault>,
    access: remote::Access,
    view: Option<remote::View>,
    /// `busy !== null`: a toggle or host save is running.
    busy: bool,
    advanced_open: bool,
    pairing: pairing::Pairing,
    devices: devices::Devices,
    hosts_draft: hosts::Draft,
    content_draft: hosts::Draft,
    /// The `settings-security` toast, replaced by the next one.
    toast: Option<ToastId>,
    _subscriptions: Vec<Subscription>,
}

pub(crate) fn page(ctx: SectionCtx, window: &mut Window, cx: &mut App) -> AnyView {
    cx.new(|cx| SecurityPage::new(ctx, window, cx)).into()
}

impl SecurityPage {
    fn new(ctx: SectionCtx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let vault = cx.new(crate::ui::shell::vault::Vault::new);
        cx.observe(&vault, |_, _, cx| cx.notify()).detach();
        let authority = cx.new(|cx| SecurityAuthority::new(ctx.clone(), window, cx));
        let subscriptions = vec![
            cx.observe(&ctx.state, |_, _, cx| cx.notify()),
            cx.observe(&authority, |_, _, cx| cx.notify()),
        ];
        let page = Self {
            ctx,
            authority,
            vault,
            access: remote::Access::Loading,
            view: None,
            busy: false,
            advanced_open: false,
            pairing: pairing::Pairing::default(),
            devices: devices::Devices::new(),
            hosts_draft: hosts::Draft::default(),
            content_draft: hosts::Draft::default(),
            toast: None,
            _subscriptions: subscriptions,
        };
        Self::refresh(cx);
        page
    }

    /// `notifyStatus` / `notifyError` with the shared `settings-security` id.
    fn notify(&mut self, next: Toast, cx: &mut Context<Self>) {
        let next = match self.toast {
            Some(id) => next.id(id),
            None => next,
        };
        self.toast = Some(toast::show(cx, next));
    }

    /// `run`: PATCH /settings with `security`. On success `applied` shows the new value, then
    /// the view is read again; a refusal replaces the page, any other failure is a toast.
    fn save(
        &mut self,
        security: &Value,
        applied: impl FnOnce(&mut Self) + 'static,
        cx: &mut Context<Self>,
    ) {
        self.busy = true;
        let body = json!({ "security": security });
        fetch(
            cx,
            move |client| async move { client.update_security_settings(&body).await },
            move |this: &mut Self, result: Result<Value, Error>, cx| {
                this.busy = false;
                match result {
                    Ok(_) => {
                        applied(this);
                        let saved = frame_words(Ds::get(cx).lang()).saved;
                        this.notify(Toast::success(saved), cx);
                        Self::refresh(cx);
                    }
                    Err(error) => match remote::refused(&error) {
                        Some(access) => this.access = access,
                        None => {
                            let failed = words(Ds::get(cx).lang()).update_failed;
                            this.notify(Toast::error(failed), cx);
                        }
                    },
                }
            },
        );
    }
}

impl Render for SecurityPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = words(Ds::get(cx).lang());
        let sections = self.authority.update(cx, |it, cx| it.sections(window, cx));
        let refused = matches!(
            self.access,
            remote::Access::AdminRequired | remote::Access::Failed
        );
        let mut leading: Vec<SettingsSection> =
            crate::ui::shell::vault::Vault::section(&self.vault, cx)
                .into_iter()
                .collect();
        leading.push(self.remote_section(copy, cx));
        if !refused && self.view.as_ref().is_some_and(|v| v.remote_access_enabled) {
            leading.push(self.pairing_section(copy, cx));
            leading.push(self.devices_section(copy, cx));
        }
        let advanced = if refused {
            None
        } else {
            self.advanced_section(copy, cx)
        };
        leading.into_iter().chain(sections).chain(advanced).fold(
            SettingsPage::new().labels(SectionCtx::labels(cx)),
            SettingsPage::section,
        )
    }
}
