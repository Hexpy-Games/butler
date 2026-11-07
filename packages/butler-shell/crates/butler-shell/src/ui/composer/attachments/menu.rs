//! `ComposerAttachmentMenu` and `ComposerProjectDocumentMenu`: the "+" menu (attach a file or
//! image, project documents, response mode) and the nested project-document picker.
#![allow(dead_code, reason = "P2 shell-wave: wired by Opus at wave integration")]

use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::filtered_select_popover::{FilteredSelectPopover, Width as SelectWidth};
use butler_ds::ui::blocks::option_menu::{OptionMenu, OptionMenuItem, OptionMenuSection};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::overlay::place::{Align, Side};
use butler_ds::ui::popover::{MenuSize, Popover, PopoverContent};
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::ShellClient;
use gpui::{AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Window};

use super::documents::{PickDocument, load_documents, picker_filters, picker_groups, tr};
use crate::ui::source::wire::ProjectDashboardDocument;

type Choose = Rc<dyn Fn(&mut Window, &mut App)>;

/// What the menu shows and does (the `useComposerStore` selectors it reads).
pub(crate) struct AttachmentMenu {
    /// An upload is running: the "+" button is disabled.
    pub(crate) uploading: bool,
    /// The open chat's project (`activeProjectId`); gates the documents and the plan row.
    pub(crate) project_id: Option<String>,
    pub(crate) plan_mode: bool,
    /// Why the model takes no images (`imageRefusalLabel(imagesBlockedBy)`), when it does not.
    pub(crate) images_blocked: Option<SharedString>,
    pub(crate) client: Option<ShellClient>,
    /// `openAttachmentPicker`: `true` for "Attach image".
    pub(crate) on_pick_file: Rc<dyn Fn(bool, &mut Window, &mut App)>,
    /// `handlePlanModeChange`.
    pub(crate) on_plan_mode: Rc<dyn Fn(bool, &mut Window, &mut App)>,
    /// `addProjectDocument`.
    pub(crate) on_document: PickDocument,
}

/// The picker's documents and the project they were loaded for.
#[derive(Default)]
struct DocumentsState {
    project: Option<String>,
    documents: Vec<ProjectDashboardDocument>,
}

/// `ComposerAttachmentMenu`: the "+" button and its popover.
pub(crate) fn attachment_menu(menu: AttachmentMenu, window: &mut Window, cx: &mut App) -> AnyElement {
    let popover = Popover::new("composer-attachment-menu", window, cx);
    let label = tr(cx, "More options", "추가 기능");
    let uploading = menu.uploading;
    let trigger = popover.trigger(|toggle| {
        let mut button = IconButton::new("composer-attachment-button", label)
            .glyph(Icon::Plus)
            .on_click(toggle.on_click());
        if uploading {
            button = button.disabled();
        }
        button.into_any_element()
    });
    let close: Choose = {
        let popover = popover.clone();
        Rc::new(move |window, cx| popover.set_open(false, window, cx))
    };
    let body = menu_body(&menu, label, &close, window, cx);
    let content = popover.content(
        PopoverContent::new()
            .align(Align::Start)
            .menu_size(MenuSize::Content)
            .side(Side::Top)
            .side_offset(10.)
            .auto_focus()
            .child(body),
        window,
        cx,
    );
    Stack::new().gap(Space::None).child(trigger).child(content).into_any_element()
}

/// One response-mode row.
fn mode_row(
    menu: &AttachmentMenu,
    close: &Choose,
    (id, label, glyph, plan): (&'static str, &'static str, Icon, bool),
    cx: &App,
) -> OptionMenuItem {
    let (on_plan, close) = (menu.on_plan_mode.clone(), close.clone());
    let item = OptionMenuItem::new(id, label)
        .icon(icon(glyph, IconSize::Md, Ds::get(cx)))
        .on_click(move |_, window, cx| {
            on_plan(plan, window, cx);
            close(window, cx);
        });
    if plan == menu.plan_mode { item.selected() } else { item }
}

/// One "attach" row; `images` picks pictures only.
fn attach_row(
    menu: &AttachmentMenu,
    close: &Choose,
    (id, label, glyph, images): (&'static str, &'static str, Icon, bool),
    cx: &App,
) -> OptionMenuItem {
    let (pick, close) = (menu.on_pick_file.clone(), close.clone());
    let mut item = OptionMenuItem::new(id, label).icon(icon(glyph, IconSize::Md, Ds::get(cx)));
    if let (true, Some(reason)) = (images, menu.images_blocked.clone()) {
        item = item.disabled_reason(reason);
    }
    item.on_click(move |_, window, cx| {
        pick(images, window, cx);
        close(window, cx);
    })
}

/// The menu's two sections.
fn menu_body(
    menu: &AttachmentMenu,
    title: &'static str,
    close: &Choose,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let mut attachments = OptionMenuSection::new(tr(cx, "Attachments", "첨부")).first();
    if let Some(project) = menu.project_id.clone() {
        attachments = attachments.child(document_menu(menu, project, close, window, cx));
    }
    let file = ("composer-attach-file", tr(cx, "Attach file", "파일 첨부"), Icon::Paperclip, false);
    let image = ("composer-attach-image", tr(cx, "Attach image", "이미지 첨부"), Icon::ImageIcon, true);
    attachments = attachments
        .child(attach_row(menu, close, file, cx))
        .child(attach_row(menu, close, image, cx));
    let normal = ("composer-mode-normal", tr(cx, "Normal", "일반"), Icon::MessageSquarePlus, false);
    let mut response = OptionMenuSection::new(tr(cx, "Response mode", "응답 방식"))
        .child(mode_row(menu, close, normal, cx));
    if menu.project_id.is_some() {
        let plan = ("composer-mode-plan", tr(cx, "Plan", "계획"), Icon::ListChecks, true);
        response = response.child(mode_row(menu, close, plan, cx));
    }
    OptionMenu::new(title).fit().child(attachments).child(response).into_any_element()
}

