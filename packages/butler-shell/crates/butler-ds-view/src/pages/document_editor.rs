//! DocumentEditor.showcase.tsx: the document page (title, status, content with a block embed),
//! the product's title line (actions inline on a wide line, folded into a menu with close kept on
//! a narrow one) and a selected block embed. The "Butler editing a paragraph" story is the
//! editing engine's wash, which is P4b with the engine.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::block_action_frame::BlockActionFrame;
use butler_ds::ui::blocks::document_editor::{DocumentBlockEmbed, DocumentEditor};
use butler_ds::ui::blocks::markdown_content::MarkdownContent;
use butler_ds::ui::blocks::metric_card::{MetricCard, MetricGrid, Trend};
use butler_ds::ui::blocks::overflow_action_menu::OverflowItem;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, Window, div};

use super::Story;
use crate::copy::Lang;

struct Copy {
    title: &'static str,
    saved: &'static str,
    versions: &'static str,
    export: &'static str,
    close: &'static str,
    chat: &'static str,
    markdown: &'static str,
    pdf: &'static str,
    more: &'static str,
    first: &'static str,
    second: &'static str,
    spend: &'static str,
    income: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            title: "October budget",
            saved: "Saved",
            versions: "Versions",
            export: "Export",
            close: "Close",
            chat: "Original chat",
            markdown: "Export as Markdown",
            pdf: "Export as PDF",
            more: "More",
            first: "## Summary\n\nSpending rose 8% this month, mostly from the trip.",
            second: "Fixed costs stayed flat; rent is due on the 25th.",
            spend: "Spending",
            income: "Income",
        },
        Copy {
            title: "10월 예산",
            saved: "저장됨",
            versions: "버전 기록",
            export: "내보내기",
            close: "닫기",
            chat: "원래 대화",
            markdown: "Markdown으로 내보내기",
            pdf: "PDF로 내보내기",
            more: "더보기",
            first: "## 요약\n\n이번 달 지출은 여행 때문에 8% 늘었어요.",
            second: "고정비는 그대로이고, 월세는 25일에 나가요.",
            spend: "지출",
            income: "수입",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Document",
            render: document,
        },
        Story {
            name: "Title line",
            render: title_line,
        },
        Story {
            name: "Block embed (selected)",
            render: selected_embed,
        },
    ]
}

fn action_buttons(c: &Copy, with_chat: bool, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let mut row =
        div()
            .flex()
            .items_center()
            .child(IconButton::new("de-versions", c.versions).icon(icon(
                Icon::History,
                IconSize::Sm,
                ds,
            )));
    if with_chat {
        row = row.child(IconButton::new("de-chat", c.chat).icon(icon(
            Icon::MessageSquare,
            IconSize::Sm,
            ds,
        )));
    }
    row.child(IconButton::new("de-export", c.export).icon(icon(Icon::Download, IconSize::Sm, ds)))
        .into_any_element()
}

fn embed(c: &Copy, selected: bool) -> DocumentBlockEmbed {
    DocumentBlockEmbed::new().selected(selected).child(
        BlockActionFrame::new("de-frame").child(
            MetricGrid::new("de-metrics")
                .child(
                    MetricCard::text("de-spend", "₩1,240,000", c.spend)
                        .change("+8%")
                        .trend(Trend::Down),
                )
                .child(MetricCard::text("de-income", "₩3,100,000", c.income)),
        ),
    )
}

fn page(c: &Copy, selected: bool, cx: &App) -> DocumentEditor {
    DocumentEditor::new("de-page")
        .title(Typo::h2(c.title))
        .note(c.saved)
        .actions(action_buttons(c, false, cx))
        .child(MarkdownContent::new("de-first", c.first))
        .child(embed(c, selected))
        .child(MarkdownContent::new("de-second", c.second))
}

fn document(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    page(&copy(lang), false, cx).into_any_element()
}

fn selected_embed(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    page(&copy(lang), true, cx).into_any_element()
}

fn title_line(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let item = |label: &'static str, glyph: Icon| OverflowItem::new(label).icon(glyph);
    DocumentEditor::new("de-title-line")
        .title(Typo::panel_title(c.title).truncate())
        .note(c.saved)
        .actions(action_buttons(&c, true, cx))
        .menu_actions([
            item(c.versions, Icon::History),
            item(c.chat, Icon::MessageSquare),
            item(c.markdown, Icon::Download),
            item(c.pdf, Icon::Download),
        ])
        .menu_label(c.more)
        .controls(IconButton::new("de-close", c.close).icon(icon(Icon::X, IconSize::Sm, ds)))
        .child(MarkdownContent::new("de-line-body", c.first))
        .into_any_element()
}
