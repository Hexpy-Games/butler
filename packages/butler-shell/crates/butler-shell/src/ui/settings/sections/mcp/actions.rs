//! `useMcpSettingsActions.ts`: save, remove, toggle and probe, one at a time (`inFlight`).
//! The client returns no error codes (G-codes), so the form's inline command and URL errors
//! that React maps from `mcp_command_required` / `mcp_url_required` are not shown: a refused
//! save shows the `mcpErrors.save` toast.
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::Error;
use gpui::{App, Context, SharedString};
use serde::Deserialize;
use serde_json::{Value, json};

use super::copy::words;
use super::form::{FormState, IdProblem, Server, id_problem};
use super::{McpPage, Words};
use crate::ui::settings::confirm::Request;
use crate::ui::settings::state::{Load, fetch};

pub(super) fn toast_error(cx: &mut App, message: &'static str) {
    toast::show(cx, Toast::error(message));
}

/// `McpServerMutationResult`
#[derive(Deserialize)]
struct Mutation {
    server: Server,
}

/// `McpCapabilitiesView`: the first server's answer.
#[derive(Default, Deserialize)]
struct Capabilities {
    #[serde(default)]
    servers: Vec<Probed>,
}

#[derive(Deserialize)]
struct Probed {
    #[serde(default)]
    ok: bool,
    error: Option<String>,
    #[serde(default)]
    tools: Vec<Value>,
    #[serde(default)]
    resources: Vec<Value>,
}

impl McpPage {
    fn words(cx: &Context<Self>) -> &'static Words {
        words(Ds::get(cx).lang())
    }

    /// `run`: nothing starts while an action is in flight.
    fn begin(&mut self, cx: &mut Context<Self>) -> bool {
        if self.busy {
            return false;
        }
        self.busy = true;
        cx.notify();
        true
    }

    fn server(&self, id: &str) -> Option<Server> {
        match &self.servers {
            Load::Ready(servers) => servers.iter().find(|server| server.id == id).cloned(),
            _ => None,
        }
    }

    /// `updateServer`: replace or append, ordered by display name.
    fn upsert(&mut self, server: Server) {
        let mut servers = match std::mem::replace(&mut self.servers, Load::Loading) {
            Load::Ready(servers) => servers,
            _ => Vec::new(),
        };
        match servers.iter_mut().find(|item| item.id == server.id) {
            Some(item) => *item = server,
            None => servers.push(server),
        }
        servers.sort_by(|a, b| {
            let (left, right) = (a.display_name.to_lowercase(), b.display_name.to_lowercase());
            left.cmp(&right)
                .then_with(|| a.display_name.cmp(&b.display_name))
        });
        self.servers = Load::Ready(servers);
    }

    /// The add button: an empty form.
    pub(super) fn add(&mut self, cx: &mut Context<Self>) {
        self.editing = None;
        self.form = FormState::empty();
        self.open = true;
        cx.notify();
    }

    pub(super) fn edit(&mut self, id: &str, cx: &mut Context<Self>) {
        if let Some(server) = self.server(id) {
            self.editing = Some(server.id.clone());
            self.form = FormState::from_server(&server);
            self.open = true;
            cx.notify();
        }
    }

    pub(super) fn cancel(&mut self, cx: &mut Context<Self>) {
        self.open = false;
        cx.notify();
    }

    pub(super) fn save(&mut self, cx: &mut Context<Self>) {
        if id_problem(&self.form.id).is_some() || !self.begin(cx) {
            return;
        }
        let editing = self.editing.clone();
        let body = self.form.payload(editing.is_some());
        fetch(
            cx,
            move |client| async move {
                match editing {
                    Some(id) => client.update_mcp_server(&id, &body).await,
                    None => client.create_mcp_server(&body).await,
                }
            },
            |this: &mut Self, result: Result<Mutation, Error>, cx| {
                this.busy = false;
                let w = Self::words(cx);
                match result {
                    Ok(saved) => {
                        this.status = format!("{}: {}", w.saved, saved.server.id).into();
                        this.upsert(saved.server);
                        this.open = false;
                        this.editing = None;
                        this.form = FormState::empty();
                    }
                    Err(_) => toast_error(cx, w.err_save),
                }
            },
        );
    }

    /// `remove`: after the owner confirms.
    pub(super) fn remove(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(server) = self.server(id) else {
            return;
        };
        let w = Self::words(cx);
        let request = Request::new((w.delete_confirm)(&server.display_name))
            .title(w.delete_word)
            .confirm_label(w.delete_word)
            .destructive();
        let page = cx.entity();
        let id = server.id;
        self.ctx.confirm(
            request,
            move |_, cx| page.update(cx, |this, cx| this.delete(id, cx)),
            cx,
        );
    }

    fn delete(&mut self, id: String, cx: &mut Context<Self>) {
        if !self.begin(cx) {
            return;
        }
        let target = id.clone();
        fetch(
            cx,
            move |client| async move { client.delete_mcp_server(&target).await },
            move |this: &mut Self, result: Result<Value, Error>, cx| {
                this.busy = false;
                let w = Self::words(cx);
                match result {
                    Ok(_) => {
                        this.status = format!("{}: {id}", w.delete_word).into();
                        if let Load::Ready(servers) = &mut this.servers {
                            servers.retain(|server| server.id != id);
                        }
                    }
                    Err(_) => toast_error(cx, w.err_remove),
                }
            },
        );
    }

    pub(super) fn toggle(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(server) = self.server(id) else {
            return;
        };
        if !self.begin(cx) {
            return;
        }
        let body = json!({ "enabled": !server.enabled });
        fetch(
            cx,
            move |client| async move { client.update_mcp_server(&server.id, &body).await },
            |this: &mut Self, result: Result<Mutation, Error>, cx| {
                this.busy = false;
                let w = Self::words(cx);
                match result {
                    Ok(saved) => this.upsert(saved.server),
                    Err(_) => toast_error(cx, w.err_toggle),
                }
            },
        );
    }

    /// `probe`: POST /mcp-servers/{id}/probe (the client sends no body where React sends `{}`).
    pub(super) fn probe(&mut self, id: &str, cx: &mut Context<Self>) {
        if !self.begin(cx) {
            return;
        }
        let id = id.to_owned();
        let target = id.clone();
        fetch(
            cx,
            move |client| async move { client.probe_mcp_server(&target).await },
            move |this: &mut Self, result: Result<Capabilities, Error>, cx| {
                this.busy = false;
                let w = Self::words(cx);
                let outcome = result.map(|caps| caps.servers.into_iter().next());
                match outcome {
                    Ok(Some(item)) if item.ok => {
                        let status = format!(
                            "{id}: tools {}, resources {}",
                            item.tools.len(),
                            item.resources.len()
                        );
                        this.status = SharedString::from(status);
                    }
                    Ok(item) => {
                        let message = item
                            .and_then(|item| item.error)
                            .filter(|error| !error.trim().is_empty());
                        let message = message.unwrap_or_else(|| w.action_failed.to_owned());
                        toast::show(cx, Toast::error(message));
                    }
                    Err(_) => toast_error(cx, w.err_probe),
                }
            },
        );
    }

    /// The form's id problem, as the copy shows it.
    pub(super) fn id_error(&self, w: &'static Words) -> Option<&'static str> {
        id_problem(&self.form.id).map(|problem| match problem {
            IdProblem::Required => w.id_required,
            IdProblem::Invalid => w.id_invalid,
        })
    }
}
