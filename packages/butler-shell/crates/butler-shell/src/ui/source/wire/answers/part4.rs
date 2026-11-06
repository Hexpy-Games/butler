//! Typed renderer wire contracts; field names follow their TypeScript sources.
use crate::ui::source::wire::{
    AnswerBlockActionsItemsItem, AnswerBlockChartKind, AnswerBlockChartSeriesItem,
    AnswerBlockChecklistItemsItem, AnswerBlockFactsItemsItem, AnswerBlockId,
    AnswerBlockMetricsItemsItem, AnswerBlockProgressItemsItem, AnswerBlockTimelineItemsItem,
    AnswerBlockTitle, AnswerCardView, AnswerCell, AnswerMedia, AnswerSource, AssetId, Checked,
};
use serde::Deserialize;

/// TS: packages/butler-app/client/shared/answer-blocks-view.ts:5 AnswerCardsView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnswerCardsView {
    pub(crate) r#type: String,
    #[serde(default)]
    pub(crate) id: Option<AnswerBlockId>,
    #[serde(default)]
    pub(crate) title: Option<AnswerBlockTitle>,
    #[serde(default)]
    pub(crate) media: Option<AnswerMedia>,
    #[serde(default)]
    pub(crate) items: Vec<AnswerCardView>,
}

/// TS: packages/butler-app/client/shared/answer-blocks-view.ts:7 AnswerGalleryView (inline AnswerGalleryViewItemsItem).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnswerGalleryViewItemsItem {
    pub(crate) img: AssetId,
    #[serde(default)]
    pub(crate) caption: Option<String>,
    #[serde(default)]
    pub(crate) source: Option<AnswerSource>,
    #[serde(default)]
    pub(crate) image_url: Option<String>,
}

/// TS: packages/butler-app/client/shared/answer-blocks-view.ts:6 AnswerGalleryView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnswerGalleryView {
    pub(crate) r#type: String,
    #[serde(default)]
    pub(crate) id: Option<AnswerBlockId>,
    #[serde(default)]
    pub(crate) title: Option<AnswerBlockTitle>,
    #[serde(default)]
    pub(crate) media: Option<AnswerMedia>,
    #[serde(default)]
    pub(crate) items: Vec<AnswerGalleryViewItemsItem>,
}

/// TS: packages/butler-app/client/shared/answer-blocks-view.ts:9 AnswerImageView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnswerImageView {
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
    #[serde(default)]
    pub(crate) image_url: Option<String>,
    #[serde(default)]
    pub(crate) image_width: Option<i64>,
    #[serde(default)]
    pub(crate) image_height: Option<i64>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:169 CalloutBlock (inline AnswerLeafViewCalloutTone).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AnswerLeafViewCalloutTone {
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

/// TS: packages/butler-app/client/shared/answer-blocks-view.ts:10 AnswerLeafView
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type")]
pub(crate) enum AnswerLeafView {
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
        tone: Option<AnswerLeafViewCalloutTone>,
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
    #[serde(rename = "cards")]
    Cards {
        #[serde(default)]
        id: Option<AnswerBlockId>,
        #[serde(default)]
        title: Option<AnswerBlockTitle>,
        #[serde(default)]
        media: Option<AnswerMedia>,
        #[serde(default)]
        items: Vec<AnswerCardView>,
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
        items: Vec<AnswerGalleryViewItemsItem>,
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
        #[serde(default)]
        image_url: Option<String>,
        #[serde(default)]
        image_width: Option<i64>,
        #[serde(default)]
        image_height: Option<i64>,
    },
}

/// TS: packages/butler-app/client/shared/answer-blocks-view.ts:12 AnswerContainerView (inline AnswerContainerViewTabsTabsItem).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnswerContainerViewTabsTabsItem {
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) blocks: Vec<AnswerLeafView>,
}

/// TS: packages/butler-app/client/shared/answer-blocks-view.ts:11 AnswerContainerView
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type")]
pub(crate) enum AnswerContainerView {
    #[serde(rename = "columns")]
    Columns {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        blocks: Vec<AnswerLeafView>,
    },
    #[serde(rename = "group")]
    Group {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        blocks: Vec<AnswerLeafView>,
    },
    #[serde(rename = "tabs")]
    Tabs {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        tabs: Vec<AnswerContainerViewTabsTabsItem>,
    },
}

/// TS: packages/butler-app/client/shared/answer-blocks-view.ts:13 AnswerEpicsView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnswerEpicsView {
    pub(crate) r#type: String,
    pub(crate) project_id: String,
    #[serde(default)]
    pub(crate) ids: Vec<String>,
}

/// TS: packages/butler-app/client/shared/app-contracts.ts:169 CalloutBlock (inline AnswerBlockViewCalloutTone).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AnswerBlockViewCalloutTone {
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
