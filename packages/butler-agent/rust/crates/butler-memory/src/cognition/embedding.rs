//! Private, lazy BGE-M3 CPU embedding engine. It does not select a memory generation.

use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

use ort::{session::Session, value::Tensor};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokenizers::{Encoding, Tokenizer, TruncationDirection};
use unicode_segmentation::UnicodeSegmentation;

use super::mutable_paths::ensure_data_authority;

const MODEL_ID: &str = "Xenova/bge-m3";
const MODEL_FILE: &str = "onnx/model_quantized.onnx";
const TOKENIZER_VERSION: &str = "0.22.2";
const ORT_WRAPPER_VERSION: &str = "2.0.0-rc.13";
const MAX_EMBEDDINGS: usize = 32;
const EXPECTED_DIMENSION: usize = 1024;

/// A failure of the private embedding worker. Only `code` crosses the worker
/// protocol; the source stays in the worker for diagnostics.
#[derive(Debug, thiserror::Error)]
#[error("{code}")]
pub struct EmbeddingFailure {
    code: &'static str,
    #[source]
    source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl EmbeddingFailure {
    fn new(code: &'static str) -> Self {
        Self { code, source: None }
    }

    fn caused<E>(code: &'static str) -> impl FnOnce(E) -> Self
    where
        E: Into<Box<dyn std::error::Error + Send + Sync>>,
    {
        move |source| Self {
            code,
            source: Some(source.into()),
        }
    }

    /// The worker protocol code.
    pub fn code(&self) -> &'static str {
        self.code
    }
}

/// What produced an embedding: model, runtime, tokenizer, pooling and their hashes. `version`
/// hashes the rest, so vectors from different identities never mix.
#[derive(Clone, Deserialize, Serialize)]
pub struct EmbeddingIdentity {
    /// Identity schema.
    pub schema: String,
    pub(crate) model: String,
    pub(crate) runtime: String,
    pub(crate) ort_wrapper_version: String,
    pub(crate) ort_api: u32,
    pub(crate) runtime_build_info_sha256: String,
    pub(crate) tokenizer_runtime_version: String,
    pub(crate) tokenizer_asset_sha256: String,
    pub(crate) model_asset_sha256: String,
    pub(crate) preprocessing: String,
    /// Pooling (`cls` or `attention-mask-mean`).
    pub pooling: String,
    /// How overlong input is handled.
    pub truncation: String,
    pub(crate) normalize: bool,
    pub(crate) max_tokens: usize,
    /// Vector dimension.
    pub dimension: usize,
    /// Hash of every other field.
    pub version: String,
}

/// Embeddings of a request.
#[derive(Deserialize, Serialize)]
pub struct EmbeddingResult {
    /// One normalized vector per embedded text.
    pub embeddings: Vec<Vec<f32>>,
    /// Tokens per embedded text.
    pub token_counts: Vec<usize>,
    /// The texts embedded, after any resplitting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedded_texts: Option<Vec<String>>,
    /// Texts left out by the embedding limit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub omitted_count: Option<usize>,
    /// Identity of the embedding.
    pub metadata: EmbeddingIdentity,
}

/// Token ids of tokenized texts.
#[derive(Deserialize, Serialize)]
pub struct Tokenization {
    pub(crate) token_ids: Vec<Vec<u32>>,
    pub(crate) token_counts: Vec<usize>,
    pub(crate) max_tokens: usize,
}

/// The model and tokenizer files under the data root.
struct Assets {
    root: std::path::PathBuf,
    tokenizer_file: std::path::PathBuf,
    tokenizer_config: std::path::PathBuf,
    model_config: std::path::PathBuf,
    model_file: std::path::PathBuf,
}

impl Assets {
    /// The asset paths, checked to stay inside the data root and to exist.
    fn new(data_root: &Path) -> Result<Self, EmbeddingFailure> {
        let root = data_root.join("cache/models/Xenova/bge-m3");
        let assets = Self {
            tokenizer_file: root.join("tokenizer.json"),
            tokenizer_config: root.join("tokenizer_config.json"),
            model_config: root.join("config.json"),
            model_file: root.join(MODEL_FILE),
            root,
        };
        ensure_data_authority(
            data_root,
            &[
                &assets.root,
                &assets.tokenizer_file,
                &assets.tokenizer_config,
                &assets.model_config,
                &assets.model_file,
            ],
        )
        .map_err(EmbeddingFailure::caused("embed_asset_path_unsafe"))?;
        for path in [
            &assets.tokenizer_file,
            &assets.tokenizer_config,
            &assets.model_config,
            &assets.model_file,
        ] {
            if !path.is_file() {
                return Err(EmbeddingFailure::new("embed_asset_unavailable"));
            }
        }
        Ok(assets)
    }
}

/// A single-threaded ONNX session whose inputs the engine can feed.
fn load_session(model_file: &Path) -> Result<Session, EmbeddingFailure> {
    let builder =
        Session::builder().map_err(EmbeddingFailure::caused("embed_model_unavailable"))?;
    // Builder errors own the (non-Send) builder, so they cannot be kept.
    let builder = builder
        .with_intra_threads(1)
        .map_err(|_builder_error| EmbeddingFailure::new("embed_model_unavailable"))?;
    let mut builder = builder
        .with_inter_threads(1)
        .map_err(|_builder_error| EmbeddingFailure::new("embed_model_unavailable"))?;
    let session = builder
        .commit_from_file(model_file)
        .map_err(EmbeddingFailure::caused("embed_model_unavailable"))?;
    if session.inputs().is_empty()
        || session.inputs().iter().any(|input| {
            !matches!(
                input.name(),
                "input_ids" | "attention_mask" | "token_type_ids"
            )
        })
    {
        return Err(EmbeddingFailure::new("embed_model_input_unsupported"));
    }
    Ok(session)
}

/// `identity` with its version: the hash of its JSON with an empty
/// version.
fn identity(mut identity: EmbeddingIdentity) -> Result<EmbeddingIdentity, EmbeddingFailure> {
    identity.version = hash_bytes(
        &serde_json::to_vec(&identity)
            .map_err(EmbeddingFailure::caused("embed_identity_invalid"))?,
    );
    Ok(identity)
}

/// The local BGE-M3 tokenizer and ONNX model.
pub struct EmbeddingEngine {
    strict_tokenizer: Tokenizer,
    session: Session,
    max_tokens: usize,
    checked_identity: EmbeddingIdentity,
    unchecked_identity: EmbeddingIdentity,
}

impl EmbeddingEngine {
    /// Loads the local BGE-M3 tokenizer and ONNX model and derives the
    /// identities of the checked and legacy embedding modes.
    pub fn load(data_root: &Path) -> Result<Self, EmbeddingFailure> {
        let assets = Assets::new(data_root)?;
        let tokenizer_asset_sha256 =
            aggregate_hash(&assets.root, &["tokenizer.json", "tokenizer_config.json"])?;
        let model_asset_sha256 = aggregate_hash(&assets.root, &["config.json", MODEL_FILE])?;
        let mut strict_tokenizer = Tokenizer::from_file(&assets.tokenizer_file)
            .map_err(EmbeddingFailure::caused("embed_tokenizer_unavailable"))?;
        strict_tokenizer
            .with_truncation(None)
            .map_err(EmbeddingFailure::caused("embed_tokenizer_unavailable"))?;
        strict_tokenizer.with_padding(None);
        let max_tokens = [
            positive_json_integer(&assets.tokenizer_config, "model_max_length"),
            positive_json_integer(&assets.model_config, "max_position_embeddings"),
        ]
        .into_iter()
        .flatten()
        .min()
        .ok_or(EmbeddingFailure::new("embed_tokenizer_limit_unavailable"))?;
        let session = load_session(&assets.model_file)?;
        let checked_identity = identity(EmbeddingIdentity {
            schema: "butler.native-embedding-identity.v1".to_owned(),
            model: MODEL_ID.to_owned(),
            runtime: "onnxruntime-cpu-static".to_owned(),
            ort_wrapper_version: ORT_WRAPPER_VERSION.to_owned(),
            ort_api: ort::MINOR_VERSION,
            runtime_build_info_sha256: hash_bytes(ort::info().as_bytes()),
            tokenizer_runtime_version: TOKENIZER_VERSION.to_owned(),
            tokenizer_asset_sha256,
            model_asset_sha256,
            preprocessing: "tokenizer-json-special-tokens-checked-v1".to_owned(),
            pooling: "cls".to_owned(),
            truncation: "strict-error-over-max".to_owned(),
            normalize: true,
            max_tokens,
            dimension: EXPECTED_DIMENSION,
            version: String::new(),
        })?;
        let unchecked_identity = identity(EmbeddingIdentity {
            preprocessing: "tokenizer-json-special-tokens-legacy-mean-v1".to_owned(),
            pooling: "attention-mask-mean".to_owned(),
            truncation: "postprocess-right-to-max-tokens".to_owned(),
            version: String::new(),
            ..checked_identity.clone()
        })?;
        Ok(Self {
            strict_tokenizer,
            session,
            max_tokens,
            checked_identity,
            unchecked_identity,
        })
    }

