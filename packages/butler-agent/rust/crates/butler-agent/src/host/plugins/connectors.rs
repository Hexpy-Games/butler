//! Account lifecycle is change-driven. Each enabled account owns one child.
mod accounts;
mod credentials;
mod intake;
mod rules;
mod runtime;
use super::{Plugins, Result, error};
use butler_core::plugins::{
    ConnectorAccount as Account, ConnectorDefinition as Connector, ConnectorStoreRef as SharedStore,
};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, OnceLock, Weak},
};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

pub(super) struct Connectors {
    owner: Weak<Plugins>,
    store: OnceLock<SharedStore>,
    live: Mutex<BTreeMap<String, Live>>,
    states: Mutex<BTreeMap<String, Status>>,
    reconcile: tokio::sync::Mutex<()>,
}
struct Status {
    state: &'static str,
    error: Option<&'static str>,
    destinations: Value,
}
struct Live {
    digest: String,
    cancel: CancellationToken,
    task: JoinHandle<()>,
    calls: mpsc::Sender<Call>,
}
struct Call {
    tool: String,
    args: Map<String, Value>,
    response: oneshot::Sender<Result<Value>>,
}
impl Connectors {
    pub(super) fn new(owner: Weak<Plugins>) -> Arc<Self> {
        Arc::new(Self {
            owner,
            store: OnceLock::new(),
            live: Mutex::new(BTreeMap::new()),
            states: Mutex::new(BTreeMap::new()),
            reconcile: tokio::sync::Mutex::new(()),
        })
    }
    fn owner(&self) -> Result<Arc<Plugins>> {
        self.owner
            .upgrade()
            .ok_or_else(|| error("connectors_unavailable"))
    }
    async fn storage(&self, op: &str, input: Value) -> Result<Value> {
        self.store
            .get()
            .ok_or_else(|| error("connectors_unavailable"))?
            .execute(op.into(), input)
            .await
    }
    pub(super) fn bind(self: &Arc<Self>, store: SharedStore) {
        if self.store.set(store).is_ok() {
            let owner = self.clone();
            tokio::spawn(async move {
                owner.reconcile().await;
            });
        }
    }
    fn status(&self, id: &str, state: &'static str, error: Option<&'static str>) {
        let mut states = self.states.lock();
        let s = states.entry(id.into()).or_insert(Status {
            state,
            error,
            destinations: Value::Null,
        });
        s.state = state;
        s.error = error;
    }
    fn definition(&self, plugin: &str, connector: &str) -> Result<Connector> {
        self.owner()?
            .state
            .lock()
            .registry
            .plugins
            .get(plugin)
            .and_then(|p| p.package.connectors.iter().find(|c| c.id == connector))
            .cloned()
            .ok_or_else(|| error("connector_not_found"))
    }
    fn inventory(&self) -> Result<Value> {
        let owner = self.owner()?;
        let state = owner.state.lock();
        let statuses = self.states.lock();
        let connectors = state.registry.plugins.iter().flat_map(|(plugin,p)|p.package.connectors.iter().map(|c| {
            let accounts = state.registry.accounts.values().filter(|a|a.plugin==*plugin && a.connector==c.id).map(|a| {
                let status = statuses.get(&a.id);
                json!({"id":a.id,"fields":a.fields,"enabled":a.enabled,"handling":a.handling,
                    "state":status.map_or("disconnected",|s|s.state),"last_error":status.and_then(|s|s.error)})
            }).collect::<Vec<_>>();
            json!({"plugin":plugin,"connector":c.id,"label":c.label,"accounts":accounts})
        }).collect::<Vec<_>>()).collect::<Vec<_>>();
        Ok(json!({"connectors":connectors,"revision":state.registry.revision}))
    }
    pub(super) async fn reconcile(self: &Arc<Self>) {
        let _lock = self.reconcile.lock().await;
        let Ok(owner) = self.owner() else { return };
        if self.store.get().is_none() {
            return;
        }
        let desired = {
            let state = owner.state.lock();
            state
                .registry
                .accounts
                .values()
                .filter(|a| {
                    a.enabled
                        && !owner.safe_mode
                        && state
                            .registry
                            .plugins
                            .get(&a.plugin)
                            .is_some_and(|p| p.enabled && p.quarantine.is_none())
                })
                .filter_map(|a| {
                    state
                        .registry
                        .plugins
                        .get(&a.plugin)
                        .map(|p| (a.id.clone(), (a.clone(), p.approval.content_digest.clone())))
                })
                .collect::<BTreeMap<_, _>>()
        };
        let removed = {
            let mut live = self.live.lock();
            let ids = live
                .keys()
                .filter(|id| {
                    desired
                        .get(*id)
                        .is_none_or(|(_, digest)| live.get(*id).is_none_or(|l| l.digest != *digest))
                })
                .cloned()
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| live.remove(&id).map(|l| (id, l)))
                .collect::<Vec<_>>()
        };
        for (id, live) in removed {
            live.cancel.cancel();
            let _ = live.task.await;
            self.status(&id, "disconnected", None);
        }
        for (id, (account, digest)) in desired {
            if self.live.lock().contains_key(&id) {
                continue;
            }
            let Ok(definition) = self.definition(&account.plugin, &account.connector) else {
                continue;
            };
            let cancel = CancellationToken::new();
            let (calls, rx) = mpsc::channel(32);
            let runtime = self.clone();
            let signal = cancel.clone();
            let task = tokio::spawn(async move {
                runtime.run(account, definition, rx, signal).await;
            });
            self.live.lock().insert(
                id,
                Live {
                    digest,
                    cancel,
                    task,
                    calls,
                },
            );
        }
    }
    pub(super) async fn stop_plugin(&self, plugin: Option<&str>) {
        let Some(plugin) = plugin else { return };
        let accounts = self
            .owner()
            .map(|o| {
                o.state
                    .lock()
                    .registry
                    .accounts
                    .values()
                    .filter(|a| a.plugin == plugin)
                    .map(|a| a.id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for id in accounts {
            let live = self.live.lock().remove(&id);
            if let Some(l) = live {
                l.cancel.cancel();
                let _ = l.task.await;
            }
            self.status(&id, "disconnected", None);
        }
    }
    pub(super) async fn plugin_changed(&self, action: &str, plugin: Option<&str>) {
        let Some(plugin) = plugin else { return };
        if matches!(action, "enable" | "update" | "rollback" | "uninstall") {
            let accounts = self
                .owner()
                .map(|o| {
                    o.state
                        .lock()
                        .registry
                        .accounts
                        .values()
                        .filter(|a| a.plugin == plugin)
                        .map(|a| a.id.clone())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            for id in accounts {
                let live = self.live.lock().remove(&id);
                if let Some(l) = live {
                    l.cancel.cancel();
                    let _ = l.task.await;
                }
                self.states.lock().remove(&id);
            }
        }
        if action == "uninstall" {
            let _ = self
                .storage("plugin_remove", json!({"plugin":plugin}))
                .await;
        }
    }
    async fn call(
        &self,
        account: &Account,
        tool: &str,
        mut args: Map<String, Value>,
    ) -> Result<Value> {
        let definition = self.definition(&account.plugin, &account.connector)?;
        let (server, name) = tool
            .split_once('/')
            .ok_or_else(|| error("connector_tool_invalid"))?;
        if server != definition.events.server {
            let environment = std::env::vars().collect();
            let prepared = self.prepared(account, server).await?;
            let session =
                butler_models::mcp_client::ConnectorSession::operation(prepared, &environment)
                    .await
                    .map_err(error)?;
            let result = session.call(name, args).await.map_err(error);
            session.close().await;
            return result;
        }
        // Account identity cannot be replaced by model-written arguments.
        args.insert("account".into(), account.id.clone().into());
        let sender = self
            .live
            .lock()
            .get(&account.id)
            .filter(|l| !l.cancel.is_cancelled())
            .map(|l| l.calls.clone())
            .ok_or_else(|| error("connector_disconnected"))?;
        if self
            .states
            .lock()
            .get(&account.id)
            .is_none_or(|s| s.state != "connected")
        {
            return Err(error("connector_disconnected"));
        }
        let (response, rx) = oneshot::channel();
        sender
            .send(Call {
                tool: name.into(),
                args,
                response,
            })
            .await
            .map_err(|_| error("connector_disconnected"))?;
        rx.await.map_err(|_| error("connector_disconnected"))?
    }
    pub(super) fn destination(
        &self,
        server: &str,
        tool: &str,
        args: &Map<String, Value>,
    ) -> std::result::Result<(), &'static str> {
        let Some((plugin, server)) = server.split_once('/') else {
            return Ok(());
        };
        let owner = self.owner().map_err(|e| e.code)?;
        let state = owner.state.lock();
        let Some(p) = state.registry.plugins.get(plugin) else {
            return Ok(());
        };
        for c in &p.package.connectors {
            if !c
                .actions
                .iter()
                .any(|a| a.tool == format!("{server}/{tool}") && a.destination)
            {
                continue;
            }
            let Some(dest) = &c.destinations else {
                return Err("connector_destination_refused");
            };
            let Some(id) = args.get(&dest.argument).and_then(Value::as_str) else {
                return Err("connector_destination_refused");
            };
            let accounts = state
                .registry
                .accounts
                .values()
                .filter(|a| {
                    a.plugin == plugin
                        && a.connector == c.id
                        && a.enabled
                        && args
                            .get("account")
                            .and_then(Value::as_str)
                            .is_none_or(|id| id == a.id)
                })
                .collect::<Vec<_>>();
            let statuses = self.states.lock();
            if accounts.is_empty()
                || accounts.iter().any(|a| {
                    statuses.get(&a.id).is_none_or(|s| {
                        !s.destinations["destinations"]
                            .as_array()
                            .is_some_and(|list| {
                                list.iter().any(|d| {
                                    d["id"] == id
                                        && d["roles"].as_array().is_some_and(|roles| {
                                            d["roles_known"].as_bool().unwrap_or(!roles.is_empty())
                                                && !roles.iter().any(|r| {
                                                    r == "trash" || r == "junk" || r == "all"
                                                })
                                        })
                                })
                            })
                    })
                })
            {
                return Err("connector_destination_refused");
            }
        }
        Ok(())
    }
}
