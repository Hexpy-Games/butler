//! The geometry the list's CSS variables and container queries resolve to
//! (`PromptSuggestionList.module.css:1-18`, `:285-345`). The `conversation` container is the
//! enclosing ConversationShell; outside one no container query matches.
use crate::tokens::Length;
use crate::ui::blocks::scope;
use crate::ui::context::Ds;
use gpui::App;

/// `--prompt-content-width` without a conversation: `min(760px, 86%)`.
const CONTENT_MAX: f32 = 760.; // DS: PromptSuggestionList.module.css:2
const CONTENT_SHARE: f32 = 0.86; // DS: PromptSuggestionList.module.css:2
/// `--prompt-title-icon-size`, wide and compact.
const ICON_WIDE: f32 = 54.; // DS: PromptSuggestionList.module.css:3
const ICON_COMPACT: f32 = 34.; // DS: PromptSuggestionList.module.css:302
/// `@container conversation (width <= ...)`.
const MEDIUM: f32 = 900.; // DS: PromptSuggestionList.module.css:285
const COMPACT: f32 = 640.; // DS: PromptSuggestionList.module.css:296
const NARROW: f32 = 560.; // DS: PromptSuggestionList.module.css:320
/// `grid-auto-columns: minmax(min, max)` of a card, by container width.
const CARDS_WIDE: (f32, f32) = (198., 224.); // DS: PromptSuggestionList.module.css:179
const CARDS_MEDIUM: (f32, f32) = (194., 218.); // DS: PromptSuggestionList.module.css:292
const CARD_NARROW_MIN: f32 = 200.; // DS: PromptSuggestionList.module.css:342
const CARD_NARROW_SHARE: f32 = 0.66; // DS: PromptSuggestionList.module.css:342

pub(super) struct Metrics {
    /// The list's own width (measured on the last frame; zero before).
    /// `@container conversation (width <= 640px)`: the title icon sits in the moment row.
    pub compact: bool,
    pub icon_size: f32,
    pub icon_gap: f32,
    /// `--prompt-content-width`.
    pub content_width: f32,
    /// `--prompt-edge-gutter`: the header's side room.
    pub edge_gutter: f32,
    /// `--prompt-content-inset`: the rail's side padding where it starts.
    pub content_inset: f32,
    pub title_size: Length,
    pub title_line: Length,
    /// `gap` between the title and the description.
    pub copy_gap: Length,
    /// A card's width range.
    pub cards: (f32, f32),
    /// `padding-block-start` of the list.
    pub top: f32,
    /// The list's height: the viewport less the composer's room (`None` before it is known).
    pub height: Option<f32>,
}

impl Metrics {
    pub(super) fn new(root_width: f32, ds: &Ds, cx: &App) -> Self {
        let conversation = scope::conversation(cx);
        let container = conversation.map_or(0., |vars| vars.width);
        let within = |limit: f32| container > 0. && container <= limit;
        let len = |token| f32::from(ds.len(token));
        let compact = within(COMPACT);
        let icon_size = if compact { ICON_COMPACT } else { ICON_WIDE };
        let icon_gap = len(Length::SpaceMd);
        let content_width = if compact {
            root_width - 2. * len(Length::AdaptivePageGutter)
        } else {
            conversation
                .filter(|vars| vars.column_width > 0.)
                .map_or(CONTENT_MAX.min(CONTENT_SHARE * root_width), |vars| {
                    vars.column_width
                })
        };
        let edge_gutter = if compact {
            len(Length::AdaptivePageGutter)
        } else {
            icon_size + icon_gap
        };
        let (title_size, title_line) = if within(NARROW) {
            (
                Length::TypoNewChatTitleSizeSm,
                Length::TypoNewChatTitleLineHeightSm,
            )
        } else if within(MEDIUM) {
            (
                Length::TypoNewChatTitleSizeMd,
                Length::TypoNewChatTitleLineHeightMd,
            )
        } else {
            (
                Length::TypoNewChatTitleSize,
                Length::TypoNewChatTitleLineHeight,
            )
        };
        let cards = if within(NARROW) {
            (
                CARD_NARROW_MIN,
                CARD_NARROW_MIN.max(CARD_NARROW_SHARE * container),
            )
        } else if within(MEDIUM) {
            CARDS_MEDIUM
        } else {
            CARDS_WIDE
        };
        let reserve = conversation.map_or(0., |vars| vars.composer_reserve);
        let viewport = len(Length::AdaptiveViewportBlockSize);
        Self {
            compact,
            icon_size,
            icon_gap,
            content_width,
            edge_gutter,
            content_inset: edge_gutter.max((root_width - content_width) / 2.),
            title_size,
            title_line,
            copy_gap: if within(NARROW) {
                Length::SpaceSm
            } else {
                Length::SpaceMd
            },
            cards,
            top: if within(NARROW) {
                len(Length::SpaceMd)
            } else {
                len(Length::TitlebarSafeAreaTop)
            },
            height: (viewport > 0.).then(|| (viewport - reserve).max(0.)),
        }
    }
}
