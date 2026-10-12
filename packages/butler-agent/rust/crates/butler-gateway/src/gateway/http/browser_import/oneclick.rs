//! One action reads selected data first, then writes it with a durable undo receipt.
use super::{
    HttpError, HttpState, blocking, failure, import, signin_secrets, signins, sources, unique,
};
use crate::gateway::{AppHistoryCommand, AppLibraryCommand, AppSignInCommand, AppSignInUpsert};
use butler_platform::secrets::SecretText;
use serde_json::{Value, json};
use std::sync::Arc;

pub(super) async fn start(state: &Arc<HttpState>, body: &mut Value) -> Result<Value, HttpError> {
    let object = body
        .as_object_mut()
        .ok_or_else(|| failure("invalid_import_request"))?;
    let primary = match object.remove("primary_password").unwrap_or(Value::Null) {
        Value::String(s) => SecretText::new(s),
        _ => SecretText::new(String::new()),
    };
    let source = body["source"].as_str().unwrap_or("file").to_owned();
    let wants_bookmarks = body["bookmarks"].as_bool().unwrap_or(true);
    let wants_passwords = body["passwords"].as_bool().unwrap_or(true);
    if wants_passwords && !signin_secrets::available(state).await {
        return Err(failure("signin_unavailable"));
    }
    let profile = if source == "file" {
        None
    } else {
        Some(sources::resolve(state, &source).await?)
    };
    let csv = wants_passwords
        && profile
            .as_ref()
            .is_some_and(|p| butler_platform::browser_transfer::password_mode(p) == "csv");
    let request = body.clone();
    let scratch = state
        .output_data
        .clone()
        .unwrap_or_else(std::env::temp_dir)
        .join("tmp")
        .join(format!("browser-import-{}", uuid::Uuid::new_v4()));
    let selection = super::selection::Selection {
        profile,
        keys: state.import_dependencies.keys.clone(),
        items: super::selection::Items {
            bookmarks: wants_bookmarks,
            passwords: wants_passwords,
            history: body["history"].as_bool().unwrap_or(false),
        },
        csv,
        request,
        primary,
        scratch,
    };
    let super::selection::SelectedData {
        bookmarks,
        passwords,
        mut history,
        invalid,
    } = blocking(move || selection.read()).await??;
    let run = uuid::Uuid::new_v4().to_string();
    let mut counts = save(state, &run, bookmarks, passwords).await?;
    for visit in &mut history {
        visit["source"] = json!(format!("imported:{run}"));
    }
    let recorded = state
        .application
        .library(AppLibraryCommand::History(AppHistoryCommand::Record(
            history,
        )))
        .await?;
    counts["invalid"] = json!(invalid);
    counts["history"] = recorded["recorded"].clone();
    counts["run_id"] = json!(run);
    counts["needs_csv"] = json!(csv);
    audit(state, &source, &counts).await?;
    Ok(counts)
}

pub(super) async fn save(
    state: &Arc<HttpState>,
    run: &str,
    bookmarks: Vec<import::Bookmark>,
    passwords: Vec<import::PasswordRow>,
) -> Result<Value, HttpError> {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let saved = state
        .application
        .signins(AppSignInCommand::ImportBookmarks {
            items: bookmarks
                .iter()
                .map(|b| import::library_item(b, &now))
                .collect(),
            run_id: run.into(),
        })
        .await?;
    let (mut inserted, mut updated, mut existing) = (0_u64, 0_u64, 0_u64);
    for row in unique(passwords) {
        let input = AppSignInUpsert {
            site: row.site,
            origin: row.origin,
            username: row.username,
            source: "import".into(),
            import_run: Some(run.into()),
            modified_ms: row.modified_ms,
        };
        match signins::store(state, input, row.password).await {
            Ok(saved) if saved["action"] == "inserted" => inserted += 1,
            Ok(saved) if saved["action"] == "skipped" => existing += 1,
            Ok(_) => updated += 1,
            Err(_) => {
                return Ok(
                    json!({"bookmarks":saved["imported"],"existing":saved["existing"].as_u64().unwrap_or(0)+existing,"passwords":inserted,"updated":updated,"error":"signin_store_failed"}),
                );
            }
        }
    }
    Ok(
        json!({"bookmarks":saved["imported"],"existing":saved["existing"].as_u64().unwrap_or(0)+existing,"passwords":inserted,"updated":updated}),
    )
}

pub(super) async fn audit(
    state: &Arc<HttpState>,
    source: &str,
    counts: &Value,
) -> Result<(), HttpError> {
    // Browser identifier only: no profile names, paths, usernames or receipt IDs.
    let source = source
        .split(':')
        .next()
        .filter(|s| {
            matches!(
                *s,
                "chrome"
                    | "chromium"
                    | "edge"
                    | "brave"
                    | "arc"
                    | "whale"
                    | "firefox"
                    | "zen"
                    | "safari"
            )
        })
        .unwrap_or("file");
    state.application.signins(AppSignInCommand::ImportSummary { source:source.into(), kind:"browser".into(), counts:json!({"bookmarks":counts["bookmarks"],"passwords":counts["passwords"],"updated":counts["updated"],"existing":counts["existing"],"history":counts["history"],"invalid":counts["invalid"]}) }).await?;
    Ok(())
}

pub(super) async fn undo(state: &Arc<HttpState>, body: &Value) -> Result<Value, HttpError> {
    let run = body["run_id"]
        .as_str()
        .filter(|s| uuid::Uuid::parse_str(s).is_ok())
        .ok_or_else(|| failure("invalid_import_request"))?;
    let _mutation = state.signin_secrets.mutation.lock().await;
    let rows = state
        .application
        .signins(AppSignInCommand::ImportAdditions { run_id: run.into() })
        .await?;
    let (mut bookmarks, mut passwords, mut updated) = (0_u64, 0_u64, 0_u64);
    for row in rows["items"].as_array().into_iter().flatten() {
        let id = row["id"].as_str().unwrap_or_default();
        if row["kind"] == "bookmarks" {
            let result = state
                .application
                .signins(AppSignInCommand::UndoBookmark {
                    run_id: run.into(),
                    id: id.into(),
                })
                .await?;
            if result["deleted"] == true {
                bookmarks += 1;
            }
        } else if row["kind"] == "updated" {
            if super::password_undo::restore(state, row, run).await? {
                updated += 1;
            }
        } else if row["current"] != true {
            state
                .application
                .signins(AppSignInCommand::ForgetAddition {
                    run_id: run.into(),
                    kind: "passwords".into(),
                    id: id.into(),
                })
                .await?;
        } else {
            signin_secrets::delete(state, id).await?;
            let result = state
                .application
                .signins(AppSignInCommand::Forget { id: id.into() })
                .await?;
            if result["removed"] == true {
                passwords += 1;
            }
        }
    }
    let history = state
        .application
        .library(AppLibraryCommand::History(AppHistoryCommand::UndoImport(
            run.into(),
        )))
        .await?;
    let counts = json!({"bookmarks":bookmarks,"passwords":passwords,"history":history["deleted"],"updated":updated});
    audit(state, "file", &counts).await?;
    Ok(counts)
}
