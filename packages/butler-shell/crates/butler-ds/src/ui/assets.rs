//! Embedded assets: generated Butler DS icons, the custom sidebar spinner, the Pretendard faces
//! (--font-body) and IBM Plex Mono (--font-family-code).
//! See THIRD-PARTY-NOTICES at the workspace root.
use std::borrow::Cow;

use gpui::{AssetSource, SharedString};

use super::icon_files::FILES;

pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> anyhow::Result<Option<Cow<'static, [u8]>>> {
        Ok(FILES
            .iter()
            .chain(super::toast::ASSETS)
            .chain(super::provider_logo::ASSETS)
            .find(|(p, _)| *p == path)
            .map(|(_, b)| Cow::Borrowed(*b)))
    }

    fn list(&self, path: &str) -> anyhow::Result<Vec<SharedString>> {
        Ok(FILES
            .iter()
            .chain(super::toast::ASSETS)
            .chain(super::provider_logo::ASSETS)
            .filter(|(p, _)| p.starts_with(path))
            .map(|(p, _)| SharedString::from(*p))
            .collect())
    }
}

pub const FONTS: &[&[u8]] = &[
    include_bytes!("../../assets/fonts/Pretendard-Regular.ttf"),
    include_bytes!("../../assets/fonts/Pretendard-Medium.ttf"),
    include_bytes!("../../assets/fonts/Pretendard-SemiBold.ttf"),
    include_bytes!("../../assets/fonts/Pretendard-Bold.ttf"),
    // DS fonts.css: IBM Plex Mono 2.5.0, regular and semibold only.
    include_bytes!("../../assets/fonts/IBMPlexMono-Regular.ttf"),
    include_bytes!("../../assets/fonts/IBMPlexMono-SemiBold.ttf"),
    // Hangul in code: IBM Plex Sans KR 1.1.0, complete files (regular and semibold).
    include_bytes!("../../assets/fonts/IBMPlexSansKR-Regular.ttf"),
    include_bytes!("../../assets/fonts/IBMPlexSansKR-SemiBold.ttf"),
];