    /// Token ids of each text, with special tokens.
    pub fn tokenize(&self, texts: &[String]) -> Result<Tokenization, EmbeddingFailure> {
        let mut token_ids = Vec::with_capacity(texts.len());
        let mut token_counts = Vec::with_capacity(texts.len());
        for text in texts {
            let encoded = self.encode(text)?;
            token_counts.push(encoded.len());
            token_ids.push(encoded.get_ids().to_vec());
        }
        Ok(Tokenization {
            token_ids,
            token_counts,
            max_tokens: self.max_tokens,
        })
    }

    /// Embeds the texts with the given pooling.
    pub fn embed(
        &mut self,
        texts: &[String],
        checked: bool,
        resplit: bool,
        max_embeddings: Option<usize>,
    ) -> Result<EmbeddingResult, EmbeddingFailure> {
        if texts.is_empty()
            || texts.len() > MAX_EMBEDDINGS
            || (checked && texts.iter().any(String::is_empty))
        {
            return Err(EmbeddingFailure::new("embed_invalid_request"));
        }
        if max_embeddings.is_some_and(|n| n == 0 || n > MAX_EMBEDDINGS) {
            return Err(EmbeddingFailure::new("embed_invalid_request"));
        }
        let prepared = if checked && resplit {
            self.resplit(texts)?
        } else {
            texts.to_vec()
        };
        if prepared.len() > MAX_EMBEDDINGS && max_embeddings.is_none() {
            return Err(EmbeddingFailure::new("embed_request_too_large"));
        }
        let limit = max_embeddings.unwrap_or(prepared.len()).min(prepared.len());
        let omitted_count = prepared.len() - limit;
        let embedded_texts = prepared.get(..limit).unwrap_or_default().to_vec();
        let mut embeddings = Vec::with_capacity(limit);
        let mut token_counts = Vec::with_capacity(limit);
        for text in &embedded_texts {
            let mut encoded = self.encode(text)?;
            if checked && encoded.len() > self.max_tokens {
                return Err(EmbeddingFailure::new("embed_input_too_long"));
            }
            if !checked && encoded.len() > self.max_tokens {
                // transformers.js 3.8.1 truncates the already postprocessed
                // sequence, so an overlong legacy input may lose its EOS.
                encoded.truncate(self.max_tokens, 0, TruncationDirection::Right);
                encoded.get_overflowing_mut().clear();
            }
            token_counts.push(encoded.len());
            embeddings.push(self.infer(&encoded, checked)?);
        }
        Ok(EmbeddingResult {
            embeddings,
            token_counts,
            embedded_texts: (checked && resplit).then_some(embedded_texts),
            omitted_count: (checked && resplit).then_some(omitted_count),
            metadata: if checked {
                self.checked_identity.clone()
            } else {
                self.unchecked_identity.clone()
            },
        })
    }

