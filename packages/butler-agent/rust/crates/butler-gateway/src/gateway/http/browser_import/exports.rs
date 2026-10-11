//! Scoped export sessions: event-driven watch, automatic import, consented deletion.
use super::{HttpError, HttpState, blocking, failure, import, native_error, oneclick};
use butler_platform::browser_transfer::DownloadWatch;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

#[derive(Default)]
pub(in crate::gateway::http) struct ImportSessions {
    pub(in crate::gateway::http) folders:
        Mutex<HashMap<String, butler_platform::browser_profiles::BrowserProfile>>,
    watches: Mutex<HashMap<String, Arc<Mutex<Export>>>>,
}
struct Export {
    watch: Option<DownloadWatch>,
    path: Option<PathBuf>,
    digest: Option<Vec<u8>>,
    result: Option<Value>,
    run: String,
    source: String,
    expires: Instant,
}

pub(super) async fn begin(state: &Arc<HttpState>, body: &Value) -> Result<Value, HttpError> {
    if !super::signin_secrets::available(state).await {
        return Err(failure("signin_unavailable"));
    }
    let source = body["source"].as_str().unwrap_or("file").to_owned();
    let run = body["run_id"]
        .as_str()
        .filter(|s| uuid::Uuid::parse_str(s).is_ok())
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let open = body["open"].as_bool().unwrap_or(true);
    let browser = source.split(':').next().unwrap_or("file").to_owned();
    let watch = blocking(move || {
        let watch = DownloadWatch::start()?;
        if open {
            butler_platform::browser_transfer::export_instructions(&browser)?;
        }
        Ok::<_, butler_platform::browser_transfer::ImportError>(watch)
    })
    .await?
    .map_err(native_error)?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut watches = state.browser_import.watches.lock().await;
    watches.retain(|_, session| {
        session
            .try_lock()
            .map_or(true, |s| s.result.is_some() || s.expires > Instant::now())
    });
    if watches.len() >= 8 {
        return Err(failure("import_busy"));
    }
    watches.insert(
        id.clone(),
        Arc::new(Mutex::new(Export {
            watch: Some(watch),
            path: None,
            digest: None,
            result: None,
            run: run.clone(),
            source,
            expires: Instant::now() + Duration::from_secs(180),
        })),
    );
    drop(watches);
    let weak = Arc::downgrade(state);
    let expiry_id = id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(180)).await;
        if let Some(state) = weak.upgrade() {
            expire_waiting(&state, &expiry_id).await;
        }
    });
    Ok(json!({"export_id":id,"run_id":run}))
}

/// Stop abandoned watches, retaining completed receipts until the UI cancels them.
async fn expire_waiting(state: &Arc<HttpState>, id: &str) {
    let session = state.browser_import.watches.lock().await.get(id).cloned();
    if let Some(session) = session {
        let mut export = session.lock().await;
        if export.result.is_none() {
            export.watch = None;
            state.browser_import.watches.lock().await.remove(id);
        }
    }
}

async fn session(state: &Arc<HttpState>, body: &Value) -> Result<Arc<Mutex<Export>>, HttpError> {
    let id = body["export_id"].as_str().unwrap_or_default();
    state
        .browser_import
        .watches
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| failure("import_not_found"))
}

pub(super) async fn poll(state: &Arc<HttpState>, body: &Value) -> Result<Value, HttpError> {
    let session = session(state, body).await?;
    let mut export = session.lock().await;
    if let Some(result) = &export.result {
        return Ok(result.clone());
    }
    let watch = export
        .watch
        .take()
        .ok_or_else(|| failure("import_not_found"))?;
    let (watch, next) = blocking(move || {
        let next = watch.next_csv();
        (watch, next)
    })
    .await?;
    export.watch = Some(watch);
    let Some(path) = next.map_err(native_error)? else {
        return Ok(json!({"waiting":true}));
    };
    match import_file(state, &mut export, path, &body["export_id"]).await {
        Err(HttpError::Public { code, .. }) if code == "import_format" => {
            Ok(json!({"waiting":true}))
        }
        result => result,
    }
}

pub(super) async fn file(state: &Arc<HttpState>, body: &Value) -> Result<Value, HttpError> {
    let session = session(state, body).await?;
    let mut export = session.lock().await;
    if let Some(result) = &export.result {
        return Ok(result.clone());
    }
    let request = body.clone();
    let path = blocking(move || super::export_file(&request, import::MAX_CSV_BYTES)).await??;
    import_file(state, &mut export, path, &body["export_id"]).await
}

async fn import_file(
    state: &Arc<HttpState>,
    export: &mut Export,
    path: PathBuf,
    export_id: &Value,
) -> Result<Value, HttpError> {
    let file = path.clone();
    let (rows, digest) = blocking(move || {
        let bytes = butler_platform::browser_transfer::read(&file, import::MAX_CSV_BYTES)
            .map_err(native_error)?;
        let digest = Sha256::digest(&bytes).to_vec();
        let rows = import::parse_password_csv(&bytes)
            .map_err(|e| super::import_error(&e))?
            .0;
        Ok::<_, HttpError>((rows, digest))
    })
    .await??;
    let mut counts = oneclick::save(state, &export.run, Vec::new(), rows).await?;
    counts["run_id"] = json!(export.run);
    counts["export_id"] = export_id.clone();
    oneclick::audit(state, &export.source, &counts).await?;
    export.path = Some(path);
    export.digest = Some(digest);
    export.result = Some(counts.clone());
    export.watch = None;
    Ok(counts)
}

pub(super) async fn delete(state: &Arc<HttpState>, body: &Value) -> Result<Value, HttpError> {
    let session = session(state, body).await?;
    let mut export = session.lock().await;
    let path = export
        .path
        .clone()
        .ok_or_else(|| failure("import_not_found"))?;
    let digest = export
        .digest
        .clone()
        .ok_or_else(|| failure("import_not_found"))?;
    blocking(move || {
        let meta = std::fs::symlink_metadata(&path).map_err(|_| failure("import_unreadable"))?;
        if !meta.is_file() {
            return Err(failure("import_file_changed"));
        }
        let bytes = butler_platform::browser_transfer::read(&path, import::MAX_CSV_BYTES)
            .map_err(native_error)?;
        if Sha256::digest(&bytes).as_slice() != digest {
            return Err(failure("import_file_changed"));
        }
        std::fs::remove_file(path).map_err(|_| failure("import_unreadable"))
    })
    .await??;
    export.path = None;
    Ok(json!({"deleted":true}))
}
pub(super) async fn cancel(state: &Arc<HttpState>, body: &Value) -> Result<Value, HttpError> {
    state
        .browser_import
        .watches
        .lock()
        .await
        .remove(body["export_id"].as_str().unwrap_or_default());
    Ok(json!({"cancelled":true}))
}
