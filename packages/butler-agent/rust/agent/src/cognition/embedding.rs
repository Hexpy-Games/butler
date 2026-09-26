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

#[derive(Debug, Clone, Copy)]
pub(crate) struct EmbeddingFailure(pub(crate) &'static str);

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct NativeEmbeddingIdentity {
    pub(crate) schema: String,
    pub(crate) model: String,
    pub(crate) runtime: String,
    pub(crate) ort_wrapper_version: String,
    pub(crate) ort_api: u32,
    pub(crate) runtime_build_info_sha256: String,
    pub(crate) tokenizer_runtime_version: String,
    pub(crate) tokenizer_asset_sha256: String,
    pub(crate) model_asset_sha256: String,
    pub(crate) preprocessing: String,
    pub(crate) pooling: String,
    pub(crate) truncation: String,
    pub(crate) normalize: bool,
    pub(crate) max_tokens: usize,
    pub(crate) dimension: usize,
    pub(crate) version: String,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct NativeEmbeddingResult {
    pub(crate) embeddings: Vec<Vec<f32>>,
    pub(crate) token_counts: Vec<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) embedded_texts: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) omitted_count: Option<usize>,
    pub(crate) metadata: NativeEmbeddingIdentity,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct NativeTokenization {
    pub(crate) token_ids: Vec<Vec<u32>>,
    pub(crate) token_counts: Vec<usize>,
    pub(crate) max_tokens: usize,
}

pub(crate) struct NativeEmbeddingEngine {
    strict_tokenizer: Tokenizer,
    session: Session,
    max_tokens: usize,
    checked_identity: NativeEmbeddingIdentity,
    unchecked_identity: NativeEmbeddingIdentity,
}

impl NativeEmbeddingEngine {
    pub(crate) fn load(data_root: &Path) -> Result<Self, EmbeddingFailure> {
        let root = data_root.join("cache/models/Xenova/bge-m3");
        let tokenizer_file = root.join("tokenizer.json");
        let tokenizer_config = root.join("tokenizer_config.json");
        let model_config = root.join("config.json");
        let model_file = root.join(MODEL_FILE);
        ensure_data_authority(
            data_root,
            &[
                &root,
                &tokenizer_file,
                &tokenizer_config,
                &model_config,
                &model_file,
            ],
        )
        .map_err(|_| EmbeddingFailure("embed_asset_path_unsafe"))?;
        for path in [
            &tokenizer_file,
            &tokenizer_config,
            &model_config,
            &model_file,
        ] {
            if !path.is_file() {
                return Err(EmbeddingFailure("embed_asset_unavailable"));
            }
        }
        let tokenizer_asset_sha256 =
            aggregate_hash(&root, &["tokenizer.json", "tokenizer_config.json"])?;
        let model_asset_sha256 = aggregate_hash(&root, &["config.json", MODEL_FILE])?;
        let mut strict_tokenizer = Tokenizer::from_file(&tokenizer_file)
            .map_err(|_| EmbeddingFailure("embed_tokenizer_unavailable"))?;
        strict_tokenizer
            .with_truncation(None)
            .map_err(|_| EmbeddingFailure("embed_tokenizer_unavailable"))?;
        strict_tokenizer.with_padding(None);
        let max_tokens = [
            positive_json_integer(&tokenizer_config, "model_max_length"),
            positive_json_integer(&model_config, "max_position_embeddings"),
        ]
        .into_iter()
        .flatten()
        .min()
        .ok_or(EmbeddingFailure("embed_tokenizer_limit_unavailable"))?;
        let builder =
            Session::builder().map_err(|_| EmbeddingFailure("embed_model_unavailable"))?;
        let builder = builder
            .with_intra_threads(1)
            .map_err(|_| EmbeddingFailure("embed_model_unavailable"))?;
        let mut builder = builder
            .with_inter_threads(1)
            .map_err(|_| EmbeddingFailure("embed_model_unavailable"))?;
        let session = builder
            .commit_from_file(&model_file)
            .map_err(|_| EmbeddingFailure("embed_model_unavailable"))?;
        if session.inputs().is_empty()
            || session.inputs().iter().any(|input| {
                !matches!(
                    input.name(),
                    "input_ids" | "attention_mask" | "token_type_ids"
                )
            })
        {
            return Err(EmbeddingFailure("embed_model_input_unsupported"));
        }
        let runtime_build_info_sha256 = hash_bytes(ort::info().as_bytes());
        let mut checked_identity = NativeEmbeddingIdentity {
            schema: "butler.native-embedding-identity.v1".to_owned(),
            model: MODEL_ID.to_owned(),
            runtime: "onnxruntime-cpu-static".to_owned(),
            ort_wrapper_version: ORT_WRAPPER_VERSION.to_owned(),
            ort_api: ort::MINOR_VERSION,
            runtime_build_info_sha256,
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
        };
        checked_identity.version = hash_bytes(
            &serde_json::to_vec(&checked_identity)
                .map_err(|_| EmbeddingFailure("embed_identity_invalid"))?,
        );
        let mut unchecked_identity = checked_identity.clone();
        unchecked_identity.preprocessing =
            "tokenizer-json-special-tokens-legacy-mean-v1".to_owned();
        unchecked_identity.pooling = "attention-mask-mean".to_owned();
        unchecked_identity.truncation = "postprocess-right-to-max-tokens".to_owned();
        unchecked_identity.version.clear();
        unchecked_identity.version = hash_bytes(
            &serde_json::to_vec(&unchecked_identity)
                .map_err(|_| EmbeddingFailure("embed_identity_invalid"))?,
        );
        Ok(Self {
            strict_tokenizer,
            session,
            max_tokens,
            checked_identity,
            unchecked_identity,
        })
    }

    pub(crate) fn tokenize(
        &self,
        texts: &[String],
    ) -> Result<NativeTokenization, EmbeddingFailure> {
        let mut token_ids = Vec::with_capacity(texts.len());
        let mut token_counts = Vec::with_capacity(texts.len());
        for text in texts {
            let encoded = self.encode(text)?;
            token_counts.push(encoded.len());
            token_ids.push(encoded.get_ids().to_vec());
        }
        Ok(NativeTokenization {
            token_ids,
            token_counts,
            max_tokens: self.max_tokens,
        })
    }

    pub(crate) fn embed(
        &mut self,
        texts: &[String],
        checked: bool,
        resplit: bool,
        max_embeddings: Option<usize>,
    ) -> Result<NativeEmbeddingResult, EmbeddingFailure> {
        if texts.is_empty()
            || texts.len() > MAX_EMBEDDINGS
            || (checked && texts.iter().any(String::is_empty))
        {
            return Err(EmbeddingFailure("embed_invalid_request"));
        }
        if max_embeddings.is_some_and(|n| n == 0 || n > MAX_EMBEDDINGS) {
            return Err(EmbeddingFailure("embed_invalid_request"));
        }
        let prepared = if checked && resplit {
            self.resplit(texts)?
        } else {
            texts.to_vec()
        };
        if prepared.len() > MAX_EMBEDDINGS && max_embeddings.is_none() {
            return Err(EmbeddingFailure("embed_request_too_large"));
        }
        let limit = max_embeddings.unwrap_or(prepared.len()).min(prepared.len());
        let omitted_count = prepared.len() - limit;
        let embedded_texts = prepared[..limit].to_vec();
        let mut embeddings = Vec::with_capacity(limit);
        let mut token_counts = Vec::with_capacity(limit);
        for text in &embedded_texts {
            let mut encoded = self.encode(text)?;
            if checked && encoded.len() > self.max_tokens {
                return Err(EmbeddingFailure("embed_input_too_long"));
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
        Ok(NativeEmbeddingResult {
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
            .map_err(|_| EmbeddingFailure("embed_tokenization_failed"))
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
                    return Err(EmbeddingFailure("embed_grapheme_too_long"));
                }
                let mid = graphemes.len().div_ceil(2);
                pending.push(graphemes[mid..].concat());
                pending.push(graphemes[..mid].concat());
            }
            if pending.len() + result.len() > 1024 {
                return Err(EmbeddingFailure("embed_resplit_limit"));
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
                _ => return Err(EmbeddingFailure("embed_model_input_unsupported")),
            }
            .iter()
            .map(|value| i64::from(*value))
            .collect();
            let tensor = Tensor::from_array(([1usize, len], values))
                .map_err(|_| EmbeddingFailure("embed_inference_failed"))?;
            inputs.push((input.name().to_owned(), tensor));
        }
        let outputs = self
            .session
            .run(inputs)
            .map_err(|_| EmbeddingFailure("embed_inference_failed"))?;
        let output = ["last_hidden_state", "logits", "token_embeddings"]
            .into_iter()
            .find_map(|name| outputs.get(name))
            .ok_or(EmbeddingFailure("embed_output_invalid"))?;
        let (shape, data) = output
            .try_extract_tensor::<f32>()
            .map_err(|_| EmbeddingFailure("embed_output_invalid"))?;
        if shape.len() != 3
            || shape[0] != 1
            || shape[1] != len as i64
            || shape[2] != EXPECTED_DIMENSION as i64
            || data.len() != len * EXPECTED_DIMENSION
        {
            return Err(EmbeddingFailure("embed_dimension_invalid"));
        }
        let mut vector = vec![0.0_f32; EXPECTED_DIMENSION];
        if checked {
            vector.copy_from_slice(&data[..EXPECTED_DIMENSION]);
        } else {
            let mask = encoded.get_attention_mask();
            let count: u32 = mask.iter().sum();
            if count == 0 {
                return Err(EmbeddingFailure("embed_output_invalid"));
            }
            for (position, active) in mask.iter().enumerate() {
                if *active == 0 {
                    continue;
                }
                let row = &data[position * EXPECTED_DIMENSION..(position + 1) * EXPECTED_DIMENSION];
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
            return Err(EmbeddingFailure("embed_output_invalid"));
        }
        let norm = squared.sqrt() as f32;
        for value in &mut vector {
            *value /= norm;
        }
        if vector.iter().any(|value| !value.is_finite()) {
            return Err(EmbeddingFailure("embed_output_invalid"));
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
            .map_err(|_| EmbeddingFailure("embed_asset_identity_unavailable"))?;
        aggregate.update(pair);
    }
    Ok(format!("{:x}", aggregate.finalize()))
}

fn hash_file(path: &PathBuf) -> Result<String, EmbeddingFailure> {
    let mut file =
        File::open(path).map_err(|_| EmbeddingFailure("embed_asset_identity_unavailable"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| EmbeddingFailure("embed_asset_identity_unavailable"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
