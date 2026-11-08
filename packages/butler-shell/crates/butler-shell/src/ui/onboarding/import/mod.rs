//! Importing from other AI tools (`FirstRunAgentStep`, `useFirstRunImports`, `useAgentPicks`,
//! `useAgentImport`): the detected tools, one page of items per chosen tool, and the result.
//! The calls run through the app's admin credential; the step keeps counts only.
mod copy;
mod screens;

use std::collections::HashMap;

use butler_shell_client::Error;
use gpui::{Context, SharedString};
use serde::Deserialize;
use serde_json::{Value, json};

pub(crate) use screens::screen;

use crate::ui::settings::state::fetch;

/// A server a tool holds.
#[derive(Clone, Default, Deserialize)]
struct Server {
    name: String,
    #[serde(default)]
    needs_secret: bool,
}

/// What can be picked: the importable instruction file label and every importable server.
#[derive(Clone, Default, Deserialize)]
struct Items {
    #[serde(default)]
    instructions: Vec<String>,
    #[serde(default)]
    servers: Vec<Server>,
}

/// A detected AI tool: what it holds, never a path outside its label or a secret.
#[derive(Clone, Deserialize)]
struct Source {
    key: String,
    name: String,
    #[serde(default)]
    instructions: bool,
    #[serde(default)]
    instructions_file: Option<String>,
    #[serde(default)]
    instructions_error: Option<String>,
    #[serde(default)]
    servers: u64,
    #[serde(default)]
    items: Items,
}

impl Source {
    /// `importable`: the tool holds an instruction file or a server.
    fn importable(&self) -> bool {
        self.instructions || self.servers > 0
    }
}

/// GET /security/agent-import/sources
#[derive(Deserialize)]
struct Sources {
    sources: Vec<Source>,
}

/// What one import added.
#[derive(Clone, Default, Deserialize)]
struct Counts {
    #[serde(default)]
    instructions: u64,
    #[serde(default)]
    servers: u64,
    #[serde(default)]
    needs_secret: u64,
}

/// The tools imported in order, until one failed.
#[derive(Deserialize)]
struct Run {
    done: Vec<Done>,
    failed: bool,
}

#[derive(Deserialize)]
struct Done {
    key: String,
    counts: Counts,
}

/// One tool's item choice.
#[derive(Clone)]
struct Choice {
    instructions: bool,
    servers: Vec<String>,
}

/// `useFirstRunImports` + `useAgentPicks` + `useAgentImport`. `sources` is `None` while loading.
#[derive(Default)]
pub(crate) struct Imports {
    started: bool,
    sources: Option<Vec<Source>>,
    busy: bool,
    error: bool,
    result: Option<Counts>,
    by_source: HashMap<String, Counts>,
    /// Picked tools; `None` until the user changes the default (every importable tool).
    picked: Option<Vec<String>>,
    /// The open tool page; `None` is the tool list.
    page: Option<usize>,
    choices: HashMap<String, Choice>,
}

impl Imports {
    pub(crate) fn new(cx: &mut Context<Self>) -> Self {
        let _ = cx;
        Self::default()
    }

    /// The frame calls it on every flow change once the reply is saved and Butler is ready; it
    /// fetches the sources once.
    pub(crate) fn enable(&mut self, cx: &mut Context<Self>) {
        if self.started {
            return;
        }
        self.started = true;
        fetch(
            cx,
            |client| async move { client.list_agent_import_sources().await },
            |this: &mut Self, result: Result<Sources, Error>, _| match result {
                Ok(view) => this.sources = Some(view.sources),
                Err(_) => {
                    this.sources = Some(Vec::new());
                    this.error = true;
                }
            },
        );
    }

    /// `agentsDone`: imported, with no error and nothing running.
    pub(crate) fn done(&self) -> bool {
        self.result.is_some() && !self.error && !self.busy
    }

    /// `imported.agents`: the instructions and servers the import added (none when skipped).
    pub(crate) fn agent_counts(&self) -> Option<(u64, u64)> {
        self.result
            .as_ref()
            .map(|counts| (counts.instructions, counts.servers))
    }

    /// `agents`, `agents:<key>` or `agents:done`.
    pub(crate) fn page_key(&self) -> SharedString {
        if self.done() {
            "agents:done".into()
        } else if let Some(source) = self.current() {
            format!("agents:{}", source.key).into()
        } else {
            "agents".into()
        }
    }

