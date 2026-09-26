use std::future::Future;

use rusqlite::{Connection, params};
use tokio::sync::mpsc;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::gateway::GatewayApplicationError;
use crate::public_text::trim_js_whitespace;

use super::storage::AppStorage;
use super::{AppApplication, AppChatKind, AppStorageError, app_error};

pub(crate) const MAX_SESSION_MESSAGE_PAGE_SIZE: usize = 200;
const MAX_TRANSCRIPT_EXPORT_PAGES: usize = 100_000;
const TRANSCRIPT_EXPORT_TEXT_CHUNK_SIZE: usize = 64 * 1024;
const TRANSCRIPT_EXPORT_CHANNEL_CAPACITY: usize = 1;

pub(crate) struct TranscriptExport {
    pub session_id: String,
    pub format: String,
    pub filename: String,
    pub generated_at: String,
    pub chunks: mpsc::Receiver<Result<TranscriptExportChunk, GatewayApplicationError>>,
}

pub(crate) struct TranscriptExportChunk {
    pub text: String,
    pub message_count: usize,
}

#[derive(Clone)]
pub(crate) struct TranscriptExportOwner {
    tasks: TaskTracker,
    cancellation: CancellationToken,
}

impl TranscriptExportOwner {
    pub(crate) fn new() -> Self {
        Self {
            tasks: TaskTracker::new(),
            cancellation: CancellationToken::new(),
        }
    }

    pub(crate) fn spawn<F>(&self, future: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let cancellation = self.cancellation.clone();
        self.tasks.spawn(async move {
            tokio::select! {
                _ = cancellation.cancelled() => {}
                _ = future => {}
            }
        });
    }

    pub(crate) async fn close(&self) {
        self.cancellation.cancel();
        self.tasks.close();
        self.tasks.wait().await;
    }
}

impl AppApplication {
    pub(crate) async fn export_transcript_owned(
        &self,
        session_id: String,
    ) -> Result<TranscriptExport, GatewayApplicationError> {
        let session = self.get_session(session_id.clone()).await?;
        let generated_at = self.dependencies.identity_clock.now_iso();
        let (sender, receiver) = mpsc::channel(TRANSCRIPT_EXPORT_CHANNEL_CAPACITY);
        let title = session.title;
        let kind = session_kind(session.kind);
        let filename = format!("{}.md", safe_export_filename(&title));
        let storage = self.storage.clone();
        let export = TranscriptExport {
            session_id: session_id.clone(),
            format: "markdown".to_owned(),
            filename,
            generated_at: generated_at.clone(),
            chunks: receiver,
        };
        self.transcript_exports.spawn(async move {
            produce_transcript(storage, sender, session_id, title, kind, generated_at).await;
        });
        Ok(export)
    }
}

async fn produce_transcript(
    storage: AppStorage,
    sender: mpsc::Sender<Result<TranscriptExportChunk, GatewayApplicationError>>,
    session_id: String,
    title: String,
    kind: &'static str,
    generated_at: String,
) {
    if !send_chunk(
        &sender,
        TranscriptExportChunk {
            text: format!("# {title}\n\nSession: {kind}\nGenerated: {generated_at}\n\n"),
            message_count: 0,
        },
    )
    .await
    {
        return;
    }

    let mut after_cursor = 0_u64;
    let mut page_count = 0;
    while page_count < MAX_TRANSCRIPT_EXPORT_PAGES {
        let cursor = after_cursor;
        let page_session_id = session_id.clone();
        let page = match storage
            .execute(move |db| read_page(db, &page_session_id, cursor))
            .await
        {
            Ok(page) => page,
            Err(error) => {
                let _ = send_error(&sender, app_error(error)).await;
                return;
            }
        };

        let next_cursor = page.next_cursor;
        let has_more = page.has_more;
        if !emit_page(&sender, page).await {
            return;
        }

        if !has_more || next_cursor <= after_cursor {
            return;
        }
        after_cursor = next_cursor;
        page_count += 1;
    }
}

