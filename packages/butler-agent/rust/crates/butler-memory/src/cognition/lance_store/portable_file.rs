//! Keep native file URLs and decoding while using the standard atomic writer.
use std::{collections::HashMap, sync::Arc};

use lance::io::{ObjectStore, ObjectStoreParams, ObjectStoreRegistry};
use lance_io::object_store::ObjectStoreProvider;
use object_store::path::Path;
use url::Url;

pub(super) fn configure(registry: &ObjectStoreRegistry) -> lance::Result<()> {
    let file = registry
        .get_provider("file")
        .ok_or_else(|| lance::Error::invalid_input("File provider is unavailable"))?;
    registry.insert("file", Arc::new(PortableFile { file }));
    Ok(())
}

#[derive(Debug)]
struct PortableFile {
    file: Arc<dyn ObjectStoreProvider>,
}

#[async_trait::async_trait]
impl ObjectStoreProvider for PortableFile {
    async fn new_store(&self, base: Url, params: &ObjectStoreParams) -> lance::Result<ObjectStore> {
        // Lance's optimized local writer calls tempfile::persist's native APIs.
        // The file-object-store backend uses std::fs::rename, which supports
        // extended paths. Its files, formats, atomic replacement and cache
        // budgets are identical. Keep the original file URL for path decoding.
        let path = base
            .as_str()
            .strip_prefix("file:")
            .ok_or_else(|| lance::Error::invalid_input("File URL is required"))?;
        let portable = Url::parse(&format!("file-object-store:{path}"))
            .map_err(|error| lance::Error::invalid_input(error.to_string()))?;
        let mut store = self.file.new_store(portable, params).await?;
        store.store_prefix = self.calculate_object_store_prefix(&base, params.storage_options())?;
        Ok(store)
    }

    fn extract_path(&self, url: &Url) -> lance::Result<Path> {
        self.file.extract_path(url)
    }

    fn calculate_object_store_prefix(
        &self,
        url: &Url,
        options: Option<&HashMap<String, String>>,
    ) -> lance::Result<String> {
        self.file.calculate_object_store_prefix(url, options)
    }
}
