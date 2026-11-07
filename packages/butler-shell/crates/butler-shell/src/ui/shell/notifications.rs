//! Attention transitions share the React hook's labels, deduplication and dismissal rules.
use super::{Shell, navigation::Navigation};
use crate::ui::{i18n::Locale, source::SessionId};
use butler_ds::ui::toast::{self, Toast, ToastId};
use gpui::{AppContext as _, Context, SystemNotification, Window};
use std::collections::HashMap;

#[derive(Default)]
pub(super) struct Attention {
    waiting: HashMap<SessionId, Option<ToastId>>,
    pub disconnected: bool,
}

impl Shell {
    pub(super) fn copy(&self, en: &'static str, ko: &'static str) -> &'static str {
        match self.theme.strings.locale {
            Locale::En => en,
            Locale::Ko => ko,
        }
    }

    pub(super) fn connected_notice(&mut self, cx: &mut Context<Self>) {
        if self.attention.disconnected {
            toast::show(
                cx,
                Toast::success(self.copy("Connection restored", "연결됨")),
            );
            self.attention.disconnected = false;
        }
    }

    pub(super) fn sync_attention(&mut self, cx: &mut Context<Self>) {
        let resolved: Vec<_> = self
            .attention
            .waiting
            .keys()
            .filter(|id| {
                !self
                    .store
                    .chats
                    .iter()
                    .any(|row| row.waiting && &row.chat.session == *id)
            })
            .cloned()
            .collect();
        for session in resolved {
            if let Some(Some(id)) = self.attention.waiting.remove(&session) {
                toast::dismiss(cx, id);
            }
        }
        let Some(source) = self.source.clone() else {
            return;
        };
        let added: Vec<_> = self
            .store
            .chats
            .iter()
            .filter(|r| r.waiting && !self.attention.waiting.contains_key(&r.chat.session))
            .cloned()
            .collect();
        for row in added {
            let session = row.chat.session.clone();
            self.attention.waiting.insert(session.clone(), None);
            Self::raise_attention(row, &source, cx);
        }
    }

    fn raise_attention(
        row: crate::ui::source::ChatSummary,
        source: &std::rc::Rc<dyn crate::ui::source::Source>,
        cx: &mut Context<Self>,
    ) {
        let session = row.chat.session;
        let cards = source.authority(&session);
        let settings = source.settings();
        let fetch = Box::pin(async move { Ok(futures::join!(cards, settings)) });
        Self::run(fetch, cx, move |s, result, cx| {
            let Ok((cards, settings)) = result else {
                return;
            };
            if !s.attention.waiting.contains_key(&session) {
                return;
            }
            let tool = cards
                .as_ref()
                .ok()
                .and_then(|c| c.first())
                .and_then(|c| c.tool.as_deref());
            let label = match tool {
                Some("browser_sign_in_wait") => s.copy("Sign-in needs you", "로그인 확인 필요"),
                Some("browser_pay_wait") => s.copy("Payment needs you", "결제 확인 필요"),
                Some("browser_wait_for_user") => s.copy("Needs you in the tab", "직접 확인 필요"),
                _ => s.copy("Needs attention", "확인 필요"),
            };
            let body = format!("{} · {label}", row.title);
            let id = toast::show(cx, Toast::message(body.clone()).persistent());
            s.attention.waiting.insert(session.clone(), Some(id));
            if settings.is_ok_and(|s| s.desktop_notifications.enabled) {
                cx.show_system_notification(SystemNotification {
                    tag: format!("attention:{}", session.0).into(),
                    title: s.copy("Butler", "버틀러").into(),
                    body: body.into(),
                    actions: Vec::new(),
                });
            }
        });
    }

    pub(super) fn notification_responses(window: &Window, cx: &mut Context<Self>) {
        let entity = cx.entity().downgrade();
        let handle = window.window_handle();
        cx.on_system_notification_response(move |response, cx| {
            let Some(id) = response.tag.strip_prefix("attention:") else {
                return;
            };
            let request = Navigation::Session(id.to_owned());
            let _ = cx.update_window(handle, |_, w, cx| {
                let _ = entity.update(cx, |s, cx| s.navigate(request, w, cx));
            });
        });
    }
}