async fn emit_page(
    sender: &mpsc::Sender<Result<TranscriptExportChunk, GatewayApplicationError>>,
    page: TranscriptMessagePage,
) -> bool {
    for message in page.items {
        let Some(role) = transcript_role(&message.role) else {
            continue;
        };
        let mut chunk = String::with_capacity(TRANSCRIPT_EXPORT_TEXT_CHUNK_SIZE);
        chunk.push_str("## ");
        chunk.push_str(role);
        chunk.push_str("\n\n");
        for character in message.text.chars() {
            if chunk.len() + character.len_utf8() > TRANSCRIPT_EXPORT_TEXT_CHUNK_SIZE {
                if !send_chunk(
                    sender,
                    TranscriptExportChunk {
                        text: std::mem::take(&mut chunk),
                        message_count: 0,
                    },
                )
                .await
                {
                    return false;
                }
                chunk = String::with_capacity(TRANSCRIPT_EXPORT_TEXT_CHUNK_SIZE);
            }
            chunk.push(character);
        }
        chunk.push_str("\n\n");
        if !send_chunk(
            sender,
            TranscriptExportChunk {
                text: chunk,
                message_count: 1,
            },
        )
        .await
        {
            return false;
        }
    }
    true
}

async fn send_chunk(
    sender: &mpsc::Sender<Result<TranscriptExportChunk, GatewayApplicationError>>,
    chunk: TranscriptExportChunk,
) -> bool {
    sender.send(Ok(chunk)).await.is_ok()
}

async fn send_error(
    sender: &mpsc::Sender<Result<TranscriptExportChunk, GatewayApplicationError>>,
    error: GatewayApplicationError,
) -> bool {
    sender.send(Err(error)).await.is_ok()
}

struct TranscriptMessagePage {
    items: Vec<TranscriptMessage>,
    next_cursor: u64,
    has_more: bool,
}

struct TranscriptMessage {
    cursor: u64,
    role: String,
    text: String,
}

fn read_page(
    db: &Connection,
    session_id: &str,
    after_cursor: u64,
) -> Result<TranscriptMessagePage, AppStorageError> {
    let mut statement = db
        .prepare(
            "SELECT rowid,role,text FROM messages WHERE chat_id=?1 AND rowid>?2 \
             AND NOT (role='assistant' AND safe_error_code IS NOT NULL AND \
             safe_error_code IN ('app_turn_queue_failed','goal_completion_incomplete')) \
             ORDER BY rowid ASC LIMIT ?3",
        )
        .map_err(AppStorageError::sqlite)?;
    let mut items = statement
        .query_map(
            params![session_id, after_cursor, MAX_SESSION_MESSAGE_PAGE_SIZE + 1],
            |row| {
                Ok(TranscriptMessage {
                    cursor: row.get(0)?,
                    role: row.get(1)?,
                    text: row.get(2)?,
                })
            },
        )
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    let has_more = items.len() > MAX_SESSION_MESSAGE_PAGE_SIZE;
    items.truncate(MAX_SESSION_MESSAGE_PAGE_SIZE);
    let next_cursor = items.last().map_or(after_cursor, |message| message.cursor);
    Ok(TranscriptMessagePage {
        items,
        next_cursor,
        has_more,
    })
}

fn session_kind(kind: AppChatKind) -> &'static str {
    match kind {
        AppChatKind::Chat => "chat",
        AppChatKind::Project => "project",
    }
}

fn transcript_role(role: &str) -> Option<&'static str> {
    match role {
        "user" => Some("user"),
        "assistant" => Some("assistant"),
        "automation" => Some("automation"),
        "system_event" => Some("system_event"),
        _ => None,
    }
}

fn safe_export_filename(title: &str) -> String {
    let mut sanitized = String::with_capacity(title.len());
    for character in title.chars() {
        let character = if matches!(
            character,
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
        ) || character < '\u{20}'
            || character == '\u{7f}'
        {
            '-'
        } else {
            character
        };
        sanitized.push(character);
    }
    let truncated =
        String::from_utf16_lossy(&sanitized.encode_utf16().take(120).collect::<Vec<_>>());
    let trimmed = trim_js_whitespace(&truncated);
    if trimmed.is_empty() {
        "session".to_owned()
    } else {
        trimmed.to_owned()
    }
}
