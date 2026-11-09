//! The loads and the actions of `useSignIns` and `useVault`: one action runs at a time (`busy`),
//! shows its toast, reloads, and a failure shows React's fallback copy (the client returns no
//! error codes).
use butler_ds::ui::motion;
use std::time::Duration;

use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::{Error, ShellClient};
use gpui::{App, Context, Entity, SharedString};
use serde_json::{Value, json};

use super::copy::{Words, words};
use super::form::{DETAILS, Form, FormId};
use super::model::{Revealed, SignInsView, VaultView};
use super::{BrowserVault, Kind, Reveal, Target};
use crate::ui::settings::SectionCtx;
use crate::ui::settings::confirm::Request;
use crate::ui::settings::state::{Load, fetch};

/// `REVEAL_MS`: how long a revealed number stays.
const REVEAL: Duration = Duration::from_secs(20);

/// The two lists, each with its own busy key and reload.
#[derive(Clone, Copy, PartialEq)]
pub(super) enum Scope {
    SignIns,
    Vault,
}

/// `confirmAction` for a destructive row action: `act` runs on the page when accepted.
pub(super) fn ask(
    ctx: &SectionCtx,
    this: &Entity<BrowserVault>,
    message: String,
    label: &str,
    act: impl FnOnce(&mut BrowserVault, &mut Context<BrowserVault>) + 'static,
    cx: &mut App,
) {
    let this = this.clone();
    let request = Request::new(message)
        .title(label.to_owned())
        .confirm_label(label.to_owned())
        .destructive();
    ctx.confirm(
        request,
        move |_, cx| {
            this.update(cx, act);
        },
        cx,
    );
}

impl BrowserVault {
    pub(super) fn busy(&self, scope: Scope) -> Option<&SharedString> {
        match scope {
            Scope::SignIns => self.sign_in_busy.as_ref(),
            Scope::Vault => self.vault_busy.as_ref(),
        }
    }

    fn set_busy(&mut self, scope: Scope, key: Option<SharedString>) {
        match scope {
            Scope::SignIns => self.sign_in_busy = key,
            Scope::Vault => self.vault_busy = key,
        }
    }

