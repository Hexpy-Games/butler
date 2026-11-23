//! Site data (`BrowserSiteDataSection.tsx`): clears the in-app browser's cookies, site data and
//! cache. Saved sign-ins live in the keychain and stay.
mod copy;

use butler_ds::ui::blocks::settings_action_field::SettingsActionField;
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::tooltip::Tooltip;
use gpui::{BorrowAppContext as _, Context, IntoElement as _, ParentElement as _};

use crate::ui::browser::{engine::site_data_unavailable, model::BrowserState};
use crate::ui::settings::{
    SectionCtx,
    confirm::{Detail, Request},
};
use crate::ui::source::agent::Jobs;
use crate::ui::widgets::control_anchored;
use copy::words;

pub(super) struct SiteData {
    ctx: SectionCtx,
    busy: bool,
}

impl SiteData {
    pub(super) fn new(ctx: SectionCtx) -> Self {
        Self { ctx, busy: false }
    }

    pub(super) fn section(&mut self, cx: &mut Context<Self>) -> SettingsSection {
        let copy = words(Ds::get(cx).lang());
        let supported = cx
            .try_global::<BrowserState>()
            .is_some_and(BrowserState::site_data_supported);
        let mut button = Button::new("browser-site-data-clear")
            .size(Size::Sm)
            .variant(Variant::Outline)
            .text(copy.clear)
            .on_click(cx.listener(|this, _, _, cx| this.ask(cx)));
        if self.busy || !supported {
            button = button.disabled();
        }
        let action = control_anchored(button, "browser-site-data-clear", !self.busy && supported);
        let action = if supported {
            action
        } else {
            Tooltip::new("browser-site-data-reason")
                .label(copy.desktop_only)
                .child(action)
                .into_any_element()
        };
        SettingsSection::new("browser-site-data", SettingsSectionKind::Form, copy.title).child(
            SettingsActionField::new(copy.label, copy.description, action)
                .setting_id("browser-site-data"),
        )
    }

    fn ask(&self, cx: &mut Context<Self>) {
        let copy = words(Ds::get(cx).lang());
        let this = cx.entity();
        let request = Request::new(copy.confirm_message)
            .title(copy.confirm_title)
            .confirm_label(copy.clear)
            .destructive()
            .detail(Detail {
                label: Some(copy.items.into()),
                text: copy.item_list.into(),
                caption: None,
            })
            .note(copy.kept);
        self.ctx
            .confirm(request, move |_, cx| this.update(cx, SiteData::clear), cx);
    }

    fn clear(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        cx.notify();
        let request = Jobs::run(cx, |client| async move {
            client.browser_history_origins().await
        });
        cx.spawn(async move |this, cx| {
            let origins = request.await.and_then(Result::ok);
            let fetch_ok = origins.is_some();
            let origins = origins.unwrap_or_default();
            let reply = cx.update(|cx| {
                if cx.has_global::<BrowserState>() {
                    cx.update_global::<BrowserState, _>(|b, cx| b.clear_site_data(&origins, cx))
                } else {
                    site_data_unavailable()
                }
            });
            let clear_ok = matches!(reply.await, Ok(Ok(_)));
            cx.update(|cx| {
                let copy = words(Ds::get(cx).lang());
                toast::show(
                    cx,
                    if fetch_ok && clear_ok {
                        Toast::success(copy.cleared)
                    } else {
                        Toast::error(copy.failed)
                    },
                );
            });
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                cx.notify();
            });
        })
        .detach();
    }
}
