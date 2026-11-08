//! The approved actions (`grantRows.ts`, `useGrants.ts`): the agent's permission records,
//! grouped by what was approved, and revoking one.
use std::collections::{HashMap, HashSet};

use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::Error;
use gpui::Context;
use serde::Deserialize;
use serde_json::{Value, json};

use super::SecurityAuthority;
use crate::ui::settings::confirm::{Detail, Request};
use crate::ui::settings::state::{Load, fetch};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Scope {
    Conversation,
    Project,
    Always,
}

impl Scope {
    pub(super) fn index(self) -> usize {
        self as usize
    }

    fn id(self) -> &'static str {
        ["conversation", "project", "always"][self.index()]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind {
    Command,
    FileWrite,
    Network,
    Tool,
    Other,
}

impl Kind {
    pub(super) const ALL: [Self; 5] = [
        Self::Command,
        Self::FileWrite,
        Self::Network,
        Self::Tool,
        Self::Other,
    ];

    /// `grantKind`
    fn of(capability: &str) -> Self {
        match capability {
            "run_command" | "run_command_remote_observation" => Self::Command,
            "write_file" | "edit_file" => Self::FileWrite,
            "call_mcp_tool" => Self::Tool,
            _ if ["web_", "fetch_", "http_"]
                .iter()
                .any(|prefix| capability.starts_with(prefix)) =>
            {
                Self::Network
            }
            _ => Self::Other,
        }
    }

    pub(super) fn index(self) -> usize {
        self as usize
    }

    pub(super) fn id(self) -> &'static str {
        ["command", "fileWrite", "network", "tool", "other"][self.index()]
    }
}

/// One record of `GET /authority-permissions`.
#[derive(Deserialize)]
struct Record {
    grant_ref: String,
    session_id: String,
    capability: String,
    target: String,
    cwd: Option<String>,
    scope: Scope,
    session_title: Option<String>,
    project_id: Option<String>,
    project_name: Option<String>,
    created_at: String,
}

#[derive(Deserialize)]
struct Reply {
    permissions: Vec<Record>,
}

/// `GrantedRow`: records with the same public identity, every storage reference kept.
pub(super) struct Row {
    pub(super) key: String,
    pub(super) kind: Kind,
    pub(super) target: String,
    pub(super) cwd: Option<String>,
    pub(super) scope: Scope,
    /// Conversation id and title.
    pub(super) places: Vec<(String, Option<String>)>,
    pub(super) project: Option<String>,
    pub(super) created_at: String,
    refs: Vec<Value>,
}

/// `groupGrants`: newest first.
fn group(records: Vec<Record>) -> Vec<Row> {
    let mut rows: Vec<Row> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for record in records {
        let kind = Kind::of(&record.capability);
        let key = json!([
            kind.id(),
            record.target,
            record.cwd,
            record.scope.id(),
            record.project_id
        ])
        .to_string();
        let at = *index.entry(key.clone()).or_insert_with(|| {
            rows.push(Row {
                key,
                kind,
                target: record.target.clone(),
                cwd: record.cwd.clone(),
                scope: record.scope,
                places: Vec::new(),
                project: record.project_name.clone(),
                created_at: record.created_at.clone(),
                refs: Vec::new(),
            });
            rows.len() - 1
        });
        let row = &mut rows[at];
        match row
            .places
            .iter_mut()
            .find(|(id, _)| *id == record.session_id)
        {
            Some(place) => place.1 = record.session_title,
            None => row
                .places
                .push((record.session_id.clone(), record.session_title)),
        }
        if record.created_at > row.created_at {
            row.created_at = record.created_at;
        }
        row.refs
            .push(json!({"grant_ref": record.grant_ref, "session_id": record.session_id}));
    }
    rows.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    rows
}

pub(super) struct Grants {
    pub(super) rows: Load<Vec<Row>>,
    pub(super) busy: HashSet<String>,
    pub(super) query: String,
    pub(super) kind: Option<Kind>,
    /// `revision`: a read that a later read or revoke has overtaken is dropped.
    revision: u32,
}

impl Default for Grants {
    fn default() -> Self {
        Self {
            rows: Load::Loading,
            busy: HashSet::new(),
            query: String::new(),
            kind: None,
            revision: 0,
        }
    }
}

impl SecurityAuthority {
    /// `useGrants.reload`
    pub(super) fn load_grants(&mut self, quiet: bool, cx: &mut Context<Self>) {
        self.grants.revision += 1;
        let request = self.grants.revision;
        if !quiet {
            self.grants.rows = Load::Loading;
        }
        fetch(
            cx,
            |client| async move { client.get_authority_permissions().await },
            move |this: &mut Self, result: Result<Reply, Error>, _| {
                if this.grants.revision != request {
                    return;
                }
                match result {
                    Ok(reply) => this.grants.rows = Load::Ready(group(reply.permissions)),
                    Err(_) => this.grants.rows = Load::Failed,
                }
            },
        );
    }

    /// `useGrants.revoke`: an always-on approval asks first.
    pub(super) fn revoke_grant(&mut self, key: &str, cx: &mut Context<Self>) {
        if self.grants.busy.contains(key) {
            return;
        }
        let Load::Ready(rows) = &self.grants.rows else {
            return;
        };
        let Some(row) = rows.iter().find(|row| row.key == key) else {
            return;
        };
        let words = Self::words(cx);
        let refs = row.refs.clone();
        let key = row.key.clone();
        if row.scope != Scope::Always {
            self.run_revoke(key, refs, cx);
            return;
        }
        let target = if row.target.is_empty() {
            words.target_unknown
        } else {
            row.target.as_str()
        };
        let request = Request::new(words.revoke_always_message)
            .title(words.revoke_always_title)
            .confirm_label(words.revoke)
            .destructive()
            .detail(Detail {
                label: Some(words.kinds[row.kind.index()].into()),
                text: target.to_owned().into(),
                caption: None,
            });
        let this = cx.entity();
        self.ctx.confirm(
            request,
            move |_, cx| this.update(cx, |this, cx| this.run_revoke(key, refs, cx)),
            cx,
        );
    }

    fn run_revoke(&mut self, key: String, refs: Vec<Value>, cx: &mut Context<Self>) {
        self.grants.busy.insert(key.clone());
        fetch(
            cx,
            move |client| async move {
                client
                    .revoke_authority_permissions(&json!({ "grants": refs }))
                    .await
            },
            move |this: &mut Self, result: Result<Value, Error>, cx| {
                this.grants.busy.remove(&key);
                let words = Self::words(cx);
                // The agent no longer has the approval (`authority_permission_not_found`).
                if matches!(result, Ok(_) | Err(Error::Http(404))) {
                    this.grants.revision += 1;
                    if let Load::Ready(rows) = &mut this.grants.rows {
                        rows.retain(|row| row.key != key);
                    }
                    let _ = toast::show(cx, Toast::success(words.revoked));
                    this.load_grants(true, cx);
                } else {
                    let _ = toast::show(cx, Toast::error(words.revoke_failed));
                }
            },
        );
    }
}
