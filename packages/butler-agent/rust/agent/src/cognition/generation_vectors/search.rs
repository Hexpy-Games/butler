use std::{collections::HashMap, path::Path};

use arrow_array::{Float32Array, Float64Array};
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
        return Err(error("native_vector_unavailable"));
    };
    let root = generation.root.join("butler.lance");
    ensure_data_authority(
        data_root,
        &[&generation.root, &root, &root.join("butler_memory.lance")],
    )?;
    let connection = crate::cognition::lance_store::connect(&root)
        .await
        .map_err(|_| error("native_vector_unavailable"))?;
    let table = crate::cognition::lance_store::open(&connection, "butler_memory")
        .await
        .map_err(|_| error("native_vector_unavailable"))?;
    let legacy = !has_source_kind(&table).await?;
    let columns = selected_columns(legacy);
    for kind in ["node", "episode"] {
        if kind == "episode"
            && request.session_ids.is_empty()
            && request.scope == RecallScope::CurrentSession
            && request.runtime.session_id.is_empty()
        {
            continue;
        }
        let mut best = HashMap::<String, RecallVectorMatch>::new();
        for vector in vectors {
            if vector.len() != dimension(embedding) || vector.iter().any(|v| !v.is_finite()) {
                return Err(error("native_vector_invalid_query"));
            }
            let Some(predicate) = predicate(generation, request, kind, legacy) else {
                continue;
            };
            let batches = table
                .vector_search(vector.as_slice())
                .map_err(|_| error("native_vector_unavailable"))?
                .only_if(predicate)
                .select(Select::columns(&columns))
                .limit(LIMIT)
                .execute()
                .await
                .map_err(|_| error("native_vector_unavailable"))?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|_| error("native_vector_unavailable"))?;
            let mut count = 0;
            for batch in batches {
                let distance_column = batch
                    .schema()
                    .index_of("_distance")
                    .map_err(|_| error("native_vector_unavailable"))?;
                for row in 0..batch.num_rows() {
                    count += 1;
                    let distance = distance(&batch, distance_column, row)?;
                    let candidate = RecallVectorMatch {
                        vector_key: text(&batch, 0, row)?,
                        generation: text(&batch, 1, row)?,
                        embedding_chunk_id: text(&batch, 6, row)?,
                        embedding_version: text(&batch, 7, row)?,
                        owner_id: text(&batch, 3, row)?,
                        owner_revision: text(&batch, 4, row)?,
                        source_revision: text(&batch, 5, row)?,
                        source_refs_json: text(&batch, index(13, legacy), row)?,
                        project_id: text(&batch, 8, row)?,
                        origin_kind: text(&batch, 9, row)?,
                        source_kind: if legacy {
                            Some("conversation".into())
                        } else {
                            Some(text(&batch, 10, row)?)
                        },
                        conversation_session_id: optional_text(&batch, index(11, legacy), row)?,
                        source_observed_at: text(&batch, index(12, legacy), row)?,
                        source_episode_id: None,
                        rank: 0,
                        distance,
                    };
                    if candidate.generation != generation.generation_id
                        || candidate.embedding_version != embedding.version()
                        || text(&batch, 2, row)? != kind
                        || !distance.is_finite()
                    {
                        continue;
                    }
                    best.entry(candidate.vector_key.clone())
                        .and_modify(|prior| {
                            if distance < prior.distance {
                                *prior = candidate.clone();
                            }
                        })
                        .or_insert(candidate);
                }
            }
            if count >= LIMIT {
                result
                    .diagnostics
                    .push(format!("{kind}_vector_bound_reached"));
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
        if kind == "node" {
            result.nodes = ranked;
        } else {
            result.episodes = ranked;
        }
    }
    Ok(result)
}

