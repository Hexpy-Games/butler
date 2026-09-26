//! Strict legacy transcript indexing. Embedding happens before the short write lease.

use std::time::{SystemTime, UNIX_EPOCH};

use tokio_util::sync::CancellationToken;

use super::*;

struct LegacyTranscriptInput<'a> {
    text: &'a str,
    session_id: &'a str,
    source_session_id: &'a str,
    project: &'a str,
    kind: &'a str,
    source: &'a str,
    topic: Option<&'a str>,
    strict: bool,
}

impl LegacyIndexService {
    pub(crate) async fn index_transcript(
        &self,
        text: &str,
        session_id: &str,
        source_session_id: &str,
        project: &str,
        cancellation: &CancellationToken,
    ) -> CognitionResult<()> {
        self.index_legacy(
            LegacyTranscriptInput {
                text,
                session_id,
                source_session_id,
                project,
                kind: "conversation",
                source: "butler",
                topic: None,
                strict: true,
            },
            cancellation,
        )
        .await
    }

    pub(crate) async fn index_hot_entry(
        &self,
        text: &str,
        session_id: &str,
        source_session_id: &str,
        project: &str,
        topic: Option<&str>,
        cancellation: &CancellationToken,
    ) -> CognitionResult<()> {
        self.index_legacy(
            LegacyTranscriptInput {
                text,
                session_id,
                source_session_id,
                project,
                kind: "hot-cache",
                source: "hot-cache",
                topic,
                strict: false,
            },
            cancellation,
        )
        .await
    }

    async fn index_legacy(
        &self,
        input: LegacyTranscriptInput<'_>,
        cancellation: &CancellationToken,
    ) -> CognitionResult<()> {
        let LegacyTranscriptInput {
            text,
            session_id,
            source_session_id: _,
            project,
            kind,
            source,
            topic,
            strict: _,
        } = input;
        let chunks = chunk_text(trim_js_whitespace(text));
        if chunks.is_empty() {
            return Ok(());
        }
        if !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return Err(error("legacy_session_id_invalid"));
        }
        let mut vectors = Vec::with_capacity(chunks.len());
        for batch in chunks.chunks(4) {
            if cancellation.is_cancelled() {
                return Err(error("memory_write_aborted"));
            }
            let result = self
                .embedding
                .embed(
                    EmbeddingRequest {
                        texts: batch.to_vec(),
                        mode: EmbeddingMode::LegacyMean,
                        resplit: false,
                        max_embeddings: None,
                        request_class: EmbeddingRequestClass::Background,
                        deadline_at_epoch_ms: None,
                    },
                    cancellation.clone(),
                )
                .await?;
            if result.embeddings.len() != batch.len() {
                return Err(error("legacy_embedding_incomplete"));
            }
            vectors.extend(result.embeddings);
        }
        if cancellation.is_cancelled() {
            return Err(error("memory_write_aborted"));
        }
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| error("legacy_clock_unavailable"))?
            .as_secs_f64();
        let rows: Vec<LegacyVectorRow> = chunks
            .into_iter()
            .zip(vectors)
            .enumerate()
            .map(|(index, (text, vector))| LegacyVectorRow {
                id: format!("{session_id}_{index}"),
                text,
                project: project.to_owned(),
                r#type: kind.into(),
                session_id: session_id.to_owned(),
                timestamp,
                hot_score: 0.0,
                source: source.into(),
                topic: topic.unwrap_or("").into(),
                vector,
            })
            .collect();
        self.commit_legacy(rows, input).await
    }

    async fn commit_legacy(
        &self,
        rows: Vec<LegacyVectorRow>,
        input: LegacyTranscriptInput<'_>,
    ) -> CognitionResult<()> {
        let LegacyTranscriptInput {
            text,
            session_id,
            source_session_id,
            project,
            source,
            topic,
            strict,
            ..
        } = input;
        let memory_root = self.paths.memory_root(&self.data_root);
        let db_root = memory_root.join("db");
        let lock = self.paths.consolidation_lock(&self.data_root);
        let temp = db_root.join(format!("vector-stats.json.tmp-{}", uuid::Uuid::new_v4()));
        let graph = db_root.join("graph.sqlite");
        let lance = db_root.join("butler.lance");
        let provenance = db_root.join("session-provenance.jsonl");
        let stats = db_root.join("vector-stats.json");
        ensure_data_authority(
            &self.data_root,
            &[
                &self.paths.cognition_root(&self.data_root),
                &memory_root,
                &db_root,
                &lock,
                &graph,
                &graph.with_extension("sqlite-wal"),
                &graph.with_extension("sqlite-shm"),
                &lance,
                &provenance,
                &stats,
                &temp,
                &self.data_root.join("logs/memory.log"),
            ],
        )?;
        let lease = self
            .coordinator
            .acquire(
                CognitionWriteAcquire::immediate(lock, "legacy-session-sync"),
                CognitionWaitClass::Background,
            )
            .await
            .map_err(CognitionError::from)?
            .ok_or_else(|| error("memory_write_busy"))?;
        // Once the Lance mutation begins, keep the lease until all writes finish.
        let row_count = match self.writer.upsert_session(&lease, session_id, &rows).await {
            Ok(count) => count,
            Err(failure) => {
                let _ = lease.release(false);
                return Err(failure);
            }
        };
        let data_root = self.data_root.clone();
        let text = text.to_owned();
        let session_id = session_id.to_owned();
        let source_session_id = source_session_id.to_owned();
        let project = project.to_owned();
        let source = source.to_owned();
        let topic = topic.map(str::to_owned);
        let chunks = rows.len();
        tokio::task::spawn_blocking(move || {
            let result = receipts::record_legacy(receipts::LegacyReceiptInput {
                data_root: &data_root,
                memory_root: &memory_root,
                text: &text,
                session_id: &session_id,
                source_session_id: &source_session_id,
                project: &project,
                source: &source,
                topic: topic.as_deref(),
                strict,
                chunk_count: chunks,
                row_count,
                temp: &temp,
            });
            let release = lease.release(result.is_ok()).map_err(CognitionError::from);
            match (result, release) {
                (Err(failure), _) | (Ok(()), Err(failure)) => Err(failure),
                (Ok(()), Ok(())) => Ok(()),
            }
        })
        .await
        .map_err(|_| error("legacy_session_receipt_failed"))?
    }
}