/// `ComposerProjectDocumentMenu`: the "Project documents" row; its popover is the picker.
fn document_menu(
    menu: &AttachmentMenu,
    project_id: String,
    close_menu: &Choose,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let nested = Popover::new("composer-documents-menu", window, cx);
    let title = tr(cx, "Project documents", "프로젝트 문서");
    let trigger = nested.trigger(|toggle| {
        OptionMenuItem::new("composer-documents-item", title)
            .icon(icon(Icon::FileText, IconSize::Md, Ds::get(cx)))
            .description(icon(Icon::ChevronRight, IconSize::Sm, Ds::get(cx)))
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let close_all: Choose = {
        let (nested, close_menu) = (nested.clone(), close_menu.clone());
        Rc::new(move |window, cx| {
            nested.set_open(false, window, cx);
            close_menu(window, cx);
        })
    };
    let picker = document_picker(menu, project_id, &nested, close_all, title, window, cx);
    let content = nested.content(
        PopoverContent::new()
            .align(Align::End)
            .menu_size(MenuSize::Content)
            .side(Side::Right)
            .side_offset(8.)
            .child(picker),
        window,
        cx,
    );
    Stack::new().gap(Space::None).child(trigger).child(content).into_any_element()
}

/// `ComposerProjectDocumentPicker`: loads the project's documents while the popover is open,
/// and starts fresh (no documents, empty search, "all") each time it opens.
fn document_picker(
    menu: &AttachmentMenu,
    project_id: String,
    nested: &Popover,
    close_all: Choose,
    title: &'static str,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let state: Entity<DocumentsState> =
        window.use_keyed_state("composer-documents-state", cx, |_, _| DocumentsState::default());
    let search: Entity<SharedString> =
        window.use_keyed_state("composer-documents-search", cx, |_, _| SharedString::default());
    let filter: Entity<SharedString> =
        window.use_keyed_state("composer-documents-filter", cx, |_, _| SharedString::from("all"));
    if nested.is_open(cx) {
        load_when_needed(&state, &project_id, menu.client.clone(), cx);
    } else {
        reset(&state, &search, &filter, cx);
    }
    let on_pick: PickDocument = {
        let on_document = menu.on_document.clone();
        Rc::new(move |document, window, cx| {
            on_document(document, window, cx);
            close_all(window, cx);
        })
    };
    let (search_now, filter_now) = (search.read(cx).clone(), filter.read(cx).clone());
    let groups = picker_groups(&state.read(cx).documents, &filter_now, &search_now, &on_pick, cx);
    let set_filter = filter.clone();
    let filters = picker_filters(cx, move |id, _, cx| {
        let id = SharedString::from(id.to_owned());
        set_filter.update(cx, |filter, cx| {
            *filter = id;
            cx.notify();
        });
    });
    FilteredSelectPopover::new(
        "composer-documents-list",
        title,
        tr(cx, "Search document titles", "문서 제목 검색"),
        tr(cx, "No project documents.", "프로젝트 문서가 없습니다."),
    )
    .search(search_now, move |text, _, cx| {
        let text = SharedString::from(text.to_owned());
        search.update(cx, |search, cx| {
            *search = text;
            cx.notify();
        });
    })
    .filters(filters, filter_now)
    .groups(groups)
    .width(SelectWidth::Fixed)
    .into_any_element()
}

/// The picker closed: forget what it held, so the next open loads again.
fn reset(
    state: &Entity<DocumentsState>,
    search: &Entity<SharedString>,
    filter: &Entity<SharedString>,
    cx: &mut App,
) {
    if state.read(cx).project.is_some() {
        state.update(cx, |state, _| *state = DocumentsState::default());
    }
    if !search.read(cx).is_empty() {
        search.update(cx, |search, _| *search = SharedString::default());
    }
    if filter.read(cx).as_ref() != "all" {
        filter.update(cx, |filter, _| *filter = SharedString::from("all"));
    }
}

/// The effect on `projectId`: starts the document load once per opening.
fn load_when_needed(
    state: &Entity<DocumentsState>,
    project_id: &str,
    client: Option<ShellClient>,
    cx: &mut App,
) {
    if state.read(cx).project.as_deref() == Some(project_id) {
        return;
    }
    let project = project_id.to_owned();
    state.update(cx, |state, _| {
        *state = DocumentsState {
            project: Some(project.clone()),
            documents: Vec::new(),
        };
    });
    let Some(client) = client else { return };
    let failed = tr(cx, "Project documents failed", "프로젝트 문서를 불러오지 못했습니다");
    let state = state.clone();
    // TODO(integration: run on agent worker)
    cx.spawn(async move |cx| {
        let loaded = load_documents(client, project.clone()).await;
        let _ = cx.update(|cx| {
            match loaded {
                Ok(documents) => state.update(cx, |state, cx| {
                    if state.project.as_deref() == Some(project.as_str()) {
                        state.documents = documents;
                        cx.notify();
                    }
                }),
                Err(()) => {
                    toast::show(cx, Toast::error(failed));
                }
            }
            cx.refresh_windows();
        });
    })
    .detach();
}
