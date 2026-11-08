//! 목록 (`useLogViewer.ts`, the viewer section of `LogsSettings.tsx`): the rows for the filter,
//! more of them, and the live stream.
use butler_ds::ui::blocks::empty_line::EmptyLine;
use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::skeleton::{RowsShape, SkeletonRows};
use butler_ds::ui::toast::Toast;
use butler_shell_client::Error;
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _};

use super::api::{self, LogPage, LogRecord};
use super::copy::LogsCopy;
use super::format::{http_attrs, record_key};
use super::live;
use super::records::Status;
use super::{LogList, show};
use crate::ui::i18n::settings::words;
use crate::ui::settings::state::Load;

impl LogList {
    /// Reads the first page for the filter. The period starts now, once; every later page of
    /// this query reuses it.
    pub(super) fn reload_rows(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        let range = api::Range {
            since: api::period_since(self.filter.period),
            ..api::Range::default()
        };
        self.rows.reset(range.since.clone());
        let (filter, asked) = (self.filter.clone(), range.clone());
        fetch_page(cx, filter, asked, move |this, result, cx| {
            if this.generation != generation {
                return;
            }
            match result {
                Ok(page) => {
                    this.rows.first_page(&page, &range);
                    this.open_row_body(cx);
                }
                Err(_) => this.rows.failed(),
            }
        });
    }

    /// More: the next page of the same query.
    pub(super) fn load_more(&mut self, cx: &mut Context<Self>) {
        let Some(range) = self.rows.next.clone() else {
            return;
        };
        if self.paging {
            return;
        }
        self.paging = true;
        cx.notify();
        fetch_page(
            cx,
            self.filter.clone(),
            range.clone(),
            move |this, result, cx| {
                this.paging = false;
                match result {
                    Ok(page) => this.rows.more_page(&page, &range),
                    Err(_) => {
                        let message = super::copy::get(cx).load_failed;
                        show(&mut this.more_toast, Toast::error(message), cx);
                    }
                }
            },
        );
    }

    /// The Live switch.
    pub(super) fn set_live(&mut self, live: bool, cx: &mut Context<Self>) {
        self.live = live;
        self.live_conn = live.then(|| live::connect(cx));
        cx.notify();
    }

    pub(super) fn on_live(&mut self, record: LogRecord, cx: &mut Context<Self>) {
        if super::format::matches_filter(&record, &self.filter) {
            self.rows.live(record);
            cx.notify();
        }
    }

    /// The stream failed or ended: Live goes off and says so.
    pub(super) fn live_lost(&mut self, cx: &mut Context<Self>) {
        self.live = false;
        self.live_conn = None;
        let message = super::copy::get(cx).live_lost;
        show(&mut self.live_toast, Toast::message(message), cx);
        cx.notify();
    }

    pub(super) fn toggle_row(&mut self, key: String, cx: &mut Context<Self>) {
        if self.open_key.as_ref() == Some(&key) {
            self.open_key = None;
        } else {
            self.open_key = Some(key);
            self.open_row_body(cx);
        }
        cx.notify();
    }

    /// The open row's request body, when it has one stored (the Request tab opens first, and
    /// holds the body of a request that has no status yet).
    fn open_row_body(&mut self, cx: &mut Context<Self>) {
        let Some(open) = &self.open_key else {
            return;
        };
        let reference = self
            .rows
            .rows
            .iter()
            .find(|record| record_key(record) == *open)
            .filter(|record| http_attrs(record).is_some_and(|attrs| !attrs.contains_key("status")))
            .and_then(|record| record.body_ref.clone());
        if let Some(reference) = reference {
            self.ensure_body(reference, cx);
        }
    }

    /// `readLogBody`, once per reference.
    pub(super) fn ensure_body(&mut self, reference: String, cx: &mut Context<Self>) {
        if self.bodies.contains_key(&reference) {
            return;
        }
        self.bodies.insert(reference.clone(), Load::Loading);
        let asked = reference.clone();
        crate::ui::settings::state::fetch(
            cx,
            move |client| async move { api::read_body(&client, &reference).await },
            move |this: &mut Self, result: Result<String, Error>, _| {
                this.bodies
                    .insert(asked, result.map_or(Load::Failed, Load::Ready));
            },
        );
    }

    /// 목록: `logs-viewer`, the filters over the rows. It computes its own state, so the filters
    /// stay while the rows load, fail or are empty.
    pub(super) fn viewer_section(
        &self,
        copy: &'static LogsCopy,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let empty = self.rows.rows.is_empty();
        let loading = self.rows.status == Status::Loading || self.paging;
        let body: AnyElement = if self.rows.status == Status::Failed {
            let retry = words(Ds::get(cx).lang()).state_retry;
            let retry = Button::new("logs-viewer-retry")
                .size(Size::Sm)
                .variant(Variant::Outline)
                .text(retry)
                .on_click(cx.listener(|this, _, _, cx| this.reload_rows(cx)));
            Notice::new(NoticeTone::Error, copy.load_failed)
                .action(retry)
                .into_any_element()
        } else if loading && empty {
            SkeletonRows::new("logs-viewer-skeleton")
                .rows(3)
                .shape(RowsShape::List)
                .into_any_element()
        } else if empty {
            EmptyLine::new(copy.empty).into_any_element()
        } else {
            self.rows_block(copy, cx)
        };
        SettingsSection::new(
            "logs-viewer",
            SettingsSectionKind::List,
            copy.section_viewer,
        )
        .child(self.filters(copy, cx))
        .child(body)
    }
}

/// One page of the query, then `done` on the list.
fn fetch_page(
    cx: &mut Context<LogList>,
    filter: api::Filter,
    range: api::Range,
    done: impl FnOnce(&mut LogList, Result<LogPage, Error>, &mut Context<LogList>) + 'static,
) {
    crate::ui::settings::state::fetch(
        cx,
        move |client| async move { api::query(&client, &filter, &range).await },
        done,
    );
}
