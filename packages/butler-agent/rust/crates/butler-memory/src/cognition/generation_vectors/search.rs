//! Vector recall over a generation's Lance table: nearest node and episode
//! vectors for recall, and node candidates for semantic binding.

use std::{collections::HashMap, path::Path};

use arrow_array::{Float32Array, Float64Array, RecordBatch};
use futures_util::TryStreamExt;
use lancedb::{
    Table,
    query::{ExecutableQuery, QueryBase, Select},
};

use crate::cognition::{
    CognitionResult, GenerationEmbedding, MemoryGenerationHandle, ensure_data_authority,
    graph::{GraphRepository, VectorHit},
    recall::{
        RecallProjectFilter, RecallRequest, RecallScope, RecallTimeBasis, RecallVectorMatch,
        RecallVectorMatches,
    },
};

use super::rows::{error, optional_text, text};
use crate::cognition::CognitionCode;

const LIMIT: usize = 256;
const META: [&str; 14] = [
    "vector_key",
    "generation",
    "record_kind",
    "owner_id",
    "owner_revision",
    "source_revision",
    "embedding_chunk_id",
    "embedding_version",
    "project_id",
    "origin_kind",
    "source_kind",
    "conversation_session_id",
    "source_observed_at",
    "source_refs_json",
];

/// Whether the table predates the `source_kind` column.
#[derive(Clone, Copy, PartialEq, Eq)]
enum TableLayout {
    /// Every metadata column is present.
    Current,
    /// No `source_kind` column: every row is a conversation source.
    WithoutSourceKind,
}

impl TableLayout {
    fn columns(self) -> Vec<&'static str> {
        META.iter()
            .copied()
            .filter(|field| self == Self::Current || *field != "source_kind")
            .collect()
    }

    /// The position of a current-layout column in this layout.
    fn index(self, current: usize) -> usize {
        current - usize::from(self == Self::WithoutSourceKind && current > 10)
    }
}

/// Which owner a vector row embeds.
#[derive(Clone, Copy, PartialEq, Eq)]
enum VectorKind {
    Node,
    Episode,
}

impl VectorKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Episode => "episode",
        }
    }
}

/// The generation's vector table and its column layout.
struct VectorTable {
    table: Table,
    layout: TableLayout,
}

impl VectorTable {
    async fn open(data_root: &Path, generation: &MemoryGenerationHandle) -> CognitionResult<Self> {
        let root = generation.root.join("butler.lance");
        ensure_data_authority(
            data_root,
            &[&generation.root, &root, &root.join("butler_memory.lance")],
        )?;
        // Reuse the generation's bounded session/index cache, as its writer
        // does. Read consistency remains zero: every read checks new commits.
        let table = crate::cognition::lance_store::shared(&root, "butler_memory")
            .await
            .map_err(unavailable)?;
        let schema = table.schema().await.map_err(unavailable)?;
        let layout = if schema
            .fields()
            .iter()
            .any(|field| field.name() == "source_kind")
        {
            TableLayout::Current
        } else {
            TableLayout::WithoutSourceKind
        };
        Ok(Self { table, layout })
    }

    async fn nearest(
        &self,
        vector: &[f32],
        predicate: String,
        limit: usize,
    ) -> CognitionResult<Vec<RecordBatch>> {
        self.table
            .vector_search(vector)
            .map_err(unavailable)?
            .only_if(predicate)
            .select(Select::columns(&self.layout.columns()))
            .limit(limit)
            .execute()
            .await
            .map_err(unavailable)?
            .try_collect::<Vec<_>>()
            .await
            .map_err(unavailable)
    }

    /// Decodes one result row with its distance.
    fn decode(
        &self,
        batch: &RecordBatch,
        distance_column: usize,
        row: usize,
    ) -> CognitionResult<RecallVectorMatch> {
        let layout = self.layout;
        Ok(RecallVectorMatch {
            vector_key: text(batch, 0, row)?,
            generation: text(batch, 1, row)?,
            embedding_chunk_id: text(batch, 6, row)?,
            embedding_version: text(batch, 7, row)?,
            owner_id: text(batch, 3, row)?,
            owner_revision: text(batch, 4, row)?,
            source_revision: text(batch, 5, row)?,
            source_refs_json: text(batch, layout.index(13), row)?,
            project_id: text(batch, 8, row)?,
            origin_kind: text(batch, 9, row)?,
            source_kind: Some(match layout {
                TableLayout::WithoutSourceKind => "conversation".into(),
                TableLayout::Current => text(batch, 10, row)?,
            }),
            conversation_session_id: optional_text(batch, layout.index(11), row)?,
            source_observed_at: text(batch, layout.index(12), row)?,
            source_episode_id: None,
            rank: 0,
            distance: distance(batch, distance_column, row)?,
        })
    }
}

