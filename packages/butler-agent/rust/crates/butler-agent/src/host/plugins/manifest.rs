use super::{Result, error, inspect::relative, types::*};
use serde_json::Value;
use std::{collections::BTreeMap, fs, path::Path};

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}
pub(crate) fn json(root: &Path, path: &str) -> Result<Value> {
    let bytes =
        fs::read(root.join(relative(path)?)).map_err(|_| error("plugin_component_unreadable"))?;
    serde_json::from_slice(&bytes).map_err(|_| error("plugin_json_invalid"))
}
pub(crate) fn read(root: &Path) -> Result<Package> {
    let metadata = [
        "plugin.json",
        ".claude-plugin/plugin.json",
        ".codex-plugin/plugin.json",
    ]
    .into_iter()
    .find(|path| root.join(path).is_file())
    .ok_or_else(|| error("plugin_manifest_missing"))?;
    let value = json(root, metadata)?;
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| valid_id(s))
        .ok_or_else(|| error("plugin_name_invalid"))?;
    let version = value
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("0.0.0");
    semver::Version::parse(version).map_err(|_| error("plugin_version_invalid"))?;
    let ext = value.pointer("/extensions/io.github.hexpy-games.butler");
    if ext.is_some_and(|v| v.get("api").and_then(Value::as_u64) != Some(1)) {
        return Err(error("plugin_api_unsupported"));
    }
    let mut package = Package {
        name: name.into(),
        version: version.into(),
        author: value.get("author").cloned().unwrap_or(Value::Null),
        servers: BTreeMap::new(),
        skills: BTreeMap::new(),
        hooks: Vec::new(),
        declared: CapabilitySet::default(),
        compatibility: Vec::new(),
        connectors: Vec::new(),
    };
    declared(&mut package, ext)?;
    skills(root, &value, &mut package)?;
    servers(root, &value, &mut package)?;
    super::connector_manifest::read(ext, &mut package)?;
    if let Some(path) = ext.and_then(|v| v.get("hooks")).and_then(Value::as_str) {
        let config: butler_core::hooks::HookConfig =
            serde_json::from_value(json(root, path)?).map_err(|_| error("plugin_hooks_invalid"))?;
        config
            .validate()
            .map_err(|_| error("plugin_hooks_invalid"))?;
        if config.hooks.iter().any(|h| h.command.is_some()) {
            return Err(error("plugin_hooks_require_argv"));
        }
        if config.hooks.iter().any(|h| {
            h.env
                .keys()
                .any(|k| k.starts_with("BUTLER_") || k.starts_with("CLAUDE_"))
        }) {
            return Err(error("plugin_environment_reserved"));
        }
        package.hooks = config.hooks;
        supported(&mut package, "hooks");
    }
    unsupported(root, &value, ext, &mut package);
    normalize_entrypoints(root, &mut package)?;
    super::capabilities::derive_capabilities(&package)?;
    Ok(package)
}
fn declared(package: &mut Package, ext: Option<&Value>) -> Result<()> {
    let Some(caps) = ext.and_then(|v| v.get("capabilities")) else {
        return Ok(());
    };
    if let Some(network) = caps.get("network") {
        package.declared.network = serde_json::from_value(network.clone())
            .map_err(|_| error("plugin_capabilities_invalid"))?;
    }
    if let Some(files) = caps.get("files") {
        package.declared.files = serde_json::from_value(files.clone())
            .map_err(|_| error("plugin_capabilities_invalid"))?;
    }
    if let Some(secrets) = caps.get("secrets") {
        package.declared.secrets = serde_json::from_value(secrets.clone())
            .map_err(|_| error("plugin_capabilities_invalid"))?;
    }
    for scope in &package.declared.files {
        if scope.path.is_empty()
            || scope.path.contains('\\')
            || std::path::Path::new(&scope.path).components().any(|c| {
                matches!(
                    c,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
            || !matches!(scope.access.as_str(), "read" | "write" | "read_write")
        {
            return Err(error("plugin_capabilities_invalid"));
        }
    }
    Ok(())
}
fn paths(value: Option<&Value>, fallback: &str) -> Result<Vec<String>> {
    match value {
        None => Ok(vec![fallback.into()]),
        Some(Value::String(path)) => Ok(vec![path.clone()]),
        Some(Value::Array(values)) => values
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| error("plugin_component_path_invalid"))
            })
            .collect(),
        _ => Err(error("plugin_component_path_invalid")),
    }
}
fn skills(root: &Path, value: &Value, package: &mut Package) -> Result<()> {
    for path in paths(value.get("skills"), "skills")? {
        let path = path.trim_start_matches("./");
        let dir = root.join(relative(path)?);
        if !dir.exists() {
            if value.get("skills").is_some() {
                return Err(error("plugin_skill_missing"));
            }
            continue;
        }
        let roots = if dir.join("SKILL.md").is_file() {
            vec![dir]
        } else {
            fs::read_dir(dir)
                .map_err(|_| error("plugin_skill_missing"))?
                .map(|e| {
                    e.map(|e| e.path())
                        .map_err(|_| error("plugin_skill_missing"))
                })
                .collect::<Result<Vec<_>>>()?
        };
        for dir in roots {
            if !dir.join("SKILL.md").is_file() {
                continue;
            }
            let name = dir
                .file_name()
                .and_then(|s| s.to_str())
                .filter(|s| valid_id(s))
                .ok_or_else(|| error("plugin_skill_name_invalid"))?;
            let rel = dir
                .strip_prefix(root)
                .map_err(|_| error("invalid_plugin_path"))?
                .iter()
                .map(|s| s.to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            if package.skills.insert(name.into(), rel).is_some() {
                return Err(error("plugin_skill_duplicate"));
            }
        }
    }
    if !package.skills.is_empty() {
        supported(package, "skills");
    }
    Ok(())
}
fn servers(root: &Path, value: &Value, package: &mut Package) -> Result<()> {
    let explicit = value.get("mcpServers").or_else(|| value.get("mcp"));
    let configs = if explicit.is_some_and(Value::is_object) {
        vec![explicit.cloned().unwrap_or(Value::Null)]
    } else {
        let fallback = if root.join("mcp.json").is_file() {
            "mcp.json"
        } else {
            ".mcp.json"
        };
        let mut configs = Vec::new();
        for path in paths(explicit, fallback)? {
            let path = path.strip_prefix("./").unwrap_or(&path);
            if !root.join(relative(path)?).exists() && explicit.is_none() {
                continue;
            }
            configs.push(json(root, path)?);
        }
        configs
    };
    for config in configs {
        let entries = config
            .get("mcpServers")
            .unwrap_or(&config)
            .as_object()
            .ok_or_else(|| error("plugin_mcp_invalid"))?;
        for (id, value) in entries {
            let id = butler_models::mcp_client::normalize_server_id(id);
            if id.is_empty() {
                return Err(error("plugin_mcp_id_invalid"));
            }
            let value: Value = serde_json::from_str(
                &value
                    .to_string()
                    .replace("${CLAUDE_PLUGIN_ROOT}", "${BUTLER_PLUGIN_ROOT}"),
            )
            .map_err(|_| error("plugin_mcp_invalid"))?;
            let mut server: Server = serde_json::from_value(serde_json::json!({
                "transport": value.get("transport").or_else(||value.get("type")).and_then(Value::as_str).unwrap_or(if value.get("url").is_some() { "http" } else { "stdio" }),
                "command": value.get("command"), "args": value.get("args").cloned().unwrap_or_else(||serde_json::json!([])),
                "url": value.get("url"), "env": value.get("env").cloned().unwrap_or_else(||serde_json::json!({})),
                "headers": value.get("headers").cloned().unwrap_or_else(||serde_json::json!({}))
            })).map_err(|_| error("plugin_mcp_invalid"))?;
            if server
                .env
                .keys()
                .any(|k| k.starts_with("BUTLER_") || k.starts_with("CLAUDE_"))
            {
                return Err(error("plugin_environment_reserved"));
            }
            if server.transport == "streamable-http" {
                server.transport = "http".into();
            }
            if !matches!(server.transport.as_str(), "stdio" | "http" | "sse")
                || (server.transport == "stdio"
                    && server.command.as_deref().is_none_or(str::is_empty))
            {
                return Err(error("plugin_mcp_invalid"));
            }
            if package.servers.insert(id.clone(), server).is_some() {
                return Err(error("plugin_mcp_duplicate"));
            }
        }
    }
    if !package.servers.is_empty() {
        supported(package, "mcp");
    }
    Ok(())
}
fn supported(package: &mut Package, component: &str) {
    package.compatibility.push(Compatibility {
        component: component.into(),
        status: "native".into(),
        reason: None,
    });
}
fn unsupported(root: &Path, value: &Value, ext: Option<&Value>, package: &mut Package) {
    for component in [
        "commands",
        "agents",
        "hooks",
        "outputStyles",
        "lspServers",
        "app",
    ] {
        let present = value.get(component).is_some()
            || root.join(component).exists()
            || (component == "app" && ext.is_some_and(|v| v.get("app").is_some()));
        if present {
            package.compatibility.push(Compatibility {
                component: component.into(),
                status: "unsupported".into(),
                reason: Some("not_supported_yet".into()),
            });
        }
    }
}

fn normalize_entrypoints(root: &Path, package: &mut Package) -> Result<()> {
    for server in package.servers.values_mut() {
        if let Some(command) = server.command.as_mut() {
            normalize_argument(root, command)?;
        }
        for arg in &mut server.args {
            normalize_argument(root, arg)?;
        }
    }
    for hook in &mut package.hooks {
        for arg in hook.args.iter_mut().flatten() {
            normalize_argument(root, arg)?;
        }
    }
    Ok(())
}
fn normalize_argument(root: &Path, value: &mut String) -> Result<()> {
    let path = value.strip_prefix("./").unwrap_or(value);
    if Path::new(path)
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(error("invalid_plugin_path"));
    }
    if Path::new(path).is_relative() && !path.starts_with("${") && root.join(path).is_file() {
        relative(path)?;
        *value = format!("${{BUTLER_PLUGIN_ROOT}}/{path}");
    }
    Ok(())
}
