//! ProjectFolderBrowser.tsx and useProjectFolderBrowser.ts: pick a folder of the agent's
//! workspace root, one `list_project_folders` page at a time, under a DS Breadcrumb trail.
use super::super::Shell;
use crate::ui::{Icon, i18n::Locale, source::agent::Jobs};
use butler_ds::ui::{
    blocks::{
        breadcrumb::{
            Breadcrumb, BreadcrumbButton, BreadcrumbItem, BreadcrumbList, BreadcrumbPage,
            BreadcrumbSeparator,
        },
        empty_line::EmptyLine,
        nav_row::NavRow,
    },
    button::{Button, Variant},
    context::Ds,
    dialog::DialogFooter,
    field::FieldError,
    icon::{IconSize, icon},
    layout::{Space, Stack},
    scroll::{MaxHeight, MinHeight, ScrollArea},
    spinner::Spinner,
    tooltip::Tooltip,
};
use gpui::{Context, IntoElement, Render, WeakEntity, Window, div, prelude::*};

/// `ProjectFolderSelection` of a workspace folder.
#[derive(Clone)]
pub(super) struct Chosen {
    pub(super) workspace_path: String,
    pub(super) folder_path: String,
}

/// `ProjectFolderPage`.
struct Page {
    root_name: String,
    path: String,
    folders: Vec<String>,
    next_after: Option<String>,
}

impl Page {
    fn parse(value: &serde_json::Value) -> Option<Self> {
        Some(Self {
            root_name: value.get("root_name")?.as_str()?.to_owned(),
            path: value.get("path")?.as_str()?.to_owned(),
            folders: value
                .get("folders")?
                .as_array()?
                .iter()
                .filter_map(|folder| folder.get("name")?.as_str())
                .map(str::to_owned)
                .collect(),
            next_after: value
                .get("next_after")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
        })
    }

    fn segments(&self) -> Vec<&str> {
        self.path.split('/').filter(|s| !s.is_empty()).collect()
    }
}

/// The create dialog's folder state and, while `browsing`, the browser it shows.
pub(super) struct FolderPicker {
    shell: WeakEntity<Shell>,
    locale: Locale,
    pub(super) browsing: bool,
    pub(super) chosen: Option<Chosen>,
    /// The project name typed before browsing, kept for the form that comes back.
    pub(super) name: String,
    page: Option<Page>,
    loading: bool,
    error: bool,
    generation: u64,
}

impl FolderPicker {
    pub(super) fn new(shell: WeakEntity<Shell>, locale: Locale) -> Self {
        Self {
            shell,
            locale,
            browsing: false,
            chosen: None,
            name: String::new(),
            page: None,
            loading: false,
            error: false,
            generation: 0,
        }
    }

