//! Security: approved actions, saved keys and connected accounts
//! (`SecurityAuthoritySections.tsx`). The security page (U14) holds this entity, observes it,
//! and places the sections it returns after the paired devices.
//!
//! Skipped live refresh (F4): `authorityPermissionEvents` (approvals), `chatGptEvents` (the
//! account change published after a sign-out). The lists load on open and after each action.
mod accounts;
mod copy;
mod dates;
mod grants;
mod grants_view;
mod keys;
mod keys_view;

use butler_ds::ui::blocks::settings_section::SettingsSection;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::toast::{self, Toast, ToastId};
use butler_shell_client::Error;
use gpui::{AnyElement, App, Context, IntoElement as _, Window};

use crate::ui::Icon;
use crate::ui::settings::SectionCtx;

use self::copy::Words;

/// `SecurityAuthoritySections`
pub(crate) struct SecurityAuthority {
    ctx: SectionCtx,
    grants: grants::Grants,
    keys: keys::Keys,
    accounts: accounts::Accounts,
}

impl SecurityAuthority {
    pub(crate) fn new(ctx: SectionCtx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let _ = window;
        let mut this = Self {
            ctx,
            grants: grants::Grants::default(),
            keys: keys::Keys::default(),
            accounts: accounts::Accounts::default(),
        };
        this.load_grants(false, cx);
        this.load_keys(false, cx);
        this.load_accounts(false, cx);
        this
    }

    /// grants, saved-keys, connected-accounts, in schema order. The keys and accounts sections
    /// are absent on an agent without their routes.
    pub(crate) fn sections(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<SettingsSection> {
        let _ = window;
        let mut sections = vec![self.grants_section(cx)];
        if !self.keys.unsupported {
            sections.push(self.keys_section(cx));
        }
        if !self.accounts.unsupported {
            sections.push(self.accounts_section(cx));
        }
        sections
    }

    fn words(cx: &App) -> &'static Words {
        Words::of(Ds::get(cx).lang())
    }
}

/// `isMissingRoute`: the agent has no such route.
fn missing_route(error: &Error) -> bool {
    matches!(error, Error::Http(404) | Error::Incompatible)
}

/// A DS icon at a token size.
fn glyph(cx: &App, glyph: Icon, size: IconSize) -> AnyElement {
    icon(glyph, size, Ds::get(cx)).into_any_element()
}

/// `notifyStatus` / `notifyError`: with an `id`, a new toast takes the place of the last one.
fn announce(slot: &mut Option<ToastId>, toast: Toast, cx: &mut App) {
    let toast = match *slot {
        Some(id) => toast.id(id),
        None => toast,
    };
    *slot = Some(toast::show(cx, toast));
}