pub(crate) async fn search_vector_candidates(
    data_root: &Path,
    generation: &MemoryGenerationHandle,
    project: Option<&str>,
    vector: &[f32],
) -> CognitionResult<Vec<VectorHit>> {
    let Some(embedding) = generation.embedding.as_ref() else {
        return Err(error("native_vector_unavailable"));
    };
    if vector.len() != dimension(embedding) {
        return Err(error("native_vector_invalid_query"));
    }
    let root = generation.root.join("butler.lance");
    ensure_data_authority(
        data_root,
        &[&generation.root, &root, &root.join("butler_memory.lance")],
    )?;
    let connection = crate::cognition::lance_store::connect(&root)
        .await
        .map_err(|_| error("native_vector_unavailable"))?;
    let table = crate::cognition::lance_store::open(&connection, "butler_memory")
        .await
        .map_err(|_| error("native_vector_unavailable"))?;
    let legacy = !has_source_kind(&table).await?;
    let columns = selected_columns(legacy);
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
    let batches = table
        .vector_search(vector)
        .map_err(|_| error("native_vector_unavailable"))?
        .only_if(clauses.join(" AND "))
        .select(Select::columns(&columns))
        .limit(50)
        .execute()
        .await
        .map_err(|_| error("native_vector_unavailable"))?
        .try_collect::<Vec<_>>()
        .await
        .map_err(|_| error("native_vector_unavailable"))?;
    let graph = GraphRepository::open(&generation.graph_path)?;
    let mut hits = Vec::new();
    for batch in batches {
        let column = batch
            .schema()
            .index_of("_distance")
            .map_err(|_| error("native_vector_unavailable"))?;
        for row in 0..batch.num_rows() {
            let hit = RecallVectorMatch {
                vector_key: text(&batch, 0, row)?,
                generation: text(&batch, 1, row)?,
                embedding_chunk_id: text(&batch, 6, row)?,
                embedding_version: text(&batch, 7, row)?,
                owner_id: text(&batch, 3, row)?,
                owner_revision: text(&batch, 4, row)?,
                source_revision: text(&batch, 5, row)?,
                source_refs_json: text(&batch, index(13, legacy), row)?,
                project_id: text(&batch, 8, row)?,
                origin_kind: text(&batch, 9, row)?,
                source_kind: if legacy {
                    Some("conversation".into())
                } else {
                    Some(text(&batch, 10, row)?)
                },
                conversation_session_id: optional_text(&batch, index(11, legacy), row)?,
                source_observed_at: text(&batch, index(12, legacy), row)?,
                source_episode_id: None,
                rank: hits.len() + 1,
                distance: distance(&batch, column, row)?,
            };
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

async fn has_source_kind(table: &Table) -> CognitionResult<bool> {
    let schema = table
        .schema()
        .await
        .map_err(|_| error("native_vector_unavailable"))?;
    Ok(schema
        .fields()
        .iter()
        .any(|field| field.name() == "source_kind"))
}

fn selected_columns(legacy: bool) -> Vec<&'static str> {
    META.iter()
        .copied()
        .filter(|field| !legacy || *field != "source_kind")
        .collect()
}

fn index(modern: usize, legacy: bool) -> usize {
    modern - usize::from(legacy && modern > 10)
}

fn dimension(embedding: &GenerationEmbedding) -> usize {
    match embedding {
        GenerationEmbedding::Native(value) => value.dimension,
        GenerationEmbedding::JavaScript(value) => value.dimension as usize,
    }
}

fn predicate(
    generation: &MemoryGenerationHandle,
    request: &RecallRequest,
    kind: &str,
    legacy: bool,
) -> Option<String> {
    let version = generation.embedding.as_ref()?.version();
    let mut clauses = vec![
        format!("record_kind = {}", quote(kind)),
        format!("generation = {}", quote(&generation.generation_id)),
        format!("embedding_version = {}", quote(version)),
    ];
    if !request.include_internal {
        clauses.push(if legacy {
            "origin_kind IN ('user_input','assistant_public')".into()
        } else {
            "((source_kind='conversation' AND origin_kind IN ('user_input','assistant_public')) OR source_kind IN ('task_report','explicit_record'))".into()
        });
    }
    if kind == "episode" {
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
        return Ok(values.value(row) as f64);
    }
    if let Some(values) = data.as_any().downcast_ref::<Float64Array>() {
        return Ok(values.value(row));
    }
    Err(error("native_vector_unavailable"))
}
