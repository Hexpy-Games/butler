//! On-disk records of a memory generation: its `manifest.json`, the
//! `active-generation.json` descriptor that names the serving generation, and
//! the readiness record a rebuild stores in its manifest.
//!
//! Field order is the order every writer has always used, so a typed rewrite
//! produces the same bytes (pinned by `format_pin`). Manifest fields are read
//! leniently like the legacy JavaScript readers: a field of the wrong type
//! reads as absent. Keys this version does not interpret are kept verbatim.

use std::{fs, path::Path};

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use super::types::{GenerationEmbedding, NATIVE_EMBEDDING_SCHEMA};
use crate::cognition::{CognitionCode, CognitionError, CognitionResult};
use crate::lenient;

pub(crate) const GENERATION_MANIFEST_SCHEMA: &str = "butler.memory-generation.v2";
pub(crate) const ACTIVE_DESCRIPTOR_SCHEMA: &str = "butler.memory-active-generation.v2";
const READINESS_SCHEMA: &str = "butler.memory-generation-readiness.v1";

/// How a generation stores its graph: native v2 files or the adopted legacy root.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GenerationFormat {
    /// Native generation under `generations/<id>/`.
    V2,
    /// Pre-generation memory under `db/`, adopted as a baseline.
    Legacy,
}

/// Lifecycle state of a generation manifest.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GenerationState {
    /// A rebuild candidate still being projected.
    Building,
    /// Qualified and waiting for activation.
    Ready,
    /// Named by the active descriptor.
    Active,
    /// Replaced by a later activation; a rollback target.
    Retired,
}

/// Which command created a generation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InitializationOrigin {
    /// A truly empty data root.
    Empty,
    /// A snapshot-backed rebuild.
    Rebuild,
    /// The adopted legacy baseline.
    Legacy,
}

/// Whether projection runs against the serving generation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectionMode {
    /// Native generations project new sources.
    Running,
    /// The legacy baseline does not project.
    Paused,
}

/// The stored `embedding` field of a manifest.
#[derive(Clone, Debug, PartialEq)]
pub enum EmbeddingSlot {
    /// `null`: no embedding bound yet.
    Unbound,
    /// A recognised JavaScript or native embedding identity.
    Bound(Box<GenerationEmbedding>),
    /// Passthrough: a value no reader accepts, kept verbatim for rewrites.
    Unreadable(Value),
}

impl Serialize for EmbeddingSlot {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Unbound => serializer.serialize_unit(),
            Self::Bound(embedding) => embedding.serialize(serializer),
            Self::Unreadable(value) => value.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for EmbeddingSlot {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        if value.is_null() {
            return Ok(Self::Unbound);
        }
        // JavaScript metadata always carried `bun_runtime_version`, even as null.
        let recognised = value.as_object().is_some_and(|object| {
            object.contains_key("bun_runtime_version")
                || object.get("schema").and_then(Value::as_str) == Some(NATIVE_EMBEDDING_SCHEMA)
        });
        if !recognised {
            return Ok(Self::Unreadable(value));
        }
        Ok(match GenerationEmbedding::deserialize(&value) {
            Ok(embedding) => Self::Bound(Box::new(embedding)),
            Err(_) => Self::Unreadable(value),
        })
    }
}

/// Facts about the canonical conversation-store snapshot a rebuild reads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanonicalSnapshot {
    /// SHA-256 of the snapshot file.
    pub file_sha256: String,
    /// Snapshot size in bytes.
    pub bytes: u64,
    /// How long the snapshot copy took.
    pub duration_ms: u64,
    /// Public source revision captured by the snapshot.
    pub canonical_revision: i64,
    /// Reserved for incremental snapshots; always `null`.
    pub base_snapshot_id: Option<String>,
    /// Reserved for incremental snapshots; always `null`.
    pub delta_from_snapshot_id: Option<String>,
}

