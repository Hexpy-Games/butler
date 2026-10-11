//! Settings → Security → import from other browsers (host only). Bookmarks
//! come from a detected profile or an HTML export; passwords only from the
//! browser's own CSV export, straight into the keychain-backed sign-in store.
//! Answers and the audit carry counts only, never a value.
mod exports;
mod oneclick;
mod selection;
mod sources;
use super::{HttpError, HttpState, json, read_body_with_limit, signin_secrets, signins};
use crate::gateway::protocol::{APP_PROTOCOL_VERSION, ApiEnvelope};
use crate::gateway::{AppSignInCommand, AppSignInUpsert};
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::response::Response;
use butler_platform::browser_profiles::{
    BookmarkFormat, BrowserProfile, detect, read_safari_bookmarks,
};
use butler_runtime::browser_import::{self as import, Bookmark, ImportError, PasswordRow};
pub(super) use exports::ImportSessions;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let mut body = if method == Method::POST {
        let bytes = zeroize::Zeroizing::new(
            read_body_with_limit(request.into_body(), 16 * 1024)
                .await?
                .to_vec(),
        );
        serde_json::from_slice::<Value>(&bytes).map_err(|_| HttpError::invalid_json())?
    } else {
        Value::Null
    };
    let data = match (&method, path.as_str()) {
        (&Method::GET, "/security/browser-import/sources") => sources::list(&state).await?,
        (&Method::POST, "/security/browser-import/preview") => run(&state, &body, false).await?,
        (&Method::POST, "/security/browser-import/run") => run(&state, &body, true).await?,
        (&Method::POST, "/security/browser-import/start") => {
            oneclick::start(&state, &mut body).await?
        }
        (&Method::POST, "/security/browser-import/undo") => oneclick::undo(&state, &body).await?,
        (&Method::POST, "/security/browser-import/folder") => sources::pick(&state, &body).await?,
        (&Method::POST, "/security/browser-import/disk-access") => {
            blocking(butler_platform::browser_transfer::open_disk_access)
                .await?
                .map_err(native_error)?;
            json!({"ok":true})
        }
        (&Method::POST, "/security/browser-import/export") => exports::begin(&state, &body).await?,
        (&Method::POST, "/security/browser-import/export/poll") => {
            exports::poll(&state, &body).await?
        }
        (&Method::POST, "/security/browser-import/export/file") => {
            exports::file(&state, &body).await?
        }
        (&Method::POST, "/security/browser-import/export/delete") => {
            exports::delete(&state, &body).await?
        }
        (&Method::POST, "/security/browser-import/export/cancel") => {
            exports::cancel(&state, &body).await?
        }
        _ => return Err(HttpError::public(404, "not_found", "Route not found.")),
    };
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}

fn failure(code: &str) -> HttpError {
    let message = match code {
        "full_disk_access_required" => "Choose the browser folder or allow Full Disk Access.",
        "browser_locked" => "Close the browser and retry.",
        "primary_password_required" => "Enter the primary password.",
        "incorrect_primary_password" => "Incorrect primary password.",
        "password_csv_required" => "Export passwords to CSV.",
        "import_format" => "This file is not a browser export.",
        "import_too_large" => "This file is too large.",
        _ => "The file could not be read.",
    };
    HttpError::public(
        if code == "signin_unavailable" {
            409
        } else {
            422
        },
        code,
        message,
    )
}

fn import_error(error: &ImportError) -> HttpError {
    failure(match error {
        ImportError::Format => "import_format",
        ImportError::TooLarge => "import_too_large",
        ImportError::Unreadable => "import_unreadable",
        ImportError::PermissionDenied => "full_disk_access_required",
        ImportError::Locked => "browser_locked",
    })
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, HttpError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| HttpError::Internal)
}

/// A chosen export file: absolute, a regular file, within the size limit.
fn export_file(body: &Value, limit: u64) -> Result<PathBuf, HttpError> {
    let path = PathBuf::from(body["path"].as_str().unwrap_or(""));
    let meta = std::fs::metadata(&path).map_err(|_| failure("import_unreadable"))?;
    if !path.is_absolute() || !meta.is_file() {
        return Err(failure("import_unreadable"));
    }
    if meta.len() > limit {
        return Err(failure("import_too_large"));
    }
    Ok(path)
}

async fn run(state: &Arc<HttpState>, body: &Value, apply: bool) -> Result<Value, HttpError> {
    match body["kind"].as_str() {
        Some("bookmarks") => bookmarks(state, body, apply).await,
        Some("passwords") => passwords(state, body, apply).await,
        _ => Err(HttpError::public(
            400,
            "invalid_import_request",
            "Choose what to import.",
        )),
    }
}

async fn bookmarks(state: &Arc<HttpState>, body: &Value, apply: bool) -> Result<Value, HttpError> {
    let source = body["source"].as_str().unwrap_or("").to_owned();
    let request = body.clone();
    let scratch = state
        .output_data
        .clone()
        .unwrap_or_else(std::env::temp_dir)
        .join("tmp")
        .join(format!("browser-import-{}", uuid::Uuid::new_v4()));
    let items = blocking(move || {
        let file = if source.is_empty() {
            Some(export_file(&request, import::MAX_BOOKMARK_BYTES)?)
        } else {
            None
        };
        read_bookmarks(&source, file, &scratch)
    })
    .await??;
    let folders = items
        .iter()
        .map(|item| item.folder.as_str())
        .collect::<std::collections::HashSet<_>>()
        .len();
    if !apply {
        return Ok(json!({"bookmarks": items.len(), "folders": folders}));
    }
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let saved = state
        .application
        .signins(AppSignInCommand::ImportBookmarks {
            run_id: uuid::Uuid::new_v4().to_string(),
            items: items
                .iter()
                .map(|item| import::library_item(item, &now))
                .collect(),
        })
        .await?;
    let counts = json!({"bookmarks": items.len(), "imported": saved["imported"], "existing": saved["existing"]});
    summary(state, body, "bookmarks", &counts).await?;
    Ok(counts)
}