fn distance_column(batch: &RecordBatch) -> CognitionResult<usize> {
    batch.schema().index_of("_distance").map_err(unavailable)
}

fn unavailable(
    source: impl std::error::Error + Send + Sync + 'static,
) -> crate::cognition::CognitionError {
    error(CognitionCode::VectorUnavailable).with_source(source)
}

/// Nearest node and episode vectors for up to four query vectors, ranked by
/// best distance per vector key.
pub(crate) async fn search_generation_vectors(
    data_root: &Path,
    generation: &MemoryGenerationHandle,
    request: &RecallRequest,
    vectors: &[Vec<f32>],
) -> CognitionResult<RecallVectorMatches> {
    if vectors.is_empty() || vectors.len() > 4 {
        return Ok(RecallVectorMatches::default());
    }
    let mut result = RecallVectorMatches::default();
    let Some(embedding) = generation.embedding.as_ref() else {
        return Err(error(CognitionCode::VectorUnavailable));
    };
    let table = VectorTable::open(data_root, generation).await?;
    for kind in [VectorKind::Node, VectorKind::Episode] {
        if kind == VectorKind::Episode
            && request.session_ids.is_empty()
            && request.scope == RecallScope::CurrentSession
            && request.runtime.session_id.is_empty()
        {
            continue;
        }
        let search = KindSearch {
            table: &table,
            generation,
            embedding,
            request,
            kind,
        };
        let ranked = search.ranked(vectors, &mut result.diagnostics).await?;
        match kind {
            VectorKind::Node => result.nodes = ranked,
            VectorKind::Episode => result.episodes = ranked,
        }
    }
    Ok(result)
}

/// One vector kind searched for every query vector.
struct KindSearch<'a> {
    table: &'a VectorTable,
    generation: &'a MemoryGenerationHandle,
    embedding: &'a GenerationEmbedding,
    request: &'a RecallRequest,
    kind: VectorKind,
}

impl KindSearch<'_> {
    async fn ranked(
        &self,
        vectors: &[Vec<f32>],
        diagnostics: &mut Vec<String>,
    ) -> CognitionResult<Vec<RecallVectorMatch>> {
        let mut best = HashMap::<String, RecallVectorMatch>::new();
        for vector in vectors {
            if vector.len() != dimension(self.embedding) || vector.iter().any(|v| !v.is_finite()) {
                return Err(error(CognitionCode::VectorInvalidQuery));
            }
            let Some(predicate) =
                predicate(self.generation, self.request, self.kind, self.table.layout)
            else {
                continue;
            };
            let batches = self.table.nearest(vector, predicate, LIMIT).await?;
            let mut count = 0;
            for batch in batches {
                let distance_column = distance_column(&batch)?;
                for row in 0..batch.num_rows() {
                    count += 1;
                    self.keep_best(&mut best, &batch, distance_column, row)?;
                }
            }
            if count >= LIMIT {
                diagnostics.push(format!("{}_vector_bound_reached", self.kind.as_str()));
            }
        }
        let mut ranked = best.into_values().collect::<Vec<_>>();
        ranked.sort_by(|a, b| {
            a.distance
                .total_cmp(&b.distance)
                .then_with(|| a.vector_key.cmp(&b.vector_key))
        });
        for (index, row) in ranked.iter_mut().enumerate() {
            row.rank = index + 1;
        }
        Ok(ranked)
    }

    /// Keeps the closest row per vector key among rows of this generation,
    /// embedding version, and kind.
    fn keep_best(
        &self,
        best: &mut HashMap<String, RecallVectorMatch>,
        batch: &RecordBatch,
        distance_column: usize,
        row: usize,
    ) -> CognitionResult<()> {
        let candidate = self.table.decode(batch, distance_column, row)?;
        let distance = candidate.distance;
        if candidate.generation != self.generation.generation_id
            || candidate.embedding_version != self.embedding.version()
            || text(batch, 2, row)? != self.kind.as_str()
            || !distance.is_finite()
        {
            return Ok(());
        }
        best.entry(candidate.vector_key.clone())
            .and_modify(|prior| {
                if distance < prior.distance {
                    *prior = candidate.clone();
                }
            })
            .or_insert(candidate);
        Ok(())
    }
}

