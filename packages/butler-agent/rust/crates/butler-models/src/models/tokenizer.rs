//! Exact o200k encoding, reusing unchanged blocks at pre-tokenizer boundaries.
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use tiktoken_rs::{CoreBPE, o200k_base};

use super::ModelCatalogError;

mod blocks;
use blocks::{BlockCache, chunks};

#[derive(Default)]
pub(super) struct TokenizerOwner {
    encoding: OnceLock<Result<CoreBPE, Arc<dyn std::error::Error + Send + Sync>>>,
    blocks: Mutex<BlockCache>,
}

impl TokenizerOwner {
    fn encoding(&self) -> Result<&CoreBPE, ModelCatalogError> {
        self.encoding
            .get_or_init(|| o200k_base().map_err(|error| Arc::from(error.into_boxed_dyn_error())))
            .as_ref()
            .map_err(|error| ModelCatalogError::Tokenizer(Arc::clone(error)))
    }

    fn block(&self, encoding: &CoreBPE, text: &str) -> Arc<[u32]> {
        if let Some(tokens) = self.blocks.lock().get(text) {
            return tokens;
        }
        // Never hold the shared lock during regex/BPE work. Concurrent misses
        // can compute the same block; insertion checks again and stays bounded.
        let tokens: Arc<[u32]> = encoding.encode_ordinary(text).into();
        self.blocks.lock().insert(text, tokens.clone());
        tokens
    }

    pub(super) fn encode_ordinary(&self, text: &str) -> Result<Vec<u32>, ModelCatalogError> {
        let encoding = self.encoding()?;
        let mut tokens = Vec::new();
        for chunk in chunks(text) {
            tokens.extend_from_slice(&self.block(encoding, chunk));
        }
        Ok(tokens)
    }

    pub(super) fn count_ordinary(&self, text: &str) -> Result<usize, ModelCatalogError> {
        let encoding = self.encoding()?;
        // Marker-looking user/tool strings remain ordinary text, matching
        // js-tiktoken encode(text, [], []). Counting needs no transcript copy.
        Ok(chunks(text)
            .map(|chunk| self.block(encoding, chunk).len())
            .sum())
    }
}

#[cfg(test)]
pub(crate) mod verification;
