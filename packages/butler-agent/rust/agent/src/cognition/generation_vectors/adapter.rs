use std::{path::PathBuf, sync::Arc};

use tokio_util::sync::CancellationToken;
use unicode_normalization::UnicodeNormalization;

use crate::cognition::{
    CandidateSearchInput, CognitionEmbeddingPort, CognitionError, CognitionPathEnvironment,
    CognitionResult, CognitionVectorSearch, EmbeddingMode, EmbeddingRequest, EmbeddingRequestClass,
    MemoryGenerationHandle, NativeRecallVectorPort, RecallVectorFuture, VectorSearchFuture,
    generation::resolve_projection_generation,
    recall::{RecallRequest, RecallVectorMatches},
};
use crate::segmentation::grapheme_segments;

use super::{
    compatibility,
    search::{search_generation_vectors, search_vector_candidates},
};

pub(crate) struct NativeGenerationVectorAdapter {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    embedding: Arc<dyn CognitionEmbeddingPort>,
}

impl NativeGenerationVectorAdapter {
    pub(crate) fn new(
        data_root: PathBuf,
        paths: CognitionPathEnvironment,
        embedding: Arc<dyn CognitionEmbeddingPort>,
    ) -> Self {
        Self {
            data_root,
            paths,
            embedding,
        }
    }

    async fn query(
        &self,
        generation: &MemoryGenerationHandle,
        request: &RecallRequest,
        deadline: i64,
    ) -> CognitionResult<RecallVectorMatches> {
        let expected = generation
            .embedding
            .as_ref()
            .ok_or_else(|| error("native_vector_unavailable"))?;
        compatibility::preflight(expected)?;
        let source = if request.vector_queries.is_empty() {
            vec![request.cue.clone()]
        } else {
            request.vector_queries.clone()
        };
        let mut unique = Vec::<String>::new();
        for phrase in source {
            let nfc = phrase.nfc().collect::<String>();
            if !nfc.is_empty() && !unique.contains(&nfc) {
                unique.push(nfc);
            }
        }
        let omitted_phrases = unique.len().saturating_sub(4);
        unique.truncate(4);
        let texts = unique
            .iter()
            .flat_map(|phrase| grapheme_chunks(phrase))
            .collect::<Vec<_>>();
        if texts.is_empty() {
            return Ok(RecallVectorMatches::default());
        }
        let response = self
            .embedding
            .embed(
                EmbeddingRequest {
                    texts,
                    mode: EmbeddingMode::CheckedCls,
                    resplit: true,
                    max_embeddings: Some(4),
                    request_class: EmbeddingRequestClass::Interactive,
                    deadline_at_epoch_ms: Some(deadline),
                },
                CancellationToken::new(),
            )
            .await?;
        compatibility::query_identity(expected, &response.metadata)?;
        let mut matches =
            search_generation_vectors(&self.data_root, generation, request, &response.embeddings)
                .await?;
        if omitted_phrases > 0 {
            matches
                .diagnostics
                .push(format!("vector_phrases_omitted={omitted_phrases}"));
        }
        if let Some(omitted) = response.omitted_count.filter(|count| *count > 0) {
            matches
                .diagnostics
                .push(format!("vector_chunks_omitted={omitted}"));
        }
        Ok(matches)
    }
}

impl NativeRecallVectorPort for NativeGenerationVectorAdapter {
    fn search<'a>(
        &'a self,
        generation: &'a MemoryGenerationHandle,
        request: &'a RecallRequest,
        deadline_at: i64,
    ) -> RecallVectorFuture<'a> {
        Box::pin(self.query(generation, request, deadline_at))
    }
}

impl CognitionVectorSearch for NativeGenerationVectorAdapter {
    fn search<'a>(&'a self, input: CandidateSearchInput<'a>) -> VectorSearchFuture<'a> {
        Box::pin(async move {
            let generation =
                resolve_projection_generation(&self.data_root, &self.paths, input.generation_id)?;
            if generation.source_root != input.source_root
                || generation.embedding.as_ref() != input.embedding
            {
                return Err(error("memory_generation_changed"));
            }
            let expected = generation
                .embedding
                .as_ref()
                .ok_or_else(|| error("native_vector_unavailable"))?;
            compatibility::preflight(expected)?;
            let response = self
                .embedding
                .embed(
                    EmbeddingRequest {
                        texts: vec![input.cue.to_owned()],
                        mode: EmbeddingMode::CheckedCls,
                        resplit: true,
                        max_embeddings: Some(4),
                        request_class: EmbeddingRequestClass::Interactive,
                        deadline_at_epoch_ms: Some(input.deadline_epoch_millis),
                    },
                    CancellationToken::new(),
                )
                .await?;
            compatibility::query_identity(expected, &response.metadata)?;
            let Some(vector) = response.embeddings.first() else {
                return Ok(Vec::new());
            };
            search_vector_candidates(&self.data_root, &generation, input.bound_project_id, vector)
                .await
        })
    }
}

fn grapheme_chunks(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for segment in grapheme_segments(text) {
        if !current.is_empty() && current.len() + segment.text.len() > 4096 {
            chunks.push(std::mem::take(&mut current));
        }
        current.push_str(segment.text);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
