//! Read/write compatibility for the verified Transformers.js checked CLS profile.
//! Stored version labels remain the serving generation compatibility domain.

use serde_json::json;
use sha2::{Digest, Sha256};

use crate::cognition::CognitionCode;
use crate::cognition::{CognitionError, CognitionResult, EmbeddingIdentity, GenerationEmbedding};

pub(crate) fn preflight(embedding: &GenerationEmbedding) -> CognitionResult<()> {
    let GenerationEmbedding::JavaScript(js) = embedding else {
        return Ok(());
    };
    if js.model != "Xenova/bge-m3"
        || js.dimension != 1024.0
        || js.max_tokens != 8192.0
        || js.pooling != "cls"
        || !js.normalize
    {
        return Err(mismatch());
    }
    let source_identity = json!([
        "butler-embedding-runtime-v1",
        js.model,
        js.transformers_version,
        "cls",
        true,
        1024,
        8192,
        js.tokenizer_asset_sha256,
        js.model_asset_sha256,
        js.node_runtime_version,
        js.bun_runtime_version,
    ]);
    let expected = format!(
        "{:x}",
        Sha256::digest(source_identity.to_string().as_bytes())
    );
    if js.version != expected {
        return Err(mismatch());
    }
    Ok(())
}

pub(crate) fn query_identity(
    embedding: &GenerationEmbedding,
    actual: &EmbeddingIdentity,
) -> CognitionResult<()> {
    match embedding {
        GenerationEmbedding::Native(expected) => {
            if expected.model_asset_sha256 != actual.model_asset_sha256
                || expected.tokenizer_asset_sha256 != actual.tokenizer_asset_sha256
                || expected.dimension != actual.dimension
                || expected.pooling != actual.pooling
                || expected.normalize != actual.normalize
                || expected.truncation != actual.truncation
                || expected.max_tokens != actual.max_tokens
                || expected.preprocessing != actual.preprocessing
            {
                return Err(mismatch());
            }
        }
        GenerationEmbedding::JavaScript(js) => {
            preflight(embedding)?;
            if actual.dimension != 1024
                || actual.max_tokens != 8192
                || actual.tokenizer_asset_sha256 != js.tokenizer_asset_sha256
                || actual.model_asset_sha256 != js.model_asset_sha256
                || actual.preprocessing != "tokenizer-json-special-tokens-checked-v1"
                || actual.pooling != "cls"
                || actual.truncation != "strict-error-over-max"
                || !actual.normalize
            {
                return Err(mismatch());
            }
        }
    }
    Ok(())
}

fn mismatch() -> CognitionError {
    CognitionError::new(
        CognitionCode::MemoryEmbeddingVersionMismatch,
        "memory_embedding_version_mismatch",
    )
}
