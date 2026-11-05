//! A DS icon at a token size, drawn in the inherited text colour (`currentColor`).
use gpui::{SharedString, Styled as _, Svg, svg};

use super::Icon;
use super::context::Ds;
use crate::tokens::Length;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IconSize {
    Xs,
    Sm,
    Md,
    Lg,
}

pub fn icon(icon: Icon, size: IconSize, ds: &Ds) -> Svg {
    let side = ds.len(match size {
        IconSize::Xs => Length::IconSizeXs,
        IconSize::Sm => Length::IconSizeSm,
        IconSize::Md => Length::IconSizeMd,
        IconSize::Lg => Length::IconSizeLg,
    });
    svg()
        .path(SharedString::from(icon.path()))
        .size(side)
        .flex_none()
}
