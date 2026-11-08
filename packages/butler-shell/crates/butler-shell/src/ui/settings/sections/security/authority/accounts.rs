//! The connected accounts (`ConnectedAccountRows.tsx`, `useConnectedAccounts.ts`,
//! `securityApi.ts` oauth): the ChatGPT sign-ins, listed and removed through the admin routes.
//! `Error::LocalMetadata` (no admin credential) reads as a failed load, as in React.
use butler_ds::ui::blocks::list_row::ListRow;
use butler_ds::ui::blocks::settings_section::{
    SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::icon::IconSize;
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::toast::{Toast, ToastId};
use butler_ds::ui::tooltip::Tooltip;
use butler_shell_client::Error;
use gpui::prelude::FluentBuilder as _;
use gpui::{
    AnyElement, Context, IntoElement as _, ParentElement as _, SharedString, Styled as _, div,
};
use serde::Deserialize;
use serde_json::Value;

use super::copy::Words;
use super::{SecurityAuthority, announce, dates, glyph, missing_route};
use crate::ui::Icon;
use crate::ui::settings::confirm::Request;
use crate::ui::settings::state::{Load, fetch};

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Kind {
    SignIn,
    LegacySignIn,
}

/// `OauthCredential`: the public inventory; tokens stay in the agent.
#[derive(Deserialize)]
pub(super) struct Account {
    id: String,
    kind: Kind,
    label: Option<String>,
    obtained_at: Option<f64>,
    expires_at: Option<f64>,
}

#[derive(Deserialize)]
struct Reply {
    credentials: Vec<Account>,
}

pub(super) struct Accounts {
    list: Load<Vec<Account>>,
    /// An agent without the route: the section stays hidden.
    pub(super) unsupported: bool,
    busy: bool,
    toast: Option<ToastId>,
}

impl Default for Accounts {
    fn default() -> Self {
        Self {
            list: Load::Loading,
            unsupported: false,
            busy: false,
            toast: None,
        }
    }
}

impl Account {
    /// The legacy sign-in has no name of its own.
    fn name(&self, words: &Words) -> String {
        match (&self.kind, &self.label) {
            (Kind::SignIn, Some(label)) => label.clone(),
            _ => words.provider.to_owned(),
        }
    }

    /// `accountMeta`
    fn meta(&self, words: &Words) -> String {
        let lang = words.lang();
        #[expect(clippy::cast_possible_truncation, reason = "epoch seconds")]
        let date = |seconds: Option<f64>, template: &str| {
            seconds.map(|seconds| Words::fill(template, &dates::short(seconds as i64, lang)))
        };
        [
            date(self.obtained_at, words.obtained),
            date(self.expires_at, words.expires),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ")
    }
}

impl SecurityAuthority {
    /// `useConnectedAccounts.load`
    pub(super) fn load_accounts(&mut self, quiet: bool, cx: &mut Context<Self>) {
        if !quiet {
            self.accounts.list = Load::Loading;
        }
        fetch(
            cx,
            |client| async move { client.list_oauth_credentials().await },
            move |this: &mut Self, result: Result<Reply, Error>, _| match result {
                Ok(reply) => {
                    this.accounts.unsupported = false;
                    this.accounts.list = Load::Ready(reply.credentials);
                }
                Err(error) => {
                    this.accounts.unsupported = missing_route(&error);
                    this.accounts.list = Load::Failed;
                }
            },
        );
    }

    /// `useConnectedAccounts.remove`: asks first. The chat sign-in views re-read the account
    /// through `chatGptEvents` in React (F4); here the catalog reloads.
    fn sign_out(&mut self, id: &str, cx: &mut Context<Self>) {
        let Load::Ready(list) = &self.accounts.list else {
            return;
        };
        let Some(account) = list.iter().find(|account| account.id == id) else {
            return;
        };
        if self.accounts.busy {
            return;
        }
        let words = Self::words(cx);
        let name = account.name(words);
        let request = Request::new(Words::fill(words.sign_out_confirm, &name))
            .title(words.sign_out)
            .confirm_label(words.sign_out)
            .destructive();
        let (this, id) = (cx.entity(), id.to_owned());
        self.ctx.confirm(
            request,
            move |_, cx| this.update(cx, |this, cx| this.run_sign_out(id, cx)),
            cx,
        );
    }

    fn run_sign_out(&mut self, id: String, cx: &mut Context<Self>) {
        self.accounts.busy = true;
        cx.notify();
        fetch(
            cx,
            move |client| async move { client.remove_oauth_credential(&id).await },
            move |this: &mut Self, result: Result<Value, Error>, cx| {
                this.accounts.busy = false;
                let words = Self::words(cx);
                let toast = match result {
                    Ok(reply) if reply.get("revoked").and_then(Value::as_bool) == Some(false) => {
                        Toast::success(words.revoke_unconfirmed)
                    }
                    Ok(_) => Toast::success(words.signed_out),
                    Err(_) => Toast::error(words.sign_out_error),
                };
                announce(&mut this.accounts.toast, toast, cx);
                this.load_accounts(true, cx);
                this.ctx.reload_catalog(cx);
            },
        );
    }

    pub(super) fn accounts_section(&mut self, cx: &mut Context<Self>) -> SettingsSection {
        let words = Self::words(cx);
        let state = self.accounts.list.state(std::vec::Vec::is_empty);
        let this = cx.entity();
        let mut section = SettingsSection::new(
            "connected-accounts",
            SettingsSectionKind::List,
            words.accounts_title,
        )
        .state(state)
        .empty_message(words.accounts_empty)
        .on_retry(move |_, _, cx| this.update(cx, |this, cx| this.load_accounts(false, cx)));
        if let (SettingsSectionState::Ready, Load::Ready(accounts)) = (state, &self.accounts.list) {
            for account in accounts {
                section = section.child(self.account_row(account, cx));
            }
        }
        section
    }

    /// `ConnectedAccountRows`: the account, and its Sign out button.
    fn account_row(&self, account: &Account, cx: &mut Context<Self>) -> AnyElement {
        let words = Self::words(cx);
        let name = account.name(words);
        let kind = words.account_kinds[usize::from(account.kind == Kind::LegacySignIn)];
        let row = ListRow::new(name.clone())
            .icon(glyph(cx, Icon::UserRound, IconSize::Md))
            .description(kind)
            .meta(account.meta(words));
        let label = Words::fill(words.sign_out_of, &name);
        let (this, id) = (cx.entity(), account.id.clone());
        let button = Button::new(SharedString::from(format!("account-sign-out-{id}")))
            .variant(Variant::Outline)
            .size(Size::Sm)
            .text(words.sign_out)
            .when(self.accounts.busy, Button::disabled)
            .on_click({
                let id = id.clone();
                move |_, _, cx| this.update(cx, |this, cx| this.sign_out(&id, cx))
            });
        let tip = if self.accounts.busy {
            words.working.to_owned()
        } else {
            label
        };
        Stack::row()
            .cross(Cross::Center)
            .gap(Space::Sm)
            .wrap(true)
            .child(div().flex_1().min_w_0().child(row))
            .child(
                Tooltip::new(SharedString::from(format!("account-sign-out-tip-{id}")))
                    .label(tip)
                    .child(button),
            )
            .into_any_element()
    }
}
