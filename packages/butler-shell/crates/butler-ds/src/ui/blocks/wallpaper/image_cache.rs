//! `Wallpaper/imageCache.ts`: encoded image bytes by asset and variant, for the assets in use.
//! The app injects the loader (a stored upload, an authenticated fetch); decoding is gpui's.
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use gpui::{Image, ImageFormat, SharedString};

use super::ImageVariant;

/// Loads an asset's encoded image (orientation applied by the decoder) or says why it cannot.
pub type ImageLoader = Arc<dyn Fn(&str, ImageVariant) -> anyhow::Result<Arc<Image>>>;

/// Prefix of the asset id of a module's default image. // DS: imageCache.ts:10
const DEFAULT_IMAGE: &str = "default-image:";

/// The asset id of a module's default image (its bytes come from the module, not the loader).
pub fn default_image_asset(module_id: &str, key: &str) -> SharedString {
    format!("{DEFAULT_IMAGE}{module_id}\n{key}").into()
}

/// A default image bundled with the app: `bytes` is its encoded content (PNG or JPEG).
pub fn bundled_image(format: ImageFormat, bytes: &'static [u8]) -> Arc<Image> {
    Arc::new(Image::from_bytes(format, bytes.to_vec()))
}

/// Encoded bytes by asset and variant. Repeated requests share one loader call; a failure is not
/// kept, so the next request retries.
pub struct ImageCache {
    loader: ImageLoader,
    defaults: HashMap<SharedString, Arc<Image>>,
    entries: HashMap<(ImageVariant, SharedString), Arc<Image>>,
}

impl ImageCache {
    pub fn new(loader: ImageLoader) -> Self {
        Self {
            loader,
            defaults: HashMap::new(),
            entries: HashMap::new(),
        }
    }

    /// Registers a module default image under its asset id and returns the id.
    pub fn register_default(
        &mut self,
        module_id: &str,
        key: &str,
        image: Arc<Image>,
    ) -> SharedString {
        let asset = default_image_asset(module_id, key);
        self.defaults.insert(asset.clone(), image);
        asset
    }

    /// The asset's image: a module default from its module, anything else through the loader.
    pub fn image(
        &mut self,
        asset: &SharedString,
        variant: ImageVariant,
    ) -> anyhow::Result<Arc<Image>> {
        if asset.starts_with(DEFAULT_IMAGE) {
            return self
                .defaults
                .get(asset)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Unknown wallpaper image"));
        }
        let key = (variant, asset.clone());
        if let Some(cached) = self.entries.get(&key) {
            return Ok(Arc::clone(cached));
        }
        let image = (self.loader)(asset, variant)?;
        self.entries.insert(key, Arc::clone(&image));
        Ok(image)
    }

    /// Forgets every asset not listed (no scene uses it now).
    pub fn retain(&mut self, assets: &HashSet<SharedString>) {
        self.entries.retain(|(_, asset), _| assets.contains(asset));
    }
}
