//! Embedded assets: Hugeicons glyphs (Butler's DS icon set, MIT, exported as SVG) and the
//! Pretendard faces (OFL). See THIRD-PARTY-NOTICES at the workspace root.
use std::borrow::Cow;

use gpui::{AssetSource, SharedString};

macro_rules! icon {
    ($name:literal) => {
        (
            concat!("icons/", $name, ".svg"),
            include_bytes!(concat!("../assets/icons/", $name, ".svg")).as_slice(),
        )
    };
}

const FILES: &[(&str, &[u8])] = &[
    icon!("activity"),
    icon!("arrow-left"),
    icon!("briefcase"),
    icon!("chevron-down"),
    icon!("chevron-right"),
    icon!("clock"),
    icon!("copy"),
    icon!("file"),
    icon!("filter"),
    icon!("folder"),
    icon!("folder-add"),
    icon!("general"),
    icon!("library"),
    icon!("message"),
    icon!("minus"),
    icon!("moon"),
    icon!("more"),
    icon!("panel-left"),
    icon!("panel-left-open"),
    icon!("pencil"),
    icon!("plus"),
    icon!("search"),
    icon!("send"),
    icon!("settings"),
    icon!("shield-check"),
    icon!("shield-question"),
    icon!("spinner"),
    icon!("square"),
    icon!("sun"),
    icon!("terminal"),
    icon!("wrench"),
    icon!("x"),
];

pub(crate) struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> anyhow::Result<Option<Cow<'static, [u8]>>> {
        Ok(FILES
            .iter()
            .find(|(p, _)| *p == path)
            .map(|(_, b)| Cow::Borrowed(*b)))
    }

    fn list(&self, path: &str) -> anyhow::Result<Vec<SharedString>> {
        Ok(FILES
            .iter()
            .filter(|(p, _)| p.starts_with(path))
            .map(|(p, _)| SharedString::from(*p))
            .collect())
    }
}

pub(crate) const FONTS: &[&[u8]] = &[
    include_bytes!("../assets/fonts/Pretendard-Regular.ttf"),
    include_bytes!("../assets/fonts/Pretendard-Medium.ttf"),
    include_bytes!("../assets/fonts/Pretendard-SemiBold.ttf"),
    include_bytes!("../assets/fonts/Pretendard-Bold.ttf"),
];
