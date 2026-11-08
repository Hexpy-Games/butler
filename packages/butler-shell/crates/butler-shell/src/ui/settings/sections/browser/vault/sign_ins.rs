//! Section `sign-ins` (`SecuritySignInsSection.tsx`): saved sign-ins and Butler's per-site
//! access. Passwords are never shown.
use butler_ds::ui::blocks::card_list::CardListItem;
use butler_ds::ui::blocks::overflow_action_menu::{OverflowActionMenu, OverflowItem};
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::segmented_control::{Choice, SegmentedControl};
use butler_ds::ui::switch::Switch;
use butler_ds::ui::tag::{Size as TagSize, Tag, Tone as TagTone};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, Context, Entity, ParentElement as _, SharedString};

use super::BrowserVault;
use super::actions::ask;
use super::copy::{Words, words};
use super::form::{self, Form, FormId, secret_input, with_extra};
use super::model::{SignInSite, since};
use crate::ui::Icon;
use crate::ui::settings::state::Load;

const POLICIES: [&str; 3] = ["always", "ask", "never"];

impl BrowserVault {
    /// Section `sign-ins`.
    pub(super) fn sign_ins_section(&mut self, cx: &mut Context<Self>) -> SettingsSection {
        let copy = words(Ds::get(cx).lang());
        let this = cx.entity();
        let busy = self.sign_in_busy.is_some();
        let adding = self.adding_sign_in;
        let available = self.keychain_available();
        let add = form::add_button(
            "sign-in-add",
            copy,
            available,
            available && !adding,
            Ds::get(cx),
            cx.listener(|this, _, _, cx| {
                this.adding_sign_in = true;
                this.drafts[FormId::SignIn as usize] = Form::default();
                cx.notify();
            }),
        );
        let mut section =
            SettingsSection::new("sign-ins", SettingsSectionKind::List, copy.title_sign_ins)
                .state(self.sign_ins.state(|view| view.sites.is_empty() && !adding))
                .empty_message(copy.empty_sign_ins)
                .on_retry(cx.listener(|_, _, _, cx| Self::reload_sign_ins(cx)))
                .actions(add);
        if adding {
            section = section.child(self.sign_in_form(&this, busy, copy, cx));
        }
        if let Load::Ready(view) = &self.sign_ins {
            for site in &view.sites {
                section = section.child(self.sign_in_row(site, &this, busy, copy, cx));
            }
        }
        section
    }

    /// `SignInAddForm`
    fn sign_in_form(
        &self,
        this: &Entity<Self>,
        busy: bool,
        copy: &'static Words,
        cx: &mut Context<Self>,
    ) -> Stack {
        let draft = &self.drafts[FormId::SignIn as usize];
        let ready = !draft.text("site").trim().is_empty()
            && !draft.text("username").trim().is_empty()
            && !draft.text("password").is_empty();
        let site = form::input(this, FormId::SignIn, draft, "site", copy.site_placeholder);
        let username = form::input(this, FormId::SignIn, draft, "username", copy.username);
        let password = secret_input(this, FormId::SignIn, draft, "password", copy.password);
        let buttons = form::form_buttons(
            "sign-in-form",
            copy,
            ready && !busy,
            cx.listener(|this, _, _, cx| {
                this.adding_sign_in = false;
                cx.notify();
            }),
            cx.listener(|this, _, _, cx| this.add_sign_in(cx)),
        );
        Stack::new()
            .gap(Space::Sm)
            .child(site)
            .child(username)
            .child(password)
            .child(buttons)
    }

