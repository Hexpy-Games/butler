//! Settings: MCP (`McpSettings.tsx`). The connected canon tools, the MCP server list and the
//! add/edit form. React event buses are not subscribed in this wave (F4): `canonTrust`
//! (`publishCanonTrustEvent`); the list loads on open and after the page's own actions.
mod actions;
mod canon;
mod copy;
mod fields;
mod form;
mod row;
mod secrets;

use butler_ds::ui::blocks::card_list::CardList;
use butler_ds::ui::blocks::settings_section::{SettingsPage, SettingsSection, SettingsSectionKind};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_shell_client::Error;
use gpui::prelude::FluentBuilder as _;
use gpui::{
    AnyView, App, AppContext as _, Context, IntoElement, ParentElement as _, Render, SharedString,
    Subscription, Window,
};
use serde::Deserialize;

use self::canon::Canon;
use self::copy::{Words, words};
use self::form::{FormState, Server};
use crate::ui::Icon;
use crate::ui::settings::SectionCtx;
use crate::ui::settings::state::{Load, fetch};

pub(crate) fn page(ctx: SectionCtx, _window: &mut Window, cx: &mut App) -> AnyView {
    cx.new(|cx| McpPage::new(ctx, cx)).into()
}

/// `McpServerListView`
#[derive(Deserialize)]
struct ServerList {
    servers: Vec<Server>,
}

struct McpPage {
    ctx: SectionCtx,
    servers: Load<Vec<Server>>,
    form: FormState,
    /// The id of the server the form edits; `None` adds one.
    editing: Option<String>,
    status: SharedString,
    open: bool,
    /// `busy`: one action runs at a time.
    busy: bool,
    canon: Canon,
    _subscription: Subscription,
}

impl McpPage {
    fn new(ctx: SectionCtx, cx: &mut Context<Self>) -> Self {
        let subscription = cx.observe(&ctx.state, |_, _, cx| cx.notify());
        let mut page = Self {
            ctx,
            servers: Load::Loading,
            form: FormState::empty(),
            editing: None,
            status: SharedString::default(),
            open: false,
            busy: false,
            canon: Canon::new(),
            _subscription: subscription,
        };
        page.refresh(cx);
        Self::refresh_grants(cx);
        page
    }

    /// `refresh`: GET /mcp-servers.
    fn refresh(&mut self, cx: &mut Context<Self>) {
        if !matches!(self.servers, Load::Ready(_)) {
            self.servers = Load::Loading;
        }
        fetch(
            cx,
            |client| async move { client.list_mcp_servers().await },
            |this: &mut Self, result: Result<ServerList, Error>, cx| match result {
                Ok(list) => this.servers = Load::Ready(list.servers),
                Err(_) => {
                    if !matches!(this.servers, Load::Ready(_)) {
                        this.servers = Load::Failed;
                    }
                    let message = words(Ds::get(cx).lang()).err_unavailable;
                    actions::toast_error(cx, message);
                }
            },
        );
    }

    fn servers_section(&self, w: &'static Words, cx: &mut Context<Self>) -> SettingsSection {
        let add = Button::new("mcp-add")
            .size(Size::Sm)
            .variant(Variant::Outline)
            .icon_start(icon(Icon::Plus, IconSize::Md, Ds::get(cx)))
            .text(w.add)
            .when(self.busy, Button::disabled)
            .on_click(cx.listener(|this, _, _, cx| this.add(cx)));
        let mut section = SettingsSection::new("mcp-servers", SettingsSectionKind::List, w.servers)
            .state(self.servers.state(Vec::is_empty))
            .empty_message(w.no_servers)
            .on_retry(cx.listener(|this, _, _, cx| this.refresh(cx)))
            .actions(add);
        if !self.status.is_empty() {
            section = section.description(self.status.clone());
        }
        if let Load::Ready(servers) = &self.servers {
            let rows: Vec<_> = servers
                .iter()
                .map(|server| self.server_row(server, w, cx))
                .collect();
            section = section.child(CardList::new("mcp-server-list").flush().children(rows));
        }
        section
    }
}

impl Render for McpPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let w = words(Ds::get(cx).lang());
        let mut page = SettingsPage::new()
            .labels(SectionCtx::labels(cx))
            .section(self.canon_section(w, cx))
            .section(self.servers_section(w, cx));
        if self.open {
            page = page.section(self.form_section(w, cx));
        }
        page
    }
}
