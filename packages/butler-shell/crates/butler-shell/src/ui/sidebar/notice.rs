//! useOrganizationNotice: only automatic grouping raises a brief toast with Undo.
use super::Shell;
use crate::ui::source::sidebar::SpaceCommand;
use butler_ds::ui::toast::{self, Action, Toast};
use gpui::Context;
impl Shell {
    pub(super) fn organization_notice(&mut self, cx: &mut Context<Self>) {
        let notice = self
            .store
            .navigation
            .view
            .as_ref()
            .and_then(|v| {
                v.space
                    .smartNotice
                    .as_ref()
                    .filter(|n| n.revision == v.space.revision)
            })
            .cloned();
        let token = notice.as_ref().map(|n| n.undoToken.clone());
        if token != self.sidebar.notice_token
            && let Some(id) = self.sidebar.notice_id.take()
        {
            toast::dismiss(cx, id);
        }
        let Some(notice) = notice else {
            return;
        };
        if self.sidebar.notice_token.as_ref() == Some(&notice.undoToken) {
            return;
        }
        self.sidebar.notice_token = Some(notice.undoToken.clone());
        let weak = cx.entity().downgrade();
        let token = notice.undoToken;
        let action = Action::new(self.copy("Undo", "실행 취소"), move |cx| {
            let _ = weak.update(cx, |s, cx| {
                if s.sidebar.pending {
                    return;
                }
                let current = s.store.navigation.view.as_ref().and_then(|v| {
                    v.space
                        .smartNotice
                        .as_ref()
                        .filter(|n| n.revision == v.space.revision)
                });
                if current.is_some_and(|n| n.undoToken == token) {
                    s.space_mutate(
                        SpaceCommand::Undo,
                        serde_json::json!({"action":"undo","undoToken":token}),
                        cx,
                    );
                }
            });
        });
        self.sidebar.notice_id = Some(toast::show(
            cx,
            Toast::message(format!(
                "{} {}",
                notice.title,
                self.copy("grouped", "그룹으로 정리했어요")
            ))
            .duration(std::time::Duration::from_secs(8))
            .action(action),
        ));
    }
}
