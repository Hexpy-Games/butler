//! Typed renderer wire contracts; field names follow their TypeScript sources.
use crate::ui::source::wire::{
    AnswerBlock, AnswerBlockActionsItemsItem, AnswerBlockChartKind, AnswerBlockChartSeriesItem,
    AnswerBlockChecklistItemsItem, AnswerBlockFactsItemsItem, AnswerBlockGalleryItemsItem,
    AnswerBlockId, AnswerBlockMetricsItemsItem, AnswerBlockProgressItemsItem,
    AnswerBlockTabsTabsItem, AnswerBlockTimelineItemsItem, AnswerBlockTitle, AnswerCell,
    AnswerMedia, AnswerSource, AssetId, CardItem, CardValue, Checked,
};
use serde::Deserialize;

/// TS: packages/butler-app/client/shared/app-contracts.ts:173 ActionsBlock
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ActionsBlock {
    pub(crate) r#type: String,
    #[serde(default)]
    pub(crate) id: Option<AnswerBlockId>,
    #[serde(default)]
    pub(crate) title: Option<AnswerBlockTitle>,
    #[serde(default)]
    pub(crate) items: Vec<AnswerBlockActionsItemsItem>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:185 TimelineBlock
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TimelineBlock {
    pub(crate) r#type: String,
    #[serde(default)]
    pub(crate) id: Option<AnswerBlockId>,
    #[serde(default)]
    pub(crate) title: Option<AnswerBlockTitle>,
    #[serde(default)]
    pub(crate) items: Vec<AnswerBlockTimelineItemsItem>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:198 ChecklistBlock
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ChecklistBlock {
    pub(crate) r#type: String,
    #[serde(default)]
    pub(crate) id: Option<AnswerBlockId>,
    #[serde(default)]
    pub(crate) title: Option<AnswerBlockTitle>,
    #[serde(default)]
    pub(crate) items: Vec<AnswerBlockChecklistItemsItem>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:208 ProgressBlock
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ProgressBlock {
    pub(crate) r#type: String,
    #[serde(default)]
    pub(crate) id: Option<AnswerBlockId>,
    #[serde(default)]
    pub(crate) title: Option<AnswerBlockTitle>,
    #[serde(default)]
    pub(crate) items: Vec<AnswerBlockProgressItemsItem>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:222 TextBlock
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TextBlock {
    pub(crate) r#type: String,
    #[serde(default)]
    pub(crate) id: Option<AnswerBlockId>,
    #[serde(default)]
    pub(crate) title: Option<AnswerBlockTitle>,
    pub(crate) text: String,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:229 ImageBlock
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ImageBlock {
    pub(crate) r#type: String,
    #[serde(default)]
    pub(crate) id: Option<AnswerBlockId>,
    #[serde(default)]
    pub(crate) title: Option<AnswerBlockTitle>,
    pub(crate) img: AssetId,
    #[serde(default)]
    pub(crate) caption: Option<String>,
    #[serde(default)]
    pub(crate) source: Option<AnswerSource>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:238 QuoteBlock
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct QuoteBlock {
    pub(crate) r#type: String,
    #[serde(default)]
    pub(crate) id: Option<AnswerBlockId>,
    #[serde(default)]
    pub(crate) title: Option<AnswerBlockTitle>,
    pub(crate) text: String,
    #[serde(default)]
    pub(crate) cite: Option<String>,
    #[serde(default)]
    pub(crate) source: Option<AnswerSource>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:169 CalloutBlock (inline AnswerLeafBlockCalloutTone).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AnswerLeafBlockCalloutTone {
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

/// TS: packages/butler-app/client/shared/app-contracts.ts:247 AnswerLeafBlock
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type")]
pub(crate) enum AnswerLeafBlock {
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
        tone: Option<AnswerLeafBlockCalloutTone>,
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
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:249 ColumnsBlock
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct ColumnsBlock {
    pub(crate) r#type: String,
    #[serde(default)]
    pub(crate) id: Option<AnswerBlockId>,
    #[serde(default)]
    pub(crate) title: Option<AnswerBlockTitle>,
    #[serde(default)]
    pub(crate) blocks: Vec<AnswerLeafBlock>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:256 GroupBlock
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct GroupBlock {
    pub(crate) r#type: String,
    #[serde(default)]
    pub(crate) id: Option<AnswerBlockId>,
    #[serde(default)]
    pub(crate) title: Option<AnswerBlockTitle>,
    #[serde(default)]
    pub(crate) blocks: Vec<AnswerLeafBlock>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:263 TabsBlock
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct TabsBlock {
    pub(crate) r#type: String,
    #[serde(default)]
    pub(crate) id: Option<AnswerBlockId>,
    #[serde(default)]
    pub(crate) title: Option<AnswerBlockTitle>,
    #[serde(default)]
    pub(crate) tabs: Vec<AnswerBlockTabsTabsItem>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:273 AnswerBlocks
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnswerBlocks {
    pub(crate) v: i64,
    #[serde(default)]
    pub(crate) blocks: Vec<AnswerBlock>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:278 AnswerBlockSet
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnswerBlockSet {
    pub(crate) call_id: String,
    #[serde(default)]
    pub(crate) set_ids: Vec<String>,
    pub(crate) spec: AnswerBlocks,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:286 EpicsBlock
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct EpicsBlock {
    pub(crate) r#type: String,
    pub(crate) project_id: String,
    #[serde(default)]
    pub(crate) ids: Vec<String>,
}

/// TS: packages/butler-app/client/shared/answer-blocks-view.ts:4 AnswerCardView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnswerCardView {
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
    #[serde(default)]
    pub(crate) image_url: Option<String>,
}
