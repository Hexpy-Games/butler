//! Electron `ConnectionsSettings.tsx`, `useConnections.ts`, and `connectionsApi.ts`.
mod copy;
mod form;

use crate::ui::Icon;
use crate::ui::settings::{SectionCtx, state::fetch};
use butler_ds::ui::blocks::card_list::{CardList, CardListItem};
use butler_ds::ui::blocks::settings_section::{
    SettingsPage, SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::tooltip::Tooltip;
use butler_shell_client::{Error, ShellClient};
use copy::{Copy, words};
use form::Form;
use gpui::{
    AnyView, App, AppContext as _, Context, IntoElement, ParentElement as _, Render, Window,
    prelude::FluentBuilder as _,
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Loaded {
    view: View,
    rules: Rules,
}
#[derive(Deserialize)]
struct View {
    revision: u64,
    connectors: Vec<Connector>,
}
#[derive(Deserialize)]
struct Connector {
    plugin: String,
    #[serde(rename = "connector")]
    kind: String,
    accounts: Vec<Account>,
}
#[derive(Deserialize)]
struct Account {
    id: String,
    fields: std::collections::HashMap<String, String>,
    enabled: bool,
    state: String,
}
#[derive(Deserialize)]
struct Rules {
    rules: Vec<Rule>,
}
#[derive(Deserialize)]
struct Rule {
    id: String,
    title: String,
}

enum Work {
    Add(Value),
    Retry(String),
    Remove(String),
    DeleteRule(String),
}

struct ConnectionsPage {
    view: Option<View>,
    rules: Vec<Rule>,
    state: SettingsSectionState,
    busy: bool,
    adding: bool,
    form: Form,
    version: u64,
}

pub(crate) fn page(ctx: SectionCtx, _: &mut Window, cx: &mut App) -> AnyView {
    let settings = ctx.state;
    cx.new(|cx| {
        cx.observe(&settings, |this: &mut ConnectionsPage, state, cx| {
            let version = state.read(cx).connector_version;
            if this.version != version {
                this.version = version;
                ConnectionsPage::reload(cx, None);
            }
            cx.notify();
        })
        .detach();
        ConnectionsPage::reload(cx, None);
        ConnectionsPage::preinstall(cx);
        ConnectionsPage {
            view: None,
            rules: Vec::new(),
            state: SettingsSectionState::Loading,
            busy: false,
            adding: false,
            form: Form::default(),
            version: settings.read(cx).connector_version,
        }
    })
    .into()
}

/// Electron `connectionsApi.ts`: inspect/install or check/update at the current revision.
async fn ensure_bundled_plugin(client: &ShellClient, name: &str) -> Result<(), Error> {
    let plugins = client.list_plugins().await?;
    let installed = plugins["plugins"]
        .as_array()
        .ok_or(Error::Protocol)?
        .iter()
        .any(|plugin| plugin["id"].as_str() == Some(name));
    if installed {
        let check = client
            .check_plugin(name, &json!({"revision": plugins["revision"]}))
            .await?;
        if check["status"] == "needs_review" {
            client
                .update_plugin(
                    name,
                    &json!({
                        "revision": check["revision"], "staging_id": check["pending"]["staging_id"],
                        "digest": check["pending"]["digest"], "secrets": {},
                    }),
                )
                .await?;
        }
    } else {
        let inspection = client
            .inspect_bundled_plugin(&json!({"bundled": name}))
            .await?;
        client
            .install_plugin(&json!({
                "staging_id": inspection["staging_id"], "digest": inspection["digest"],
                "revision": plugins["revision"], "secrets": {},
            }))
            .await?;
    }
    Ok(())
}

impl ConnectionsPage {
    /// `useConnections`: an installed bundled mail plugin is checked once on mount.
    fn preinstall(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move {
                let plugins = client.list_plugins().await?;
                let installed = plugins["plugins"]
                    .as_array()
                    .is_some_and(|plugins| plugins.iter().any(|plugin| plugin["id"] == "mail"));
                if installed {
                    ensure_bundled_plugin(&client, "mail").await?;
                }
                Ok(json!(installed))
            },
            |_: &mut Self, result: Result<bool, Error>, cx| {
                if matches!(result, Ok(true)) {
                    Self::reload(cx, None);
                }
            },
        );
    }

    /// `reload`: both lists are requested in parallel, including after failed actions.
    fn reload(cx: &mut Context<Self>, finished: Option<(bool, bool)>) {
        fetch(
            cx,
            |client| async move {
                let (view, rules) =
                    futures::try_join!(client.list_connectors(), client.list_connector_rules())?;
                Ok(json!({"view": view, "rules": rules}))
            },
            move |this: &mut Self, result: Result<Loaded, Error>, _| {
                match result {
                    Ok(loaded) => {
                        this.view = Some(loaded.view);
                        this.rules = loaded.rules.rules;
                        this.state = SettingsSectionState::Ready;
                    }
                    Err(_) => this.state = SettingsSectionState::Error,
                }
                if let Some((submitted, succeeded)) = finished {
                    if submitted {
                        this.form.password.clear();
                        if succeeded {
                            this.adding = false;
                        }
                    }
                    this.busy = false;
                }
            },
        );
    }

    fn accounts(&self) -> Vec<&Account> {
        self.view
            .as_ref()
            .into_iter()
            .flat_map(|view| &view.connectors)
            .filter(|connector| connector.plugin == "mail" && connector.kind == "mail")
            .flat_map(|connector| &connector.accounts)
            .filter(|account| account.enabled)
            .collect()
    }

    /// Electron `run`: serialize actions, toast, reload, and only then release busy.
    fn run(&mut self, work: Work, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        let revision = self.view.as_ref().map_or(0, |view| view.revision);
        let adding = matches!(&work, Work::Add(_));
        fetch(
            cx,
            move |client| async move {
                match work {
                    Work::Add(mut body) => {
                        ensure_bundled_plugin(&client, "mail").await?;
                        body["revision"] = client.list_connectors().await?["revision"].clone();
                        client.add_connector_account("mail/mail", &body).await
                    }
                    Work::Retry(id) => {
                        client
                            .retry_connector_account(
                                "mail/mail",
                                &id,
                                &json!({"revision": revision}),
                            )
                            .await
                    }
                    Work::Remove(id) => {
                        client
                            .remove_connector_account("mail/mail", &id, revision)
                            .await
                    }
                    Work::DeleteRule(id) => client.delete_connector_rule(&id).await,
                }
            },
            move |_: &mut Self, result: Result<Value, Error>, cx| {
                let w = words(Ds::get(cx).lang());
                let succeeded = result.is_ok();
                match result {
                    Ok(_) if adding => {
                        toast::show(cx, Toast::success(w.connected_toast));
                    }
                    Ok(_) => {}
                    Err(_) => {
                        toast::show(
                            cx,
                            Toast::error(if adding { w.failed } else { w.action_failed }),
                        );
                    }
                }
                Self::reload(cx, Some((adding, succeeded)));
            },
        );
        cx.notify();
    }

    fn remove_button(
        &self,
        id: &str,
        rule: bool,
        w: &'static Copy,
        cx: &mut Context<Self>,
    ) -> Tooltip {
        let target = id.to_owned();
        let key = format!("{}-remove-{id}", if rule { "rule" } else { "account" });
        Tooltip::new(format!("{key}-tip")).label(w.remove).child(
            IconButton::new(key, w.remove)
                .glyph(Icon::X)
                .when(self.busy, IconButton::disabled)
                .on_click(cx.listener(move |this, _, _, cx| {
                    let work = if rule {
                        Work::DeleteRule(target.clone())
                    } else {
                        Work::Remove(target.clone())
                    };
                    this.run(work, cx);
                })),
        )
    }

    fn account_row(
        &self,
        account: &Account,
        w: &'static Copy,
        cx: &mut Context<Self>,
    ) -> CardListItem {
        let description = match account.state.as_str() {
            "connected" => w.connected,
            "connecting" | "reconnecting" => w.connecting,
            "crashed" => w.check_account,
            _ => w.disconnected,
        };
        let mut actions = button::container(Size::Sm);
        if account.state == "crashed" {
            let id = account.id.clone();
            actions = actions.child(
                Button::new(format!("account-retry-{id}"))
                    .size(Size::Sm)
                    .variant(Variant::Outline)
                    .text(w.retry)
                    .when(self.busy, Button::disabled)
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.run(Work::Retry(id.clone()), cx)),
                    ),
            );
        }
        actions = actions.child(self.remove_button(&account.id, false, w, cx));
        CardListItem::new(
            format!("account-{}", account.id),
            account.fields.get("address").cloned().unwrap_or_default(),
        )
        .description(description)
        .actions(actions)
    }

    fn mail_section(&self, w: &'static Copy, cx: &mut Context<Self>) -> SettingsSection {
        let accounts = self.accounts();
        let state = if matches!(self.state, SettingsSectionState::Ready)
            && accounts.is_empty()
            && !self.adding
        {
            SettingsSectionState::Empty
        } else {
            self.state
        };
        let add = Button::new("mail-add")
            .size(Size::Sm)
            .variant(Variant::Outline)
            .icon_start(icon(Icon::Plus, IconSize::Sm, Ds::get(cx)))
            .text(w.add)
            .when(self.adding || self.busy, Button::disabled)
            .on_click(cx.listener(|this, _, _, cx| {
                this.form = Form::default();
                this.adding = true;
                cx.notify();
            }));
        let mut section = SettingsSection::new("mail", SettingsSectionKind::List, w.mail)
            .state(state)
            .empty_message(w.empty)
            .actions(add)
            .on_retry(cx.listener(|_, _, _, cx| Self::reload(cx, None)));
        if self.adding {
            section = section.child(self.mail_form(w, cx));
        }
        section.child(
            CardList::new("mail-accounts").flush().children(
                accounts
                    .into_iter()
                    .map(|account| self.account_row(account, w, cx))
                    .collect::<Vec<_>>(),
            ),
        )
    }

    fn rules_section(&self, w: &'static Copy, cx: &mut Context<Self>) -> SettingsSection {
        let state = if matches!(self.state, SettingsSectionState::Ready) && self.rules.is_empty() {
            SettingsSectionState::Empty
        } else {
            self.state
        };
        let rows = self
            .rules
            .iter()
            .map(|rule| {
                CardListItem::new(format!("connector-rule-{}", rule.id), rule.title.clone())
                    .actions(self.remove_button(&rule.id, true, w, cx))
            })
            .collect::<Vec<_>>();
        SettingsSection::new(
            "connector-rules",
            SettingsSectionKind::List,
            w.connector_rules,
        )
        .state(state)
        .empty_message(w.no_rules)
        .on_retry(cx.listener(|_, _, _, cx| Self::reload(cx, None)))
        .child(CardList::new("connector-rule-list").flush().children(rows))
    }
}

impl Render for ConnectionsPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let w = words(Ds::get(cx).lang());
        SettingsPage::new()
            .labels(SectionCtx::labels(cx))
            .section(self.mail_section(w, cx))
            .section(self.rules_section(w, cx))
    }
}
