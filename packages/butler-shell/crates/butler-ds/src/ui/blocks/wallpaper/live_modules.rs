//! Built-in shader mapping and Electron's bundled manifests; no copied manifest defaults.
use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::Value;

use super::{DIM_SKIP, ImageDim, WallpaperTone, brightness, default_dim};

pub(super) struct Photo {
    pub path: &'static str,
    pub bytes: &'static [u8],
    pub luminance: f32,
}

pub(super) struct Module {
    pub manifest: Value,
    pub shaders: [u32; 2],
    pub still_time: f32,
    pub photo: Option<Photo>,
}

macro_rules! manifest {
    ($id:literal) => {
        include_str!(concat!("../../../../../../../butler-app/client/ui/src/libs/design-system/blocks/Wallpaper/modules/", $id, "/wallpaper.json"))
    };
}

macro_rules! photo {
    ($id:literal, $luminance:literal) => {
        Some(Photo {
            path: concat!("modules/", $id, "/photo.jpg"),
            bytes: include_bytes!(concat!("../../../../../../../butler-app/client/ui/src/libs/design-system/blocks/Wallpaper/modules/", $id, "/photo.jpg")),
            luminance: $luminance,
        })
    };
}

pub(super) fn get(id: &str) -> Option<&'static Module> {
    static MODULES: OnceLock<HashMap<String, Module>> = OnceLock::new();
    MODULES.get_or_init(modules).get(id)
}

fn modules() -> HashMap<String, Module> {
    // DS: modules/index.ts BUILTIN_WALLPAPER_MODULES: stillTime, defaultImage and luminance.
    // Shader ids: gpui_render/src/shaders/filters.rs fragment_wallpaper at b1049da385.
    let entries = [
        (manifest!("butler.riso-print"), [4, 5], 0., None),
        (manifest!("butler.bloom"), [1, 0], 0., None),
        (manifest!("butler.silk"), [7, 0], 0., None),
        (manifest!("butler.riso-flow"), [8, 0], 20., None),
        (manifest!("butler.lamina"), [9, 0], 2., None),
        (manifest!("butler.diatom"), [10, 11], 6., None),
        (manifest!("butler.dusk"), [2, 0], 10., None),
        (manifest!("butler.shoreline"), [3, 0], 8., None),
        (
            manifest!("butler.photo-clouds"),
            [12, 0],
            20.,
            photo!("butler.photo-clouds", 0.245),
        ),
        (
            manifest!("butler.photo-daisies"),
            [13, 0],
            6.,
            photo!("butler.photo-daisies", 0.297),
        ),
        (
            manifest!("butler.stipple"),
            [14, 15],
            20.,
            photo!("butler.stipple", 0.14),
        ),
        (manifest!("butler.grain"), [16, 0], 0., None),
        (manifest!("butler.cherry-blossom"), [18, 0], 37., None),
    ];
    entries
        .into_iter()
        .filter_map(|(json, shaders, still_time, photo)| {
            let manifest: Value = serde_json::from_str(json).ok()?;
            let id = manifest["id"].as_str()?.to_owned();
            Some((
                id,
                Module {
                    manifest,
                    shaders,
                    still_time,
                    photo,
                },
            ))
        })
        .collect()
}

impl Module {
    /// DS: scheduler.ts wallpaperRenderPolicy and POLICIES.
    pub(super) fn policy(&self) -> (f32, f32) {
        if self.manifest["pixelRatio"] == "device" {
            return (2., f32::INFINITY);
        }
        match self.manifest["motion"].as_str() {
            Some("static") => (2., 4_000_000.),
            Some("drift") => (1.5, 2_400_000.),
            _ => (1., 1_400_000.),
        }
    }

    /// DS: time.ts wallpaperShaderTime (stillTime is already in seconds).
    #[expect(
        clippy::cast_possible_truncation,
        reason = "shader time is an f32 uniform"
    )]
    pub(super) fn time(&self) -> f32 {
        if self.manifest["motion"] == "static" {
            return 0.;
        }
        (f64::from(self.still_time).rem_euclid(self.period())) as f32
    }

    /// DS: time.ts WALLPAPER_TIME_PERIOD_SECONDS.
    pub(super) fn period(&self) -> f64 {
        self.manifest["timePeriod"]
            .as_f64()
            .unwrap_or(5000. * std::f64::consts::PI)
    }

    /// DS: registry.ts wallpaperDefaultImageScene, imageMath.ts wallpaperImageBrightness.
    pub(super) fn brightness(&self, tone: WallpaperTone) -> f32 {
        let Some(photo) = &self.photo else {
            return 1.;
        };
        let dim = default_dim(Some(photo.luminance));
        let dim = if dim <= DIM_SKIP { 0. } else { dim };
        let mode = match self.manifest["imageDim"].as_str() {
            Some("none") => ImageDim::None,
            Some("noDarkStep") => ImageDim::NoDarkStep,
            _ => ImageDim::Auto,
        };
        brightness(dim, tone == WallpaperTone::Dark, mode)
    }
}
