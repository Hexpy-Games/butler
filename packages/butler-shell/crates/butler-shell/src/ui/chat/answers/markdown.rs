//! `toMarkdown` of `answer-blocks-markdown.ts`: the portable copy of one answer block (the
//! frame's "copy" action). Plain block text never introduces Markdown syntax.
use super::containers::leaf_block;
use super::frame::title;
use crate::ui::source::wire::{
    AnswerBlock, AnswerBlockActionsItemsItem, AnswerBlockChartSeriesItem,
    AnswerBlockMetricsItemsItemValue, AnswerCellValue, AnswerLeafBlock, CardItem, CardValue,
};

/// `text`: escapes the characters Markdown reads, and folds line breaks into spaces.
fn text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut broken = false;
    for c in value.chars() {
        if c == '\n' || c == '\r' {
            if !broken {
                out.push(' ');
            }
            broken = true;
            continue;
        }
        broken = false;
        if c == '\\' {
            out.push_str("\\\\");
            continue;
        }
        if "`*_{}[]()<>#+.!|~-".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn number(value: f64) -> String {
    format!("{value}")
}

/// `link`: an http(s) source becomes a Markdown link, anything else plain text.
fn link(label: &str, source: Option<&str>) -> String {
    let url = source
        .filter(|source| !source.is_empty())
        .and_then(|source| url::Url::parse(source).ok())
        .filter(|url| matches!(url.scheme(), "http" | "https"));
    let Some(url) = url else {
        return text(label);
    };
    let mut destination = String::new();
    for c in url.as_str().chars() {
        if "()<>\\".contains(c) {
            destination.push_str(&format!("%{:x}", u32::from(c)));
        } else {
            destination.push(c);
        }
    }
    format!("[{}]({destination})", text(label))
}

/// `provenance`: the source link and the read time.
fn provenance(source: Option<&str>, checked: Option<&str>) -> String {
    [
        source
            .filter(|source| !source.is_empty())
            .map(|source| link(source, Some(source))),
        checked.filter(|checked| !checked.is_empty()).map(text),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ")
}

/// ` · provenance`, or nothing without one.
fn provenance_tail(source: Option<&str>, checked: Option<&str>) -> String {
    let line = provenance(source, checked);
    if line.is_empty() {
        line
    } else {
        format!(" · {line}")
    }
}

/// `amount`: a number with its currency or unit.
fn amount(value: &CardValue, amount: f64) -> String {
    let unit = match value {
        CardValue::Variant1(value) => value.unit.as_deref(),
        CardValue::Variant2(value) => value.cur.as_deref(),
    };
    let mut parts = vec![text(&number(amount))];
    parts.extend(unit.map(text));
    parts.join(" ")
}

fn card(item: &CardItem) -> String {
    let some = |value: &Option<String>| value.clone().filter(|value| !value.is_empty());
    let mut lines = vec![format!("- {}", link(&item.title, item.source.as_deref()))];
    let detail = [&item.label, &item.sub]
        .into_iter()
        .filter_map(some)
        .map(|part| text(&part))
        .collect::<Vec<_>>()
        .join(" · ");
    if !detail.is_empty() {
        lines.push(format!("  {detail}"));
    }
    if let Some(img) = some(&item.img) {
        lines.push(format!("  {}", text(&img)));
    }
    if let Some(value) = &item.value {
        let (now, was, note) = match value {
            CardValue::Variant1(v) => (v.amount, v.was, v.note.clone()),
            CardValue::Variant2(v) => (v.amount, v.was, v.note.clone()),
        };
        let previous = was
            .map(|was| format!(" (~~{}~~)", amount(value, was)))
            .unwrap_or_default();
        let note = some(&note)
            .map(|note| format!(" · {}", text(&note)))
            .unwrap_or_default();
        lines.push(format!("  {}{previous}{note}", amount(value, now)));
    }
    for fact in item.facts.iter().flatten() {
        lines.push(format!("  - {}", text(fact)));
    }
    if let Some(body) = some(&item.text) {
        lines.push(format!("  {}", text(&body)));
    }
    let source = provenance(item.source.as_deref(), item.checked.as_deref());
    if !source.is_empty() {
        lines.push(format!("  {source}"));
    }
    lines.join("\n")
}

fn row(cells: &[String]) -> String {
    let cells: Vec<String> = cells.iter().map(|cell| text(cell)).collect();
    format!("| {} |", cells.join(" | "))
}

fn table(columns: &[String], rows: &[Vec<String>]) -> String {
    let dashes = vec!["---"; columns.len()].join(" | ");
    let mut lines = vec![row(columns), format!("| {dashes} |")];
    lines.extend(rows.iter().map(|cells| row(cells)));
    lines.join("\n")
}

fn cell(value: &Option<AnswerCellValue>) -> String {
    match value {
        None => String::new(),
        Some(AnswerCellValue::Variant1(value)) => value.clone(),
        Some(AnswerCellValue::Variant2(value)) => number(*value),
    }
}

fn joined(blocks: impl Iterator<Item = String>) -> String {
    blocks.collect::<Vec<_>>().join("\n")
}

/// The blocks of a container: each with its title, apart by a blank line.
fn children(leaves: &[AnswerLeafBlock]) -> String {
    leaves
        .iter()
        .filter_map(|leaf| leaf_block(leaf.clone()).ok())
        .map(|block| titled_block(&block))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// A chart as a table of its series, then its unit and provenance.
fn chart(
    x: &[String],
    series: &[AnswerBlockChartSeriesItem],
    unit: Option<&str>,
    (source, checked): (Option<&str>, Option<&str>),
) -> String {
    let mut columns = vec![String::new()];
    columns.extend(series.iter().map(|series| series.name.clone()));
    let rows: Vec<Vec<String>> = x
        .iter()
        .enumerate()
        .map(|(at, x)| {
            let mut cells = vec![x.clone()];
            cells.extend(series.iter().map(|series| {
                series
                    .values
                    .get(at)
                    .copied()
                    .flatten()
                    .map(number)
                    .unwrap_or_default()
            }));
            cells
        })
        .collect();
    let unit = unit
        .filter(|unit| !unit.is_empty())
        .map(text)
        .unwrap_or_default();
    [table(&columns, &rows), unit, provenance(source, checked)]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn data(block: &AnswerBlock) -> String {
    match block {
        AnswerBlock::Cards { items, .. } => joined(items.iter().map(card)),
        AnswerBlock::Table { columns, rows, .. } => {
            let rows: Vec<Vec<String>> = rows
                .iter()
                .map(|cells| cells.iter().map(cell).collect())
                .collect();
            table(columns, &rows)
        }
        AnswerBlock::Gallery { items, .. } => joined(items.iter().map(|item| {
            let label = item.caption.as_deref().unwrap_or(&item.img);
            format!(
                "- {} · {}",
                link(label, item.source.as_deref()),
                text(&item.img)
            )
        })),
        AnswerBlock::Facts { items, .. } => joined(items.iter().map(|item| {
            let tail = provenance_tail(item.source.as_deref(), item.checked.as_deref());
            format!("- {}: {}{tail}", text(&item.label), text(&item.value))
        })),
        AnswerBlock::Metrics { items, .. } => joined(items.iter().map(|item| {
            let value = match &item.value {
                AnswerBlockMetricsItemsItemValue::Variant1(value) => text(value),
                AnswerBlockMetricsItemsItemValue::Variant2(value) => text(&number(*value)),
            };
            let unit = item
                .unit
                .as_deref()
                .filter(|unit| !unit.is_empty())
                .map(|unit| format!(" {}", text(unit)))
                .unwrap_or_default();
            let delta = item
                .delta
                .as_deref()
                .filter(|delta| !delta.is_empty())
                .map(|delta| format!(" ({})", text(delta)))
                .unwrap_or_default();
            let tail = provenance_tail(item.source.as_deref(), item.checked.as_deref());
            format!("- {}: {value}{unit}{delta}{tail}", text(&item.label))
        })),
        AnswerBlock::Chart {
            x,
            series,
            unit,
            checked,
            source,
            ..
        } => chart(
            x,
            series,
            unit.as_deref(),
            (source.as_deref(), checked.as_deref()),
        ),
        _ => String::new(),
    }
}

fn leaf(block: &AnswerBlock) -> String {
    match block {
        AnswerBlock::Timeline { items, .. } => joined(items.iter().map(|item| {
            let body = item
                .text
                .as_deref()
                .filter(|body| !body.is_empty())
                .map(|body| format!(" — {}", text(body)))
                .unwrap_or_default();
            format!("- **{}** {}{body}", text(&item.when), text(&item.title))
        })),
        AnswerBlock::Checklist { items, .. } => joined(items.iter().map(|item| {
            let mark = if item.done { "x" } else { " " };
            format!("- [{mark}] {}", text(&item.text))
        })),
        AnswerBlock::Progress { items, .. } => joined(items.iter().map(|item| {
            let unit = item
                .unit
                .as_deref()
                .filter(|unit| !unit.is_empty())
                .map(|unit| format!(" {}", text(unit)))
                .unwrap_or_default();
            let max = number(item.max.unwrap_or(100.));
            format!(
                "{}: {} / {max}{unit}",
                text(&item.label),
                number(item.value)
            )
        })),
        AnswerBlock::Text { text, .. } => text.clone(),
        AnswerBlock::Quote {
            text: body, cite, ..
        } => {
            let cite = cite
                .as_deref()
                .filter(|cite| !cite.is_empty())
                .map(|cite| format!(" — {}", text(cite)))
                .unwrap_or_default();
            format!("> {}{cite}", text(body))
        }
        AnswerBlock::Image { caption, .. } => {
            format!("![{}]()", text(caption.as_deref().unwrap_or_default()))
        }
        AnswerBlock::Callout { text: body, .. } => format!("> {}", text(body)),
        AnswerBlock::Actions { items, .. } => joined(items.iter().map(|item| match item {
            AnswerBlockActionsItemsItem::Variant1(ask) => {
                format!("> 질문 제안: {}", text(&ask.ask))
            }
            AnswerBlockActionsItemsItem::Variant2(open) => {
                format!("- {}", link(&open.label, Some(&open.open)))
            }
        })),
        _ => String::new(),
    }
}

fn block_markdown(block: &AnswerBlock) -> String {
    match block {
        AnswerBlock::Epics { .. } => String::new(),
        AnswerBlock::Columns { blocks, .. } | AnswerBlock::Group { blocks, .. } => children(blocks),
        AnswerBlock::Tabs { tabs, .. } => tabs
            .iter()
            .map(|tab| format!("### {}\n\n{}", text(&tab.label), children(&tab.blocks)))
            .collect::<Vec<_>>()
            .join("\n\n"),
        AnswerBlock::Cards { .. }
        | AnswerBlock::Table { .. }
        | AnswerBlock::Gallery { .. }
        | AnswerBlock::Facts { .. }
        | AnswerBlock::Metrics { .. }
        | AnswerBlock::Chart { .. } => data(block),
        _ => leaf(block),
    }
}

fn titled_block(block: &AnswerBlock) -> String {
    if matches!(block, AnswerBlock::Epics { .. }) {
        return String::new();
    }
    let heading = title(block)
        .filter(|title| !title.is_empty())
        .map(|title| format!("### {}", text(title)));
    [heading, Some(block_markdown(block))]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// `toMarkdown` of a spec holding just `block`.
pub(super) fn to_markdown(block: &AnswerBlock) -> String {
    titled_block(block)
}
