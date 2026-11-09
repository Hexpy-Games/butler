//! `library/LibraryDetail.tsx`: a scrap's detail: its picture, and its name, group, tags and
//! source beside it.
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::artifact_preview::{
    ArtifactPreview, ArtifactPreviewFrame, ArtifactPreviewImage,
};
use butler_ds::ui::blocks::tag_field::{Suggestion, TagField};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::field::{Field, FieldLabel};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Box as Pad, Columns, Grid, Preset, Responsive, Space, Stack};
use butler_ds::ui::meta_list::{MetaItem, MetaList};
use butler_ds::ui::page_container::{PageContainer, PageWidth};
use butler_ds::ui::scroll::ScrollArea;
use butler_ds::ui::select::{Select, SelectContent, SelectGroup, SelectItem, SelectTrigger};
use butler_ds::ui::text::{self, Input};
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::typo::Typo;
use gpui::{
    AnyElement, ClickEvent, Context, Focusable as _, InteractiveElement as _, IntoElement,
    KeyDownEvent, ParentElement as _, Render, SharedString, Styled as _, Subscription, Window, div,
};

use super::actions::{file_items, has_web_source, item_meta, pixels, rename, safe_host, tag_items};
use super::api::{delete_item, load_groups, load_tags};
use super::copy::{Words, words};
use super::dialogs::LibraryDialog;
use super::files::open_source;
use super::runtime::open_dialog;
use crate::ui::manage::library::main::media::library_image;
use crate::ui::manage::library::types::{LibraryGroup, LibraryItem, LibraryNames, TagCount};
use crate::ui::manage::route::library_parent;
use crate::ui::manage::{LibraryKind, LibraryView, ManageCtx, Pick, Topic, View};
use crate::ui::widgets::anchor;

const NEW: &str = "__new";
const NONE: &str = "none";
/// `maxLength` of the name field.
const NAME_MAX: usize = 200;
/// A picture of unknown size shows at this size until it is measured.
const NATURAL: (f32, f32) = (360., 270.);

/// The picture's own size in logical px, once it is decoded (`<img>` at its intrinsic size).
fn decoded_size(
    src: &gpui::ImageSource,
    window: &mut Window,
    cx: &mut gpui::App,
) -> Option<(f32, f32)> {
    let render = match src {
        gpui::ImageSource::Render(data) => data.clone(),
        gpui::ImageSource::Resource(resource) => window
            .use_asset::<gpui::ImgResourceLoader>(resource, cx)?
            .ok()?,
        gpui::ImageSource::Image(image) => image.clone().use_render_image(window, cx)?,
        gpui::ImageSource::Custom(_) => return None,
    };
    let size = render.size(0);
    let scale = window.scale_factor();
    Some((size.width.0 as f32 / scale, size.height.0 as f32 / scale))
}

/// `LibraryDetail`: a scrap's detail panel.
pub(crate) struct LibraryDetail {
    ctx: ManageCtx,
    view: LibraryView,
    on_attach: Pick<LibraryItem>,
    groups: Vec<LibraryGroup>,
    tags: Vec<TagCount>,
    /// The name field's text, and the item it was last taken from.
    name: SharedString,
    synced: Option<(String, String)>,
    naming: bool,
    revision: u64,
    blur: Option<Subscription>,
    _live: Subscription,
}

impl LibraryDetail {
    pub(crate) fn new(
        ctx: ManageCtx,
        view: LibraryView,
        on_attach: Pick<LibraryItem>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let revision = ctx.live.read(cx).revision(&Topic::Library);
        let live = cx.observe(&ctx.live, |this, live, cx| {
            let moved = live.read(cx).revision(&Topic::Library);
            if std::mem::replace(&mut this.revision, moved) != moved {
                Self::reload(cx);
            }
        });
        let detail = Self {
            ctx,
            view,
            on_attach,
            groups: Vec::new(),
            tags: Vec::new(),
            name: SharedString::default(),
            synced: None,
            naming: false,
            revision,
            blur: None,
            _live: live,
        };
        Self::reload(cx);
        detail
    }

