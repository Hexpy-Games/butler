//! History-only page engine used until the native page engines land.
use std::collections::HashMap;

use butler_ds::{
    tokens::Color,
    ui::{
        context::Ds,
        typo::{TextAlign, Tone, Typo},
    },
};
use futures::channel::mpsc::UnboundedSender;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, Window, div};
use url::Url;

use super::engine::{PageChange, PageCommand, PageEngine, PageEvent, TabId};

#[derive(Default)]
struct Page {
    history: Vec<String>,
    index: usize,
}

impl Page {
    fn url(&self) -> &str {
        self.history.get(self.index).map_or("", String::as_str)
    }

    fn load(&mut self, url: String) {
        self.history.truncate(if self.history.is_empty() {
            0
        } else {
            self.index + 1
        });
        self.history.push(url);
        self.index = self.history.len() - 1;
    }
}

pub(crate) struct PlaceholderEngine {
    pages: HashMap<TabId, Page>,
    events: UnboundedSender<PageEvent>,
}

impl PlaceholderEngine {
    pub(crate) fn new(events: UnboundedSender<PageEvent>) -> Self {
        Self {
            pages: HashMap::new(),
            events,
        }
    }

    fn publish(&self, id: &TabId) {
        let Some(page) = self.pages.get(id) else {
            return;
        };
        let url = page.url().to_owned();
        let title = Url::parse(&url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned))
            .unwrap_or_else(|| url.clone());
        for change in [
            PageChange::Loading(true),
            PageChange::Url(url),
            PageChange::Title(title),
            PageChange::History {
                can_back: page.index > 0,
                can_forward: page.index + 1 < page.history.len(),
            },
            PageChange::Loading(false),
        ] {
            let _ = self.events.unbounded_send(PageEvent {
                page: id.clone(),
                change,
            });
        }
    }
}

impl PageEngine for PlaceholderEngine {
    fn enabled(&self) -> bool {
        true
    }

    fn open(&mut self, page: &TabId, url: &str) {
        let state = self.pages.entry(page.clone()).or_default();
        if !url.is_empty() {
            state.load(url.to_owned());
        }
        self.publish(page);
    }

    fn command(&mut self, page: &TabId, command: PageCommand) {
        let Some(state) = self.pages.get_mut(page) else {
            return;
        };
        match command {
            PageCommand::Load(url) => state.load(url),
            PageCommand::Back if state.index > 0 => state.index -= 1,
            PageCommand::Forward if state.index + 1 < state.history.len() => state.index += 1,
            _ => return,
        }
        self.publish(page);
    }

    fn resize(&mut self, _: &TabId, _: gpui::Size<gpui::Pixels>, _: f32) {}

    fn close(&mut self, page: &TabId) {
        self.pages.remove(page);
    }

    fn surface(&self, page: &TabId, _: &mut Window, cx: &mut App) -> Option<AnyElement> {
        let url = self.pages.get(page)?.url().to_owned();
        Some(
            div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .bg(Ds::get(cx).color(Color::Muted))
                .text_color(Ds::get(cx).color(Color::MutedForeground))
                .child(Typo::body(url).tone(Tone::Inherit).align(TextAlign::Center))
                .into_any_element(),
        )
    }
}
