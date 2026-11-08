//! Section `profiles` (`VaultProfilesSection.tsx`, `VaultProfileForm.tsx`): names and the fields
//! on file; identity numbers are never shown except by an explicit reveal.
use butler_ds::ui::blocks::card_list::CardListItem;
use butler_ds::ui::blocks::disclosure_row::DisclosureRow;
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::context::Ds;
use butler_ds::ui::field::FieldLabel;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Grid, Space, Stack};
use butler_ds::ui::segmented_control::{Choice, SegmentedControl};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, Context, Entity, IntoElement as _, ParentElement as _, SharedString};

use super::copy::{Words, words};
use super::form::{
    self, Form, FormId, item_menu, labeled, reveal_button, secret_input, with_extra,
};
use super::model::VaultProfile;
use super::sites::sites_field;
use super::{BrowserVault, Kind, Target};
use crate::ui::Icon;
use crate::ui::settings::state::Load;

/// The fields of the profile form, grouped as React groups them.
struct Fields<'a> {
    this: &'a Entity<BrowserVault>,
    draft: &'a Form,
    copy: &'static Words,
}

impl Fields<'_> {
    fn field(&self, key: &'static str) -> Stack {
        let input = form::input(self.this, FormId::Profile, self.draft, key, "");
        labeled((self.copy.detail)(key), input)
    }

    fn secret(&self, key: &'static str) -> Stack {
        let input = secret_input(self.this, FormId::Profile, self.draft, key, "");
        labeled((self.copy.detail)(key), input)
    }

    fn pair(&self, id: &'static str, a: &'static str, b: &'static str) -> Grid {
        form::pair(id, true, self.field(a), self.field(b))
    }

    /// A caption over its fields.
    fn group(title: &str) -> Stack {
        Stack::new()
            .gap(Space::Sm)
            .child(Typo::caption(title.to_owned()).tone(Tone::Secondary))
    }

    fn names(&self) -> Stack {
        let name = labeled(
            self.copy.profile_name,
            form::input(self.this, FormId::Profile, self.draft, "nickname", ""),
        );
        Self::group(self.copy.groups[0])
            .child(name)
            .child(self.field("name"))
            .child(self.pair("vault-profile-names", "family_name", "given_name"))
            .child(self.pair(
                "vault-profile-latin",
                "name_latin_surname",
                "name_latin_given",
            ))
    }

    fn contact(&self) -> Stack {
        Self::group(self.copy.groups[1]).child(self.pair("vault-profile-contact", "phone", "email"))
    }

    fn address(&self) -> Stack {
        Self::group(self.copy.groups[2])
            .child(self.pair("vault-profile-country", "country", "postal_code"))
            .child(self.pair("vault-profile-region", "region", "city"))
            .child(self.field("address_line1"))
            .child(self.field("address_line2"))
    }

    fn other(&self, gender: Stack) -> Stack {
        Self::group(self.copy.groups[3])
            .child(self.field("organization"))
            .child(self.secret("birth_date"))
            .child(gender)
    }

    /// The optional ID details, inside the disclosure.
    fn identity(&self) -> Stack {
        let passport = form::pair(
            "vault-profile-passport",
            true,
            self.secret("passport_number"),
            self.field("passport_expiry"),
        );
        Stack::new().gap(Space::Sm).child(passport).child(self.pair(
            "vault-profile-nationality",
            "nationality",
            "issuing_country",
        ))
    }
}

/// The key of the profile's passport number in `extras`.
const PASSPORT: &str = "passport_number";

impl BrowserVault {
    /// Section `profiles`.
    pub(super) fn profiles_section(&mut self, cx: &mut Context<Self>) -> SettingsSection {
        let copy = words(Ds::get(cx).lang());
        let this = cx.entity();
        let busy = self.vault_busy.is_some();
        let available = matches!(&self.vault, Load::Ready(view) if view.available);
        let editing = self.profile_form.clone();
        let adding = editing == Some(Target::New);
        let add = form::add_button(
            "vault-profile-add",
            copy,
            available,
            available && editing.is_none(),
            Ds::get(cx),
            cx.listener(|this, _, _, cx| this.open_form(Kind::Profiles, Target::New, cx)),
        );
        let mut section =
            SettingsSection::new("profiles", SettingsSectionKind::List, copy.title_profiles)
                .state(self.vault.state(|view| view.profiles.is_empty() && !adding))
                .empty_message(copy.empty_profiles)
                .on_retry(cx.listener(|_, _, _, cx| Self::reload_vault(cx)))
                .actions(add);
        if adding {
            section = section.child(self.profile_form_view(None, &this, busy, copy, cx));
        }
        if let Load::Ready(view) = &self.vault {
            for profile in &view.profiles {
                let editing_this = editing == Some(Target::Item(profile.id.clone()));
                section = section.child(if editing_this {
                    self.profile_form_view(Some(profile), &this, busy, copy, cx)
                        .into_any_element()
                } else {
                    self.profile_row(profile, &this, copy, cx)
                });
            }
        }
        section
    }