    /// `useLibraryGroups("scrap")`, `useLibraryTags()`
    fn reload(cx: &mut Context<Self>) {
        load_groups(cx, LibraryKind::Scrap, |this: &mut Self, groups, _| {
            let changed = this.groups != groups;
            this.groups = groups;
            changed
        });
        load_tags(cx, |this: &mut Self, tags, _| {
            let changed = this.tags != tags;
            this.tags = tags;
            changed
        });
    }

    /// Without its item (a reload) the detail goes up one level.
    fn go_up(&self, cx: &mut Context<Self>) {
        let (ctx, view) = (
            self.ctx.clone(),
            library_parent(&self.view).unwrap_or_default(),
        );
        cx.defer(move |cx| ctx.set_view(View::Library(view), cx));
    }

    /// `commitName`
    fn commit_name(&mut self, item: &LibraryItem, cx: &mut Context<Self>) {
        let title = self.name.trim().to_owned();
        if title == item.title || self.naming {
            return;
        }
        self.naming = true;
        let me = cx.weak_entity();
        rename(item, &title, cx, move |cx| {
            let _ = me.update(cx, |this, cx| {
                this.naming = false;
                this.synced = None;
                cx.notify();
            });
        });
    }

    /// `remove`: delete the item, then back up a level.
    fn remove(&self, item: &LibraryItem, cx: &mut Context<Self>) {
        let (ctx, view) = (
            self.ctx.clone(),
            library_parent(&self.view).unwrap_or_default(),
        );
        delete_item(cx, item.id.clone(), move |result, cx| match result {
            Ok(_) => ctx.set_view(View::Library(view), cx),
            Err(_) => {
                toast::show(cx, Toast::error(words(Ds::get(cx).lang()).failed));
            }
        });
    }

    /// The scrap's picture, at its own size.
    fn preview(
        item: &LibraryItem,
        copy: &'static Words,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut preview = ArtifactPreview::new("library-detail-preview");
        // CARVE-OUT(G-ds): a block scrap renders its answer block (`BlockScrap` over
        // `AnswerBlocks preview`), which needs a transcript context the 서랍 has none of.
        if let Some(src) = library_image(item, cx) {
            let natural = item
                .snapshot
                .as_ref()
                .map(|s| pixels(s.width, s.height))
                .or_else(|| item.rect.map(|r| pixels(r.width, r.height)))
                .or_else(|| decoded_size(&src, window, cx))
                .unwrap_or(NATURAL);
            preview = preview.child(ArtifactPreviewImage::new(src, natural));
        } else if let (Some(snapshot), false) = (&item.snapshot, item.block.is_some()) {
            // CARVE-OUT(G-cef): React shows the saved HTML in a sandboxed frame
            // (`ArtifactPreviewFrame srcDoc`); the web view is the P5 browser's.
            let (width, height) = pixels(snapshot.width, snapshot.height);
            preview = preview.child(ArtifactPreviewFrame::new().intrinsic_size(width, height));
        } else {
            let text = if item.asset.is_some() {
                copy.artifact_loading
            } else {
                copy.browser_failed
            };
            preview = preview.child(Typo::caption(text));
        }
        preview.into_any_element()
    }

