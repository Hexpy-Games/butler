use gpui::App;

use super::{engine::SiteDataReply, model::BrowserState};

impl BrowserState {
    pub(crate) fn site_data_supported(&self) -> bool {
        self.engine.site_data()
    }

    pub(crate) fn clear_site_data(&mut self, origins: &[String], cx: &mut App) -> SiteDataReply {
        self.start_engine(cx);
        self.engine.clear_site_data(origins)
    }

    pub(crate) fn sign_out_site(&mut self, site: &str, cx: &mut App) -> SiteDataReply {
        self.start_engine(cx);
        self.engine.sign_out_site(site)
    }
}
