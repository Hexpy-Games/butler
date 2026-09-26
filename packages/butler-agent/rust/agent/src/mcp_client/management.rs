//! Source-shaped registry management behind the MCP client facade.

use std::{path::Path, sync::Arc};

use serde_json::{Value, json};

use super::{
    NativeMcpClient,
    registry::{
        McpServerConfig, normalize_server_config, normalize_server_id, now_iso,
        read_registry_value, redact_server, registry_path, server_to_value,
    },
};

impl NativeMcpClient {
    pub(crate) fn list_servers(&self) -> Result<Value, String> {
        let registry = read_registry_value(&self.data_root)?;
        let servers = normalized_servers(&registry)?;
        Ok(json!({
            "storage_path": registry_path(&self.data_root).to_string_lossy(),
            "servers": servers.iter().map(redact_server).collect::<Vec<_>>(),
        }))
    }

    pub(crate) async fn upsert_server(&self, input: Value) -> Result<Value, String> {
        self.write_registry(move |data_root, guard| {
            let id_input = input
                .get("id")
                .and_then(Value::as_str)
                .or_else(|| input.get("display_name").and_then(Value::as_str))
                .unwrap_or("");
            let id = normalize_server_id(id_input);
            if id.is_empty() {
                return Err("MCP server id is required.".into());
            }
            let now = now_iso();
            let mut registry = read_registry_value(data_root)?;
            let mut servers = normalized_server_values(&registry)?;
            let index = servers
                .iter()
                .position(|server| server.get("id").and_then(Value::as_str) == Some(id.as_str()));
            let existing = index.and_then(|index| servers.get(index).cloned());
            let mut next = existing.clone().unwrap_or_else(|| {
                json!({
                    "id": id,
                    "display_name": input.get("display_name").and_then(Value::as_str)
                        .map(str::trim).filter(|value| !value.is_empty()).unwrap_or(&id),
                    "enabled": true,
                    "transport": input.get("transport").and_then(Value::as_str).unwrap_or("stdio"),
                    "args": [],
                    "env": [],
                    "headers": [],
                    "created_at": now,
                    "updated_at": now,
                })
            });
            merge_input(&mut next, &input);
            next["id"] = Value::String(id.clone());
            let display_name = input
                .get("display_name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    existing
                        .as_ref()
                        .and_then(|server| server.get("display_name").and_then(Value::as_str))
                })
                .unwrap_or(&id)
                .to_owned();
            next["display_name"] = Value::String(display_name);
            next["created_at"] = existing
                .as_ref()
                .and_then(|server| server.get("created_at"))
                .cloned()
                .unwrap_or_else(|| Value::String(now.clone()));
            next["updated_at"] = Value::String(now);
            let normalized = normalize_server_config(&next)?;
            let normalized_value = server_to_value(&normalized);
            if let Some(index) = index {
                servers[index] = normalized_value.clone();
            } else {
                servers.push(normalized_value.clone());
            }
            servers.sort_by(|left, right| {
                let left = left
                    .get("display_name")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let right = right
                    .get("display_name")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                left.to_lowercase()
                    .cmp(&right.to_lowercase())
                    .then_with(|| left.cmp(right))
            });
            registry["version"] = json!(1);
            registry["servers"] = Value::Array(servers);
            write_registry(data_root, guard, &registry)?;
            Ok(redact_server(&normalized))
        })
        .await
    }

    pub(crate) async fn update_server(
        &self,
        server_id: String,
        input: Value,
    ) -> Result<Value, String> {
        self.write_registry(move |data_root, guard| {
            let id = normalize_server_id(&server_id);
            let mut registry = read_registry_value(data_root)?;
            let mut servers = normalized_server_values(&registry)?;
            let Some(index) = servers
                .iter()
                .position(|server| server.get("id").and_then(Value::as_str) == Some(id.as_str()))
            else {
                return Err(format!("MCP server not found: {server_id}"));
            };
            let existing = servers[index].clone();
            let mut next = existing.clone();
            merge_input(&mut next, &input);
            next["id"] = Value::String(id);
            next["display_name"] = input
                .get("display_name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| Value::String(value.to_owned()))
                .unwrap_or_else(|| existing["display_name"].clone());
            if input.get("env").is_some() {
                next["env"] = merge_secret_updates(
                    existing.get("env").and_then(Value::as_array),
                    input.get("env").and_then(Value::as_array),
                );
            }
            if input.get("headers").is_some() {
                next["headers"] = merge_secret_updates(
                    existing.get("headers").and_then(Value::as_array),
                    input.get("headers").and_then(Value::as_array),
                );
            }
            next["created_at"] = existing["created_at"].clone();
            next["updated_at"] = Value::String(now_iso());
            let normalized = normalize_server_config(&next)?;
            servers[index] = server_to_value(&normalized);
            registry["version"] = json!(1);
            registry["servers"] = Value::Array(servers);
            write_registry(data_root, guard, &registry)?;
            Ok(redact_server(&normalized))
        })
        .await
    }

    pub(crate) async fn set_server_enabled(
        &self,
        server_id: String,
        enabled: bool,
    ) -> Result<Value, String> {
        self.update_server(server_id, json!({"enabled": enabled}))
            .await
    }

    pub(crate) async fn delete_server(&self, server_id: String) -> Result<Value, String> {
        self.write_registry(move |data_root, guard| {
            let id = normalize_server_id(&server_id);
            let mut registry = read_registry_value(data_root)?;
            let mut servers = normalized_server_values(&registry)?;
            let before = servers.len();
            servers.retain(|server| server.get("id").and_then(Value::as_str) != Some(id.as_str()));
            let removed = servers.len() != before;
            if removed {
                registry["version"] = json!(1);
                registry["servers"] = Value::Array(servers);
                write_registry(data_root, guard, &registry)?;
            }
            Ok(json!({"id": id, "removed": removed}))
        })
        .await
    }

    async fn write_registry<F>(&self, operation: F) -> Result<Value, String>
    where
        F: FnOnce(&Path, &super::RegistryPathGuard) -> Result<Value, String> + Send + 'static,
    {
        let data_root = self.data_root.clone();
        let path_guard = Arc::clone(&self.registry_path_guard);
        let permit = self.configuration_writes.acquire_owned().await;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            operation(&data_root, path_guard.as_ref())
        })
        .await
        .map_err(|_| "MCP registry write failed.".to_owned())?
    }
}