    /// The name, group and tags fields.
    fn fields(
        &mut self,
        item: &LibraryItem,
        copy: &'static Words,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let me = cx.weak_entity();
        let id = ("library-item-name", cx.entity_id());
        let state = text::state(id, window, cx);
        if self.blur.is_none() {
            let handle = state.read(cx).focus_handle(cx);
            let item = item.clone();
            self.blur = Some(cx.on_blur(&handle, window, move |this, _, cx| {
                let current = cx.try_global::<LibraryNames>().and_then(|n| n.item.clone());
                this.commit_name(current.as_deref().unwrap_or(&item), cx);
            }));
        }
        let name = Input::new(id).value(self.name.clone()).on_change({
            let state = state.clone();
            move |text, _, cx| {
                let kept: String = text.chars().take(NAME_MAX).collect();
                if kept != text {
                    state.update(cx, |state, cx| state.emplace(&kept, cx));
                }
                let _ = me.update(cx, |this, cx| {
                    this.name = kept.into();
                    cx.notify();
                });
            }
        });
        let enter = {
            let item = item.clone();
            cx.listener(move |this, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "enter" {
                    this.commit_name(&item, cx);
                }
            })
        };
        let name = Field::new("library-item-name-field")
            .child(FieldLabel::new().child(copy.name))
            .child(div().capture_key_down(enter).child(name));
        vec![
            name.into_any_element(),
            self.group_field(item, copy, window, cx),
            self.tags_field(item, copy),
        ]
    }

    fn group_field(
        &self,
        item: &LibraryItem,
        copy: &'static Words,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let words = copy.group(LibraryKind::Scrap);
        let chosen = item.clone();
        let select = Select::new("library-item-group", window, cx)
            .value(Some(
                item.group.clone().unwrap_or_else(|| NONE.to_owned()).into(),
            ))
            .on_value_change(move |value, _, cx| {
                if &*value == NEW {
                    let then: Pick<LibraryGroup> = {
                        let item = chosen.clone();
                        Rc::new(move |group, _, cx| {
                            let id = SharedString::from(group.id);
                            file_items(vec![item.clone()], Some(&id), cx);
                        })
                    };
                    let dialog = LibraryDialog::CreateGroup {
                        kind: LibraryKind::Scrap,
                        then: Some(then),
                    };
                    open_dialog(dialog, cx);
                    return;
                }
                let group = (&*value != NONE).then_some(value);
                file_items(vec![chosen.clone()], group.as_ref(), cx);
            });
        let mut group = SelectGroup::new().child(SelectItem::new(NONE, words.ungrouped));
        for other in &self.groups {
            group = group.child(SelectItem::new(other.id.clone(), other.name.clone()));
        }
        group = group.child(SelectItem::new(NEW, format!("{}…", words.new_group)));
        let content = SelectContent::new().child(group);
        let trigger = select.trigger(
            SelectTrigger::new("library-item-group-trigger"),
            &content,
            cx,
        );
        let list = select.content(&content, window, cx);
        Field::new("library-item-group-field")
            .child(FieldLabel::new().child(words.word))
            .child(div().child(trigger).child(list))
            .into_any_element()
    }

    fn tags_field(&self, item: &LibraryItem, copy: &'static Words) -> AnyElement {
        let now = item.tags.clone().unwrap_or_default();
        let suggestions: Vec<Suggestion> = self
            .tags
            .iter()
            .map(|tag| {
                Suggestion::new(tag.name.clone()).count(u32::try_from(tag.count).unwrap_or(0))
            })
            .collect();
        let chosen = item.clone();
        let value: Vec<SharedString> = now.iter().cloned().map(SharedString::from).collect();
        let field = TagField::new("library-item-tags", copy.tags)
            .value(value, move |next, _, cx| {
                let add = next
                    .iter()
                    .filter(|t| !now.iter().any(|n| **t == **n))
                    .cloned()
                    .collect();
                let remove = now
                    .iter()
                    .filter(|n| !next.iter().any(|t| **t == **n))
                    .cloned()
                    .map(SharedString::from)
                    .collect();
                tag_items(std::slice::from_ref(&chosen), add, remove, cx);
            })
            .suggestions(suggestions)
            .placeholder(copy.add_tag)
            .remove_label(move |name| (copy.remove_tag)(name).into())
            .create_label(move |name| (copy.create_tag)(name).into());
        Field::new("library-item-tags-field")
            .child(FieldLabel::new().child(copy.tags))
            .child(field)
            .into_any_element()
    }

    /// The source, the saved date and the size.
    fn meta(item: &LibraryItem, copy: &'static Words) -> MetaList {
        let mut meta = Vec::new();
        if has_web_source(item) {
            let source = item.site.clone().unwrap_or_else(|| safe_host(&item.url));
            meta.push(MetaItem::new(copy.source, source));
        }
        let line = item_meta(item, copy.lang);
        meta.push(MetaItem::new(
            copy.saved,
            line.split(" · ").last().unwrap_or_default().to_owned(),
        ));
        if let Some(size) = &item.snapshot {
            let (w, h) = (size.width.round(), size.height.round());
            meta.push(MetaItem::new(copy.size, format!("{w} × {h}")));
        }
        MetaList::new(meta)
    }

    fn actions(
        &self,
        item: &LibraryItem,
        copy: &'static Words,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let ds = Ds::get(cx);
        let mut row = button::container(Size::Sm);
        if item.block.is_some() || has_web_source(item) {
            let (ctx, item) = (self.ctx.clone(), item.clone());
            let label = if item.block.is_some() {
                copy.open_origin_chat
            } else {
                copy.open_source_page
            };
            row = row.child(
                Button::new("library-detail-source")
                    .size(Size::Sm)
                    .variant(Variant::Outline)
                    .icon_start(icon(Icon::Popup, IconSize::Sm, ds))
                    .text(label)
                    .on_click(move |_, _, cx| open_source(&item, &ctx, cx)),
            );
        }
        let (attach, on_attach) = (item.clone(), self.on_attach.clone());
        let (delete, me) = (item.clone(), cx.weak_entity());
        row.child(
            Button::new("library-detail-attach")
                .size(Size::Sm)
                .icon_start(icon(Icon::MessageSquarePlus, IconSize::Sm, ds))
                .text(copy.attach)
                .on_click(move |_, window, cx| on_attach(attach.clone(), window, cx)),
        )
        .child(
            Button::new("library-detail-delete")
                .size(Size::Sm)
                .variant(Variant::Ghost)
                .icon_start(icon(Icon::Trash2, IconSize::Sm, ds))
                .text(copy.delete_item)
                .on_click(move |_: &ClickEvent, _, cx| {
                    let _ = me.update(cx, |this, cx| this.remove(&delete, cx));
                }),
        )
        .into_any_element()
    }
}