fn read_bookmarks(
    source: &str,
    file: Option<PathBuf>,
    scratch: &std::path::Path,
) -> Result<Vec<Bookmark>, HttpError> {
    if let Some(file) = file {
        let html = std::fs::read(&file).map_err(|_| failure("import_unreadable"))?;
        let html = String::from_utf8_lossy(&html);
        return import::netscape_html(&html)
            .and_then(import::finish)
            .map_err(|e| import_error(&e));
    }
    let profile: BrowserProfile = detect()
        .into_iter()
        .find(|profile| format!("{}:{}", profile.browser, profile.id) == source)
        .ok_or_else(|| failure("import_unreadable"))?;
    let size = std::fs::metadata(&profile.bookmarks)
        .map(|meta| meta.len())
        .unwrap_or(0);
    if size > import::MAX_BOOKMARK_BYTES {
        return Err(failure("import_too_large"));
    }
    let items = match profile.format {
        BookmarkFormat::Chromium => {
            let bytes =
                std::fs::read(&profile.bookmarks).map_err(|_| failure("import_unreadable"))?;
            import::chromium(&bytes)
        }
        BookmarkFormat::Firefox => import::firefox(&profile.bookmarks, scratch),
        BookmarkFormat::Safari => match read_safari_bookmarks(&profile.bookmarks) {
            Ok(xml) => import::safari(&xml),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                return Err(failure("full_disk_access_required"));
            }
            Err(_) => Err(ImportError::Unreadable),
        },
    };
    items.and_then(import::finish).map_err(|e| import_error(&e))
}

async fn passwords(state: &Arc<HttpState>, body: &Value, apply: bool) -> Result<Value, HttpError> {
    if !signin_secrets::available(state).await {
        return Err(HttpError::public(
            409,
            "signin_unavailable",
            "Sign-ins need the system password store.",
        ));
    }
    let request = body.clone();
    let (rows, invalid) = blocking(move || {
        let file = export_file(&request, import::MAX_CSV_BYTES)?;
        let bytes = zeroize::Zeroizing::new(
            std::fs::read(&file).map_err(|_| failure("import_unreadable"))?,
        );
        import::parse_password_csv(&bytes).map_err(|e| import_error(&e))
    })
    .await??;
    let rows = unique(rows);
    let sites = rows
        .iter()
        .map(|row| row.site.as_str())
        .collect::<std::collections::HashSet<_>>()
        .len();
    if !apply {
        return Ok(json!({"passwords": rows.len(), "sites": sites, "invalid": invalid}));
    }
    let (mut inserted, mut updated, mut skipped) = (0_u64, 0_u64, 0_u64);
    for row in rows {
        let input = AppSignInUpsert {
            site: row.site,
            origin: row.origin,
            username: row.username,
            source: "import".into(),
            import_run: None,
        };
        match signins::store(state, input, row.password).await?["action"].as_str() {
            Some("inserted") => inserted += 1,
            Some("skipped") => skipped += 1,
            _ => updated += 1,
        }
    }
    let counts =
        json!({"imported": inserted, "updated": updated, "skipped": skipped, "invalid": invalid});
    summary(state, body, "passwords", &counts).await?;
    Ok(counts)
}

/// One row per origin and username: the last one in the file wins.
fn unique(rows: Vec<PasswordRow>) -> Vec<PasswordRow> {
    let mut last = std::collections::HashMap::new();
    for (index, row) in rows.iter().enumerate() {
        last.insert((row.origin.clone(), row.username.clone()), index);
    }
    rows.into_iter()
        .enumerate()
        .filter(|(index, row)| last.get(&(row.origin.clone(), row.username.clone())) == Some(index))
        .map(|(_, row)| row)
        .collect()
}

async fn summary(
    state: &Arc<HttpState>,
    body: &Value,
    kind: &str,
    counts: &Value,
) -> Result<(), HttpError> {
    let source = body["source"]
        .as_str()
        .filter(|s| s.len() <= 64)
        .unwrap_or("file")
        .to_owned();
    state
        .application
        .signins(AppSignInCommand::ImportSummary {
            source,
            kind: kind.into(),
            counts: counts.clone(),
        })
        .await?;
    Ok(())
}

fn native_error(error: butler_platform::browser_transfer::ImportError) -> HttpError {
    use butler_platform::browser_transfer::ImportError as E;
    failure(match error {
        E::PermissionDenied => "full_disk_access_required",
        E::NotFound => "import_not_found",
        E::Locked => "browser_locked",
        E::PrimaryPassword => "primary_password_required",
        E::IncorrectPassword => "incorrect_primary_password",
        E::CsvRequired => "password_csv_required",
        E::TooLarge => "import_too_large",
        E::Keychain => "source_keychain_failed",
        E::Format => "import_format",
    })
}