/// Semantic projection window counts.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemanticCounts {
    /// Windows projected.
    pub complete: usize,
    /// Windows the extractor cannot project.
    pub unsupported: usize,
    /// Windows still queued or running.
    pub pending: usize,
    /// Windows that failed.
    pub failed: usize,
}

/// Vector or hot-cache stage counts.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StageCounts {
    /// Units finished.
    pub complete: usize,
    /// Units still queued or running.
    pub pending: usize,
    /// Units that failed.
    pub failed: usize,
    /// Units whose stage has no configured provider.
    pub not_configured: usize,
}

/// Readiness of a building generation, stored in its manifest once recorded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GenerationReadiness {
    /// Always `butler.memory-generation-readiness.v1`.
    pub schema: String,
    /// Source inventory the readiness was computed against.
    pub inventory_hash: String,
    /// Sources registered in the candidate graph.
    pub registered: usize,
    /// Sources missing, unexpected, or invalid in any stage.
    pub unaccounted: usize,
    /// Semantic projection counts.
    pub semantic: SemanticCounts,
    /// Vector stage counts.
    pub vectors: StageCounts,
    /// Hot-cache stage counts.
    pub cache: StageCounts,
    /// SHA-256 of the full readiness evidence.
    pub evidence_sha256: String,
    /// True when nothing is unaccounted, pending, failed, or unconfigured.
    pub ready: bool,
    /// SHA-256 of this record without `sha256`; absent only while hashing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

impl GenerationReadiness {
    /// Builds an unsealed readiness record; [`Self::seal`] adds its hash.
    pub(crate) fn new(
        inventory_hash: String,
        registered: usize,
        unaccounted: usize,
        stages: (SemanticCounts, StageCounts, StageCounts),
        evidence_sha256: String,
    ) -> Self {
        let (semantic, vectors, cache) = stages;
        let ready = unaccounted == 0
            && semantic.pending == 0
            && semantic.failed == 0
            && vectors.pending == 0
            && vectors.failed == 0
            && vectors.not_configured == 0
            && cache.pending == 0
            && cache.failed == 0
            && cache.not_configured == 0;
        Self {
            schema: READINESS_SCHEMA.into(),
            inventory_hash,
            registered,
            unaccounted,
            semantic,
            vectors,
            cache,
            evidence_sha256,
            ready,
            sha256: None,
        }
    }
}

/// Binds a qualified manifest to its stored acceptance evidence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcceptanceBinding {
    /// SHA-256 of the stored acceptance file.
    pub qualification_sha256: String,
    /// Acceptance file, relative to the generation root.
    pub qualification_ref: String,
    /// Evidence directory, relative to the generation root.
    pub verification_root_ref: String,
    /// Implementation commit the evidence names.
    pub implementation_commit: String,
    /// Generation the verification ran against.
    pub verification_generation_id: String,
    /// Generation this binding qualifies.
    pub target_generation_id: String,
    /// Source inventory of the target.
    pub target_source_inventory_hash: String,
    /// Readiness hash the binding was made against.
    pub target_readiness_sha256: String,
    /// Readiness evidence hash the binding was made against.
    pub target_evidence_sha256: String,
}