    fn t(&self, en: &'static str, ko: &'static str) -> &'static str {
        match self.locale {
            Locale::En => en,
            Locale::Ko => ko,
        }
    }

    /// Opens the browser at the chosen folder, or at the root.
    pub(super) fn open(&mut self, name: String, cx: &mut Context<Self>) {
        self.name = name;
        self.browsing = true;
        let start = self
            .chosen
            .as_ref()
            .map(|chosen| chosen.workspace_path.clone())
            .unwrap_or_default();
        self.load(start, None, cx);
    }

    /// Leaves the browser for the form.
    fn close(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        self.browsing = false;
        self.loading = false;
        self.changed(cx);
    }

    pub(super) fn reset(&mut self, cx: &mut Context<Self>) {
        self.chosen = None;
        self.changed(cx);
    }

    fn changed(&self, cx: &mut Context<Self>) {
        cx.notify();
        let _ = self.shell.update(cx, |_, cx| cx.notify());
    }

    /// `navigate`: a newer request supersedes an older one; `more` appends the next page.
    fn load(&mut self, path: String, after: Option<String>, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        self.loading = true;
        self.error = false;
        let append = after.is_some();
        let request = Jobs::run(cx, move |client| async move {
            let reply = client.list_project_folders(&path, after.as_deref()).await;
            reply.ok().and_then(|value| Page::parse(&value))
        });
        cx.spawn(async move |this, cx| {
            let page = request.await.flatten();
            let _ = this.update(cx, |picker, cx| picker.loaded(generation, page, append, cx));
        })
        .detach();
        cx.notify();
    }

    fn loaded(
        &mut self,
        generation: u64,
        page: Option<Page>,
        append: bool,
        cx: &mut Context<Self>,
    ) {
        if generation != self.generation {
            return;
        }
        self.loading = false;
        match page {
            Some(mut next) => {
                if append && let Some(previous) = self.page.take() {
                    let mut folders = previous.folders;
                    folders.append(&mut next.folders);
                    next.folders = folders;
                }
                self.page = Some(next);
            }
            None => {
                self.error = true;
                if !append {
                    self.page = None;
                }
            }
        }
        cx.notify();
    }

    fn go(&mut self, path: String, cx: &mut Context<Self>) {
        if !self.loading {
            self.load(path, None, cx);
        }
    }

    fn parent(&mut self, cx: &mut Context<Self>) {
        let Some(page) = &self.page else {
            return;
        };
        let segments = page.segments();
        if let Some((_, rest)) = segments.split_last() {
            let path = rest.join("/");
            self.go(path, cx);
        }
    }

    fn more(&mut self, cx: &mut Context<Self>) {
        let Some(page) = &self.page else {
            return;
        };
        let (path, after) = (page.path.clone(), page.next_after.clone());
        if let (false, Some(after)) = (self.loading, after) {
            self.load(path, Some(after), cx);
        }
    }

    /// `choose`: the open folder becomes the project's folder; the root is not selectable.
    fn choose(&mut self, cx: &mut Context<Self>) {
        let Some(page) = self.page.as_ref().filter(|p| !p.path.is_empty()) else {
            return;
        };
        if self.loading || self.error {
            return;
        }
        let chosen = Chosen {
            workspace_path: page.path.clone(),
            folder_path: format!("{}/{}", page.root_name, page.path),
        };
        if self.name.trim().is_empty() {
            self.name = page
                .segments()
                .last()
                .map(ToString::to_string)
                .unwrap_or_default();
        }
        self.chosen = Some(chosen);
        self.close(cx);
    }

    fn trail(&self, page: &Page, cx: &mut Context<Self>) -> Breadcrumb {
        let segments = page.segments();
        let names = std::iter::once(page.root_name.as_str()).chain(segments.iter().copied());
        let last = segments.len();
        let mut list = BreadcrumbList::new();
        for (index, name) in names.enumerate() {
            if index > 0 {
                list = list.child(BreadcrumbSeparator::new());
            }
            let step = if index == last {
                BreadcrumbPage::new()
                    .child(name.to_owned())
                    .into_any_element()
            } else {
                let path = segments[..index].join("/");
                BreadcrumbButton::new(("folder-crumb", index))
                    .on_click(cx.listener(move |picker, _, _, cx| picker.go(path.clone(), cx)))
                    .child(name.to_owned())
                    .into_any_element()
            };
            list = list.child(BreadcrumbItem::new().child(step));
        }
        Breadcrumb::new(self.t("Folder path", "폴더 경로")).child(list)
    }

    fn rows(&self, page: &Page, cx: &mut Context<Self>) -> Stack {
        let folder = icon(Icon::Folder, IconSize::Sm, Ds::get(cx));
        let mut rows = Stack::new();
        if !page.path.is_empty() {
            rows = rows.child(
                NavRow::new("project-folder-up", self.t("Up one level", "상위 폴더"))
                    .glyph(Icon::Reply)
                    .when(self.loading, NavRow::disabled)
                    .on_click(cx.listener(|picker, _, _, cx| picker.parent(cx))),
            );
        }
        if !self.loading && page.folders.is_empty() {
            rows =
                rows.child(EmptyLine::new(self.t("No subfolders", "하위 폴더 없음")).icon(folder));
        }
        for (index, name) in page.folders.iter().enumerate() {
            let path = page
                .segments()
                .into_iter()
                .chain(std::iter::once(name.as_str()))
                .collect::<Vec<_>>()
                .join("/");
            rows = rows.child(
                NavRow::new(("project-folder-row", index), name.clone())
                    .glyph(Icon::Folder)
                    .when(self.loading, NavRow::disabled)
                    .on_click(cx.listener(move |picker, _, _, cx| picker.go(path.clone(), cx))),
            );
        }
        if page.next_after.is_some() {
            rows = rows.child(
                Button::new("project-folder-more")
                    .variant(Variant::Ghost)
                    .text(self.t("Show more", "더 보기"))
                    .when(self.loading, Button::disabled)
                    .on_click(cx.listener(|picker, _, _, cx| picker.more(cx))),
            );
        }
        rows
    }

    fn footer(&self, usable: bool, cx: &mut Context<Self>) -> DialogFooter {
        let choose = Button::new("project-folder-use")
            .text(self.t("Use this folder", "이 폴더 사용"))
            .when(!usable, Button::disabled)
            .on_click(cx.listener(|picker, _, _, cx| picker.choose(cx)));
        let at_root = self.page.as_ref().is_some_and(|p| p.path.is_empty());
        let choose = if at_root {
            Tooltip::new("project-folder-use-tip")
                .label(self.t("Open a subfolder first", "하위 폴더를 여세요"))
                .child(choose)
                .into_any_element()
        } else {
            choose.into_any_element()
        };
        DialogFooter::new()
            .child(
                Button::new("project-folder-back")
                    .variant(Variant::Outline)
                    .text(self.t("Back", "이전"))
                    .on_click(cx.listener(|picker, _, _, cx| picker.close(cx))),
            )
            .child(choose)
    }
}

impl Render for FolderPicker {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut body = Stack::new().gap(Space::Md);
        let page = self.page.as_ref();
        if let Some(page) = page {
            body = body.child(self.trail(page, cx));
        }
        if self.loading {
            body = body.child(Spinner::new("project-folder-loading"));
        }
        if self.error {
            body = body.child(
                FieldError::new()
                    .child(self.t("Couldn't load folders", "폴더를 불러오지 못했습니다")),
            );
        }
        let list = page
            .filter(|_| !self.error)
            .map_or_else(Stack::new, |p| self.rows(p, cx));
        let usable = page.is_some_and(|p| !p.path.is_empty()) && !self.loading && !self.error;
        let footer = self.footer(usable, cx);
        div()
            .id("project-folder-browser")
            .capture_key_down(cx.listener(|picker, event: &gpui::KeyDownEvent, _, cx| {
                let key = &event.keystroke;
                if key.key == "escape" {
                    cx.stop_propagation();
                    picker.close(cx);
                } else if key.key == "backspace" || (key.modifiers.alt && key.key == "up") {
                    cx.stop_propagation();
                    picker.parent(cx);
                }
            }))
            .child(body)
            .child(
                ScrollArea::new("project-folder-scroll")
                    .max_height(MaxHeight::Sm)
                    .min_height(MinHeight::Xs)
                    .child(list),
            )
            .child(footer)
    }
}
