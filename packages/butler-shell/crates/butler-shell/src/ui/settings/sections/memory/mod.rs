//! Settings: Memory (`MemorySettings.tsx`). One page entity holds the section state that the
//! React hooks `useMemorySummary`, `useInstructions`, `usePatterns`, `useMemoryOperation`,
//! `useMemoryReset`, `useProjectMemory` and `useConsolidation` keep; each module below owns one
//! of them. React's live memory events (`memoryEvents`, F4) are not subscribed: a running
//! operation is read again every [`POLL`] until it ends, and every list reloads after the
//! page's own actions.
mod chat;
mod consolidation;
mod copy;
mod facts;
mod fields;
mod format;
mod instructions;
mod model;
mod patterns;
mod project;
mod reset;
mod summary;
mod types;

use butler_ds::ui::motion;
use std::collections::HashMap;
use std::time::Duration;

use butler_ds::ui::blocks::settings_section::SettingsPage;
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::toast::{self, Toast, ToastId};
use butler_ds::ui::tooltip::{Side, Tooltip};
use gpui::{
    AnyElement, AnyView, App, AppContext as _, Context, IntoElement, ParentElement as _, Render,
    SharedString, Window,
};

use self::copy::{Words, words};
use crate::ui::settings::SectionCtx;

/// How often a running operation is read again.
const POLL: Duration = Duration::from_millis(800);

pub(crate) fn page(ctx: SectionCtx, window: &mut Window, cx: &mut App) -> AnyView {
    cx.new(|cx| MemoryPage::new(ctx, window, cx)).into()
}

struct MemoryPage {
    ctx: SectionCtx,
    summary: summary::Summary,
    instructions: instructions::Instructions,
    patterns: patterns::Patterns,
    cleanup: chat::Cleanup,
    reset: reset::Reset,
    consolidation: consolidation::Consolidation,
    project: project::Project,
    model: model::ModelPrep,
    /// The toast of each `notifyStatus` id, replaced by the next one of that id.
    toasts: HashMap<&'static str, ToastId>,
}

impl MemoryPage {
    fn new(ctx: SectionCtx, _: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.observe(&ctx.state, |_, _, cx| cx.notify()).detach();
        let mut page = Self {
            ctx,
            summary: summary::Summary::new(),
            instructions: instructions::Instructions::new(),
            patterns: patterns::Patterns::new(),
            cleanup: chat::Cleanup::default(),
            reset: reset::Reset::default(),
            consolidation: consolidation::Consolidation::default(),
            project: project::Project::new(),
            model: model::ModelPrep::default(),
            toasts: HashMap::new(),
        };
        page.reload_summary(cx);
        Self::reload_projects(cx);
        Self::reload_instructions(false, cx);
        Self::reload_patterns(cx);
        Self::reload_consolidation(cx);
        page.poll_model(cx);
        page
    }

    /// `notifyStatus(.., {id})`: replaces the toast last shown under `slot`.
    fn notify(&mut self, slot: &'static str, toast: Toast, cx: &mut Context<Self>) {
        let toast = match self.toasts.get(slot) {
            Some(id) => toast.id(*id),
            None => toast,
        };
        self.toasts.insert(slot, toast::show(cx, toast));
    }

    /// Another task of this page is running (`sharedBusy`).
    fn shared_busy(&self) -> bool {
        self.cleanup.busy() || self.reset.kind().is_some() || self.consolidation.running()
    }
}

fn lang(cx: &App) -> Lang {
    Ds::get(cx).lang()
}

/// Runs `f` on the page after one [`POLL`].
fn later(
    cx: &mut Context<MemoryPage>,
    f: impl FnOnce(&mut MemoryPage, &mut Context<MemoryPage>) + 'static,
) {
    cx.spawn(async move |this, cx| {
        motion::sleep(cx.background_executor(), POLL).await;
        let _ = this.update(cx, f);
    })
    .detach();
}

/// `<Tooltip label={reason}>`: without a reason the tooltip never opens.
fn with_reason(
    id: &'static str,
    reason: Option<&'static str>,
    side: Side,
    child: impl IntoElement,
) -> AnyElement {
    let mut tooltip = Tooltip::new(SharedString::from(id)).side(side);
    if let Some(reason) = reason {
        tooltip = tooltip.label(reason);
    }
    tooltip.child(child).into_any_element()
}

impl Render for MemoryPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = lang(cx);
        let copy: &'static Words = words(lang);
        SettingsPage::new()
            .labels(SectionCtx::labels(cx))
            .section(self.instructions_section(copy, lang, cx))
            .section(self.patterns_section(copy, lang, cx))
            .section(self.chat_section(copy, lang, cx))
            .section(self.cleanup_section(copy, lang, cx))
            .section(self.model_section(copy, lang, cx))
            .section(self.profile_section(copy, lang, cx))
            .section(self.project_section(copy, lang, cx))
    }
}