/// A generation's `manifest.json`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct GenerationManifest {
    /// Always `butler.memory-generation.v2`.
    #[serde(default, deserialize_with = "lenient::option")]
    pub schema: Option<String>,
    /// The generation directory name.
    #[serde(default, deserialize_with = "lenient::option")]
    pub generation_id: Option<String>,
    /// Storage format.
    #[serde(default, deserialize_with = "lenient::option")]
    pub format: Option<GenerationFormat>,
    /// Lifecycle state.
    #[serde(default, deserialize_with = "lenient::option")]
    pub state: Option<GenerationState>,
    /// Creating command.
    #[serde(default, deserialize_with = "lenient::option")]
    pub initialization_origin: Option<InitializationOrigin>,
    /// Graph schema version (`null` for legacy).
    #[serde(default, deserialize_with = "lenient::option")]
    pub schema_version: Option<u64>,
    /// Extractor version (`null` for legacy).
    #[serde(default, deserialize_with = "lenient::option")]
    pub extraction_version: Option<String>,
    /// Recall ranking version (`null` for legacy).
    #[serde(default, deserialize_with = "lenient::option")]
    pub ranking_version: Option<u64>,
    /// Embedding identity; missing only in malformed manifests.
    #[serde(
        default,
        deserialize_with = "lenient::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub embedding: Option<EmbeddingSlot>,
    /// Unicode data version used for text normalization.
    #[serde(default, deserialize_with = "lenient::option")]
    pub unicode_version: Option<String>,
    /// ICU version used for collation.
    #[serde(default, deserialize_with = "lenient::option")]
    pub icu_version: Option<String>,
    /// Identity of the canonical source snapshot.
    #[serde(default, deserialize_with = "lenient::option")]
    pub canonical_snapshot_id: Option<String>,
    /// Snapshot path relative to the generation root (rebuilds only).
    #[serde(default, deserialize_with = "lenient::option")]
    pub canonical_snapshot_path: Option<String>,
    /// Snapshot facts (rebuilds only).
    #[serde(
        default,
        deserialize_with = "lenient::option",
        skip_serializing_if = "Option::is_none"
    )]
    pub canonical_snapshot: Option<CanonicalSnapshot>,
    /// Hash of the source inventory the generation covers.
    #[serde(default, deserialize_with = "lenient::option")]
    pub source_inventory_hash: Option<String>,
    /// Sources registered in the graph.
    #[serde(default, deserialize_with = "lenient::option")]
    pub registered_source_count: Option<u64>,
    /// Sources not yet accounted for.
    #[serde(default, deserialize_with = "lenient::option")]
    pub unaccounted_source_count: Option<u64>,
    /// Whether the stored qualification still binds this manifest.
    #[serde(default, deserialize_with = "lenient::option")]
    pub required_acceptance_passed: Option<bool>,
    /// Last recorded readiness (rebuilds only).
    #[serde(
        default,
        deserialize_with = "lenient::option",
        skip_serializing_if = "Option::is_none"
    )]
    pub readiness: Option<GenerationReadiness>,
    /// Qualification binding (qualified rebuilds only).
    #[serde(
        default,
        deserialize_with = "lenient::option",
        skip_serializing_if = "Option::is_none"
    )]
    pub acceptance_binding: Option<AcceptanceBinding>,
    /// Passthrough: keys this version does not interpret, kept verbatim.
    #[serde(flatten)]
    pub other: Map<String, Value>,
}

/// Fixed facts of a new manifest; see [`GenerationManifest::new`].
pub(crate) struct NewManifest<'a> {
    pub generation_id: &'a str,
    pub format: GenerationFormat,
    pub state: GenerationState,
    pub origin: InitializationOrigin,
    pub canonical_snapshot_id: String,
    pub source_inventory_hash: String,
    pub unaccounted_source_count: u64,
}

/// Runtime versions a native generation records.
pub(crate) struct RuntimeVersions<'a> {
    pub unicode: &'a str,
    pub icu: &'a str,
}

impl GenerationManifest {
    /// A new manifest with no embedding, readiness, or qualification. Native
    /// generations pass their runtime versions; the legacy baseline records none.
    pub(crate) fn new(facts: NewManifest<'_>, runtime: Option<&RuntimeVersions<'_>>) -> Self {
        let native = runtime.is_some();
        Self {
            schema: Some(GENERATION_MANIFEST_SCHEMA.into()),
            generation_id: Some(facts.generation_id.into()),
            format: Some(facts.format),
            state: Some(facts.state),
            initialization_origin: Some(facts.origin),
            schema_version: native.then_some(3),
            extraction_version: native.then(|| "memory-extract-v3".into()),
            ranking_version: native.then_some(2),
            embedding: Some(EmbeddingSlot::Unbound),
            unicode_version: runtime.map(|versions| versions.unicode.into()),
            icu_version: runtime.map(|versions| versions.icu.into()),
            canonical_snapshot_id: Some(facts.canonical_snapshot_id),
            canonical_snapshot_path: None,
            canonical_snapshot: None,
            source_inventory_hash: Some(facts.source_inventory_hash),
            registered_source_count: Some(0),
            unaccounted_source_count: Some(facts.unaccounted_source_count),
            required_acceptance_passed: Some(false),
            readiness: None,
            acceptance_binding: None,
            other: Map::new(),
        }
    }

