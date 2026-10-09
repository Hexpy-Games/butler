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
    pub(super) fn generate_session_title(&self, chat: String, model: String) {
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
                result = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    app.generate_title(
                        &chat,
                        &model,
                        cancellation.clone(),
                    ),
                ) => result,
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
        model: &str,
        cancellation: CancellationToken,
    ) -> Result<(), &'static str> {
        let id = chat.to_owned();
        let facts = self
            .dependencies
            .settings_facts
            .snapshot()
            .map_err(|_| "settings")?;
        let input = self
            .storage
            .read(move |db| eligible_title(db, &id, &facts))
            .await
            .map_err(|_| "storage")?;
        let Some((expected, prompt)) = input else {
            return Ok(());
        };
        let generated = self
            .dependencies
            .session_title_generator
            .generate(
                AppSessionTitleInput {
                    text: prompt,
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
    facts: &AppSettingsFacts,
) -> Result<Option<(String, String)>, AppStorageError> {
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
    // At most two users are needed to decide first-message eligibility.
    let mut statement = db
        .prepare("SELECT id,text FROM messages WHERE chat_id=?1 AND role='user' LIMIT 2")
        .map_err(AppStorageError::sqlite)?;
    let users = statement
        .query_map([id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    let [(message, text)] = users.as_slice() else {
        return Ok(None);
    };
    let mut attachments = db
        .prepare(
            "SELECT f.safe_name FROM message_attachments a JOIN message_files f ON f.id=a.file_id \
         WHERE a.message_id=?1 ORDER BY a.position",
        )
        .map_err(AppStorageError::sqlite)?;
    let names = attachments
        .query_map([message], |row| row.get::<_, String>(0))
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    let default = match settings::ui_language(db, facts)? {
        crate::gateway::ui_language::UiLanguage::English => "New chat",
        crate::gateway::ui_language::UiLanguage::Korean => "새 대화",
    };
    let provisional = provisional_input(text, &names);
    if !["New chat", "New project chat", "새 대화"].contains(&title.as_str())
        && title != provisional_title(&provisional)
    {
        return Ok(None);
    }
    Ok(Some((title, title_generation_input(text, &names, default))))
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

fn utf16_code_point_prefix(text: &str, limit: usize) -> &str {
    let mut units = 0;
    let mut end = 0;
    for (index, character) in text.char_indices() {
        let width = character.len_utf16();
        if units + width > limit {
            break;
        }
        units += width;
        end = index + character.len_utf8();
    }
    &text[..end]
}

fn provisional_input(text: &str, attachment_names: &[String]) -> String {
    if butler_core::public_text::trim_js_whitespace(text).is_empty() {
        attachment_names.first().cloned().unwrap_or_default()
    } else {
        text.to_owned()
    }
}

fn title_generation_input(text: &str, attachment_names: &[String], default: &str) -> String {
    let names = attachment_names
        .iter()
        .filter(|name| !butler_core::public_text::trim_js_whitespace(name).is_empty())
        .cloned()
        .collect::<Vec<_>>();
    if names.is_empty() {
        return if butler_core::public_text::trim_js_whitespace(text).is_empty() {
            default.to_owned()
        } else {
            text.to_owned()
        };
    }
    if butler_core::public_text::trim_js_whitespace(text).is_empty() {
        format!("Attached files: {}", names.join(", "))
    } else {
        format!("{text}\nAttached files: {}", names.join(", "))
    }
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
    if title.is_empty() || contains_product_name(title) || title.chars().any(char::is_control) {
        return None;
    }
    Some(if title.encode_utf16().count() > 64 {
        format!("{}...", utf16_code_point_prefix(title, 61))
    } else {
        title.to_owned()
    })
}

fn contains_product_name(title: &str) -> bool {
    title.contains("스튜어드")
        || title
            .split(|character: char| !character.is_alphanumeric())
            .any(|word| word == "Steward")
}