fn normalized_servers(registry: &Value) -> Result<Vec<McpServerConfig>, String> {
    registry
        .get("servers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|server| server.is_object())
        .map(normalize_server_config)
        .collect()
}

fn normalized_server_values(registry: &Value) -> Result<Vec<Value>, String> {
    normalized_servers(registry).map(|servers| servers.iter().map(server_to_value).collect())
}

fn merge_input(target: &mut Value, input: &Value) {
    let (Some(target), Some(input)) = (target.as_object_mut(), input.as_object()) else {
        return;
    };
    for (key, value) in input {
        target.insert(key.clone(), value.clone());
    }
}

fn merge_secret_updates(existing: Option<&Vec<Value>>, updates: Option<&Vec<Value>>) -> Value {
    let existing_by_key = existing
        .into_iter()
        .flatten()
        .filter_map(|secret| {
            let key = secret.get("key").and_then(Value::as_str)?;
            Some((clean_secret_key(key), secret.clone()))
        })
        .collect::<std::collections::HashMap<_, _>>();
    let values = updates
        .into_iter()
        .flatten()
        .filter_map(|update| {
            let key = clean_secret_key(update.get("key")?.as_str()?);
            if key.is_empty() {
                return None;
            }
            if update
                .get("value")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
            {
                return Some(json!({
                    "key": key,
                    "source": normalize_secret_source(update.get("source")),
                    "value": update["value"],
                }));
            }
            existing_by_key.get(&key).cloned()
        })
        .collect::<Vec<_>>();
    Value::Array(values)
}

fn clean_secret_key(value: &str) -> String {
    value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn normalize_secret_source(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_str) {
        Some("env") => "env",
        Some("file") => "file",
        _ => "literal",
    }
}

fn write_registry(
    data_root: &Path,
    guard: &super::RegistryPathGuard,
    registry: &Value,
) -> Result<(), String> {
    let target = registry_path(data_root);
    let canonical = json!({
        "version": 1,
        "servers": normalized_server_values(registry)?,
    });
    let parent = target
        .parent()
        .ok_or_else(|| "MCP registry path is invalid.".to_owned())?;
    guard(data_root, data_root)?;
    guard(data_root, parent)?;
    guard(data_root, &target)?;
    crate::configuration::write_json_atomic(&target, &canonical).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests;
