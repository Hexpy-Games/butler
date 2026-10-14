//! Cache a completed probe for this boot and helper build, outside scratch.
use super::Tier;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::SystemTime;

#[derive(Serialize, Deserialize, PartialEq)]
struct Key {
    boot: String,
    helper: std::path::PathBuf,
    modified: SystemTime,
    uid: u32,
}

pub(super) fn probe(helper: &Path) -> Tier {
    let key = key(helper);
    let cache = std::env::var_os("BUTLER_DATA")
        .map(|data| std::path::PathBuf::from(data).join("sandbox-mountns-probe.json"));
    if let (Some(key), Some(path)) = (&key, &cache)
        && let Ok(bytes) = std::fs::read(path)
        && let Ok((cached, available)) = serde_json::from_slice::<(Key, Tier)>(&bytes)
        && cached == *key
    {
        return available;
    }
    let available = run_probe(helper);
    // Hint only: mask() must complete before granting the project root.
    if let (Some(key), Some(path)) = (key, cache)
        && let Ok(bytes) = serde_json::to_vec(&(key, available))
    {
        let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
        if std::fs::write(&temporary, bytes).is_ok() {
            let _ = std::fs::rename(&temporary, path);
            let _ = std::fs::remove_file(temporary);
        }
    }
    available
}

fn key(helper: &Path) -> Option<Key> {
    Some(Key {
        boot: std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?,
        helper: helper.canonicalize().ok()?,
        modified: std::fs::metadata(helper).ok()?.modified().ok()?,
        uid: nix::unistd::getuid().as_raw(),
    })
}

fn run_probe(helper: &Path) -> Tier {
    let child = std::process::Command::new(helper)
        .arg("--probe-mountns-child")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();
    let Ok(child) = child else {
        return Tier::L;
    };
    let pid = child.id();
    let output = child.wait_with_output();
    // Also recover a backing directory if the child exited before cleanup.
    let _ = std::fs::remove_dir(std::env::temp_dir().join(format!("butler-mount-probe-{pid}")));
    output
        .ok()
        .filter(|output| output.status.success())
        .map_or(Tier::L, |output| match output.stdout.as_slice() {
            b"M\n" => Tier::M,
            _ => Tier::L,
        })
}
