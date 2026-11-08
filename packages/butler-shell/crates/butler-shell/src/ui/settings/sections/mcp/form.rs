//! The MCP server types and the form state (`mcpSettingsUtils.ts`, `McpServerView`).
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Source {
    #[default]
    Literal,
    Env,
    File,
}

impl Source {
    pub(super) const ALL: [Self; 3] = [Self::Literal, Self::Env, Self::File];

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Literal => "literal",
            Self::Env => "env",
            Self::File => "file",
        }
    }

    pub(super) fn parse(value: &str) -> Self {
        Self::ALL
            .into_iter()
            .find(|source| source.as_str() == value)
            .unwrap_or_default()
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Transport {
    #[default]
    Stdio,
    Http,
    Sse,
}

impl Transport {
    pub(super) const ALL: [Self; 3] = [Self::Stdio, Self::Http, Self::Sse];

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Stdio => "stdio",
            Self::Http => "http",
            Self::Sse => "sse",
        }
    }

    pub(super) fn parse(value: &str) -> Self {
        Self::ALL
            .into_iter()
            .find(|transport| transport.as_str() == value)
            .unwrap_or_default()
    }
}

fn yes() -> bool {
    true
}

/// `McpSecretView`
#[derive(Clone, Deserialize)]
pub(super) struct SecretView {
    key: String,
    source: Source,
    value: Option<String>,
    #[serde(default)]
    redacted: bool,
    #[serde(default = "yes")]
    has_value: bool,
}

/// `McpServerView`
#[derive(Clone, Deserialize)]
pub(super) struct Server {
    #[serde(default)]
    pub(super) tool_filter_review_required: bool,
    pub(super) id: String,
    pub(super) display_name: String,
    pub(super) enabled: bool,
    pub(super) transport: Transport,
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    cwd: Option<String>,
    url: Option<String>,
    #[serde(default)]
    env: Vec<SecretView>,
    #[serde(default)]
    headers: Vec<SecretView>,
}

impl Server {
    /// Some env or header slot has no value yet.
    pub(super) fn needs_secret(&self) -> bool {
        self.env.iter().chain(&self.headers).any(|s| !s.has_value)
    }

    /// `mcpServerSubtitle`
    pub(super) fn subtitle(&self) -> String {
        let target = if self.transport == Transport::Stdio {
            let parts = self.command.iter().chain(&self.args);
            parts
                .filter(|part| !part.is_empty())
                .cloned()
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            self.url.clone().unwrap_or_default()
        };
        let counts = [("env", self.env.len()), ("headers", self.headers.len())]
            .into_iter()
            .filter(|(_, count)| *count > 0)
            .map(|(name, count)| format!("{name} {count}"))
            .collect::<Vec<_>>()
            .join(" · ");
        [self.transport.as_str().to_owned(), target, counts]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" · ")
    }
}

/// `McpSecretRowState`
pub(super) struct SecretRow {
    pub(super) id: u32,
    pub(super) key: String,
    pub(super) source: Source,
    pub(super) value: String,
    pub(super) redacted: bool,
    /// An empty slot left by an import: the key still needs its value.
    pub(super) missing: bool,
}

/// The rows of one secret map, the source the toolbar would add with, and whether the owner
/// changed the rows (an untouched map is not sent on edit).
pub(super) struct SecretGroup {
    pub(super) rows: Vec<SecretRow>,
    pub(super) selected: Source,
    common: Option<Source>,
    pub(super) dirty: bool,
}

impl SecretGroup {
    fn new(rows: Vec<SecretRow>) -> Self {
        let common = common_source(&rows);
        Self {
            rows,
            selected: common.unwrap_or_default(),
            common,
            dirty: false,
        }
    }

    /// `commonSource`: the selected source follows the rows when they all share one.
    pub(super) fn sync(&mut self) {
        let common = common_source(&self.rows);
        if common != self.common {
            self.common = common;
            if let Some(source) = common {
                self.selected = source;
            }
        }
    }