    /// Whether this is a `butler.memory-generation.v2` manifest for `generation_id`.
    pub(crate) fn is_for(&self, generation_id: &str) -> bool {
        self.schema.as_deref() == Some(GENERATION_MANIFEST_SCHEMA)
            && self.generation_id.as_deref() == Some(generation_id)
    }

    /// The bound embedding version, when one is bound.
    pub(crate) fn embedding_version(&self) -> Option<&str> {
        match &self.embedding {
            Some(EmbeddingSlot::Bound(embedding)) => Some(embedding.version()),
            _ => None,
        }
    }

    /// Whether the stored embedding is an explicit `null`.
    pub(crate) fn embedding_unbound(&self) -> bool {
        matches!(self.embedding, Some(EmbeddingSlot::Unbound))
    }

    /// Whether this is a v2 manifest in `state`.
    pub(crate) fn is_v2_in(&self, state: GenerationState) -> bool {
        self.format == Some(GenerationFormat::V2) && self.state == Some(state)
    }

    /// Records `readiness` and the counts it implies.
    pub(crate) fn record_readiness(&mut self, readiness: &GenerationReadiness) {
        self.readiness = Some(readiness.clone());
        self.registered_source_count = Some(readiness.registered as u64);
        self.unaccounted_source_count = Some(readiness.unaccounted as u64);
    }

    /// Reads and parses a manifest; `code` reports I/O and syntax failures.
    pub(crate) fn read(path: &Path, code: CognitionCode) -> CognitionResult<Self> {
        let bytes = fs::read(path).map_err(|source| error(code).with_source(source))?;
        Self::parse(&bytes, code)
    }

    /// Parses manifest bytes; `code` reports syntax failures.
    pub(crate) fn parse(bytes: &[u8], code: CognitionCode) -> CognitionResult<Self> {
        serde_json::from_slice(bytes).map_err(|source| error(code).with_source(source))
    }
}

/// The `active-generation.json` descriptor: the serving authority.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveDescriptor {
    /// Always `butler.memory-active-generation.v2`.
    pub schema: String,
    /// The serving generation.
    pub generation_id: String,
    /// The generation it replaced; a required key, `null` for the first.
    #[serde(deserialize_with = "Option::deserialize")]
    pub previous_generation_id: Option<String>,
    /// When the generation became active.
    pub activated_at: String,
    /// Whether projection runs against it.
    pub projection_mode: ProjectionMode,
}

impl ActiveDescriptor {
    /// The descriptor that makes `generation_id` the serving generation.
    pub(crate) fn new(
        generation_id: &str,
        previous_generation_id: Option<&str>,
        activated_at: &str,
        projection_mode: ProjectionMode,
    ) -> Self {
        Self {
            schema: ACTIVE_DESCRIPTOR_SCHEMA.into(),
            generation_id: generation_id.into(),
            previous_generation_id: previous_generation_id.map(str::to_owned),
            activated_at: activated_at.into(),
            projection_mode,
        }
    }
}

/// Lenient view of the descriptor used to resolve the serving generation.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct DescriptorView {
    #[serde(default, deserialize_with = "lenient::option")]
    pub schema: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub generation_id: Option<String>,
    #[serde(default, deserialize_with = "lenient::option")]
    pub projection_mode: Option<ProjectionMode>,
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