    /// `VaultProfileForm`: secret fields start empty; on a change, empty keeps the saved value.
    fn profile_form_view(
        &self,
        profile: Option<&VaultProfile>,
        this: &Entity<Self>,
        busy: bool,
        copy: &'static Words,
        cx: &mut Context<Self>,
    ) -> Stack {
        let draft = &self.drafts[FormId::Profile as usize];
        let fields = Fields { this, draft, copy };
        let identity = DisclosureRow::new("vault-profile-id", copy.id_section)
            .open(draft.id_open)
            .on_toggle(cx.listener(|this, _, _, cx| {
                let draft = this.form_mut(FormId::Profile);
                draft.id_open = !draft.id_open;
                cx.notify();
            }))
            .child(fields.identity());
        let id = profile.map(|profile| profile.id.clone());
        let buttons = form::form_buttons(
            "vault-profile-form",
            copy,
            draft.profile_ready() && !busy,
            cx.listener(|this, _, _, cx| {
                this.profile_form = None;
                cx.notify();
            }),
            cx.listener(move |this, _, _, cx| this.save_item(Kind::Profiles, id.clone(), cx)),
        );
        Stack::new()
            .gap(Space::Md)
            .child(fields.names())
            .child(fields.contact())
            .child(fields.address())
            .child(fields.other(self.gender_field(this, copy)))
            .child(identity)
            .child(buttons)
    }

    /// The gender choice, male or female.
    fn gender_field(&self, this: &Entity<Self>, copy: &'static Words) -> Stack {
        let this = this.clone();
        let value = self.drafts[FormId::Profile as usize].gender.clone();
        let options = ["M", "F"]
            .into_iter()
            .zip(copy.gender_options)
            .map(|(value, label)| Choice::new(value, label));
        let control = SegmentedControl::new("vault-profile-gender", copy.gender, value)
            .options(options)
            .on_value_change(move |value, _, cx| {
                this.update(cx, |this, cx| {
                    value.clone_into(&mut this.form_mut(FormId::Profile).gender);
                    cx.notify();
                });
            });
        Stack::new()
            .gap(Space::Xs)
            .child(FieldLabel::new().child(SharedString::from(copy.gender)))
            .child(control)
    }

    /// `VaultProfileRow`
    fn profile_row(
        &self,
        profile: &VaultProfile,
        this: &Entity<Self>,
        copy: &'static Words,
        cx: &Context<Self>,
    ) -> AnyElement {
        let has_passport = profile.extras.iter().any(|extra| extra == PASSPORT);
        let reveal = self.revealed.get(&SharedString::from(profile.id.clone()));
        let shown = reveal.and_then(|reveal| reveal.number.clone());
        let revealing = reveal.is_some_and(|reveal| reveal.number.is_none());
        let revealable = matches!(&self.vault, Load::Ready(view) if view.reveal_available);
        let allowed = if profile.sites.is_empty() {
            copy.ask_every_time.to_owned()
        } else {
            (copy.allowed_sites)(profile.sites.len())
        };
        let name = profile.details.get("name").map_or("", String::as_str);
        let description = [name, allowed.as_str()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" · ");
        let mut actions = Stack::row().gap(Space::Xs).cross(Cross::Center);
        if has_passport {
            actions = actions.child(reveal_button(
                this,
                Kind::Profiles,
                &profile.id,
                (shown.is_some(), revealing, revealable),
                copy,
            ));
        }
        let actions = actions.child(item_menu(
            this,
            Kind::Profiles,
            &profile.id,
            &profile.nickname,
            copy,
        ));
        let mut item = CardListItem::new(
            SharedString::from(format!("vault-profile-{}", profile.id)),
            profile.nickname.clone(),
        )
        .icon(icon(Icon::UserRound, IconSize::Md, Ds::get(cx)))
        .description(description)
        .actions(actions);
        if has_passport {
            let number = shown.as_deref().unwrap_or("••••");
            item = item.meta(SharedString::from(format!("{} {number}", copy.passport)));
        }
        let (sites_this, id, before) = (this.clone(), profile.id.clone(), profile.sites.clone());
        let sites = sites_field(
            format!("vault-profile-sites-{}", profile.id).into(),
            copy.site,
            &profile.sites,
            copy,
            move |next, _, cx| {
                sites_this.update(cx, |this, cx| {
                    this.set_sites(Kind::Profiles, id.clone(), before.clone(), next, cx);
                });
            },
        );
        with_extra(item, Stack::new().gap(Space::Sm).child(sites))
    }
}
