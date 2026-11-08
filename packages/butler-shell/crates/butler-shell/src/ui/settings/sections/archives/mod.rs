//! Settings: Archives (`ArchivesSettings.tsx`). The general-chat-cleared refresh is not wired
//! (F4: `generalChatEvents`).
mod copy;
mod item;

use std::rc::Rc;

use butler_ds::ui::blocks::settings_section::{
    SettingsPage, SettingsSection, SettingsSectionKind, SettingsSectionMore,
};
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::Error;
use gpui::{
    AnyView, App, AppContext as _, Context, IntoElement, ParentElement as _, Render, SharedString,
    Window,
};
use serde_json::{Value, json};

use crate::ui::settings::SectionCtx;
use crate::ui::settings::confirm::Request;
use crate::ui::settings::state::{Load, fetch};
use copy::words;
use item::{ArchiveList, Handler, Kind};

const PAGE_SIZE: u32 = 20;

pub(crate) fn page(ctx: SectionCtx, window: &mut Window, cx: &mut App) -> AnyView {
    cx.new(|cx| ArchivesPage::new(ctx, window, cx)).into()
}

struct ArchivesPage {
    ctx: SectionCtx,
    archives: Load<ArchiveList>,
    /// The id of the item being restored or deleted.
    busy: Option<String>,
}

impl ArchivesPage {
    fn new(ctx: SectionCtx, _: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut page = Self {
            ctx,
            archives: Load::Loading,
            busy: None,
        };
        page.refresh(cx);
        page
    }

    /// `refresh`: the first page; it also ends the busy state of the action that asked for it.
    fn refresh(&mut self, cx: &mut Context<Self>) {
        if matches!(self.archives, Load::Failed) {
            self.archives = Load::Loading;
        }
        fetch(
            cx,
            |client| async move { client.list_archives(Some(PAGE_SIZE), Some(0)).await },
            |this: &mut Self, result: Result<ArchiveList, Error>, _| {
                this.busy = None;
                match result {
                    Ok(list) => this.archives = Load::Ready(list),
                    Err(_) if matches!(this.archives, Load::Loading) => {
                        this.archives = Load::Failed;
                    }
                    Err(_) => {}
                }
            },
        );
    }

    /// `loadMore`: the next page, appended after the rows shown.
    fn load_more(&mut self, cx: &mut Context<Self>) {
        let Load::Ready(list) = &self.archives else {
            return;
        };
        let offset = u64::try_from(list.projects.len() + list.sessions.len()).unwrap_or_default();
        fetch(
            cx,
            move |client| async move { client.list_archives(Some(PAGE_SIZE), Some(offset)).await },
            |this: &mut Self, result: Result<ArchiveList, Error>, cx| match (
                result,
                &mut this.archives,
            ) {
                (Ok(next), Load::Ready(list)) => {
                    list.projects.extend(next.projects);
                    list.sessions.extend(next.sessions);
                    list.pagination = next.pagination;
                }
                (Err(_), _) => {
                    let copy = words(Ds::get(cx).lang());
                    toast::show(cx, Toast::error(copy.load_more_failed));
                }
                _ => {}
            },
        );
    }

    /// `restore`: PATCH `{archived: false}`.
    fn restore(&mut self, kind: Kind, id: String, cx: &mut Context<Self>) {
        self.busy = Some(id.clone());
        fetch(
            cx,
            move |client| async move {
                let body = json!({ "archived": false });
                match kind {
                    Kind::Project => client.update_project(&id, &body).await,
                    Kind::Session => client.update_session(&id, &body).await,
                }
            },
            |this: &mut Self, result: Result<Value, Error>, cx| {
                this.finish(result.is_ok(), |copy| copy.restore_failed, cx);
            },
        );
    }

    /// `remove`, after the owner confirmed: DELETE `?permanent=true`.
    fn remove(&mut self, kind: Kind, id: String, cx: &mut Context<Self>) {
        self.busy = Some(id.clone());
        fetch(
            cx,
            move |client| async move {
                match kind {
                    Kind::Project => client.delete_project(&id, Some(true)).await,
                    Kind::Session => client.delete_session_permanent(&id).await,
                }
            },
            |this: &mut Self, result: Result<Value, Error>, cx| {
                this.finish(result.is_ok(), |copy| copy.remove_failed, cx);
            },
        );
    }

    /// After a restore or a delete: refresh on success, else the error toast.
    fn finish(
        &mut self,
        ok: bool,
        failed: fn(&copy::Words) -> &'static str,
        cx: &mut Context<Self>,
    ) {
        if ok {
            self.refresh(cx);
        } else {
            self.busy = None;
            let copy = words(Ds::get(cx).lang());
            toast::show(cx, Toast::error(failed(copy)));
        }
    }

    /// `confirmAction(deleteItem(title))`
    fn ask_remove(&mut self, kind: Kind, id: String, title: &str, cx: &mut Context<Self>) {
        let copy = words(Ds::get(cx).lang());
        let request = Request::new((copy.delete_item)(title))
            .title(copy.delete)
            .confirm_label(copy.delete)
            .destructive();
        let page = cx.weak_entity();
        self.ctx.confirm(
            request,
            move |_, cx| {
                let _ = page.update(cx, |this, cx| this.remove(kind, id, cx));
            },
            cx,
        );
    }
}

impl Render for ArchivesPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = Ds::get(cx).lang();
        let copy = words(lang);
        let mut section = SettingsSection::new("archives", SettingsSectionKind::List, copy.title)
            .state(
                self.archives
                    .state(|list| list.projects.is_empty() && list.sessions.is_empty()),
            )
            .empty_message(copy.empty)
            .on_retry(cx.listener(|this, _, _, cx| this.refresh(cx)));
        if let Load::Ready(list) = &self.archives {
            if list.pagination.has_more {
                let mut more = SettingsSectionMore::new(
                    copy.more,
                    cx.listener(|this, _, _, cx| this.load_more(cx)),
                );
                if self.busy.is_some() {
                    more = more.busy();
                }
                section = section.more(more);
            }
            for entry in item::items(list, copy) {
                let (kind, id, title) = (entry.kind, entry.id.clone(), entry.title.clone());
                let open: Option<Handler> = (kind == Kind::Session).then(|| {
                    let id = id.clone();
                    Rc::new(cx.listener(move |this, _, _, cx| {
                        this.ctx.open_session(SharedString::from(id.clone()), cx);
                    })) as Handler
                });
                let restore_id = id.clone();
                let restore: Handler = Rc::new(cx.listener(move |this, _, _, cx| {
                    this.restore(kind, restore_id.clone(), cx);
                }));
                let remove: Handler = Rc::new(cx.listener(move |this, _, _, cx| {
                    this.ask_remove(kind, id.clone(), &title, cx);
                }));
                let busy = self.busy.as_deref() == Some(entry.id.as_str());
                section = section.child(item::row(&entry, busy, lang, copy, open, restore, remove));
            }
        }
        SettingsPage::new()
            .labels(SectionCtx::labels(cx))
            .section(section)
    }
}
