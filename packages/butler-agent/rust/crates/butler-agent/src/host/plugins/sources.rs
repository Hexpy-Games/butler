use super::{Result, error, types::*};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

pub(super) fn url(value: &str) -> Result<String> {
    let parsed = url::Url::parse(value).map_err(|_| error("plugin_git_url_invalid"))?;
    if !matches!(parsed.scheme(), "https" | "http" | "ssh" | "git" | "file")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(error("plugin_git_url_invalid"));
    }
    Ok(parsed.to_string())
}
pub(super) fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub(super) fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let mut command = Command::new("git");
    command
        .current_dir(root)
        .args([
            "-c",
            "core.askPass=",
            "-c",
            "core.hooksPath=",
            "-c",
            "submodule.recurse=false",
        ])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_ASKPASS")
        .env_remove("SSH_ASKPASS")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes")
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    butler_platform::process_control::hide_console(&mut command);
    let output = super::git_process::output(command, args.first().copied())?;
    if !output.status.success() {
        return Err(error("plugin_git_failed"));
    }
    Ok(output.stdout)
}
pub(super) fn checkout(
    root: &Path,
    remote: &str,
    reference: Option<&str>,
    commit: Option<&str>,
) -> Result<(PathBuf, String)> {
    let remote = url(remote)?;
    if reference.is_some() && commit.is_some() {
        return Err(error("plugin_git_ref_invalid"));
    }
    if commit
        .is_some_and(|s| !matches!(s.len(), 40 | 64) || !s.bytes().all(|c| c.is_ascii_hexdigit()))
    {
        return Err(error("plugin_git_commit_invalid"));
    }
    let target = commit.or(reference).unwrap_or("HEAD");
    if target.is_empty() || target.starts_with('-') || target.contains(['\0', '\n', '\r', ':']) {
        return Err(error("plugin_git_ref_invalid"));
    }
    let dest = root.join("sources").join(hash(&remote));
    butler_platform::secure_fs::create_private_dir_all(&dest)
        .map_err(|_| error("plugin_git_failed"))?;
    if !dest.join(".git").exists() {
        git(&dest, &["init", "--quiet"])?;
        git(&dest, &["remote", "add", "origin", &remote])?;
    }
    git(
        &dest,
        &[
            "fetch",
            "--depth",
            "1",
            "--no-tags",
            "--no-recurse-submodules",
            "origin",
            target,
        ],
    )?;
    git(&dest, &["checkout", "--detach", "--force", "FETCH_HEAD"])?;
    git(&dest, &["clean", "-ffd"])?;
    let sha = String::from_utf8(git(&dest, &["rev-parse", "HEAD"])?)
        .map_err(|_| error("plugin_git_failed"))?
        .trim()
        .to_owned();
    if commit.is_some_and(|s| !s.eq_ignore_ascii_case(&sha)) {
        return Err(error("plugin_git_commit_invalid"));
    }
    Ok((dest, sha))
}
pub(super) fn modes(root: &Path) -> Result<BTreeMap<String, String>> {
    let bytes = git(root, &["ls-files", "--stage", "-z"])?;
    let mut modes = BTreeMap::new();
    for record in bytes.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let record = std::str::from_utf8(record).map_err(|_| error("invalid_plugin_path"))?;
        let (meta, path) = record
            .split_once('\t')
            .ok_or_else(|| error("plugin_git_failed"))?;
        let mode = meta.split_whitespace().next().unwrap_or_default();
        if !matches!(mode, "100644" | "100755") {
            return Err(error("plugin_git_mode_refused"));
        }
        modes.insert(
            path.to_owned(),
            if mode == "100755" { "755" } else { "644" }.into(),
        );
    }
    Ok(modes)
}
pub(super) fn restore_modes(files: &mut [FileRecord], originals: &[FileRecord]) {
    let modes = originals
        .iter()
        .map(|f| (f.path.as_str(), f.mode.as_str()))
        .collect::<BTreeMap<_, _>>();
    for file in files {
        file.mode = butler_platform::plugin_files::git_mode(
            &file.mode,
            modes.get(file.path.as_str()).copied(),
        );
    }
}

pub(super) fn track(
    users: &mut BTreeMap<String, std::collections::BTreeSet<String>>,
    url: &str,
    user: &str,
    add: bool,
) {
    if add {
        users
            .entry(url.to_owned())
            .or_default()
            .insert(user.to_owned());
    } else if let Some(set) = users.get_mut(url) {
        set.remove(user);
        if set.is_empty() {
            users.remove(url);
        }
    }
}
pub(super) fn track_registry(
    users: &mut BTreeMap<String, std::collections::BTreeSet<String>>,
    id: &str,
    registry: &TeamRegistry,
    add: bool,
) {
    let user = format!("registry:{id}");
    track(users, &registry.url, &user, add);
    for entry in registry.entries.values() {
        track(users, &entry.git, &user, add);
    }
}
pub(super) fn users(registry: &Registry) -> BTreeMap<String, std::collections::BTreeSet<String>> {
    let mut users = BTreeMap::new();
    for (id, p) in &registry.plugins {
        track_plugin(&mut users, id, p, true);
    }
    for (id, r) in &registry.registries {
        track_registry(&mut users, id, r, true);
    }
    users
}

pub(super) fn track_plugin(
    users: &mut BTreeMap<String, std::collections::BTreeSet<String>>,
    id: &str,
    plugin: &Installed,
    add: bool,
) {
    let user = format!("plugin:{id}");
    for version in std::iter::once(plugin).chain(plugin.previous.as_deref()) {
        if let Some(pin) = &version.pin {
            track(users, &pin.git, &user, add);
        }
    }
}
