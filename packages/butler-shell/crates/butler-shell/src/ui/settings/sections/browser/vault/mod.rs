//! Browser: sign-ins, payment methods, profiles and purchase sites (`SecuritySignInsSection.tsx`,
//! `BrowserVaultSections.tsx`, `useSignIns.ts`, `useVault.ts`). U12 calls [`BrowserVault::sections`]
//! between site data and import. Secrets pass from the field to the request and are neither
//! logged nor kept; a revealed number is held for 20 seconds, then dropped.
mod actions;
mod cards;
mod copy;
mod form;
mod model;
mod profiles;
mod sign_ins;
mod sites;

use std::collections::HashMap;

use butler_ds::ui::blocks::settings_section::SettingsSection;
use gpui::{Context, SharedString, Window};

use self::form::{Form, FormId};
use self::model::{SignInsView, VaultView};
use crate::ui::settings::SectionCtx;
use crate::ui::settings::state::Load;

/// The add/edit form a list section shows: a new item or the item with this id.
#[derive(Clone, PartialEq)]
pub(super) enum Target {
    New,
    Item(String),
}

/// A number the owner asked to see: `None` while the system asks, then the number.
struct Reveal {
    number: Option<String>,
    epoch: u64,
}

/// `BrowserVaultSections` and the sign-ins section.
pub(crate) struct BrowserVault {
    ctx: SectionCtx,
    sign_ins: Load<SignInsView>,
    vault: Load<VaultView>,
    /// `useSignIns().busy` / `useVault().busy`: the key of the action running.
    sign_in_busy: Option<SharedString>,
    vault_busy: Option<SharedString>,
    adding_sign_in: bool,
    card_form: Option<Target>,
    profile_form: Option<Target>,
    /// Drafts of the sign-in, card and profile forms, by [`FormId`].
    drafts: [Form; 3],
    revealed: HashMap<SharedString, Reveal>,
    epoch: u64,
}

impl BrowserVault {
    pub(crate) fn new(ctx: SectionCtx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let _ = window;
        let this = Self {
            ctx,
            sign_ins: Load::Loading,
            vault: Load::Loading,
            sign_in_busy: None,
            vault_busy: None,
            adding_sign_in: false,
            card_form: None,
            profile_form: None,
            drafts: Default::default(),
            revealed: HashMap::new(),
            epoch: 0,
        };
        Self::reload_sign_ins(cx);
        Self::reload_vault(cx);
        this
    }

    /// sign-ins, payment-methods, profiles, purchase-sites, in schema order.
    pub(crate) fn sections(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<SettingsSection> {
        let _ = window;
        vec![
            self.sign_ins_section(cx),
            self.cards_section(cx),
            self.profiles_section(cx),
            self.purchase_sites_section(cx),
        ]
    }

    /// `signIns.view?.available === true`: import from another browser needs the same keychain.
    pub(crate) fn keychain_available(&self) -> bool {
        matches!(&self.sign_ins, Load::Ready(view) if view.available)
    }

    fn form_mut(&mut self, form: FormId) -> &mut Form {
        &mut self.drafts[form as usize]
    }
}

/// The kind of a vault item (`VaultKind`).
#[derive(Clone, Copy)]
pub(super) enum Kind {
    Cards,
    Profiles,
}
