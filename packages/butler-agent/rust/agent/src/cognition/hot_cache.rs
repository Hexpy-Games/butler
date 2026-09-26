//! Source-compatible legacy hot-cache indexing for the public maintenance command.

mod import;
mod legacy_graph;
mod receipts;
mod rules;
mod transcript_index;

pub(crate) use import::extract_legacy_import_transcript;

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::{
    CognitionEmbeddingPort, EmbeddingMode, EmbeddingRequest, EmbeddingRequestClass,
    LegacyLanceWriter, LegacyVectorRow,
};
use super::{
    CognitionError, CognitionPathEnvironment, CognitionResult, mutable_paths::ensure_data_authority,
};
use crate::{
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
    public_text::trim_js_whitespace,
};

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HotCacheBackfillOutcome {
    pub(crate) attempted: usize,
    pub(crate) indexed: usize,
    pub(crate) failed: usize,
    pub(crate) raw_text_included: bool,
}

pub(crate) struct LegacyIndexService {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    embedding: Arc<dyn CognitionEmbeddingPort>,
    writer: LegacyLanceWriter,
}

impl LegacyIndexService {
    pub(crate) fn new(
        data_root: PathBuf,
        paths: CognitionPathEnvironment,
        coordinator: Arc<CognitionWriteCoordinator>,
        embedding: Arc<dyn CognitionEmbeddingPort>,
    ) -> Self {
        let writer = LegacyLanceWriter::new(data_root.clone(), paths.clone());
        Self {
            data_root,
            paths,
            coordinator,
            embedding,
            writer,
        }
    }

    pub(crate) async fn backfill(
        &self,
        cancellation: &CancellationToken,
    ) -> CognitionResult<HotCacheBackfillOutcome> {
        let memory_root = self.paths.memory_root(&self.data_root);
        let hot_root = memory_root.join("hot");
        ensure_data_authority(
            &self.data_root,
            &[
                &self.paths.cognition_root(&self.data_root),
                &memory_root,
                &hot_root,
            ],
        )?;
        let files = tokio::task::spawn_blocking({
            let hot_root = hot_root.clone();
            let data_root = self.data_root.clone();
            move || list_markdown_files(&data_root, &hot_root)
        })
        .await
        .map_err(|_| error("hot_cache_read_failed"))??;
        let mut outcome = HotCacheBackfillOutcome::default();
        for file in files {
            if cancellation.is_cancelled() {
                return Err(error("memory_write_aborted"));
            }
            let raw = tokio::fs::read(&file)
                .await
                .map_err(|_| error("hot_cache_read_failed"))?;
            let decoded = String::from_utf8_lossy(&raw);
            for (index, block) in markdown_blocks(&decoded).into_iter().enumerate() {
                if cancellation.is_cancelled() {
                    return Err(error("memory_write_aborted"));
                }
                outcome.attempted += 1;
                let digest =
                    Sha256::digest(format!("{}:{index}:{block}", file.display()).as_bytes());
                let session_id = format!(
                    "hot_maintain_{}",
                    digest[..8]
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>()
                );
                match self.index_block(&block, &session_id, cancellation).await {
                    Ok(()) => outcome.indexed += 1,
                    Err(failure) if failure.code == "memory_write_aborted" => return Err(failure),
                    Err(failure) => {
                        eprintln!("Warning: hot-cache indexing failed ({})", failure.code);
                        outcome.failed += 1;
                    }
                }
            }
        }
        Ok(outcome)
    }

