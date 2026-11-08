//! Settings: System events (`SystemEventsSettings.tsx`). Live refresh is not wired (F4).
mod card;
mod copy;

use butler_ds::ui::blocks::settings_section::{
    SettingsPage, SettingsSection, SettingsSectionKind, SettingsSectionMore,
};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_shell_client::Error;
use gpui::{
    AnyView, App, AppContext as _, Context, IntoElement, ParentElement as _, Render, Window,
};
use serde::Deserialize;

use crate::ui::settings::SectionCtx;
use crate::ui::settings::state::{Load, fetch};
use card::Event;
use copy::words;

const PAGE_SIZE: u32 = 20;

#[derive(Deserialize)]
struct Pagination {
    #[serde(default)]
    has_more: bool,
}

/// `SystemEventListView`
#[derive(Deserialize)]
struct EventList {
    events: Vec<Event>,
    pagination: Pagination,
}

pub(crate) fn page(ctx: SectionCtx, window: &mut Window, cx: &mut App) -> AnyView {
    cx.new(|cx| SystemEventsPage::new(ctx, window, cx)).into()
}

struct SystemEventsPage {
    view: Load<EventList>,
    loading: bool,
}

impl SystemEventsPage {
    fn new(ctx: SectionCtx, _: &mut Window, cx: &mut Context<Self>) -> Self {
        let SectionCtx { state } = ctx;
        cx.observe(&state, |_, _, cx| cx.notify()).detach();
        let mut page = Self {
            view: Load::Loading,
            loading: false,
        };
        page.refresh(cx);
        page
    }

    /// `refresh`: the first page; a failure shows only while there is nothing to show.
    fn refresh(&mut self, cx: &mut Context<Self>) {
        self.loading = true;
        if matches!(self.view, Load::Failed) {
            self.view = Load::Loading;
        }
        fetch(
            cx,
            |client| async move { client.list_system_events(Some(PAGE_SIZE), Some(0)).await },
            |this: &mut Self, result: Result<EventList, Error>, _| {
                this.loading = false;
                match result {
                    Ok(view) => this.view = Load::Ready(view),
                    Err(_) if matches!(this.view, Load::Loading) => this.view = Load::Failed,
                    Err(_) => {}
                }
            },
        );
    }

    /// `loadMore`: the next page, appended; a failure changes nothing.
    fn load_more(&mut self, cx: &mut Context<Self>) {
        let Load::Ready(view) = &self.view else {
            return;
        };
        if self.loading {
            return;
        }
        self.loading = true;
        let offset = u64::try_from(view.events.len()).unwrap_or_default();
        fetch(
            cx,
            move |client| async move {
                client
                    .list_system_events(Some(PAGE_SIZE), Some(offset))
                    .await
            },
            |this: &mut Self, result: Result<EventList, Error>, _| {
                this.loading = false;
                if let (Ok(next), Load::Ready(view)) = (result, &mut this.view) {
                    view.events.extend(next.events);
                    view.pagination = next.pagination;
                }
            },
        );
    }
}

impl Render for SystemEventsPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = Ds::get(cx).lang();
        let copy = words(lang);
        let mut refresh = Button::new("system-events-refresh")
            .variant(Variant::Outline)
            .size(Size::Sm)
            .text(copy.refresh)
            .on_click(cx.listener(|this, _, _, cx| this.refresh(cx)));
        if self.loading {
            refresh = refresh.disabled();
        }
        let mut section =
            SettingsSection::new("system-events", SettingsSectionKind::List, copy.title)
                .description(copy.description)
                .state(self.view.state(|view| view.events.is_empty()))
                .empty_message(copy.empty)
                .on_retry(cx.listener(|this, _, _, cx| this.refresh(cx)))
                .actions(refresh);
        if let Load::Ready(view) = &self.view {
            if view.pagination.has_more {
                let mut more = SettingsSectionMore::new(
                    copy.more,
                    cx.listener(|this, _, _, cx| this.load_more(cx)),
                );
                if self.loading {
                    more = more.busy();
                }
                section = section.more(more);
            }
            section = section.children(
                view.events
                    .iter()
                    .map(|event| card::card(event, lang, copy)),
            );
        }
        SettingsPage::new()
            .labels(SectionCtx::labels(cx))
            .section(section)
    }
}
