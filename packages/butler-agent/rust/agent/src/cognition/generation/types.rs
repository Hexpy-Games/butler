use std::path::PathBuf;

use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as DeError};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::cognition::{CognitionError, embedding::NativeEmbeddingIdentity};

const NATIVE_EMBEDDING_SCHEMA: &str = "butler.native-embedding-identity.v1";
const CHECKED_PREPROCESSING: &str = "tokenizer-json-special-tokens-checked-v1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum MemoryGenerationTarget {
    Active {
        expected_generation: String,
    },
    Rebuild {
        generation_id: String,
        canonical_snapshot_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct JavaScriptGenerationEmbedding {
    pub model: String,
    pub dimension: f64,
    pub pooling: String,
    pub normalize: bool,
    pub version: String,
    pub max_tokens: f64,
    pub transformers_version: String,
    pub node_runtime_version: String,
    pub bun_runtime_version: Option<String>,
    pub tokenizer_asset_sha256: String,
    pub model_asset_sha256: String,
}

/// The flat wire object is either the existing JavaScript metadata shape or an
/// explicitly identified native identity. The variants add no wrapper keys.
#[derive(Clone)]
pub(crate) enum GenerationEmbedding {
    JavaScript(JavaScriptGenerationEmbedding),
    Native(NativeEmbeddingIdentity),
}

impl GenerationEmbedding {
    pub(crate) fn version(&self) -> &str {
        match self {
            Self::JavaScript(value) => &value.version,
            Self::Native(value) => &value.version,
        }
    }

    pub(crate) fn native_identity(&self) -> Option<&NativeEmbeddingIdentity> {
        match self {
            Self::JavaScript(_) => None,
            Self::Native(value) => Some(value),
        }
    }
}

impl From<NativeEmbeddingIdentity> for GenerationEmbedding {
    fn from(value: NativeEmbeddingIdentity) -> Self {
        Self::Native(value)
    }
}

impl Serialize for GenerationEmbedding {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::JavaScript(value) => {
                // JavaScript JSON.stringify emits integral Number values as
                // integer literals. Keep the existing manifest wire shape.
                let mut wire = serde_json::to_value(value).map_err(serde::ser::Error::custom)?;
                for (field, number) in [
                    ("dimension", value.dimension),
                    ("max_tokens", value.max_tokens),
                ] {
                    if number.is_finite()
                        && number >= 0.0
                        && number.fract() == 0.0
                        && number <= 9_007_199_254_740_991.0
                    {
                        wire[field] = Value::Number(serde_json::Number::from(
                            crate::json::saturating_u64(number),
                        ));
                    }
                }
                wire.serialize(serializer)
            }
            Self::Native(value) => value.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for GenerationEmbedding {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        if value
            .as_object()
            .and_then(|object| object.get("schema"))
            .and_then(Value::as_str)
            == Some(NATIVE_EMBEDDING_SCHEMA)
        {
            ensure_exact_native_fields(&value).map_err(D::Error::custom)?;
            serde_json::from_value::<NativeEmbeddingIdentity>(value)
                .map(Self::Native)
                .map_err(D::Error::custom)
        } else {
            serde_json::from_value::<JavaScriptGenerationEmbedding>(value)
                .map(Self::JavaScript)
                .map_err(D::Error::custom)
        }
    }
}

impl std::fmt::Debug for GenerationEmbedding {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match serde_json::to_value(self) {
            Ok(value) => formatter
                .debug_tuple("GenerationEmbedding")
                .field(&value)
                .finish(),
            Err(_) => formatter.write_str("GenerationEmbedding(<invalid>)"),
        }
    }
}

