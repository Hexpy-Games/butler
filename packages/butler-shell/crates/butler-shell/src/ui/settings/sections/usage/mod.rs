//! Settings: Usage (`UsageSettings.tsx` and the files it composes: `UsageBreakdown`,
//! `UsageSessionSelect`, `UsageImagesSection`, `UsageProviderPanel`, `UsageProviderRow`,
//! `ProviderQuotaGauge`, `providerQuotaPresentation`, `usage/UsageHistory`, `usage/UsageReadout`).
//!
//! The timeline, readout values and token notation are the context popover's
//! (`composer::context`). Not ported: the live refresh of the page (the React event buses are
//! follow-up F4); the activity heatmap and its daily / weekly / cumulative control (G-heat).
mod breakdown;
mod copy;
mod format;
mod history;
mod images;
mod load;
mod overview;
mod picker;
mod providers;
mod readout;
mod wire;

use std::collections::HashMap;

use butler_ds::ui::blocks::settings_section::SettingsPage;
use butler_ds::ui::blocks::usage_bars::Emphasis;
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::ToastId;
use gpui::{AnyView, App, AppContext as _, Context, IntoElement, Render, Subscription, Window};

use self::load::Snapshot;
use self::wire::{History, Quota, TopSession, View};
use crate::ui::settings::SectionCtx;

pub(crate) fn page(ctx: SectionCtx, _: &mut Window, cx: &mut App) -> AnyView {
    cx.new(|cx| UsagePage::new(ctx, cx)).into()
}

/// The key of one range's view: `${hours}/${session ?? ""}`.
fn view_key(hours: u32, session: Option<&str>) -> String {
    format!("{hours}/{}", session.unwrap_or_default())
}

/// `UsageSessionSelect`'s search and kind filter, and whether it is open.
#[derive(Default)]
struct Picker {
    open: bool,
    query: String,
    /// "all" or a session kind.
    kind: String,
}

struct UsagePage {
    ctx: SectionCtx,
    hours: u32,
    /// The chat the page is scoped to.
    session: Option<String>,
    revision: u32,
    /// The views of `useUsageRange`, by [`view_key`].
    views: HashMap<String, View>,
    all_revisions: HashMap<u32, u32>,
    pending: Option<String>,
    error: Option<String>,
    /// The requests of the last range read that are still to answer.
    outstanding: usize,
    generation: u64,
    history: Option<History>,
    history_generation: u64,
    image_days: u32,
    images: Option<Snapshot>,
    image_error: bool,
    image_generation: u64,
    /// The selected bar: the scope it was picked in, and its index.
    selection: Option<(String, usize)>,
    emphasis: Option<Emphasis>,
    picker: Picker,
    /// `useLastQuota`: the last good quota of each provider.
    last_quota: HashMap<String, Quota>,
    toast: Option<ToastId>,
    _settings: Subscription,
}

impl UsagePage {
    fn new(ctx: SectionCtx, cx: &mut Context<Self>) -> Self {
        let settings = cx.observe(&ctx.state, |_, _, cx| cx.notify());
        let mut page = Self {
            ctx,
            hours: 24,
            session: None,
            revision: 0,
            views: HashMap::new(),
            all_revisions: HashMap::new(),
            pending: None,
            error: None,
            outstanding: 0,
            generation: 0,
            history: None,
            history_generation: 0,
            image_days: 7,
            images: None,
            image_error: false,
            image_generation: 0,
            selection: None,
            emphasis: None,
            picker: Picker {
                kind: "all".to_owned(),
                ..Picker::default()
            },
            last_quota: HashMap::new(),
            toast: None,
            _settings: settings,
        };
        page.load_range(cx);
        page.load_history(cx);
        page.load_images(cx);
        page
    }

    fn key(&self) -> String {
        view_key(self.hours, self.session.as_deref())
    }

    /// `result.view`
    fn view(&self) -> Option<&View> {
        self.views.get(&self.key())
    }

    /// `result.allView`
    fn all_view(&self) -> Option<&View> {
        self.views.get(&view_key(self.hours, None))
    }

    /// `refresh`
    fn refresh(&mut self, cx: &mut Context<Self>) {
        self.revision += 1;
        self.load_range(cx);
        self.load_history(cx);
        self.load_images(cx);
        cx.notify();
    }

    fn set_hours(&mut self, hours: u32, cx: &mut Context<Self>) {
        self.hours = hours;
        self.load_range(cx);
        cx.notify();
    }

    fn set_session(&mut self, session: Option<String>, cx: &mut Context<Self>) {
        self.session = session;
        self.picker.open = false;
        self.load_range(cx);
        cx.notify();
    }

    fn set_image_days(&mut self, days: u32, cx: &mut Context<Self>) {
        self.image_days = days;
        self.load_images(cx);
        cx.notify();
    }

    /// The chats of the picker and the breakdown: the all-chat list, plus the scoped chat when it
    /// is not in it, by usage.
    fn sessions(&self) -> Vec<TopSession> {
        let mut sessions = self
            .all_view()
            .or_else(|| self.view())
            .map(|view| view.usage.top_sessions.clone())
            .unwrap_or_default();
        let selected = self.session.as_deref().and_then(|id| {
            self.view()?
                .usage
                .top_sessions
                .iter()
                .find(|item| item.session_id == id)
        });
        if let Some(selected) = selected
            && !sessions
                .iter()
                .any(|item| item.session_id == selected.session_id)
        {
            sessions.push(selected.clone());
        }
        sessions.sort_by(|a, b| b.total_tokens.total_cmp(&a.total_tokens));
        sessions
    }

    /// `useLastQuota`'s effect: a fresh quota replaces the last good one.
    fn remember_quotas(&mut self) {
        let providers = self
            .all_view()
            .or_else(|| self.view())
            .map(|view| view.usage.provider_usage.providers.clone())
            .unwrap_or_default();
        for provider in providers {
            if provider.remaining.available && !provider.remaining.stale {
                self.last_quota
                    .insert(provider.provider_id, provider.remaining);
            }
        }
    }
}

impl Render for UsagePage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.remember_quotas();
        let lang = Ds::get(cx).lang();
        let sessions = self.sessions();
        let mut page = SettingsPage::new()
            .labels(SectionCtx::labels(cx))
            .section(self.overview(&sessions, window, cx))
            .section(self.history_section(lang));
        if let Some(images) = self.images_section(lang, cx) {
            page = page.section(images);
        }
        if let Some(providers) = self.providers_section(lang, cx) {
            page = page.section(providers);
        }
        page
    }
}
