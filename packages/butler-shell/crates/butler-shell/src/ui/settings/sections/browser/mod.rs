//! Settings: Browser (`BrowserSettings.tsx`): the in-app browser's history, cookies and cache,
//! saved sign-ins, payment methods and autofill details, then import last.
mod agent;
mod history;
mod import;
mod site_data;
pub(crate) mod vault;

use butler_ds::ui::blocks::settings_section::SettingsPage;
use gpui::{AnyView, App, AppContext as _, Context, Entity, IntoElement, Render, Window};

use crate::ui::settings::SectionCtx;
use history::BrowserHistory;
use import::BrowserImport;
use site_data::SiteData;
use vault::BrowserVault;

pub(crate) fn page(ctx: SectionCtx, window: &mut Window, cx: &mut App) -> AnyView {
    cx.new(|cx| BrowserPage::new(ctx, window, cx)).into()
}

struct BrowserPage {
    ctx: SectionCtx,
    history: Entity<BrowserHistory>,
    site_data: Entity<SiteData>,
    vault: Entity<BrowserVault>,
    import: Entity<BrowserImport>,
}

impl BrowserPage {
    fn new(ctx: SectionCtx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.observe(&ctx.state, |_, _, cx| cx.notify()).detach();
        let history = cx.new(|_| BrowserHistory::new(&ctx));
        let site_data = cx.new(|_| SiteData::new(ctx.clone()));
        let vault = cx.new(|cx| BrowserVault::new(ctx.clone(), window, cx));
        let import = cx.new(|_| BrowserImport::new(vault.clone()));
        cx.observe(&history, |_, _, cx| cx.notify()).detach();
        cx.observe(&site_data, |_, _, cx| cx.notify()).detach();
        cx.observe(&vault, |_, _, cx| cx.notify()).detach();
        cx.observe(&import, |_, _, cx| cx.notify()).detach();
        Self {
            ctx,
            history,
            site_data,
            vault,
            import,
        }
    }
}

impl Render for BrowserPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let agent = agent::section(&self.ctx, cx);
        let history = self
            .history
            .update(cx, |history, cx| history.section(window, cx));
        let site_data = self.site_data.update(cx, SiteData::section);
        let vault = self
            .vault
            .update(cx, |vault, cx| vault.sections(window, cx));
        let import = self
            .import
            .update(cx, |import, cx| import.section(window, cx));
        let mut page = SettingsPage::new()
            .labels(SectionCtx::labels(cx))
            .section(agent)
            .section(history)
            .section(site_data);
        for section in vault {
            page = page.section(section);
        }
        page.section(import)
    }
}
