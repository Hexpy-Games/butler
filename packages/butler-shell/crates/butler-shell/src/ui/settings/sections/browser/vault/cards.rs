//! Section `payment-methods` (`VaultCardsSection.tsx`, `VaultCardForm.tsx`): masked cards and
//! the sites each fills without asking. A number shows only after the system asks the owner.
use butler_ds::ui::blocks::card_list::CardListItem;
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::tag::{Size as TagSize, Tag, Tone as TagTone};
use gpui::{AnyElement, Context, Entity, IntoElement as _, ParentElement as _, SharedString};

use super::copy::{Words, words};
use super::form::{self, FormId, item_menu, reveal_button, secret_input, with_extra};
use super::model::{VaultCard, grouped};
use super::sites::sites_field;
use super::{BrowserVault, Kind, Target};
use crate::ui::Icon;
use crate::ui::settings::state::Load;

impl BrowserVault {
    /// Section `payment-methods`.
    pub(super) fn cards_section(&mut self, cx: &mut Context<Self>) -> SettingsSection {
        let copy = words(Ds::get(cx).lang());
        let this = cx.entity();
        let busy = self.vault_busy.is_some();
        let available = matches!(&self.vault, Load::Ready(view) if view.available);
        let editing = self.card_form.clone();
        let adding = editing == Some(Target::New);
        let add = form::add_button(
            "vault-card-add",
            copy,
            available,
            available && editing.is_none(),
            Ds::get(cx),
            cx.listener(|this, _, _, cx| this.open_form(Kind::Cards, Target::New, cx)),
        );
        let mut section = SettingsSection::new(
            "payment-methods",
            SettingsSectionKind::List,
            copy.title_payment_methods,
        )
        .state(self.vault.state(|view| view.cards.is_empty() && !adding))
        .empty_message(copy.empty_cards)
        .on_retry(cx.listener(|_, _, _, cx| Self::reload_vault(cx)))
        .actions(add);
        if adding {
            section = section.child(self.card_form_view(None, &this, busy, copy, cx));
        }
        if let Load::Ready(view) = &self.vault {
            for card in &view.cards {
                let editing_this = editing == Some(Target::Item(card.id.clone()));
                section = section.child(if editing_this {
                    self.card_form_view(Some(card), &this, busy, copy, cx)
                        .into_any_element()
                } else {
                    self.card_row(card, &this, copy, cx)
                });
            }
        }
        section
    }

    /// `VaultCardForm`: secret fields start empty; on a change, empty keeps the saved value.
    fn card_form_view(
        &self,
        card: Option<&VaultCard>,
        this: &Entity<Self>,
        busy: bool,
        copy: &'static Words,
        cx: &mut Context<Self>,
    ) -> Stack {
        let draft = &self.drafts[FormId::Card as usize];
        let existing = card.is_some();
        let secret = |label: &str| {
            if existing {
                format!("{label} · {}", copy.keep_secret)
            } else {
                label.to_owned()
            }
        };
        let number_hint = card.map_or_else(
            || copy.card_number.to_owned(),
            |card| format!("•••• {} · {}", card.last4, copy.keep_secret),
        );
        let field = |key, hint: &str| form::input(this, FormId::Card, draft, key, hint.to_owned());
        let secret_field = |key, hint: String| secret_input(this, FormId::Card, draft, key, hint);
        let expiry_and_cvc = form::pair(
            "vault-card-expiry",
            false,
            field("expiry", copy.expiry),
            secret_field("cvc", secret(copy.cvc)),
        );
        let id = card.map(|card| card.id.clone());
        let buttons = form::form_buttons(
            "vault-card-form",
            copy,
            draft.card_ready(existing) && !busy,
            cx.listener(|this, _, _, cx| {
                this.card_form = None;
                cx.notify();
            }),
            cx.listener(move |this, _, _, cx| this.save_item(Kind::Cards, id.clone(), cx)),
        );
        Stack::new()
            .gap(Space::Sm)
            .child(field("nickname", copy.nickname))
            .child(secret_field("number", number_hint))
            .child(expiry_and_cvc)
            .child(field("holder", copy.holder_name))
            .child(secret_field("pin2", secret(copy.pin2)))
            .child(secret_field("owner_id", secret(copy.owner_id)))
            .child(buttons)
    }

    /// `VaultCardRow`
    fn card_row(
        &self,
        card: &VaultCard,
        this: &Entity<Self>,
        copy: &'static Words,
        cx: &Context<Self>,
    ) -> AnyElement {
        let reveal = self.revealed.get(&SharedString::from(card.id.clone()));
        let shown = reveal
            .and_then(|reveal| reveal.number.as_deref())
            .map(grouped);
        let revealing = reveal.is_some_and(|reveal| reveal.number.is_none());
        let revealable = matches!(&self.vault, Load::Ready(view) if view.reveal_available);
        let meta = shown
            .clone()
            .unwrap_or_else(|| format!("•••• {} · {}", card.last4, card.expiry()));
        let allowed = if card.sites.is_empty() {
            copy.ask_every_time.to_owned()
        } else {
            (copy.allowed_sites)(card.sites.len())
        };
        let description = [card.holder_name.as_str(), allowed.as_str()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" · ");
        let actions = Stack::row()
            .gap(Space::Xs)
            .cross(Cross::Center)
            .child(reveal_button(
                this,
                Kind::Cards,
                &card.id,
                (shown.is_some(), revealing, revealable),
                copy,
            ))
            .child(item_menu(this, Kind::Cards, &card.id, &card.nickname, copy));
        let item = CardListItem::new(
            SharedString::from(format!("vault-card-{}", card.id)),
            card.nickname.clone(),
        )
        .icon(icon(Icon::Lock, IconSize::Md, Ds::get(cx)))
        .meta(SharedString::from(meta))
        .description(description)
        .actions(actions);
        let (sites_this, id, before) = (this.clone(), card.id.clone(), card.sites.clone());
        let mut extra = Stack::new().gap(Space::Sm);
        if card.expired() {
            extra = extra.child(
                Stack::row().child(
                    Tag::new(format!("vault-card-expired-{}", card.id), copy.expired)
                        .size(TagSize::Sm)
                        .tone(TagTone::Warning),
                ),
            );
        }
        let sites = sites_field(
            format!("vault-card-sites-{}", card.id).into(),
            copy.site,
            &card.sites,
            copy,
            move |next, _, cx| {
                sites_this.update(cx, |this, cx| {
                    this.set_sites(Kind::Cards, id.clone(), before.clone(), next, cx);
                });
            },
        );
        with_extra(item, extra.child(sites))
    }
}
