//! Typed renderer wire contracts; field names follow their TypeScript sources.
use crate::ui::source::wire::{AnswerLeafBlock, AnswerSource, CardValue};
use serde::Deserialize;

/// TS: packages/butler-app/client/shared/app-contracts.ts:60 AnswerBlockId
pub(crate) type AnswerBlockId = String;

/// TS: packages/butler-app/client/shared/app-contracts.ts:62 AnswerBlockTitle
pub(crate) type AnswerBlockTitle = String;

/// TS: packages/butler-app/client/shared/app-contracts.ts:64 Checked
pub(crate) type Checked = String;

/// TS: packages/butler-app/client/shared/app-contracts.ts:66 AssetId
pub(crate) type AssetId = String;

/// TS: packages/butler-app/client/shared/app-contracts.ts:68 AnswerMedia
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AnswerMedia {
    #[serde(rename = "1:1")]
    V11,
    #[serde(rename = "4:5")]
    V45,
    #[serde(rename = "3:4")]
    V34,
    #[serde(rename = "16:9")]
    V169,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:70 CardItem
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CardItem {
    #[serde(default)]
    pub(crate) key: Option<String>,
    #[serde(default)]
    pub(crate) label: Option<String>,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) sub: Option<String>,
    #[serde(default)]
    pub(crate) img: Option<AssetId>,
    #[serde(default)]
    pub(crate) facts: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) text: Option<String>,
    #[serde(default)]
    pub(crate) checked: Option<Checked>,
    #[serde(default)]
    pub(crate) value: Option<CardValue>,
    #[serde(default)]
    pub(crate) source: Option<AnswerSource>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:83 AnswerCell
pub(crate) type AnswerCell = Option<AnswerCellValue>;

/// TS: packages/butler-app/client/shared/app-contracts.ts:83 AnswerCell
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub(crate) enum AnswerCellValue {
    Variant1(String),
    Variant2(f64),
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:116 GalleryBlock (inline AnswerBlockGalleryItemsItem).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnswerBlockGalleryItemsItem {
    pub(crate) img: AssetId,
    #[serde(default)]
    pub(crate) caption: Option<String>,
    #[serde(default)]
    pub(crate) source: Option<AnswerSource>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:127 FactsBlock (inline AnswerBlockFactsItemsItem).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnswerBlockFactsItemsItem {
    pub(crate) label: String,
    pub(crate) value: String,
    #[serde(default)]
    pub(crate) checked: Option<Checked>,
    #[serde(default)]
    pub(crate) source: Option<AnswerSource>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:141 MetricsBlock (inline AnswerBlockMetricsItemsItemValue).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub(crate) enum AnswerBlockMetricsItemsItemValue {
    Variant1(String),
    Variant2(f64),
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:146 MetricsBlock (inline AnswerBlockMetricsItemsItemDirection).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AnswerBlockMetricsItemsItemDirection {
    #[serde(rename = "up-good")]
    UpGood,
    #[serde(rename = "down-good")]
    DownGood,
    #[serde(rename = "neutral")]
    Neutral,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:139 MetricsBlock (inline AnswerBlockMetricsItemsItem).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnswerBlockMetricsItemsItem {
    pub(crate) label: String,
    pub(crate) value: AnswerBlockMetricsItemsItemValue,
    #[serde(default)]
    pub(crate) unit: Option<String>,
    #[serde(default)]
    pub(crate) delta: Option<String>,
    #[serde(default)]
    pub(crate) checked: Option<Checked>,
    #[serde(default)]
    pub(crate) source: Option<AnswerSource>,
    #[serde(default)]
    pub(crate) direction: Option<AnswerBlockMetricsItemsItemDirection>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:154 ChartBlock (inline AnswerBlockChartKind).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AnswerBlockChartKind {
    #[serde(rename = "bar")]
    Bar,
    #[serde(rename = "line")]
    Line,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:156 ChartBlock (inline AnswerBlockChartSeriesItem).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnswerBlockChartSeriesItem {
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) values: Vec<Option<f64>>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:169 CalloutBlock (inline AnswerBlockCalloutTone).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AnswerBlockCalloutTone {
    #[serde(rename = "neutral")]
    Neutral,
    #[serde(rename = "info")]
    Info,
    #[serde(rename = "success")]
    Success,
    #[serde(rename = "warning")]
    Warning,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:177 ActionsBlock (inline AnswerBlockActionsItemsItemVariant1).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnswerBlockActionsItemsItemVariant1 {
    pub(crate) ask: String,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:177 ActionsBlock (inline AnswerBlockActionsItemsItemVariant2).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnswerBlockActionsItemsItemVariant2 {
    pub(crate) open: AnswerSource,
    pub(crate) label: String,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:177 ActionsBlock (inline AnswerBlockActionsItemsItem).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub(crate) enum AnswerBlockActionsItemsItem {
    Variant1(AnswerBlockActionsItemsItemVariant1),
    Variant2(AnswerBlockActionsItemsItemVariant2),
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:189 TimelineBlock (inline AnswerBlockTimelineItemsItem).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnswerBlockTimelineItemsItem {
    pub(crate) when: String,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) text: Option<String>,
    #[serde(default)]
    pub(crate) checked: Option<Checked>,
    #[serde(default)]
    pub(crate) source: Option<AnswerSource>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:202 ChecklistBlock (inline AnswerBlockChecklistItemsItem).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnswerBlockChecklistItemsItem {
    pub(crate) text: String,
    pub(crate) done: bool,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:212 ProgressBlock (inline AnswerBlockProgressItemsItem).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnswerBlockProgressItemsItem {
    pub(crate) label: String,
    pub(crate) value: f64,
    #[serde(default)]
    pub(crate) max: Option<f64>,
    #[serde(default)]
    pub(crate) unit: Option<String>,
    #[serde(default)]
    pub(crate) checked: Option<Checked>,
    #[serde(default)]
    pub(crate) source: Option<AnswerSource>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:267 TabsBlock (inline AnswerBlockTabsTabsItem).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnswerBlockTabsTabsItem {
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) blocks: Vec<AnswerLeafBlock>,
}