/// The nearest current node vectors, for semantic binding candidates.
pub(crate) async fn search_vector_candidates(
    data_root: &Path,
    generation: &MemoryGenerationHandle,
    project: Option<&str>,
    vector: &[f32],
) -> CognitionResult<Vec<VectorHit>> {
    let Some(embedding) = generation.embedding.as_ref() else {
        return Err(error(CognitionCode::VectorUnavailable));
    };
    if vector.len() != dimension(embedding) {
        return Err(error(CognitionCode::VectorInvalidQuery));
    }
    let table = VectorTable::open(data_root, generation).await?;
    let mut clauses = vec![
        "record_kind = 'node'".to_owned(),
        format!("generation = {}", quote(&generation.generation_id)),
        format!("embedding_version = {}", quote(embedding.version())),
    ];
    if let Some(project) = project {
        clauses.push(format!(
            "(project_id = '' OR project_id = {})",
            quote(project)
        ));
    }
    let batches = table.nearest(vector, clauses.join(" AND "), 50).await?;
    let graph = GraphRepository::open(&generation.graph_path)?;
    let mut hits = Vec::new();
    for batch in batches {
        let column = distance_column(&batch)?;
        for row in 0..batch.num_rows() {
            let mut hit = table.decode(&batch, column, row)?;
            hit.rank = hits.len() + 1;
            if graph.current_vector_candidate(&generation.generation_id, &hit)? {
                hits.push(VectorHit {
                    owner_id: hit.owner_id,
                    rank: hits.len() + 1,
                    distance: hit.distance,
                });
            }
        }
    }
    graph.close()?;
    Ok(hits)
}

fn dimension(embedding: &GenerationEmbedding) -> usize {
    match embedding {
        GenerationEmbedding::Native(value) => value.dimension,
        GenerationEmbedding::JavaScript(value) => {
            butler_core::json::saturating_usize(value.dimension)
        }
    }
}

fn predicate(
    generation: &MemoryGenerationHandle,
    request: &RecallRequest,
    kind: VectorKind,
    layout: TableLayout,
) -> Option<String> {
    let version = generation.embedding.as_ref()?.version();
    let mut clauses = vec![
        format!("record_kind = {}", quote(kind.as_str())),
        format!("generation = {}", quote(&generation.generation_id)),
        format!("embedding_version = {}", quote(version)),
    ];
    if !request.include_internal {
        clauses.push(match layout {
            TableLayout::WithoutSourceKind => "origin_kind IN ('user_input','assistant_public')".into(),
            TableLayout::Current => "((source_kind='conversation' AND origin_kind IN ('user_input','assistant_public')) OR source_kind IN ('task_report','explicit_record'))".into(),
        });
    }
    if kind == VectorKind::Episode {
        episode_clauses(request, &mut clauses);
    }
    if request.scope == RecallScope::CurrentProject {
        clauses.push(format!(
            "project_id = {}",
            quote(request.runtime.project_id.as_deref().unwrap_or(""))
        ));
    }
    match request.project_filter {
        RecallProjectFilter::Any => {}
        RecallProjectFilter::Unassigned => clauses.push("project_id = ''".into()),
        RecallProjectFilter::Selected => {
            if request.project_ids.is_empty() {
                return None;
            }
            clauses.push(format!("project_id IN ({})", join(&request.project_ids)));
        }
    }
    Some(clauses.join(" AND "))
}

/// Episodes are limited to the requested sessions and time.
fn episode_clauses(request: &RecallRequest, clauses: &mut Vec<String>) {
    if request.scope == RecallScope::CurrentSession {
        clauses.push(format!(
            "conversation_session_id = {}",
            quote(&request.runtime.session_id)
        ));
    }
    if !request.session_ids.is_empty() {
        clauses.push(format!(
            "conversation_session_id IN ({})",
            join(&request.session_ids)
        ));
    }
    clauses.push(format!("source_observed_at <= {}", quote(&request.as_of)));
    if let Some(time) = &request.time
        && time.basis == RecallTimeBasis::Conversation
    {
        clauses.push(format!("source_observed_at >= {}", quote(&time.from)));
        clauses.push(format!("source_observed_at < {}", quote(&time.to)));
    }
}

fn join(values: &[String]) -> String {
    values
        .iter()
        .map(|value| quote(value))
        .collect::<Vec<_>>()
        .join(",")
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
fn distance(batch: &arrow_array::RecordBatch, column: usize, row: usize) -> CognitionResult<f64> {
    let data = batch.column(column);
    if let Some(values) = data.as_any().downcast_ref::<Float32Array>() {
        return Ok(f64::from(values.value(row)));
    }
    if let Some(values) = data.as_any().downcast_ref::<Float64Array>() {
        return Ok(values.value(row));
    }
    Err(error(CognitionCode::VectorUnavailable))
}
