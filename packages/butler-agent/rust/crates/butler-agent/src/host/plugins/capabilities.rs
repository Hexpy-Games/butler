use super::{Result, error, types::*};

pub(crate) fn variables(value: &str) -> Result<Vec<String>> {
    let mut vars = Vec::new();
    let mut rest = value;
    while let Some((_, tail)) = rest.split_once("${") {
        let (key, tail) = tail
            .split_once('}')
            .ok_or_else(|| error("plugin_variable_invalid"))?;
        if key.is_empty() || !key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') {
            return Err(error("plugin_variable_invalid"));
        }
        if !matches!(
            key,
            "BUTLER_PLUGIN_ROOT" | "CLAUDE_PLUGIN_ROOT" | "BUTLER_PLUGIN_DATA"
        ) {
            vars.push(key.into());
        }
        rest = tail;
    }
    Ok(vars)
}
pub(crate) fn derive_capabilities(manifest: &Package) -> Result<CapabilitySet> {
    let mut caps = manifest.declared.clone();
    caps.connectors = manifest
        .connectors
        .iter()
        .map(|c| (c.id.clone(), c.clone()))
        .collect();
    caps.network = caps
        .network
        .iter()
        .map(|s| origin(s))
        .collect::<Result<_>>()?;
    for (id, server) in &manifest.servers {
        caps.agent_tools.insert(format!("{}/{id}", manifest.name));
        if server.transport == "stdio" {
            let mut argv = vec![
                server
                    .command
                    .clone()
                    .ok_or_else(|| error("plugin_mcp_invalid"))?,
            ];
            argv.extend(server.args.clone());
            caps.runs_on_this_computer.insert(executable(argv)?);
        } else {
            caps.network.insert(origin(
                server
                    .url
                    .as_deref()
                    .ok_or_else(|| error("plugin_mcp_invalid"))?,
            )?);
        }
        for value in server.env.values().chain(server.headers.values()) {
            for key in variables(value)? {
                if !caps.secrets.iter().any(|s| s.key == key) {
                    caps.secrets.insert(SecretField {
                        label: key.clone(),
                        key,
                    });
                }
            }
        }
    }
    for hook in &manifest.hooks {
        let argv = hook
            .args
            .clone()
            .ok_or_else(|| error("plugin_hooks_require_argv"))?;
        caps.runs_on_this_computer.insert(executable(argv.clone())?);
        let mut matcher = hook.matcher.tools.clone();
        matcher.sort();
        matcher.dedup();
        caps.hooks.insert(HookCapability {
            canonical: canonical_hook(hook)?,
            event: serde_json::to_value(hook.event)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default(),
            matcher,
            argv,
        });
    }
    for name in manifest.skills.keys() {
        caps.skills.insert(format!("{}:{name}", manifest.name));
    }
    for field in &caps.secrets {
        if variables(&format!("${{{}}}", field.key))? != vec![field.key.clone()] {
            return Err(error("plugin_secret_key_invalid"));
        }
        if field.key.starts_with("BUTLER_") || field.key.starts_with("CLAUDE_") {
            return Err(error("plugin_secret_key_reserved"));
        }
    }
    Ok(caps)
}
fn origin(value: &str) -> Result<String> {
    let url = url::Url::parse(value).map_err(|_| error("plugin_network_invalid"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err(error("plugin_network_invalid"));
    }
    Ok(url.origin().ascii_serialization())
}
pub(crate) fn executable(argv: Vec<String>) -> Result<Executable> {
    let command = argv
        .first()
        .ok_or_else(|| error("plugin_command_invalid"))?;
    let name = command
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(command)
        .trim_end_matches(".exe");
    let downloads = matches!(name, "npx" | "uvx");
    if downloads {
        pinned_download(&argv, name)?;
    }
    Ok(Executable {
        argv,
        downloads_code_at_runtime: downloads,
    })
}

fn pinned_download(argv: &[String], launcher: &str) -> Result<()> {
    let unpinned = || error("plugin_runtime_package_unpinned");
    let mut args = argv.iter().skip(1);
    let mut explicit = false;
    while let Some(arg) = args.next() {
        let package_flag = if launcher == "npx" {
            matches!(arg.as_str(), "-p" | "--package")
        } else {
            matches!(arg.as_str(), "--from" | "--with")
        };
        let assignment = if launcher == "npx" {
            arg.strip_prefix("--package=")
        } else {
            arg.strip_prefix("--from=")
                .or_else(|| arg.strip_prefix("--with="))
        };
        if let Some(package) = assignment {
            exact_package(package)?;
            explicit = true;
        } else if package_flag {
            exact_package(args.next().ok_or_else(unpinned)?)?;
            explicit = true;
        } else if arg.starts_with('-') {
            if !matches!(arg.as_str(), "-y" | "--yes" | "--no-install" | "--offline") {
                return Err(unpinned());
            }
        } else {
            if !explicit {
                exact_package(arg)?;
            }
            return Ok(());
        }
    }
    if explicit { Ok(()) } else { Err(unpinned()) }
}
fn exact_package(package: &str) -> Result<()> {
    let pinned = package
        .rsplit_once('@')
        .or_else(|| package.rsplit_once("=="));
    if !pinned.is_some_and(|(name, v)| !name.is_empty() && semver::Version::parse(v).is_ok()) {
        return Err(error("plugin_runtime_package_unpinned"));
    }
    Ok(())
}

fn canonical_hook(hook: &butler_core::hooks::HookDefinition) -> Result<String> {
    let mut value = serde_json::to_value(hook).map_err(|_| error("plugin_hooks_invalid"))?;
    value.sort_all_objects();
    Ok(value.to_string())
}
