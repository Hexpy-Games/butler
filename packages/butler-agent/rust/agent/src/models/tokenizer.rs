use std::sync::{Arc, OnceLock};

use tiktoken_rs::{CoreBPE, o200k_base};

use super::ModelCatalogError;

#[derive(Default)]
pub(super) struct TokenizerOwner {
    encoding: OnceLock<Result<CoreBPE, Arc<dyn std::error::Error + Send + Sync>>>,
}

impl TokenizerOwner {
    pub(super) fn count_ordinary(&self, text: &str) -> Result<usize, ModelCatalogError> {
        let encoding = self
            .encoding
            .get_or_init(|| o200k_base().map_err(|error| Arc::from(error.into_boxed_dyn_error())))
            .as_ref()
            .map_err(|error| ModelCatalogError::Tokenizer(Arc::clone(error)))?;
        // `encode_ordinary` treats marker-looking user/tool strings as ordinary text,
        // matching js-tiktoken encode(text, [], []).
        Ok(encoding.count_ordinary(text))
    }
}
