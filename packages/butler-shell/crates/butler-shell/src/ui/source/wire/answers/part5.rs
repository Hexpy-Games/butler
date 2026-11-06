//! Typed renderer wire contracts; field names follow their TypeScript sources.
use crate::ui::source::wire::{
    AnswerBlockActionsItemsItem, AnswerBlockChartKind, AnswerBlockChartSeriesItem,
    AnswerBlockChecklistItemsItem, AnswerBlockFactsItemsItem, AnswerBlockId,
    AnswerBlockMetricsItemsItem, AnswerBlockProgressItemsItem, AnswerBlockTimelineItemsItem,
    AnswerBlockTitle, AnswerBlockViewCalloutTone, AnswerCardView, AnswerCell,
    AnswerContainerViewTabsTabsItem, AnswerGalleryViewItemsItem, AnswerLeafView, AnswerMedia,
    AnswerSource, AssetId, Checked,
};
use serde::Deserialize;

/// TS: packages/butler-app/client/shared/answer-blocks-view.ts:14 AnswerBlockView
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type")]
pub(crate) enum AnswerBlockView {
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
        tone: Option<AnswerBlockViewCalloutTone>,
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
    #[serde(rename = "epics")]
    Epics {
        project_id: String,
        #[serde(default)]
        ids: Vec<String>,
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

/// TS: packages/butler-app/client/shared/answer-blocks-view.ts:15 AnswerBlocksView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct AnswerBlocksView {
    pub(crate) v: i64,
    #[serde(default)]
    pub(crate) blocks: Vec<AnswerBlockView>,
}
