//! Runs only on the agent worker or its blocking pool.
use super::{Budget, FILE_LIMIT, Notice, Origin, SESSION_LIMIT, Totals};
use futures::channel::{mpsc, oneshot};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::Ordering,
};

pub(super) async fn transfer(
    client: &butler_shell_client::ShellClient,
    origin: &Origin,
    name: String,
    budget: Budget,
    path: PathBuf,
    notices: mpsc::UnboundedSender<Notice>,
    receive: oneshot::Receiver<(bool, u64)>,
) -> Result<Value, &'static str> {
    let load_budget = budget.clone();
    let budget_path = path.clone();
    let totals = blocking(move || load(&load_budget, &budget_path)).await?;
    budget_changed(&notices, totals).await;
    if origin.cancelled.load(Ordering::Acquire) {
        return Err("download_interrupted");
    }
    let session = origin
        .owner
        .strip_prefix("conversation:")
        .ok_or("download_workspace_unavailable")?;
    let context = client
        .browser_host_downloads(
            &json!({"op":"prepare","session":session,"tab":origin.tab.0.as_ref()}),
        )
        .await
        .map_err(|_| "download_workspace_unavailable")?;
    let workspace = context["workspace_path"]
        .as_str()
        .ok_or("download_workspace_unavailable")?
        .to_owned();
    let (directory, name) = blocking(move || prepare(&workspace, &name)).await?;
    let (completed, bytes) = receive.await.map_err(|_| "download_interrupted")?;
    if !completed || origin.cancelled.load(Ordering::Acquire) {
        return Err("download_interrupted");
    }
    let stored = origin.clone();
    let (name, totals) =
        blocking(move || finish(&stored, &directory, name, bytes, &budget, &path)).await?;
    budget_changed(&notices, totals).await;
    if origin.cancelled.load(Ordering::Acquire) {
        return Err("download_interrupted");
    }
    let output = client
        .browser_host_downloads(
            &json!({"op":"publish","session":session,"tab":origin.tab.0.as_ref(),
        "filename":name,"turn_id":context["turn_id"],"message_id":context["message_id"]}),
        )
        .await
        .map_err(|_| "download_storage_failed")?;
    let mut event =
        json!({"type":"download_completed","path":format!("downloads/{name}"),"size_bytes":bytes});
    if let Some(output) = output.as_object() {
        for (key, value) in output {
            event[key] = value.clone();
        }
    }
    Ok(event)
}
async fn budget_changed(notices: &mpsc::UnboundedSender<Notice>, totals: Totals) {
    let (send, receive) = oneshot::channel();
    let _ = notices.unbounded_send(Notice::Budget(totals, send));
    let _ = receive.await;
}
pub(super) fn failure(reason: &str) -> Value {
    if matches!(
        reason,
        "download_file_limit"
            | "download_session_limit"
            | "download_workspace_unavailable"
            | "download_symlink_refused"
    ) {
        json!({"type":"download_refused","reason":reason,"file_limit_bytes":FILE_LIMIT,"session_limit_bytes":SESSION_LIMIT})
    } else {
        json!({"type":"download_failed","reason":reason})
    }
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, &'static str> + Send + 'static,
) -> Result<T, &'static str> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| "download_storage_failed")?
}
fn prepare(workspace: &str, source: &str) -> Result<(PathBuf, String), &'static str> {
    let root = butler_platform::secure_fs::canonicalize(Path::new(workspace))
        .map_err(|_| "download_workspace_unavailable")?;
    let directory = root.join("downloads");
    fs::create_dir_all(&directory).map_err(|_| "download_storage_failed")?;
    if butler_platform::secure_fs::canonicalize(&directory)
        .map_err(|_| "download_storage_failed")?
        != directory
    {
        return Err("download_symlink_refused");
    }
    let clean: String = source
        .chars()
        .map(|c| if (c as u32) < 32 { '_' } else { c })
        .collect();
    let mut name: String = clean
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .chars()
        .map(|c| if "<>:\"|?*".contains(c) { '_' } else { c })
        .collect();
    name.truncate(name.trim_end_matches(['.', ' ']).len());
    if name.is_empty() {
        name = "download".into();
    }
    while name.len() > 180 {
        name.pop();
    }
    let lower = name.to_ascii_lowercase();
    let stem = lower.split('.').next().unwrap_or("");
    if matches!(stem, "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        name.insert(0, '_');
    }
    Ok((directory, name))
}
fn finish(
    origin: &Origin,
    directory: &Path,
    mut name: String,
    bytes: u64,
    budget: &Budget,
    path: &Path,
) -> Result<(String, Totals), &'static str> {
    let mut budget = budget.lock().map_err(|_| "download_storage_failed")?;
    let totals = budget.as_mut().ok_or("download_storage_failed")?;
    if bytes > FILE_LIMIT {
        return Err("download_file_limit");
    }
    if totals.get(&origin.owner).copied().unwrap_or(0) + bytes > SESSION_LIMIT {
        return Err("download_session_limit");
    }
    if origin.cancelled.load(Ordering::Acquire) {
        return Err("download_interrupted");
    }
    if let Some(result) = butler_platform::secure_fs::restrict_file(&origin.stage) {
        result.map_err(|_| "download_storage_failed")?;
    }
    let copy = |name: &str| -> io::Result<()> {
        let mut source = fs::File::open(&origin.stage)?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        butler_platform::secure_fs::owner_only(&mut options);
        let mut target = options.open(directory.join(name))?;
        io::copy(&mut source, &mut target)?;
        Ok(())
    };
    if let Err(error) = copy(&name) {
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err("download_storage_failed");
        }
        name = format!("{}-{name}", uuid::Uuid::new_v4());
        copy(&name).map_err(|_| "download_storage_failed")?;
    }
    *totals.entry(origin.owner.clone()).or_default() += bytes;
    origin.accounted.store(true, Ordering::Release);
    let parent = path.parent().ok_or("download_storage_failed")?;
    butler_platform::secure_fs::create_private_dir_all(parent)
        .map_err(|_| "download_storage_failed")?;
    let temporary = path.with_extension("json.tmp");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    butler_platform::secure_fs::owner_only(&mut options);
    let file = options
        .open(&temporary)
        .map_err(|_| "download_storage_failed")?;
    serde_json::to_writer(file, totals).map_err(|_| "download_storage_failed")?;
    fs::rename(temporary, path).map_err(|_| "download_storage_failed")?;
    Ok((name, totals.clone()))
}
fn load(load_budget: &Budget, budget_path: &Path) -> Result<Totals, &'static str> {
    let mut budget = load_budget.lock().map_err(|_| "download_storage_failed")?;
    if budget.is_none() {
        *budget = Some(match fs::read(budget_path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "download_storage_failed")?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => HashMap::new(),
            Err(_) => return Err("download_storage_failed"),
        });
    }
    Ok(budget.clone().unwrap_or_default())
}