    async fn index_block(
        &self,
        block: &str,
        session_id: &str,
        cancellation: &CancellationToken,
    ) -> CognitionResult<()> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| error("hot_cache_clock_unavailable"))?
            .as_secs() as f64;
        let text = trim_js_whitespace(block);
        let chunks = chunk_text(text);
        if chunks.is_empty() {
            return Err(error("hot_cache_empty_block"));
        }
        let mut vectors = Vec::with_capacity(chunks.len());
        for batch in chunks.chunks(4) {
            if cancellation.is_cancelled() {
                return Err(error("memory_write_aborted"));
            }
            let request = EmbeddingRequest {
                texts: batch.to_vec(),
                mode: EmbeddingMode::LegacyMean,
                resplit: false,
                max_embeddings: None,
                request_class: EmbeddingRequestClass::Background,
                deadline_at_epoch_ms: None,
            };
            let embedded = self.embedding.embed(request, cancellation.clone()).await?;
            if embedded.embeddings.len() != batch.len() {
                return Err(error("hot_cache_embedding_incomplete"));
            }
            vectors.extend(embedded.embeddings);
        }
        if cancellation.is_cancelled() {
            return Err(error("memory_write_aborted"));
        }
        let memory_root = self.paths.memory_root(&self.data_root);
        let db_root = memory_root.join("db");
        let lock = self.paths.consolidation_lock(&self.data_root);
        let provenance = db_root.join("session-provenance.jsonl");
        let stats = db_root.join("vector-stats.json");
        let stats_temporary =
            db_root.join(format!("vector-stats.json.tmp-{}", uuid::Uuid::new_v4()));
        let graph = db_root.join("graph.sqlite");
        let graph_wal = db_root.join("graph.sqlite-wal");
        let graph_shm = db_root.join("graph.sqlite-shm");
        let lance = db_root.join("butler.lance");
        let log = self.data_root.join("logs/memory.log");
        ensure_data_authority(
            &self.data_root,
            &[
                &self.paths.cognition_root(&self.data_root),
                &memory_root,
                &db_root,
                &lock,
                &provenance,
                &stats,
                &stats_temporary,
                &graph,
                &graph_wal,
                &graph_shm,
                &lance,
                &log,
            ],
        )?;
        let lease = self
            .coordinator
            .acquire(
                CognitionWriteAcquire::immediate(lock, "hot-cache-backfill"),
                CognitionWaitClass::Background,
            )
            .await
            .map_err(|failure| CognitionError::new(failure.code, failure.message))?
            .ok_or_else(|| error("memory_write_busy"))?;
        // Once mutation starts, await it and release the lease after all writes drain.
        let rows = chunks
            .into_iter()
            .zip(vectors)
            .enumerate()
            .map(|(index, (text, vector))| LegacyVectorRow {
                id: format!("{session_id}_{index}"),
                text,
                project: "butler".into(),
                r#type: "hot-cache".into(),
                session_id: session_id.into(),
                timestamp,
                hot_score: 0.0,
                source: "hot-cache".into(),
                topic: String::new(),
                vector,
            })
            .collect::<Vec<_>>();
        let result = self.writer.upsert_session(&lease, session_id, &rows).await;
        let row_count = match result {
            Ok(value) => value,
            Err(failure) => {
                let _ = lease.release(false);
                return Err(failure);
            }
        };
        let data_root = self.data_root.clone();
        let text = text.to_owned();
        let session_id = session_id.to_owned();
        let chunk_count = rows.len();
        drop(rows);
        tokio::task::spawn_blocking(move || {
            let result = receipts::record(
                &data_root,
                &memory_root,
                &text,
                &session_id,
                chunk_count,
                row_count,
                &stats_temporary,
            );
            let release = lease
                .release(result.is_ok())
                .map_err(|failure| CognitionError::new(failure.code, failure.message));
            match (result, release) {
                (Err(failure), _) => Err(failure),
                (Ok(_), Err(failure)) => Err(failure),
                (Ok(()), Ok(())) => Ok(()),
            }
        })
        .await
        .map_err(|_| error("hot_cache_receipt_failed"))?
    }
}

fn list_markdown_files(data_root: &Path, root: &Path) -> CognitionResult<Vec<PathBuf>> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    fn visit(data_root: &Path, dir: &Path, files: &mut Vec<PathBuf>) -> CognitionResult<()> {
        ensure_data_authority(data_root, &[dir])?;
        for entry in fs::read_dir(dir).map_err(|_| error("hot_cache_read_failed"))? {
            let path = entry.map_err(|_| error("hot_cache_read_failed"))?.path();
            ensure_data_authority(data_root, &[&path])?;
            let metadata = fs::metadata(&path).map_err(|_| error("hot_cache_read_failed"))?;
            if metadata.is_dir() {
                visit(data_root, &path, files)?;
            } else if path.to_string_lossy().ends_with(".md") {
                files.push(path);
            }
        }
        Ok(())
    }
    visit(data_root, root, &mut files)?;
    Ok(files)
}

fn markdown_blocks(raw: &str) -> Vec<String> {
    let normalized = raw.replace("\r\n", "\n");
    let mut blocks = Vec::new();
    let mut current = Vec::new();
    for line in normalized.split('\n') {
        let heading = line.chars().take_while(|value| *value == '#').count();
        let tail = &line[heading..];
        let is_heading = (1..=6).contains(&heading)
            && tail
                .chars()
                .next()
                .is_some_and(crate::public_text::is_js_whitespace)
            && !trim_js_whitespace(tail).is_empty();
        if is_heading
            && current
                .iter()
                .any(|entry: &&str| !trim_js_whitespace(entry).is_empty())
        {
            let block = trim_js_whitespace(&current.join("\n")).to_owned();
            if !block.is_empty() {
                blocks.push(block);
            }
            current.clear();
        }
        current.push(line);
    }
    if !current.is_empty() {
        let block = trim_js_whitespace(&current.join("\n")).to_owned();
        if !block.is_empty() {
            blocks.push(block);
        }
    }
    blocks
}

fn chunk_text(text: &str) -> Vec<String> {
    let units = text.encode_utf16().collect::<Vec<_>>();
    let mut chunks = Vec::new();
    let mut at = 0;
    while at < units.len() {
        chunks.push(String::from_utf16_lossy(
            &units[at..units.len().min(at + 2000)],
        ));
        at += 1950;
    }
    chunks
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn markdown_blocks_split_on_headings_and_chunks_overlap() {
        assert_eq!(
            markdown_blocks("lead\r\n# one\nbody\n## two\nmore"),
            vec!["lead", "# one\nbody", "## two\nmore"]
        );
        let text = format!("{}🙂x", "a".repeat(1999));
        let chunks = chunk_text(&text);
        assert_eq!(chunks.len(), 2);
        assert!(chunks[1].starts_with(&"a".repeat(49)), "chunks overlap");
    }
}