impl Render for LibraryDetail {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(item) = cx
            .try_global::<LibraryNames>()
            .and_then(|names| names.item.clone())
        else {
            self.go_up(cx);
            return div().size_full().into_any_element();
        };
        let key = (item.id.clone(), item.title.clone());
        if self.synced.as_ref() != Some(&key) {
            self.name = item.title.clone().into();
            self.synced = Some(key);
        }
        let copy = words(Ds::get(cx).lang());
        let preview = Self::preview(&item, copy, window, cx);
        let mut side = self.fields(&item, copy, window, cx);
        side.push(Self::meta(&item, copy).into_any_element());
        side.push(self.actions(&item, copy, cx));
        let columns = Columns::Responsive(Responsive {
            compact: Some(1),
            base: Preset::Fixed(1),
            wide: Some(Preset::MainAside),
        });
        let grid = Grid::new("library-detail-grid")
            .columns(columns)
            .gap(Space::Xl)
            .page_container()
            .child(preview)
            .child(Stack::new().gap(Space::Lg).children(side));
        let page = PageContainer::new()
            .width(PageWidth::Full)
            .gutter(Space::Xl)
            .child(Pad::new().padding_y(Space::Xl).child(grid));
        let scroll = ScrollArea::new("library-detail-scroll").fill().child(page);
        anchor(div().size_full().flex().flex_col(), "library-detail")
            .child(scroll)
            .into_any_element()
    }
}
