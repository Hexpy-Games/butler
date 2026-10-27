use super::{Plugins, Result, error, types::*};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
};

pub(super) fn expand(value: &str, root: &Path, data: &Path) -> String {
    value
        .replace("${BUTLER_PLUGIN_ROOT}", &root.to_string_lossy())
        .replace("${CLAUDE_PLUGIN_ROOT}", &root.to_string_lossy())
        .replace("${BUTLER_PLUGIN_DATA}", &data.to_string_lossy())
}
fn argv(args: &[String], root: &Path, data: &Path) -> Vec<String> {
    args.iter().map(|s| expand(s, root, data)).collect()
}
pub(super) fn resolve_preview(
    mut caps: CapabilitySet,
    root: &Path,
    data: &Path,
) -> Result<CapabilitySet> {
    caps.runs_on_this_computer = caps
        .runs_on_this_computer
        .into_iter()
        .map(|mut e| {
            e.argv = argv(&e.argv, root, data);
            e
        })
        .collect();
    caps.hooks = caps
        .hooks
        .into_iter()
        .map(|mut h| {
            h.argv = argv(&h.argv, root, data);
            h
        })
        .collect();
    Ok(caps)
}
fn config(
    id: &str,
    server: &Server,
    plugin: &Installed,
    root: &Path,
    data: &Path,
    secrets: &BTreeMap<String, String>,
) -> Value {
    let values = |fields: &BTreeMap<String, String>| {
        fields
            .iter()
            .map(|(key, value)| {
                let mut value = expand(value, root, data);
                for (key, secret) in secrets {
                    value = value.replace(&format!("${{{key}}}"), secret);
                }
                json!({"key":key,"source":"literal","value":value})
            })
            .collect::<Vec<_>>()
    };
    let mut env = server.env.clone();
    env.insert(
        "BUTLER_PLUGIN_ROOT".into(),
        root.to_string_lossy().into_owned(),
    );
    env.insert(
        "CLAUDE_PLUGIN_ROOT".into(),
        root.to_string_lossy().into_owned(),
    );
    env.insert(
        "BUTLER_PLUGIN_DATA".into(),
        data.to_string_lossy().into_owned(),
    );
    let command = server.command.as_ref().map(|v| expand(v, root, data));
    json!({"id":format!("{}/{id}",plugin.package.name), "display_name":format!("{} / {id}",plugin.package.name), "enabled":true,
        "transport":server.transport,"command":command,"args":argv(&server.args,root,data),"url":server.url,"cwd":data,
        "env":values(&env),"headers":values(&server.headers),"source":"plugin","plugin":plugin.package.name})
}
impl butler_models::mcp_client::McpOverlay for Plugins {
    fn prepare_call(
        &self,
        id: &str,
        args: &serde_json::Map<String, Value>,
    ) -> std::result::Result<butler_models::mcp_client::PreparedOverlay, &'static str> {
        let (plugin, server) = id.split_once('/').ok_or("plugin_mcp_id_invalid")?;
        let account = {
            let state = self.state.lock();
            let accounts = state
                .registry
                .accounts
                .values()
                .filter(|a| {
                    a.plugin == plugin
                        && a.enabled
                        && args
                            .get("account")
                            .and_then(Value::as_str)
                            .is_none_or(|id| id == a.id)
                })
                .cloned()
                .collect::<Vec<_>>();
            if accounts.len() > 1 {
                return Err("connector_account_required");
            }
            accounts.into_iter().next()
        };
        if let Some(account) = account {
            return self
                .connectors
                .prepared_blocking(&account, server)
                .map_err(|e| e.code);
        }
        butler_models::mcp_client::McpOverlay::prepare_leased(self, id)
    }
    fn validate_tool(
        &self,
        server: &str,
        tool: &str,
        args: &serde_json::Map<String, Value>,
    ) -> std::result::Result<(), &'static str> {
        self.connectors.destination(server, tool, args)
    }
    fn connector_tool(
        &self,
        action: String,
        input: Value,
        read_only: bool,
    ) -> butler_core::plugins::PluginFuture<'_> {
        Box::pin(async move { self.connectors.tool(&action, input, read_only).await })
    }
    fn servers(&self) -> Vec<Value> {
        if self.safe_mode {
            return Vec::new();
        }
        self.state
            .lock()
            .registry
            .plugins
            .values()
            .filter(|p| p.enabled && p.quarantine.is_none())
            .flat_map(|p| {
                let root = self.root.join("store").join(&p.approval.content_digest);
                let data = self.root.join("data").join(&p.package.name);
                p.package
                    .servers
                    .iter()
                    .map(|(id, s)| config(id, s, p, &root, &data, &BTreeMap::new()))
                    .collect::<Vec<_>>()
            })
            .collect()
    }
    fn prepare(&self, server_id: &str) -> std::result::Result<Value, &'static str> {
        self.prepare_server(server_id).map_err(|e| e.code)
    }
    fn prepare_leased(
        &self,
        server_id: &str,
    ) -> std::result::Result<butler_models::mcp_client::PreparedOverlay, &'static str> {
        // The mutation lock binds the selected digest and its execution lease.
        let (config, approval) = self.prepare_snapshot(server_id).map_err(|e| e.code)?;
        Ok(butler_models::mcp_client::PreparedOverlay {
            config,
            lease: Some(approval),
        })
    }
}
impl Plugins {
    fn prepare_server(&self, server_id: &str) -> Result<Value> {
        self.prepare_snapshot(server_id).map(|(config, _)| config)
    }
    pub(super) fn prepare_snapshot(
        &self,
        server_id: &str,
    ) -> Result<(Value, std::sync::Arc<Approval>)> {
        let _mutation = self.mutation.lock();
        let (id, server_id) = server_id
            .split_once('/')
            .ok_or_else(|| error("plugin_mcp_id_invalid"))?;
        let plugin = self
            .state
            .lock()
            .registry
            .plugins
            .get(id)
            .cloned()
            .ok_or_else(|| error("plugin_unavailable"))?;
        let server = plugin
            .package
            .servers
            .get(server_id)
            .ok_or_else(|| error("plugin_unavailable"))?;
        let root = self
            .root
            .join("store")
            .join(&plugin.approval.content_digest);
        let data = self.root.join("data").join(id);
        let mut entries = server.command.iter().cloned().collect::<Vec<_>>();
        entries.extend(server.args.clone());
        self.verify_locked(id, &argv(&entries, &root, &data), false)?;
        let secrets = self.secret_values(&plugin)?;
        Ok((
            config(server_id, server, &plugin, &root, &data, &secrets),
            plugin.approval.clone(),
        ))
    }
    fn secret_values(&self, plugin: &Installed) -> Result<BTreeMap<String, String>> {
        if plugin.approval.capabilities.secrets.is_empty() {
            return Ok(BTreeMap::new());
        }
        let secrets = super::storage::secret_store()?;
        plugin
            .approval
            .capabilities
            .secrets
            .iter()
            .map(|s| {
                let value = secrets
                    .get(&super::storage::key(&plugin.package.name, &s.key)?)
                    .map_err(|_| error("plugin_secret_unavailable"))?
                    .ok_or_else(|| error("plugin_secret_unavailable"))?;
                butler_log::register_secret(value.expose());
                Ok((s.key.clone(), value.expose().to_owned()))
            })
            .collect()
    }
    pub(crate) fn skill_roots(&self) -> (u64, Vec<(String, std::path::PathBuf)>) {
        let state = self.state.lock();
        let mut roots = Vec::new();
        if !self.safe_mode {
            for p in state
                .registry
                .plugins
                .values()
                .filter(|p| p.enabled && p.quarantine.is_none())
            {
                let root = self.root.join("store").join(&p.approval.content_digest);
                for (name, path) in &p.package.skills {
                    roots.push((
                        format!("{}:{name}", p.package.name),
                        root.join(path).join("SKILL.md"),
                    ));
                }
            }
        }
        (state.registry.revision, roots)
    }
    pub(crate) fn hooks(&self) -> Vec<butler_core::hooks::HookDefinition> {
        if self.safe_mode {
            return Vec::new();
        }
        self.state
            .lock()
            .registry
            .plugins
            .values()
            .filter(|p| p.enabled && p.quarantine.is_none())
            .flat_map(|p| {
                p.package
                    .hooks
                    .iter()
                    .map(|h| {
                        let mut h = h.clone();
                        h.id = format!("{}/{}", p.package.name, h.id);
                        h
                    })
                    .collect::<Vec<_>>()
            })
            .collect()
    }
    pub(crate) fn hook_execution(
        &self,
        hook: &mut butler_core::hooks::HookDefinition,
    ) -> Result<(std::path::PathBuf, Vec<String>)> {
        let (id, _) = hook
            .id
            .split_once('/')
            .ok_or_else(|| error("plugin_hook_id_invalid"))?;
        let p = self
            .state
            .lock()
            .registry
            .plugins
            .get(id)
            .cloned()
            .ok_or_else(|| error("plugin_unavailable"))?;
        let root = self.root.join("store").join(&p.approval.content_digest);
        let data = self.root.join("data").join(id);
        let args = argv(hook.args.as_deref().unwrap_or_default(), &root, &data);
        self.verify(id, &args, true)?;
        hook.args = Some(args);
        let secrets = self.secret_values(&p)?;
        let mut env: HashMap<String, String> = hook
            .env
            .iter()
            .map(|(k, v)| (k.clone(), expand(v, &root, &data)))
            .collect();
        env.extend(secrets.clone());
        env.insert(
            "BUTLER_PLUGIN_ROOT".into(),
            root.to_string_lossy().into_owned(),
        );
        env.insert(
            "CLAUDE_PLUGIN_ROOT".into(),
            root.to_string_lossy().into_owned(),
        );
        env.insert(
            "BUTLER_PLUGIN_DATA".into(),
            data.to_string_lossy().into_owned(),
        );
        hook.env = env.into_iter().collect();
        Ok((data, secrets.into_values().collect()))
    }
}