    fn chosen(&self) -> Vec<String> {
        self.picked.clone().unwrap_or_else(|| {
            self.sources
                .iter()
                .flatten()
                .filter(|source| source.importable())
                .map(|source| source.key.clone())
                .collect()
        })
    }

    /// The chosen tools, in detection order.
    fn tools(&self) -> Vec<Source> {
        let chosen = self.chosen();
        self.sources
            .iter()
            .flatten()
            .filter(|source| chosen.contains(&source.key))
            .cloned()
            .collect()
    }

    fn current(&self) -> Option<Source> {
        self.tools().into_iter().nth(self.page?)
    }

    fn choice_of(&self, source: &Source) -> Choice {
        self.choices
            .get(&source.key)
            .cloned()
            .unwrap_or_else(|| Choice {
                instructions: !source.items.instructions.is_empty(),
                servers: source
                    .items
                    .servers
                    .iter()
                    .map(|server| server.name.clone())
                    .collect(),
            })
    }

    /// Something to import is on for this tool.
    fn anything(&self, source: &Source) -> bool {
        let choice = self.choice_of(source);
        (choice.instructions && !source.items.instructions.is_empty()) || !choice.servers.is_empty()
    }

    fn any_on(&self) -> bool {
        self.tools().iter().any(|source| self.anything(source))
    }

    fn toggle_tool(&mut self, key: &str, cx: &mut Context<Self>) {
        let mut chosen = self.chosen();
        if chosen.iter().any(|entry| entry == key) {
            chosen.retain(|entry| entry != key);
        } else {
            chosen.push(key.to_owned());
        }
        self.picked = Some(chosen);
        cx.notify();
    }

    fn toggle_instructions(&mut self, source: &Source, cx: &mut Context<Self>) {
        let mut choice = self.choice_of(source);
        choice.instructions = !choice.instructions;
        self.choices.insert(source.key.clone(), choice);
        cx.notify();
    }

    fn toggle_server(&mut self, source: &Source, name: &str, cx: &mut Context<Self>) {
        let mut choice = self.choice_of(source);
        if choice.servers.iter().any(|entry| entry == name) {
            choice.servers.retain(|entry| entry != name);
        } else {
            choice.servers.push(name.to_owned());
        }
        self.choices.insert(source.key.clone(), choice);
        cx.notify();
    }

    /// `open(index)`: `None` is the tool list.
    fn open(&mut self, index: Option<usize>, cx: &mut Context<Self>) {
        self.page = index;
        cx.notify();
    }

    /// `importAll`: each chosen tool in order with its items; tools with nothing on are skipped.
    fn import_all(&mut self, cx: &mut Context<Self>) {
        let runs: Vec<(String, Value)> = self
            .tools()
            .iter()
            .filter(|source| self.anything(source))
            .map(|source| {
                let choice = self.choice_of(source);
                let body = json!({
                    "source": source.key,
                    "instructions": choice.instructions && !source.items.instructions.is_empty(),
                    "servers": choice.servers,
                });
                (source.key.clone(), body)
            })
            .collect();
        self.busy = true;
        self.error = false;
        fetch(
            cx,
            move |client| async move {
                let mut done = Vec::new();
                let mut failed = false;
                for (key, body) in runs {
                    match client.start_agent_import(&body).await {
                        Ok(counts) => {
                            failed = counts.get("error").is_some_and(|error| !error.is_null());
                            done.push(json!({ "key": key, "counts": counts }));
                        }
                        Err(_) => failed = true,
                    }
                    if failed {
                        break;
                    }
                }
                Ok(json!({ "done": done, "failed": failed }))
            },
            |this: &mut Self, result: Result<Run, Error>, _| {
                this.busy = false;
                match result {
                    Ok(run) => {
                        if !run.done.is_empty() {
                            let mut total = this.result.clone().unwrap_or_default();
                            for done in run.done {
                                total.instructions += done.counts.instructions;
                                total.servers += done.counts.servers;
                                total.needs_secret += done.counts.needs_secret;
                                this.by_source.insert(done.key, done.counts);
                            }
                            this.result = Some(total);
                        }
                        this.error = run.failed;
                    }
                    Err(_) => this.error = true,
                }
            },
        );
        cx.notify();
    }
}