    /// `emptySecretRow(selectedSource)`
    pub(super) fn add(&mut self, next_row: &mut u32) {
        self.rows.push(SecretRow {
            id: take_id(next_row),
            key: String::new(),
            source: self.selected,
            value: String::new(),
            redacted: false,
            missing: false,
        });
    }

    /// `secretList`
    fn payload(&self) -> Vec<Value> {
        self.rows
            .iter()
            .filter_map(|row| {
                let (key, value) = (row.key.trim(), row.value.trim());
                if key.is_empty() || (value.is_empty() && !row.redacted) {
                    return None;
                }
                Some(json!({ "key": key, "source": row.source.as_str(), "value": value }))
            })
            .collect()
    }
}

fn common_source(rows: &[SecretRow]) -> Option<Source> {
    let first = rows.first()?.source;
    rows.iter().all(|row| row.source == first).then_some(first)
}

fn take_id(next_row: &mut u32) -> u32 {
    *next_row += 1;
    *next_row
}

fn group_from_views(views: &[SecretView], next_row: &mut u32) -> SecretGroup {
    let rows = views
        .iter()
        .map(|view| SecretRow {
            id: take_id(next_row),
            key: view.key.clone(),
            source: view.source,
            value: view.value.clone().unwrap_or_default(),
            redacted: view.redacted,
            missing: !view.has_value,
        })
        .collect();
    SecretGroup::new(rows)
}

/// `McpServerFormState`
pub(super) struct FormState {
    pub(super) id: String,
    pub(super) display_name: String,
    pub(super) enabled: bool,
    pub(super) transport: Transport,
    pub(super) command: String,
    pub(super) args_text: String,
    pub(super) cwd: String,
    pub(super) url: String,
    pub(super) env: SecretGroup,
    pub(super) headers: SecretGroup,
    pub(super) next_row: u32,
}

impl FormState {
    /// `emptyMcpServerForm`
    pub(super) fn empty() -> Self {
        Self {
            id: String::new(),
            display_name: String::new(),
            enabled: true,
            transport: Transport::Stdio,
            command: String::new(),
            args_text: String::new(),
            cwd: String::new(),
            url: String::new(),
            env: SecretGroup::new(Vec::new()),
            headers: SecretGroup::new(Vec::new()),
            next_row: 0,
        }
    }

    /// `formFromMcpServer`
    pub(super) fn from_server(server: &Server) -> Self {
        let mut next_row = 0;
        Self {
            id: server.id.clone(),
            display_name: server.display_name.clone(),
            enabled: server.enabled,
            transport: server.transport,
            command: server.command.clone().unwrap_or_default(),
            args_text: server.args.join("\n"),
            cwd: server.cwd.clone().unwrap_or_default(),
            url: server.url.clone().unwrap_or_default(),
            env: group_from_views(&server.env, &mut next_row),
            headers: group_from_views(&server.headers, &mut next_row),
            next_row,
        }
    }

    /// `mcpServerPayload`: a new server sends both maps; an edit sends only a changed one.
    pub(super) fn payload(&self, editing: bool) -> Value {
        let mut body = json!({
            "id": self.id,
            "display_name": self.display_name,
            "enabled": self.enabled,
            "transport": self.transport.as_str(),
            "command": self.command,
            "args": line_list(&self.args_text),
            "cwd": self.cwd,
            "url": self.url,
        });
        if let Some(body) = body.as_object_mut() {
            if !editing || self.env.dirty {
                body.insert("env".into(), Value::Array(self.env.payload()));
            }
            if !editing || self.headers.dirty {
                body.insert("headers".into(), Value::Array(self.headers.payload()));
            }
        }
        body
    }
}

fn line_list(value: &str) -> Vec<&str> {
    value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect()
}

/// `mcpServerIdError`
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum IdProblem {
    Required,
    Invalid,
}

pub(super) fn id_problem(id: &str) -> Option<IdProblem> {
    if id.trim().is_empty() {
        return Some(IdProblem::Required);
    }
    let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-');
    let valid = id.len() <= 80 && id.chars().all(allowed) && id.chars().any(|c| c != '-');
    (!valid).then_some(IdProblem::Invalid)
}
