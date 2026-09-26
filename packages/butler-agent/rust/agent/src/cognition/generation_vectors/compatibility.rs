//! Read-only compatibility for the one verified Transformers.js checked CLS profile.
//! The JavaScript manifest and row identity remain JavaScript-owned.

use serde_json::json;
use sha2::{Digest, Sha256};

use crate::cognition::{
    CognitionError, CognitionResult, GenerationEmbedding, NativeEmbeddingIdentity,
};

pub(super) fn preflight(embedding: &GenerationEmbedding) -> CognitionResult<()> {
    let GenerationEmbedding::JavaScript(js) = embedding else {
        return Ok(());
    };
    if js.model != "Xenova/bge-m3"
        || js.transformers_version != "3.8.1"
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

pub(super) fn query_identity(
    embedding: &GenerationEmbedding,
    actual: &NativeEmbeddingIdentity,
) -> CognitionResult<()> {
    match embedding {
        GenerationEmbedding::Native(expected) => {
            if expected.version != actual.version {
                return Err(mismatch());
            }
        }
        GenerationEmbedding::JavaScript(js) => {
            preflight(embedding)?;
            if actual.model != js.model
                || actual.dimension != 1024
                || actual.max_tokens != 8192
                || actual.tokenizer_asset_sha256 != js.tokenizer_asset_sha256
                || actual.model_asset_sha256 != js.model_asset_sha256
                || actual.runtime != "onnxruntime-cpu-static"
                || actual.ort_api != 21
                || actual.tokenizer_runtime_version != "0.22.2"
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
        "memory_embedding_version_mismatch",
        "memory_embedding_version_mismatch",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn js() -> GenerationEmbedding {
        let mut value = json!({
            "model":"Xenova/bge-m3", "dimension":1024, "pooling":"cls", "normalize":true,
            "version":"", "max_tokens":8192, "transformers_version":"3.8.1",
            "node_runtime_version":"24.0.0", "bun_runtime_version":"1.2.0",
            "tokenizer_asset_sha256":"a".repeat(64), "model_asset_sha256":"b".repeat(64)
        });
        let identity = json!([
            "butler-embedding-runtime-v1",
            value["model"],
            value["transformers_version"],
            "cls",
            true,
            1024,
            8192,
            value["tokenizer_asset_sha256"],
            value["model_asset_sha256"],
            value["node_runtime_version"],
            value["bun_runtime_version"],
        ]);
        value["version"] = json!(format!(
            "{:x}",
            Sha256::digest(identity.to_string().as_bytes())
        ));
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn source_identity_is_not_native_identity() {
        let source = js();
        assert!(preflight(&source).is_ok());
        let mut altered = serde_json::to_value(js()).unwrap();
        altered["transformers_version"] = json!("3.8.0");
        assert_eq!(
            preflight(&serde_json::from_value(altered).unwrap())
                .unwrap_err()
                .code,
            "memory_embedding_version_mismatch"
        );
    }
}
