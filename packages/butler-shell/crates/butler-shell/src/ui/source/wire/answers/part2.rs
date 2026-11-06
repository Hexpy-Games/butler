//! Typed renderer wire contracts; field names follow their TypeScript sources.
use crate::ui::source::wire::{
    AnswerBlockActionsItemsItem, AnswerBlockCalloutTone, AnswerBlockChartKind,
    AnswerBlockChartSeriesItem, AnswerBlockChecklistItemsItem, AnswerBlockFactsItemsItem,
    AnswerBlockGalleryItemsItem, AnswerBlockId, AnswerBlockMetricsItemsItem,
    AnswerBlockProgressItemsItem, AnswerBlockTabsTabsItem, AnswerBlockTimelineItemsItem,
    AnswerBlockTitle, AnswerCell, AnswerLeafBlock, AnswerMedia, AssetId, CardItem, Checked,
};
use serde::Deserialize;

/// TS: packages/butler-app/client/shared/app-contracts.ts:85 AnswerBlock
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type")]
pub(crate) enum AnswerBlock {
    #[serde(rename = "cards")]
    Cards {
        #[serde(default)]
        id: Option<AnswerBlockId>,
        #[serde(default)]
        title: Option<AnswerBlockTitle>,
        #[serde(default)]
        media: Option<AnswerMedia>,
        #[serde(default)]
        items: Vec<CardItem>,
    },
    #[serde(rename = "table")]
    Table {
        #[serde(default)]
        id: Option<AnswerBlockId>,
        #[serde(default)]
        title: Option<AnswerBlockTitle>,
        #[serde(default)]
        columns: Vec<String>,
        #[serde(default)]
        rows: Vec<Vec<AnswerCell>>,
    },
    #[serde(rename = "gallery")]
    Gallery {
        #[serde(default)]
        id: Option<AnswerBlockId>,
        #[serde(default)]
        title: Option<AnswerBlockTitle>,
        #[serde(default)]
        media: Option<AnswerMedia>,
        #[serde(default)]
        items: Vec<AnswerBlockGalleryItemsItem>,
    },
    #[serde(rename = "facts")]
    Facts {
        #[serde(default)]
        id: Option<AnswerBlockId>,
        #[serde(default)]
        title: Option<AnswerBlockTitle>,
        #[serde(default)]
        items: Vec<AnswerBlockFactsItemsItem>,
    },
    #[serde(rename = "metrics")]
    Metrics {
        #[serde(default)]
        id: Option<AnswerBlockId>,
        #[serde(default)]
        title: Option<AnswerBlockTitle>,
        #[serde(default)]
        items: Vec<AnswerBlockMetricsItemsItem>,
    },
    #[serde(rename = "chart")]
    Chart {
        #[serde(default)]
        id: Option<AnswerBlockId>,
        #[serde(default)]
        title: Option<AnswerBlockTitle>,
        kind: AnswerBlockChartKind,
        #[serde(default)]
        x: Vec<String>,
        #[serde(default)]
        series: Vec<AnswerBlockChartSeriesItem>,
        #[serde(default)]
        unit: Option<String>,
        #[serde(default)]
        checked: Option<Checked>,
        #[serde(default)]
        source: Option<AnswerSource>,
    },
    #[serde(rename = "callout")]
    Callout {
        #[serde(default)]
        id: Option<AnswerBlockId>,
        #[serde(default)]
        title: Option<AnswerBlockTitle>,
        #[serde(default)]
        tone: Option<AnswerBlockCalloutTone>,
        text: String,
    },
    #[serde(rename = "actions")]
    Actions {
        #[serde(default)]
        id: Option<AnswerBlockId>,
        #[serde(default)]
        title: Option<AnswerBlockTitle>,
        #[serde(default)]
        items: Vec<AnswerBlockActionsItemsItem>,
    },
    #[serde(rename = "timeline")]
    Timeline {
        #[serde(default)]
        id: Option<AnswerBlockId>,
        #[serde(default)]
        title: Option<AnswerBlockTitle>,
        #[serde(default)]
        items: Vec<AnswerBlockTimelineItemsItem>,
    },
    #[serde(rename = "checklist")]
    Checklist {
        #[serde(default)]
        id: Option<AnswerBlockId>,
        #[serde(default)]
        title: Option<AnswerBlockTitle>,
        #[serde(default)]
        items: Vec<AnswerBlockChecklistItemsItem>,
    },
    #[serde(rename = "progress")]
    Progress {
        #[serde(default)]
        id: Option<AnswerBlockId>,
        #[serde(default)]
        title: Option<AnswerBlockTitle>,
        #[serde(default)]
        items: Vec<AnswerBlockProgressItemsItem>,
    },
    #[serde(rename = "text")]
    Text {
        #[serde(default)]
        id: Option<AnswerBlockId>,
        #[serde(default)]
        title: Option<AnswerBlockTitle>,
        text: String,
    },
    #[serde(rename = "image")]
    Image {
        #[serde(default)]
        id: Option<AnswerBlockId>,
        #[serde(default)]
        title: Option<AnswerBlockTitle>,
        img: AssetId,
        #[serde(default)]
        caption: Option<String>,
        #[serde(default)]
        source: Option<AnswerSource>,
    },
    #[serde(rename = "quote")]
    Quote {
        #[serde(default)]
        id: Option<AnswerBlockId>,
        #[serde(default)]
        title: Option<AnswerBlockTitle>,
        text: String,
        #[serde(default)]
        cite: Option<String>,
        #[serde(default)]
        source: Option<AnswerSource>,
    },
    #[serde(rename = "columns")]
    Columns {
        #[serde(default)]
        id: Option<AnswerBlockId>,
        #[serde(default)]
        title: Option<AnswerBlockTitle>,
        #[serde(default)]
        blocks: Vec<AnswerLeafBlock>,
    },
    #[serde(rename = "tabs")]
    Tabs {
        #[serde(default)]
        id: Option<AnswerBlockId>,
        #[serde(default)]
        title: Option<AnswerBlockTitle>,
        #[serde(default)]
        tabs: Vec<AnswerBlockTabsTabsItem>,
    },
    #[serde(rename = "group")]
    Group {
        #[serde(default)]
        id: Option<AnswerBlockId>,
        #[serde(default)]
        title: Option<AnswerBlockTitle>,
        #[serde(default)]
        blocks: Vec<AnswerLeafBlock>,
    },
    #[serde(rename = "epics")]
    Epics {
        project_id: String,
        #[serde(default)]
        ids: Vec<String>,
    },
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:87 AnswerSource
pub(crate) type AnswerSource = String;

/// TS: packages/butler-app/client/shared/app-contracts.ts:89 CardValue
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CardValueVariant1 {
    pub(crate) amount: f64,
    #[serde(default)]
    pub(crate) was: Option<f64>,
    #[serde(default)]
    pub(crate) note: Option<String>,
    #[serde(default)]
    pub(crate) unit: Option<String>,
    #[serde(default)]
    pub(crate) cur: Option<()>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:89 CardValue
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CardValueVariant2 {
    pub(crate) amount: f64,
    #[serde(default)]
    pub(crate) was: Option<f64>,
    #[serde(default)]
    pub(crate) note: Option<String>,
    #[serde(default)]
    pub(crate) unit: Option<()>,
    #[serde(default)]
    pub(crate) cur: Option<String>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:89 CardValue
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub(crate) enum CardValue {
    Variant1(CardValueVariant1),
    Variant2(CardValueVariant2),
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:95 CardsBlock
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CardsBlock {
    pub(crate) r#type: String,
    #[serde(default)]
    pub(crate) id: Option<AnswerBlockId>,
    #[serde(default)]
    pub(crate) title: Option<AnswerBlockTitle>,
    #[serde(default)]
    pub(crate) media: Option<AnswerMedia>,
    #[serde(default)]
    pub(crate) items: Vec<CardItem>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:103 TableBlock
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TableBlock {
    pub(crate) r#type: String,
    #[serde(default)]
    pub(crate) id: Option<AnswerBlockId>,
    #[serde(default)]
    pub(crate) title: Option<AnswerBlockTitle>,
    #[serde(default)]
    pub(crate) columns: Vec<String>,
    #[serde(default)]
    pub(crate) rows: Vec<Vec<AnswerCell>>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:111 GalleryBlock
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct GalleryBlock {
    pub(crate) r#type: String,
    #[serde(default)]
    pub(crate) id: Option<AnswerBlockId>,
    #[serde(default)]
    pub(crate) title: Option<AnswerBlockTitle>,
    #[serde(default)]
    pub(crate) media: Option<AnswerMedia>,
    #[serde(default)]
    pub(crate) items: Vec<AnswerBlockGalleryItemsItem>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:123 FactsBlock
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct FactsBlock {
    pub(crate) r#type: String,
    #[serde(default)]
    pub(crate) id: Option<AnswerBlockId>,
    #[serde(default)]
    pub(crate) title: Option<AnswerBlockTitle>,
    #[serde(default)]
    pub(crate) items: Vec<AnswerBlockFactsItemsItem>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:135 MetricsBlock
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct MetricsBlock {
    pub(crate) r#type: String,
    #[serde(default)]
    pub(crate) id: Option<AnswerBlockId>,
    #[serde(default)]
    pub(crate) title: Option<AnswerBlockTitle>,
    #[serde(default)]
    pub(crate) items: Vec<AnswerBlockMetricsItemsItem>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:150 ChartBlock
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ChartBlock {
    pub(crate) r#type: String,
    #[serde(default)]
    pub(crate) id: Option<AnswerBlockId>,
    #[serde(default)]
    pub(crate) title: Option<AnswerBlockTitle>,
    pub(crate) kind: AnswerBlockChartKind,
    #[serde(default)]
    pub(crate) x: Vec<String>,
    #[serde(default)]
    pub(crate) series: Vec<AnswerBlockChartSeriesItem>,
    #[serde(default)]
    pub(crate) unit: Option<String>,
    #[serde(default)]
    pub(crate) checked: Option<Checked>,
    #[serde(default)]
    pub(crate) source: Option<AnswerSource>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:169 CalloutBlock (inline CalloutBlockTone).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CalloutBlockTone {
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

/// TS: packages/butler-app/client/shared/app-contracts.ts:165 CalloutBlock
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CalloutBlock {
    pub(crate) r#type: String,
    #[serde(default)]
    pub(crate) id: Option<AnswerBlockId>,
    #[serde(default)]
    pub(crate) title: Option<AnswerBlockTitle>,
    #[serde(default)]
    pub(crate) tone: Option<CalloutBlockTone>,
    pub(crate) text: String,
}
