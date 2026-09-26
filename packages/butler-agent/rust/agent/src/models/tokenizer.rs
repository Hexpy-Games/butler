use std::sync::OnceLock;

use tiktoken_rs::{CoreBPE, o200k_base};

use super::ModelCatalogError;

#[derive(Default)]
pub(super) struct TokenizerOwner {
    encoding: OnceLock<Result<CoreBPE, String>>,
}

impl TokenizerOwner {
    pub(super) fn count_ordinary(&self, text: &str) -> Result<usize, ModelCatalogError> {
        let encoding = self
            .encoding
            .get_or_init(|| o200k_base().map_err(|error| error.to_string()))
            .as_ref()
            .map_err(|error| ModelCatalogError::new(error.clone()))?;
        // `encode_ordinary` treats marker-looking user/tool strings as ordinary text,
        // matching js-tiktoken encode(text, [], []).
        Ok(encoding.count_ordinary(text))
    }
}
