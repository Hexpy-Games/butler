//! The type roles (DS Typo.tsx variants) as token tuples.
use crate::tokens::{Length, Number};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    H1,
    H2,
    H3,
    H4,
    H5,
    H6,
    Body,
    Caption,
    Label,
    Code,
    /// Inherits size, weight and line height; applies the text props only.
    Text,
    AppTitle,
    PanelTitle,
    DashboardTitle,
    SectionTitle,
    PanelSectionTitle,
    MetricValue,
}

/// The tokens of one role: size, line height, weight and letter spacing.
pub struct RoleTokens {
    pub size: Length,
    pub line_height: Length,
    pub weight: Number,
    pub letter_spacing: Number,
}

const fn roles(
    size: Length,
    line_height: Length,
    weight: Number,
    letter_spacing: Number,
) -> RoleTokens {
    RoleTokens {
        size,
        line_height,
        weight,
        letter_spacing,
    }
}

impl Role {
    /// `None` for [`Role::Text`], which sets no type scale of its own.
    pub fn tokens(self) -> Option<RoleTokens> {
        match self {
            Self::H1 | Self::H2 | Self::H3 | Self::H4 | Self::H5 | Self::H6 => Some(self.heading()),
            Self::Body | Self::Caption | Self::Label | Self::Code | Self::MetricValue => {
                Some(self.text_role())
            }
            Self::Text => None,
            _ => Some(self.title()),
        }
    }

    fn heading(self) -> RoleTokens {
        match self {
            Self::H1 => roles(
                Length::TypoH1Size,
                Length::TypoH1LineHeight,
                Number::TypoH1Weight,
                Number::TypoH1LetterSpacing,
            ),
            Self::H2 => roles(
                Length::TypoH2Size,
                Length::TypoH2LineHeight,
                Number::TypoH2Weight,
                Number::TypoH2LetterSpacing,
            ),
            Self::H3 => roles(
                Length::TypoH3Size,
                Length::TypoH3LineHeight,
                Number::TypoH3Weight,
                Number::TypoH3LetterSpacing,
            ),
            Self::H4 => roles(
                Length::TypoH4Size,
                Length::TypoH4LineHeight,
                Number::TypoH4Weight,
                Number::TypoH4LetterSpacing,
            ),
            Self::H5 => roles(
                Length::TypoH5Size,
                Length::TypoH5LineHeight,
                Number::TypoH5Weight,
                Number::TypoH5LetterSpacing,
            ),
            _ => roles(
                Length::TypoH6Size,
                Length::TypoH6LineHeight,
                Number::TypoH6Weight,
                Number::TypoH6LetterSpacing,
            ),
        }
    }

    fn text_role(self) -> RoleTokens {
        match self {
            Self::Body => roles(
                Length::TypoBodySize,
                Length::TypoBodyLineHeight,
                Number::TypoBodyWeight,
                Number::TypoBodyLetterSpacing,
            ),
            Self::Caption => roles(
                Length::TypoCaptionSize,
                Length::TypoCaptionLineHeight,
                Number::TypoCaptionWeight,
                Number::TypoCaptionLetterSpacing,
            ),
            Self::Label => roles(
                Length::TypoLabelSize,
                Length::TypoLabelLineHeight,
                Number::TypoLabelWeight,
                Number::TypoLabelLetterSpacing,
            ),
            Self::Code => roles(
                Length::TypoCodeSize,
                Length::TypoCodeLineHeight,
                Number::TypoCodeWeight,
                Number::TypoCodeLetterSpacing,
            ),
            _ => roles(
                Length::TypoMetricValueSize,
                Length::TypoMetricValueLineHeight,
                Number::TypoMetricValueWeight,
                Number::TypoMetricValueLetterSpacing,
            ),
        }
    }

    fn title(self) -> RoleTokens {
        match self {
            Self::AppTitle => roles(
                Length::TypoAppTitleSize,
                Length::TypoAppTitleLineHeight,
                Number::TypoAppTitleWeight,
                Number::TypoAppTitleLetterSpacing,
            ),
            Self::PanelTitle => roles(
                Length::TypoPanelTitleSize,
                Length::TypoPanelTitleLineHeight,
                Number::TypoPanelTitleWeight,
                Number::TypoPanelTitleLetterSpacing,
            ),
            Self::DashboardTitle => roles(
                Length::TypoDashboardTitleSize,
                Length::TypoDashboardTitleLineHeight,
                Number::TypoDashboardTitleWeight,
                Number::TypoDashboardTitleLetterSpacing,
            ),
            Self::SectionTitle => roles(
                Length::TypoSectionTitleSize,
                Length::TypoSectionTitleLineHeight,
                Number::TypoSectionTitleWeight,
                Number::TypoSectionTitleLetterSpacing,
            ),
            _ => roles(
                Length::TypoPanelSectionTitleSize,
                Length::TypoPanelSectionTitleLineHeight,
                Number::TypoPanelSectionTitleWeight,
                Number::TypoPanelSectionTitleLetterSpacing,
            ),
        }
    }

    /// Headings and title roles set `word-break: keep-all` themselves.
    pub fn keeps_words(self) -> bool {
        !matches!(
            self,
            Self::Body | Self::Caption | Self::Label | Self::Code | Self::Text | Self::MetricValue
        )
    }
}
