//! `Wallpaper/still.ts`: stills of wallpapers (picker thumbnails) cached by content. The React
//! file draws them through one offscreen WebGL2 context (`stillGpu.ts`, P6); here a still comes
//! from a `draw` the caller supplies (a poster, a decoded image), and this keeps the cache, its
//! key and its least-recently-used eviction.
use std::collections::VecDeque;
use std::sync::Arc;

use gpui::Image;

use super::{WallpaperSource, WallpaperTone, source_key};

/// Drawing-buffer px of a still.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StillSize {
    pub width: u32,
    pub height: u32,
    /// Lifecycle stills compose at their own window size instead of picker screen size.
    pub composition_width: Option<u32>,
    pub pixel_ratio: Option<f32>,
    pub day_phase: Option<f32>,
}

/// Most stills kept. // DS: still.ts:49
const DEFAULT_LIMIT: usize = 48;

/// Cache key of a still: the source's content key, the module's content revision (an edited
/// shader renders again), tone and size. // DS: still.ts:57-67
pub fn still_key(
    source: &WallpaperSource,
    revision: &str,
    tone: WallpaperTone,
    size: &StillSize,
) -> String {
    let optional = |value: Option<String>| value.unwrap_or_default();
    format!(
        "{}|{revision}|{}|{}x{}|{}|{}|{}",
        source_key(source),
        tone.as_str(),
        size.width,
        size.height,
        optional(size.composition_width.map(|width| width.to_string())),
        optional(size.day_phase.map(|phase| phase.to_string())),
        optional(size.pixel_ratio.map(|ratio| ratio.to_string())),
    )
}

/// Stills by [`still_key`]; equal requests share one render and the least recently used goes
/// first out. A failed render is not kept, so the next request retries.
pub struct StillCache {
    limit: usize,
    /// Least recently used first.
    entries: VecDeque<(String, Arc<Image>)>,
}

impl StillCache {
    pub fn new() -> Self {
        Self::with_limit(DEFAULT_LIMIT)
    }

    pub fn with_limit(limit: usize) -> Self {
        Self {
            limit,
            entries: VecDeque::new(),
        }
    }

    /// The still for `key`, drawn by `draw` when it is not cached.
    pub fn render(
        &mut self,
        key: String,
        draw: impl FnOnce() -> anyhow::Result<Arc<Image>>,
    ) -> anyhow::Result<Arc<Image>> {
        if let Some(entry) = self
            .entries
            .iter()
            .position(|(cached, _)| *cached == key)
            .and_then(|position| self.entries.remove(position))
        {
            let image = Arc::clone(&entry.1);
            self.entries.push_back(entry);
            return Ok(image);
        }
        let image = draw()?;
        self.entries.push_back((key, Arc::clone(&image)));
        while self.entries.len() > self.limit {
            self.entries.pop_front();
        }
        Ok(image)
    }
}

impl Default for StillCache {
    fn default() -> Self {
        Self::new()
    }
}