    /// `SignInRow`
    fn sign_in_row(
        &self,
        row: &SignInSite,
        this: &Entity<Self>,
        busy: bool,
        copy: &'static Words,
        cx: &Context<Self>,
    ) -> AnyElement {
        let ds = Ds::get(cx);
        let used = row
            .entry
            .as_ref()
            .and_then(|entry| entry.last_used_at.as_deref());
        let meta = used.map_or_else(
            || copy.not_used.to_owned(),
            |at| (copy.last_used)(&since(at, copy)),
        );
        let username = row
            .entry
            .as_ref()
            .map_or(copy.no_password, |entry| entry.username.as_str());
        let item = CardListItem::new(
            SharedString::from(format!("sign-in-{}", row.site)),
            row.site.clone(),
        )
        .icon(icon(Icon::Globe2, IconSize::Md, ds))
        .meta(SharedString::from(meta))
        .description(username.to_owned())
        .actions(self.sign_in_menu(row, this, copy));
        let mut extra = Stack::new().gap(Space::Sm);
        if row.conversations > 0 {
            extra = extra.child(
                Stack::row().child(
                    Tag::new(
                        format!("sign-in-conversations-{}", row.site),
                        (copy.conversations)(row.conversations),
                    )
                    .size(TagSize::Sm)
                    .tone(TagTone::Neutral),
                ),
            );
        }
        if let Some(entry) = &row.entry {
            extra = extra.child(policy_row(this, &entry.id, &entry.policy, copy));
        }
        extra = extra.child(all_conversations_row(this, row, busy, copy));
        with_extra(item, extra)
    }

    /// The row's menu: delete the password, remove Butler's access.
    // CARVE-OUT(G-native): "Sign out of this site" clears the site from the App's signed-in
    // browser profile (`butlerBrowser` bridge, `canSignOut()`); the browser is not ported, so
    // React hides it too when the bridge is missing.
    fn sign_in_menu(
        &self,
        row: &SignInSite,
        this: &Entity<Self>,
        copy: &'static Words,
    ) -> OverflowActionMenu {
        let mut menu =
            OverflowActionMenu::new(format!("sign-in-menu-{}", row.site), row.site.clone());
        let (ctx, site) = (self.ctx.clone(), row.site.clone());
        if let Some(entry) = &row.entry {
            let (ctx, this, site, id) = (ctx.clone(), this.clone(), site.clone(), entry.id.clone());
            menu = menu.item(
                OverflowItem::new(copy.delete_password).on_select(move |_, cx| {
                    let (site, id) = (site.clone(), id.clone());
                    let message = (copy.delete_password_confirm)(&site);
                    ask(
                        &ctx,
                        &this,
                        message,
                        copy.delete_password,
                        move |t, cx| t.delete_sign_in(site, id, cx),
                        cx,
                    );
                }),
            );
        }
        let this = this.clone();
        menu.item(OverflowItem::new(copy.revoke).on_select(move |_, cx| {
            let site = site.clone();
            let message = (copy.revoke_confirm)(&site);
            ask(
                &ctx,
                &this,
                message,
                copy.revoke,
                move |t, cx| t.revoke_site(site, cx),
                cx,
            );
        }))
    }
}

/// The policy control: "Butler signs in" always, ask or never.
fn policy_row(this: &Entity<BrowserVault>, id: &str, policy: &str, copy: &'static Words) -> Stack {
    let (this, entry) = (this.clone(), id.to_owned());
    let options = POLICIES
        .iter()
        .zip(copy.policy)
        .map(|(value, label)| Choice::new(*value, label));
    let control = SegmentedControl::new(
        format!("sign-in-policy-{id}"),
        copy.policy_label,
        policy.to_owned(),
    )
    .options(options)
    .on_value_change(move |value, _, cx| {
        this.update(cx, |this, cx| this.set_policy(entry.clone(), value, cx));
    });
    Stack::row()
        .gap(Space::Sm)
        .cross(Cross::Center)
        .wrap(true)
        .child(Typo::caption(copy.policy_label).tone(Tone::Secondary))
        .child(control)
}

/// "Use in all conversations" for the site.
fn all_conversations_row(
    this: &Entity<BrowserVault>,
    row: &SignInSite,
    busy: bool,
    copy: &'static Words,
) -> Stack {
    let (this, site) = (this.clone(), row.site.clone());
    let mut switch = Switch::new(format!("sign-in-all-{}", row.site))
        .checked(row.all_conversations)
        .on_checked_change(move |checked, _, cx| {
            this.update(cx, |this, cx| {
                this.set_all_conversations(site.clone(), checked, cx);
            });
        });
    if busy {
        switch = switch.disabled();
    }
    Stack::row()
        .gap(Space::Sm)
        .cross(Cross::Center)
        .child(Typo::caption(copy.all_conversations).tone(Tone::Secondary))
        .child(switch)
}