    fn encode(&self, text: &str) -> Result<Encoding, EmbeddingFailure> {
        self.strict_tokenizer
            .encode(text, true)
            .map_err(EmbeddingFailure::caused("embed_tokenization_failed"))
    }

    fn resplit(&self, texts: &[String]) -> Result<Vec<String>, EmbeddingFailure> {
        let mut result = Vec::new();
        let mut pending: Vec<String> = texts.iter().rev().cloned().collect();
        while let Some(text) = pending.pop() {
            if self.encode(&text)?.len() <= self.max_tokens {
                result.push(text);
            } else {
                let graphemes: Vec<&str> = text.graphemes(true).collect();
                if graphemes.len() <= 1 {
                    return Err(EmbeddingFailure::new("embed_grapheme_too_long"));
                }
                let (head, tail) = graphemes.split_at(graphemes.len().div_ceil(2));
                pending.push(tail.concat());
                pending.push(head.concat());
            }
            if pending.len() + result.len() > 1024 {
                return Err(EmbeddingFailure::new("embed_resplit_limit"));
            }
        }
        Ok(result)
    }

    fn infer(&mut self, encoded: &Encoding, checked: bool) -> Result<Vec<f32>, EmbeddingFailure> {
        let len = encoded.len();
        let mut inputs = Vec::with_capacity(self.session.inputs().len());
        for input in self.session.inputs() {
            let values: Vec<i64> = match input.name() {
                "input_ids" => encoded.get_ids(),
                "attention_mask" => encoded.get_attention_mask(),
                "token_type_ids" => encoded.get_type_ids(),
                _ => return Err(EmbeddingFailure::new("embed_model_input_unsupported")),
            }
            .iter()
            .map(|value| i64::from(*value))
            .collect();
            let tensor = Tensor::from_array(([1usize, len], values))
                .map_err(EmbeddingFailure::caused("embed_inference_failed"))?;
            inputs.push((input.name().to_owned(), tensor));
        }
        let outputs = self
            .session
            .run(inputs)
            .map_err(EmbeddingFailure::caused("embed_inference_failed"))?;
        let output = ["last_hidden_state", "logits", "token_embeddings"]
            .into_iter()
            .find_map(|name| outputs.get(name))
            .ok_or(EmbeddingFailure::new("embed_output_invalid"))?;
        let (shape, data) = output
            .try_extract_tensor::<f32>()
            .map_err(EmbeddingFailure::caused("embed_output_invalid"))?;
        let expected_shape = [
            1,
            i64::try_from(len).unwrap_or(i64::MAX),
            i64::try_from(EXPECTED_DIMENSION).unwrap_or(i64::MAX),
        ];
        if **shape != expected_shape || data.len() != len * EXPECTED_DIMENSION {
            return Err(EmbeddingFailure::new("embed_dimension_invalid"));
        }
        let mut vector = vec![0.0_f32; EXPECTED_DIMENSION];
        if checked {
            let first = data
                .get(..EXPECTED_DIMENSION)
                .ok_or(EmbeddingFailure::new("embed_output_invalid"))?;
            vector.copy_from_slice(first);
        } else {
            let mask = encoded.get_attention_mask();
            let count: u32 = mask.iter().sum();
            if count == 0 {
                return Err(EmbeddingFailure::new("embed_output_invalid"));
            }
            for (active, row) in mask.iter().zip(data.chunks_exact(EXPECTED_DIMENSION)) {
                if *active == 0 {
                    continue;
                }
                for (total, value) in vector.iter_mut().zip(row) {
                    *total += *value / count as f32;
                }
            }
        }
        let squared: f64 = vector
            .iter()
            .map(|value| f64::from(*value) * f64::from(*value))
            .sum();
        if !squared.is_finite() || squared <= 0.0 {
            return Err(EmbeddingFailure::new("embed_output_invalid"));
        }
        #[expect(
            clippy::cast_possible_truncation,
            reason = "the finite positive norm of f32 components fits f32"
        )]
        let norm = squared.sqrt() as f32;
        for value in &mut vector {
            *value /= norm;
        }
        if vector.iter().any(|value| !value.is_finite()) {
            return Err(EmbeddingFailure::new("embed_output_invalid"));
        }
        Ok(vector)
    }
}

fn positive_json_integer(path: &Path, key: &str) -> Option<usize> {
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    value
        .get(key)?
        .as_u64()
        .and_then(|number| usize::try_from(number).ok())
        .filter(|number| *number > 0)
}

fn aggregate_hash(root: &Path, files: &[&str]) -> Result<String, EmbeddingFailure> {
    let mut aggregate = Sha256::new();
    for relative in files {
        let digest = hash_file(&root.join(relative))?;
        let pair = serde_json::to_vec(&(relative, digest))
            .map_err(EmbeddingFailure::caused("embed_asset_identity_unavailable"))?;
        aggregate.update(pair);
    }
    Ok(format!("{:x}", aggregate.finalize()))
}

fn hash_file(path: &PathBuf) -> Result<String, EmbeddingFailure> {
    let mut file =
        File::open(path).map_err(EmbeddingFailure::caused("embed_asset_identity_unavailable"))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(EmbeddingFailure::caused("embed_asset_identity_unavailable"))?;
        if count == 0 {
            break;
        }
        digest.update(buffer.get(..count).unwrap_or_default());
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
