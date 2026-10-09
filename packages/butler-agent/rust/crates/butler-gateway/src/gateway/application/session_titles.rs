//! First-message titles: bounded background work with rename-safe persistence.
use super::*;
use rusqlite::{Connection, OptionalExtension};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

#[derive(Clone, Default)]
pub(super) struct SessionTitleOwner {
    tasks: TaskTracker,
    cancellation: CancellationToken,
}

impl SessionTitleOwner {
    pub(super) async fn close(&self) {
        self.cancellation.cancel();
        self.tasks.close();
        self.tasks.wait().await;
    }
}

impl AppApplication {
    pub(super) fn generate_session_title(&self, chat: String, text: String, model: String) {
        if chat == "general" || chat.starts_with("steward-") || chat.starts_with("worker-") {
            return;
        }
        let app = self.clone_handle();
        let cancellation = self.session_titles.cancellation.child_token();
        self.session_titles.tasks.spawn(async move {
            let result = tokio::select! {
                biased;
                () = cancellation.cancelled() => return,
                () = app.dependencies.service_shutdown.cancelled() => { cancellation.cancel(); return },
                result = tokio::time::timeout(std::time::Duration::from_secs(5),
                    app.generate_title(&chat, &text, &model, cancellation.clone())) => result,
            };
            cancellation.cancel();
            let reason = match result {
                Err(_) => Some("timeout"),
                Ok(Err(reason)) => Some(reason),
                Ok(Ok(())) => None,
            };
            if let Some(reason) = reason {
                eprintln!("WARN [session-title] chat={chat} model={model} reason={reason}");
            }
        });
    }

    async fn generate_title(
        &self,
        chat: &str,
        text: &str,
        model: &str,
        cancellation: CancellationToken,
    ) -> Result<(), &'static str> {
        let id = chat.to_owned();
        let prompt = text.to_owned();
        let expected = self
            .storage
            .read(move |db| eligible_title(db, &id, &prompt))
            .await
            .map_err(|_| "storage")?;
        let Some(expected) = expected else {
            return Ok(());
        };
        let generated = self
            .dependencies
            .session_title_generator
            .generate(
                AppSessionTitleInput {
                    text: text.to_owned(),
                    model_ref: model.to_owned(),
                },
                cancellation.clone(),
            )
            .await
            .map_err(|_| "provider")?;
        let title = normalized_title(&generated).ok_or("invalid_output")?;
        if cancellation.is_cancelled() {
            return Ok(());
        }
        let id = chat.to_owned();
        let clock = self.dependencies.identity_clock.clone();
        let subscribers = self.subscribers.clone();
        self.storage
            .execute(move |db| {
                if cancellation.is_cancelled() {
                    return Ok(());
                }
                sessions::compare_and_set_title(
                    db,
                    &subscribers,
                    &id,
                    &expected,
                    &title,
                    clock.as_ref(),
                )
            })
            .await
            .map_err(|_| "storage")
    }
}

fn eligible_title(
    db: &Connection,
    id: &str,
    text: &str,
) -> Result<Option<String>, AppStorageError> {
    let title = db
        .query_row(
            "SELECT title FROM chats c WHERE id=?1 AND kind IN ('chat','project') AND archived=0 \
         AND NOT EXISTS(SELECT 1 FROM app_session_branches WHERE target_session_id=c.id) \
         AND NOT EXISTS(SELECT 1 FROM app_automations WHERE target_session_id=c.id)",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let Some(title) = title else { return Ok(None) };
    if !["New chat", "New project chat", "새 대화"].contains(&title.as_str())
        && title != provisional_title(text)
    {
        return Ok(None);
    }
    let count: i64 = db.query_row(
        "SELECT COUNT(*) FROM (SELECT id FROM messages WHERE chat_id=?1 AND role='user' LIMIT 2)",
        [id], |row| row.get(0),
    ).map_err(AppStorageError::sqlite)?;
    Ok((count == 1).then_some(title))
}

fn collapsed(text: &str) -> String {
    // ECMAScript \s includes BOM but excludes U+0085 (Rust whitespace differs).
    text.split(butler_core::public_text::is_js_whitespace)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn utf16_prefix(text: &str, limit: usize) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(limit).collect::<Vec<_>>())
}

fn provisional_title(text: &str) -> String {
    let first = butler_core::public_text::trim_js_whitespace(text)
        .split_once('\n')
        .map_or_else(
            || butler_core::public_text::trim_js_whitespace(text),
            |(first, _)| first,
        );
    let title = collapsed(first);
    if title.is_empty() {
        "새 대화".into()
    } else if title.encode_utf16().count() > 48 {
        format!("{}...", utf16_prefix(&title, 45))
    } else {
        title
    }
}

fn normalized_title(text: &str) -> Option<String> {
    let title = collapsed(text);
    let title = title
        .trim_start_matches(['"', '\'', '`'])
        .trim_end_matches(['"', '\'', '`', '.'])
        .trim_start_matches('#')
        .trim();
    if title.is_empty()
        || title.to_lowercase().contains("steward")
        || title.contains("스튜어드")
        || title.chars().any(char::is_control)
    {
        return None;
    }
    Some(if title.encode_utf16().count() > 64 {
        format!("{}...", utf16_prefix(title, 61))
    } else {
        title.to_owned()
    })
}
