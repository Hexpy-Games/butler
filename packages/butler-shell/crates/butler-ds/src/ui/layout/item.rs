//! Layout item props (DS Layout/itemProps.ts): flex and alignment props shared by Box, Stack
//! items, Grid items and Typo.
use gpui::{Styled, relative};

use crate::tokens::Length;
use crate::ui::context::Ds;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Basis {
    Auto,
    Content,
    /// `0%`.
    Zero,
    Xs,
    Sm,
    Md,
    Lg,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MinWidth {
    Zero,
    Auto,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MaxWidth {
    Full,
    ThreeFifths,
    Half,
    /// Capped at `--layout-max-width-field`. React lets the row's wrap lift the cap to the full
    /// width (a container-width calc); a flex item cannot read its parent's width, so the cap
    /// always applies (card 1, `maxWidth="field"`).
    Field,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AlignSelf {
    Start,
    Center,
    End,
    Stretch,
    Baseline,
}

/// Grid column span.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Span {
    One,
    Two,
    Three,
    Full,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ItemProps {
    pub grow: bool,
    pub shrink: Option<bool>,
    pub basis: Option<Basis>,
    pub min_width: Option<MinWidth>,
    pub max_width: Option<MaxWidth>,
    pub align_self: Option<AlignSelf>,
    pub invisible: bool,
}

impl ItemProps {
    pub fn apply<E: Styled>(&self, mut el: E, ds: &Ds) -> E {
        if self.grow {
            el = el.flex_grow(1.);
        }
        el = match self.shrink {
            Some(true) => el.flex_shrink(1.),
            Some(false) => el.flex_shrink_0(),
            None => el,
        };
        el = match self.basis {
            Some(Basis::Zero) => el.flex_basis(relative(0.)),
            Some(Basis::Xs) => el.flex_basis(ds.len(Length::LayoutBasisXs)),
            Some(Basis::Sm) => el.flex_basis(ds.len(Length::LayoutBasisSm)),
            Some(Basis::Md) => el.flex_basis(ds.len(Length::LayoutBasisMd)),
            Some(Basis::Lg) => el.flex_basis(ds.len(Length::LayoutBasisLg)),
            Some(Basis::Auto | Basis::Content) | None => el,
        };
        if self.min_width == Some(MinWidth::Zero) {
            el = el.min_w_0();
        }
        el = match self.max_width {
            Some(MaxWidth::Full) => el.max_w_full(),
            Some(MaxWidth::ThreeFifths) => el.max_w(relative(0.6)),
            Some(MaxWidth::Half) => el.max_w(relative(0.5)),
            Some(MaxWidth::Field) => el.max_w(ds.len(Length::LayoutMaxWidthField)),
            None => el,
        };
        el = match self.align_self {
            Some(AlignSelf::Start) => el.self_start(),
            Some(AlignSelf::Center) => el.self_center(),
            Some(AlignSelf::End) => el.self_end(),
            Some(AlignSelf::Stretch) => el.self_stretch(),
            Some(AlignSelf::Baseline) => el.self_baseline(),
            None => el,
        };
        if self.invisible {
            el = el.invisible();
        }
        el
    }
}

/// Chainable item props for any component that embeds [`ItemProps`].
pub trait WithItem: Sized {
    fn item_mut(&mut self) -> &mut ItemProps;

    fn grow(mut self) -> Self {
        self.item_mut().grow = true;
        self
    }

    fn shrink(mut self, shrink: bool) -> Self {
        self.item_mut().shrink = Some(shrink);
        self
    }

    fn basis(mut self, basis: Basis) -> Self {
        self.item_mut().basis = Some(basis);
        self
    }

    fn min_width(mut self, min_width: MinWidth) -> Self {
        self.item_mut().min_width = Some(min_width);
        self
    }

    fn max_width(mut self, max_width: MaxWidth) -> Self {
        self.item_mut().max_width = Some(max_width);
        self
    }

    fn align_self(mut self, align_self: AlignSelf) -> Self {
        self.item_mut().align_self = Some(align_self);
        self
    }

    fn invisible(mut self) -> Self {
        self.item_mut().invisible = true;
        self
    }
}
