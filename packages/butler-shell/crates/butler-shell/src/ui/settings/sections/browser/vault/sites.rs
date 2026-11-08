//! `VaultSitesField` and the purchase-sites section (`BrowserVaultSections.tsx`).
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::blocks::tag_field::TagField;
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{App, Context, ParentElement as _, SharedString, Window};

use super::BrowserVault;
use super::copy::{Words, words};
use crate::ui::settings::state::Load;

/// Sites where a saved item (or a purchase) goes without asking. Typing a site adds it.
pub(super) fn sites_field(
    id: SharedString,
    label: &str,
    sites: &[String],
    copy: &'static Words,
    on_change: impl Fn(Vec<String>, &mut Window, &mut App) + 'static,
) -> Stack {
    let tags = sites.iter().cloned().map(SharedString::from).collect();
    Stack::new()
        .gap(Space::Xs)
        .child(Typo::caption(label.to_owned()).tone(Tone::Secondary))
        .child(
            TagField::new(id, label.to_owned())
                .value(tags, move |next, window, cx| {
                    on_change(
                        next.into_iter().map(|site| site.to_string()).collect(),
                        window,
                        cx,
                    );
                })
                .placeholder(copy.site_placeholder)
                .remove_label(move |site| (copy.remove_site)(site).into())
                .create_label(move |name| format!("{} · {name}", copy.add_site).into())
                .max_length(253),
        )
}

impl BrowserVault {
    /// Section `purchase-sites`: the sites where a purchase needs no final card.
    pub(super) fn purchase_sites_section(&mut self, cx: &mut Context<Self>) -> SettingsSection {
        let copy = words(Ds::get(cx).lang());
        let this = cx.entity();
        let sites = match &self.vault {
            Load::Ready(view) => view.purchase_sites.clone(),
            _ => Vec::new(),
        };
        let label = if sites.is_empty() {
            copy.empty_purchase_sites
        } else {
            copy.title_purchase_sites
        };
        let before = sites.clone();
        let field = sites_field(
            "vault-purchase-sites".into(),
            label,
            &sites,
            copy,
            move |next, _, cx| {
                this.update(cx, |this, cx| {
                    this.set_purchase_sites(before.clone(), next, cx);
                });
            },
        );
        SettingsSection::new(
            "purchase-sites",
            SettingsSectionKind::Form,
            copy.title_purchase_sites,
        )
        .state(self.vault.state(|_| false))
        .on_retry(cx.listener(|_, _, _, cx| Self::reload_vault(cx)))
        .child(Stack::new().gap(Space::Sm).child(field))
    }
}