impl PartialEq for GenerationEmbedding {
    fn eq(&self, other: &Self) -> bool {
        serde_json::to_value(self).ok() == serde_json::to_value(other).ok()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct MemoryGenerationHandle {
    pub generation_id: String,
    pub graph_path: PathBuf,
    pub root: PathBuf,
    pub embedding: Option<GenerationEmbedding>,
    pub source_root: PathBuf,
    pub canonical_snapshot_path: Option<PathBuf>,
}

pub(super) struct ActiveDescriptor {
    pub generation_id: String,
    pub projection_mode: Option<String>,
}

pub(super) struct GenerationManifest {
    pub schema: String,
    pub generation_id: String,
    pub format: String,
    pub state: Option<String>,
    pub embedding: Option<GenerationEmbedding>,
    pub canonical_snapshot_id: Option<String>,
    pub canonical_snapshot_path: Option<String>,
}

pub(super) fn validate_generation_embedding(
    value: &GenerationEmbedding,
) -> Result<(), CognitionError> {
    match value {
        GenerationEmbedding::JavaScript(value) => validate_javascript_embedding(value),
        GenerationEmbedding::Native(value) => validate_native_embedding_identity(value),
    }
}

pub(super) fn validate_native_embedding_identity(
    value: &NativeEmbeddingIdentity,
) -> Result<(), CognitionError> {
    let sha = |text: &str| {
        text.len() == 64
            && text
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    };
    if value.schema != NATIVE_EMBEDDING_SCHEMA
        || value.model.trim().is_empty()
        || value.runtime.trim().is_empty()
        || value.ort_wrapper_version.trim().is_empty()
        || value.ort_api == 0
        || !sha(&value.runtime_build_info_sha256)
        || value.tokenizer_runtime_version.trim().is_empty()
        || !sha(&value.tokenizer_asset_sha256)
        || !sha(&value.model_asset_sha256)
        || value.preprocessing != CHECKED_PREPROCESSING
        || value.pooling != "cls"
        || value.truncation != "strict-error-over-max"
        || !value.normalize
        || value.max_tokens == 0
        || value.dimension != 1024
        || !sha(&value.version)
    {
        return Err(invalid_embedding_metadata());
    }

    let mut versioned_identity = value.clone();
    versioned_identity.version.clear();
    let expected_version = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&versioned_identity).map_err(|_| invalid_embedding_metadata())?
        )
    );
    if value.version != expected_version {
        return Err(invalid_embedding_metadata());
    }
    Ok(())
}

fn validate_javascript_embedding(
    value: &JavaScriptGenerationEmbedding,
) -> Result<(), CognitionError> {
    let safe = |number: f64| {
        number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
    };
    let sha = |text: &str| {
        text.len() == 64
            && text
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    };
    if value.model.trim().is_empty()
        || !safe(value.dimension)
        || value.dimension <= 0.0
        || value.pooling != "cls"
        || !value.normalize
        || !sha(&value.version)
        || !safe(value.max_tokens)
        || value.max_tokens <= 0.0
        || value.transformers_version.is_empty()
        || value.node_runtime_version.is_empty()
        || !sha(&value.tokenizer_asset_sha256)
        || !sha(&value.model_asset_sha256)
    {
        return Err(invalid_embedding_metadata());
    }
    Ok(())
}

fn ensure_exact_native_fields(value: &Value) -> Result<(), &'static str> {
    const FIELDS: [&str; 16] = [
        "schema",
        "model",
        "runtime",
        "ort_wrapper_version",
        "ort_api",
        "runtime_build_info_sha256",
        "tokenizer_runtime_version",
        "tokenizer_asset_sha256",
        "model_asset_sha256",
        "preprocessing",
        "pooling",
        "truncation",
        "normalize",
        "max_tokens",
        "dimension",
        "version",
    ];
    let Some(object) = value.as_object() else {
        return Err("native embedding metadata must be an object");
    };
    if object.len() != FIELDS.len() || FIELDS.iter().any(|field| !object.contains_key(*field)) {
        return Err("native embedding metadata fields do not match the native schema");
    }
    Ok(())
}

fn invalid_embedding_metadata() -> CognitionError {
    CognitionError::new(
        "memory_embedding_metadata_invalid",
        "memory_embedding_metadata_invalid",
    )
}
