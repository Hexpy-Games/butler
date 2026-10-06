//! Exact o200k encoding, reusing unchanged blocks at pre-tokenizer boundaries.
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use tiktoken_rs::{CoreBPE, o200k_base};

use super::ModelCatalogError;

mod blocks;
mod chains;
use blocks::{BlockCache, chunks};

#[derive(Default)]
pub(super) struct TokenizerOwner {
    encoding: OnceLock<Result<CoreBPE, Arc<dyn std::error::Error + Send + Sync>>>,
    blocks: Mutex<BlockCache>,
    chains: Mutex<chains::Cache>,
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

    fn token_blocks(&self, text: &str) -> Result<chains::Chain, ModelCatalogError> {
        let encoding = self.encoding()?;
        let mut chunks = chunks(text).peekable();
        let previous = chunks
            .peek()
            .and_then(|first| self.chains.lock().take(first));
        let mut chain = Vec::new();
        for (index, chunk) in chunks.enumerate() {
            if let Some((source, tokens)) = previous.as_ref().and_then(|old| old.get(index))
                && source.as_ref() == chunk
            {
                chain.push((source.clone(), tokens.clone()));
            } else {
                chain.push((Arc::from(chunk), self.block(encoding, chunk)));
            }
        }
        self.chains.lock().insert(chain.clone());
        Ok(chain)
    }

    pub(super) fn encode_ordinary(&self, text: &str) -> Result<Vec<u32>, ModelCatalogError> {
        let blocks = self.token_blocks(text)?;
        let mut tokens = Vec::with_capacity(blocks.iter().map(|(_, tokens)| tokens.len()).sum());
        for (_, block) in blocks {
            tokens.extend_from_slice(&block);
        }
        Ok(tokens)
    }

    pub(super) fn count_ordinary(&self, text: &str) -> Result<usize, ModelCatalogError> {
        // Marker-looking user/tool strings remain ordinary text, matching
        // js-tiktoken encode(text, [], []). Counting needs no transcript copy.
        Ok(self
            .token_blocks(text)?
            .iter()
            .map(|(_, tokens)| tokens.len())
            .sum())
    }
}

#[cfg(test)]
pub(crate) mod verification;
