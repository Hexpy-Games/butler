//! Private, lazy BGE-M3 CPU embedding engine. It does not select a memory generation.

use std::path::Path;

use ort::session::Session;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokenizers::{Encoding, Tokenizer, TruncationDirection};
use unicode_segmentation::UnicodeSegmentation;

mod assets;
mod cache;
mod infer;

use assets::{Assets, MODEL_FILE, positive_json_integer};
use cache::{Key, VectorCache};

const MODEL_ID: &str = "Xenova/bge-m3";
const TOKENIZER_VERSION: &str = "0.22.2";
const ORT_WRAPPER_VERSION: &str = "2.0.0-rc.13";
const MAX_EMBEDDINGS: usize = 32;
const EXPECTED_DIMENSION: usize = 1024;
/// The most threads one inference uses; more do not speed a single BGE-M3
/// batch up enough to be worth taking the cores from everything else.
const MAX_INTRA_THREADS: usize = 4;

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

/// An ONNX session whose inputs the engine can feed. It computes on as many
/// performance cores as a batch can use, up to four, and its threads sleep
/// between requests instead of spinning.
fn load_session(model_file: &Path) -> Result<Session, EmbeddingFailure> {
    let threads = butler_platform::cpu::performance_cores().clamp(1, MAX_INTRA_THREADS);
    let builder =
        Session::builder().map_err(EmbeddingFailure::caused("embed_model_unavailable"))?;
    // Builder errors own the (non-Send) builder, so they cannot be kept.
    let builder = builder
        .with_intra_threads(threads)
        .map_err(|_builder_error| EmbeddingFailure::new("embed_model_unavailable"))?;
    let builder = builder
        .with_intra_op_spinning(false)
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
    pad_id: i64,
    max_tokens: usize,
    checked_identity: EmbeddingIdentity,
    unchecked_identity: EmbeddingIdentity,
    cache: VectorCache,
}

/// A text with its token encoding, made once and used for the length check,
/// the batch plan and the inference.
struct Prepared {
    text: String,
    encoded: Encoding,
}

impl EmbeddingEngine {
    /// Loads the local BGE-M3 tokenizer and ONNX model and derives the
    /// identities of the checked and legacy embedding modes.
    pub fn load(data_root: &Path) -> Result<Self, EmbeddingFailure> {
        let assets = Assets::new(data_root)?;
        let tokenizer_asset_sha256 =
            assets.aggregate_hash(&["tokenizer.json", "tokenizer_config.json"])?;
        let model_asset_sha256 = assets.aggregate_hash(&["config.json", MODEL_FILE])?;
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
        let pad_id = strict_tokenizer.token_to_id("<pad>").map_or(1, i64::from);
        Ok(Self {
            strict_tokenizer,
            session,
            pad_id,
            max_tokens,
            checked_identity,
            unchecked_identity,
            cache: VectorCache::default(),
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
        let mut prepared = if checked && resplit {
            self.resplit(texts)?
        } else {
            texts
                .iter()
                .map(|text| self.prepare(text))
                .collect::<Result<Vec<_>, _>>()?
        };
        if prepared.len() > MAX_EMBEDDINGS && max_embeddings.is_none() {
            return Err(EmbeddingFailure::new("embed_request_too_large"));
        }
        let limit = max_embeddings.unwrap_or(prepared.len()).min(prepared.len());
        let omitted_count = prepared.len() - limit;
        prepared.truncate(limit);
        for item in &mut prepared {
            if checked && item.encoded.len() > self.max_tokens {
                return Err(EmbeddingFailure::new("embed_input_too_long"));
            }
            if !checked && item.encoded.len() > self.max_tokens {
                // transformers.js 3.8.1 truncates the already postprocessed
                // sequence, so an overlong legacy input may lose its EOS.
                item.encoded
                    .truncate(self.max_tokens, 0, TruncationDirection::Right);
                item.encoded.get_overflowing_mut().clear();
            }
        }
        let embeddings = self.vectors(&prepared, checked)?;
        let token_counts = prepared.iter().map(|item| item.encoded.len()).collect();
        let embedded_texts =
            (checked && resplit).then(|| prepared.into_iter().map(|item| item.text).collect());
        Ok(EmbeddingResult {
            embeddings,
            token_counts,
            embedded_texts,
            omitted_count: (checked && resplit).then_some(omitted_count),
            metadata: if checked {
                self.checked_identity.clone()
            } else {
                self.unchecked_identity.clone()
            },
        })
    }

    /// The vector of each text, in order. Texts seen before come from the
    /// cache and equal texts of one request are embedded once; the rest run
    /// through the model in padded batches of similar length.
    fn vectors(
        &mut self,
        prepared: &[Prepared],
        checked: bool,
    ) -> Result<Vec<Vec<f32>>, EmbeddingFailure> {
        let keys: Vec<Key> = prepared
            .iter()
            .map(|item| Key::new(checked, &item.text))
            .collect();
        // The first position of each distinct text the cache does not hold.
        let mut missing: Vec<usize> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for (index, key) in keys.iter().enumerate() {
            if self.cache.get(key).is_none() && seen.insert(*key) {
                missing.push(index);
            }
        }
        let lengths: Vec<usize> = missing
            .iter()
            .map(|index| prepared.get(*index).map_or(0, |item| item.encoded.len()))
            .collect();
        for batch in infer::plan_batches(&lengths) {
            let positions: Vec<usize> = batch
                .iter()
                .filter_map(|slot| missing.get(*slot).copied())
                .collect();
            let encodings: Vec<&Encoding> = positions
                .iter()
                .filter_map(|index| prepared.get(*index).map(|item| &item.encoded))
                .collect();
            let vectors = infer::embed_batch(&mut self.session, self.pad_id, &encodings, checked)?;
            for (index, vector) in positions.into_iter().zip(vectors) {
                if let Some(key) = keys.get(index) {
                    self.cache.insert(*key, vector);
                }
            }
        }
        keys.iter()
            .map(|key| {
                self.cache
                    .get(key)
                    .cloned()
                    .ok_or(EmbeddingFailure::new("embed_output_invalid"))
            })
            .collect()
    }

    fn prepare(&self, text: &str) -> Result<Prepared, EmbeddingFailure> {
        Ok(Prepared {
            text: text.to_owned(),
            encoded: self.encode(text)?,
        })
    }

    fn encode(&self, text: &str) -> Result<Encoding, EmbeddingFailure> {
        self.strict_tokenizer
            .encode(text, true)
            .map_err(EmbeddingFailure::caused("embed_tokenization_failed"))
    }

    /// Splits texts over the model limit in halves at grapheme boundaries
    /// until every piece fits. Each piece is tokenized once, here.
    fn resplit(&self, texts: &[String]) -> Result<Vec<Prepared>, EmbeddingFailure> {
        let mut result = Vec::new();
        let mut pending: Vec<String> = texts.iter().rev().cloned().collect();
        while let Some(text) = pending.pop() {
            let encoded = self.encode(&text)?;
            if encoded.len() <= self.max_tokens {
                result.push(Prepared { text, encoded });
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
}

fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