    /// `reload` of `useSignIns`. Also what an import calls when it is done.
    pub(crate) fn reload_sign_ins(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.list_sign_ins().await },
            |this: &mut Self, result: Result<SignInsView, Error>, _| {
                this.sign_ins = result.map_or(Load::Failed, Load::Ready);
            },
        );
    }

    pub(super) fn reload_vault(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.list_vault().await },
            |this: &mut Self, result: Result<VaultView, Error>, _| {
                this.vault = result.map_or(Load::Failed, Load::Ready);
            },
        );
    }

    pub(super) fn reload(scope: Scope, cx: &mut Context<Self>) {
        match scope {
            Scope::SignIns => Self::reload_sign_ins(cx),
            Scope::Vault => Self::reload_vault(cx),
        }
    }

    /// `run(key, work, done)`: nothing while another action runs. On success `after` runs, the
    /// `done` toast shows and the list reloads; a failure shows the fallback copy.
    pub(super) fn run<Fut>(
        &mut self,
        scope: Scope,
        key: impl Into<SharedString>,
        work: impl FnOnce(ShellClient) -> Fut + Send + 'static,
        done: Option<fn(&Words) -> &'static str>,
        after: impl FnOnce(&mut Self, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) where
        Fut: Future<Output = Result<Value, Error>> + Send + 'static,
    {
        if self.busy(scope).is_some() {
            return;
        }
        self.set_busy(scope, Some(key.into()));
        cx.notify();
        fetch(
            cx,
            work,
            move |this: &mut Self, result: Result<Value, Error>, cx| {
                this.set_busy(scope, None);
                let copy = words(Ds::get(cx).lang());
                match result {
                    Ok(_) => {
                        if let Some(done) = done {
                            toast::show(cx, Toast::success(done(copy)));
                        }
                        after(this, cx);
                        Self::reload(scope, cx);
                    }
                    Err(_) => {
                        let failed = match scope {
                            Scope::SignIns => copy.sign_in_failed,
                            Scope::Vault => copy.failed,
                        };
                        toast::show(cx, Toast::error(failed));
                    }
                }
            },
        );
    }

    /// `add` of `useSignIns`; the password leaves the draft with the request.
    pub(super) fn add_sign_in(&mut self, cx: &mut Context<Self>) {
        if self.busy(Scope::SignIns).is_some() {
            return;
        }
        let draft = self.form_mut(FormId::SignIn);
        let body = json!({
            "site": draft.text("site").trim(),
            "username": draft.text("username").trim(),
            "password": draft.take("password"),
        });
        self.run(
            Scope::SignIns,
            "add",
            move |client| async move { client.add_sign_in(&body).await },
            Some(|copy| copy.saved),
            |this, cx| {
                this.adding_sign_in = false;
                cx.notify();
            },
            cx,
        );
    }

    /// `policy`
    pub(super) fn set_policy(&mut self, id: String, policy: &str, cx: &mut Context<Self>) {
        let body = json!({ "policy": policy });
        self.run(
            Scope::SignIns,
            id.clone(),
            move |client| async move { client.update_sign_in(&id, &body).await },
            None,
            |_, _| {},
            cx,
        );
    }

    /// `allConversations`
    pub(super) fn set_all_conversations(
        &mut self,
        site: String,
        value: bool,
        cx: &mut Context<Self>,
    ) {
        let body = json!({ "site": site, "all_conversations": value });
        self.run(
            Scope::SignIns,
            site,
            move |client| async move { client.update_sign_in_site(&body).await },
            None,
            |_, _| {},
            cx,
        );
    }

    /// `deletePassword`, after its confirmation.
    pub(super) fn delete_sign_in(&mut self, site: String, id: String, cx: &mut Context<Self>) {
        self.run(
            Scope::SignIns,
            site,
            move |client| async move { client.delete_sign_in(&id).await },
            None,
            |_, _| {},
            cx,
        );
    }

    /// `revoke`, after its confirmation.
    pub(super) fn revoke_site(&mut self, site: String, cx: &mut Context<Self>) {
        let body = json!({ "site": site, "revoke": true });
        self.run(
            Scope::SignIns,
            site,
            move |client| async move { client.update_sign_in_site(&body).await },
            Some(|copy| copy.revoked),
            |_, _| {},
            cx,
        );
    }

    /// `save(kind, id, input)`: adds, or changes the item `id`; the form closes on success.
    pub(super) fn save_item(&mut self, kind: Kind, id: Option<String>, cx: &mut Context<Self>) {
        if self.busy(Scope::Vault).is_some() {
            return;
        }
        let body = match kind {
            Kind::Cards => self.form_mut(FormId::Card).card_body(),
            Kind::Profiles => self.form_mut(FormId::Profile).profile_body(),
        };
        let key = id.clone().unwrap_or_else(|| match kind {
            Kind::Cards => "add-cards".into(),
            Kind::Profiles => "add-profiles".into(),
        });
        self.run(
            Scope::Vault,
            key,
            move |client| async move {
                match (kind, id) {
                    (Kind::Cards, Some(id)) => client.update_vault_card(&id, &body).await,
                    (Kind::Cards, None) => client.add_vault_card(&body).await,
                    (Kind::Profiles, Some(id)) => client.update_vault_profile(&id, &body).await,
                    (Kind::Profiles, None) => client.add_vault_profile(&body).await,
                }
            },
            Some(|copy| copy.saved),
            move |this, cx| {
                match kind {
                    Kind::Cards => this.card_form = None,
                    Kind::Profiles => this.profile_form = None,
                }
                cx.notify();
            },
            cx,
        );
    }

    /// `remove(kind, id)`, after its confirmation.
    pub(super) fn remove_item(&mut self, kind: Kind, id: String, cx: &mut Context<Self>) {
        self.run(
            Scope::Vault,
            id.clone(),
            move |client| async move {
                match kind {
                    Kind::Cards => client.delete_vault_card(&id).await,
                    Kind::Profiles => client.delete_vault_profile(&id).await,
                }
            },
            None,
            |_, _| {},
            cx,
        );
    }

    /// `sites(kind, id, before, next)`: the added sites are allowed, the removed ones are not.
    pub(super) fn set_sites(
        &mut self,
        kind: Kind,
        id: String,
        before: Vec<String>,
        next: Vec<String>,
        cx: &mut Context<Self>,
    ) {
        let key = id.clone();
        self.run(
            Scope::Vault,
            key,
            move |client| async move {
                for (site, allow) in site_changes(&before, &next) {
                    let body = json!({ "site": site, "allow": allow });
                    match kind {
                        Kind::Cards => client.set_vault_card_site(&id, &body).await?,
                        Kind::Profiles => client.set_vault_profile_site(&id, &body).await?,
                    };
                }
                Ok(Value::Null)
            },
            None,
            |_, _| {},
            cx,
        );
    }

    /// `purchaseSites(before, next)`
    pub(super) fn set_purchase_sites(
        &mut self,
        before: Vec<String>,
        next: Vec<String>,
        cx: &mut Context<Self>,
    ) {
        self.run(
            Scope::Vault,
            "purchase",
            move |client| async move {
                for (site, allow) in site_changes(&before, &next) {
                    let body = json!({ "site": site, "allow": allow });
                    client.set_purchase_site(&body).await?;
                }
                Ok(Value::Null)
            },
            None,
            |_, _| {},
            cx,
        );
    }

    /// `reveal()` of a card or profile row: the system asks the owner, then the number shows
    /// for [`REVEAL`] and is dropped.
    pub(super) fn reveal(&mut self, kind: Kind, id: String, cx: &mut Context<Self>) {
        let key = SharedString::from(id.clone());
        if self.revealed.contains_key(&key) {
            return;
        }
        self.epoch += 1;
        let epoch = self.epoch;
        self.revealed.insert(
            key.clone(),
            Reveal {
                number: None,
                epoch,
            },
        );
        cx.notify();
        let locale = match Ds::get(cx).lang() {
            Lang::Ko => "ko",
            Lang::En => "en",
        };
        fetch(
            cx,
            move |client| async move {
                let body = json!({ "locale": locale });
                match kind {
                    Kind::Cards => client.reveal_vault_card(&id, &body).await,
                    Kind::Profiles => client.reveal_vault_profile(&id, &body).await,
                }
            },
            move |this: &mut Self, result: Result<Revealed, Error>, cx| match result {
                Ok(revealed) => {
                    this.revealed.insert(
                        key.clone(),
                        Reveal {
                            number: Some(revealed.number),
                            epoch,
                        },
                    );
                    Self::forget_later(key, epoch, cx);
                }
                Err(_) => {
                    this.revealed.remove(&key);
                    let copy = words(Ds::get(cx).lang());
                    toast::show(cx, Toast::error(copy.failed));
                }
            },
        );
    }

    /// `setShown(null)` of the Hide button.
    pub(super) fn hide(&mut self, id: &SharedString, cx: &mut Context<Self>) {
        self.revealed.remove(id);
        cx.notify();
    }

    fn forget_later(key: SharedString, epoch: u64, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            motion::sleep(cx.background_executor(), REVEAL).await;
            let _ = this.update(cx, |this, cx| {
                if this
                    .revealed
                    .get(&key)
                    .is_some_and(|reveal| reveal.epoch == epoch)
                {
                    this.revealed.remove(&key);
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// The draft of an item's edit form: what the agent shows, never a secret.
    fn prefill(&self, kind: Kind, target: &Target) -> Form {
        let mut draft = Form::default();
        let (Target::Item(id), Load::Ready(view)) = (target, &self.vault) else {
            return draft;
        };
        match kind {
            Kind::Cards => {
                if let Some(card) = view.cards.iter().find(|card| card.id == *id) {
                    draft.set("nickname", &card.nickname);
                    draft.set("expiry", &card.expiry());
                    draft.set("holder", &card.holder_name);
                }
            }
            Kind::Profiles => {
                if let Some(profile) = view.profiles.iter().find(|profile| profile.id == *id) {
                    draft.set("nickname", &profile.nickname);
                    for key in DETAILS {
                        draft.set(key, profile.details.get(key).map_or("", String::as_str));
                    }
                    draft.gender = profile.details.get("gender").cloned().unwrap_or_default();
                }
            }
        }
        draft
    }

    /// Opens the card or profile form on `target`, with the draft of the item or an empty one.
    pub(super) fn open_form(&mut self, kind: Kind, target: Target, cx: &mut Context<Self>) {
        let draft = self.prefill(kind, &target);
        match kind {
            Kind::Cards => {
                self.card_form = Some(target);
                self.drafts[FormId::Card as usize] = draft;
            }
            Kind::Profiles => {
                self.profile_form = Some(target);
                self.drafts[FormId::Profile as usize] = draft;
            }
        }
        cx.notify();
    }
}

/// Sites in `next` and not `before` are added, those in `before` and not `next` removed.
fn site_changes(before: &[String], next: &[String]) -> Vec<(String, bool)> {
    let added = next
        .iter()
        .filter(|site| !before.contains(site))
        .map(|site| (site.clone(), true));
    let removed = before
        .iter()
        .filter(|site| !next.contains(site))
        .map(|site| (site.clone(), false));
    added.chain(removed).collect()
}
