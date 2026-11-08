//! Prompt section estimates (`DeveloperUsageSections.tsx`, `UsageSectionPanel.tsx`): diagnostics,
//! separate from consumer usage.
use std::collections::BTreeMap;

use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::layout::{
    Basis, Cross, Justify, MinWidth, Space, Stack, StackItem, WithItem as _,
};
use butler_ds::ui::meta_list::{MetaItem, MetaList};
use butler_ds::ui::typo::{TextAlign, Typo};
use butler_shell_client::Error;
use gpui::{Context, ParentElement as _};
use serde::Deserialize;

use super::LogList;
use super::copy::LogsCopy;
use crate::ui::settings::state::{Load, fetch};

/// `UsageSectionBucketView`
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Bucket {
    #[serde(default)]
    request_count: f64,
    #[serde(default)]
    chars: f64,
    #[serde(default)]
    estimated_tokens: f64,
}

#[derive(Deserialize, Default)]
struct ModelUsage {
    #[serde(default, rename = "bySection")]
    by_section: BTreeMap<String, Bucket>,
}

/// `UsageMonitorView`, the part this section reads.
#[derive(Deserialize)]
struct Monitor {
    #[serde(default)]
    model: ModelUsage,
}

/// The sections by estimated tokens, most first.
pub(super) type Sections = Vec<(String, Bucket)>;

/// `formatCount`: whole numbers grouped by thousands.
fn format_count(value: f64) -> String {
    let digits = format!("{:.0}", value.abs());
    let mut grouped = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    if value < 0. {
        format!("-{grouped}")
    } else {
        grouped
    }
}

impl LogList {
    pub(super) fn load_usage(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.get_usage_monitor(None, Some(24.)).await },
            |this: &mut Self, result: Result<Monitor, Error>, _| {
                this.usage = match result {
                    Ok(monitor) => {
                        let mut rows: Sections = monitor.model.by_section.into_iter().collect();
                        rows.sort_by(|a, b| b.1.estimated_tokens.total_cmp(&a.1.estimated_tokens));
                        Load::Ready(rows)
                    }
                    Err(_) => Load::Failed,
                };
            },
        );
    }

    /// `developer-context-estimates`
    pub(super) fn usage_section(&self, copy: &'static LogsCopy) -> SettingsSection {
        let mut section = SettingsSection::new(
            "developer-context-estimates",
            SettingsSectionKind::List,
            copy.context_estimates,
        )
        .description(copy.usage_day)
        .state(self.usage.state(Vec::is_empty))
        .error_message(copy.usage_failed)
        .empty_message(copy.no_usage);
        if let Load::Ready(rows) = &self.usage {
            for (name, bucket) in rows {
                section = section.child(usage_row(name, bucket, copy));
            }
        }
        section
    }
}

fn usage_row(name: &str, bucket: &Bucket, copy: &'static LogsCopy) -> Stack {
    let facts = MetaList::new([
        MetaItem::new(copy.requests, format_count(bucket.request_count)),
        MetaItem::new(copy.characters, format_count(bucket.chars)),
    ]);
    Stack::row()
        .justify(Justify::Between)
        .cross(Cross::Start)
        .gap(Space::Md)
        .wrap(true)
        .child(
            StackItem::new()
                .grow()
                .basis(Basis::Md)
                .min_width(MinWidth::Zero)
                .child(
                    Stack::new()
                        .gap(Space::Xs)
                        .child(Typo::body(name.to_owned()))
                        .child(facts),
                ),
        )
        .child(
            Typo::body(format_count(bucket.estimated_tokens))
                .align(TextAlign::End)
                .tabular(),
        )
}
