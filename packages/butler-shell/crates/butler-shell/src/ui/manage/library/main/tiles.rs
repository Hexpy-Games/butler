//! `library/GroupTiles.tsx`: one row of group tiles (`limit` cells; the last becomes "+N" when
//! the groups overflow).
//! A card dragged over a tile files into the group (`useDropGroup`); a tile dragged over another
//! of its kind takes its place (`startGroupDrag`). Chips share both ([`group_target`]).
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::group_tile::{GroupTile, GroupTileMore, GroupTilePreview};
use butler_ds::ui::blocks::overflow_action_menu::{OverflowActionMenu, OverflowItem};
use gpui::{
    AnyElement, App, Context, Div, Entity, InteractiveElement as _, IntoElement as _,
    ParentElement as _, SharedString, Stateful, StatefulInteractiveElement as _, div,
};

use super::copy::get;
use super::media::library_image;
use super::open::has_web_source;
use crate::ui::manage::library::LibraryPage;
use crate::ui::manage::library::detail::{
    CardDrag, GroupDrag, LibraryDialog, drop_cards_on_group, drop_group_on, group_ghost,
};
use crate::ui::manage::library::filters::locale_date;
use crate::ui::manage::library::open_library;
use crate::ui::manage::library::types::{LibraryGroup, LibraryItem, LibraryItemKind};
use crate::ui::manage::{LibraryKind, ManageCtx};

/// What a drag in progress means to the tiles: the cards lifted (dimmed in place) and the group
/// the cards are over (`useCardDrag`'s `items` and `target`).
#[derive(Default)]
pub(crate) struct Drag {
    pub(crate) lifted: Vec<String>,
    pub(crate) over: Option<SharedString>,
}

impl LibraryPage {
    /// `startCardDrag`: the cards leave their places.
    pub(crate) fn lift(&mut self, drag: &CardDrag, cx: &mut Context<Self>) {
        self.drag = Drag {
            lifted: drag.items.iter().map(|item| item.id.clone()).collect(),
            over: None,
        };
        cx.notify();
    }

    /// The drag ended on a target: nothing is lifted or over any more.
    fn landed(&mut self, cx: &mut Context<Self>) {
        self.drag = Drag::default();
        cx.notify();
    }

    /// `useDropGroup`: a dragged card is over the group.
    pub(crate) fn drop_over(&self, group: &str, cx: &App) -> bool {
        cx.has_active_drag() && self.drag.over.as_deref() == Some(group)
    }
}

/// The element of a tile or chip of `group` that lifts it (`startGroupDrag`) and takes dropped
/// cards (`dropOn`) and tiles (`moveGroup`) of its kind.
pub(crate) fn group_target(
    page: &Entity<LibraryPage>,
    id: impl Into<gpui::ElementId>,
    group: &LibraryGroup,
) -> Stateful<Div> {
    let (kind, key) = (group.kind, SharedString::from(group.id.clone()));
    let (lift, track, land, reorder) = (page.clone(), page.clone(), page.clone(), key.clone());
    let (hover, filed) = (key.clone(), key.clone());
    div()
        .id(id)
        .on_drag(GroupDrag { id: key, kind }, move |_, _, _, cx| {
            lift.update(cx, super::super::LibraryPage::landed);
            group_ghost(cx)
        })
        .on_drag_move::<CardDrag>(move |event, _, cx| {
            let inside = event.bounds.contains(&event.event.position) && event.drag(cx).fits(kind);
            track.update(cx, |page, cx| {
                let now = page.drag.over.as_ref() == Some(&hover);
                if inside && !now {
                    page.drag.over = Some(hover.clone());
                    cx.notify();
                } else if !inside && now {
                    page.drag.over = None;
                    cx.notify();
                }
            });
        })
        .on_drop::<CardDrag>(move |drag, _, cx| {
            if drag.fits(kind) {
                drop_cards_on_group(drag, &filed, cx);
            }
            land.update(cx, super::super::LibraryPage::landed);
        })
        .on_drop::<GroupDrag>(move |drag, _, cx| drop_group_on(drag, &reorder, cx))
}

/// `safeHost`
fn safe_host(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_else(|| url.to_owned())
}

/// `preview`: a crop, a bookmark's site, a text scrap's words, or a document.
fn preview(item: &LibraryItem, cx: &mut App) -> GroupTilePreview {
    if let Some(src) = library_image(item, cx) {
        return GroupTilePreview::Image { src };
    }
    if item.kind == LibraryItemKind::Bookmark && has_web_source(item) {
        let host = item.site.clone().unwrap_or_else(|| safe_host(&item.url));
        return GroupTilePreview::Site {
            host: host.into(),
            icon: None,
        };
    }
    if item.kind == LibraryItemKind::Scrap {
        let text = item.text.clone().unwrap_or_else(|| item.title.clone());
        return GroupTilePreview::Quote { text: text.into() };
    }
    GroupTilePreview::Document
}

/// The ⋯ menu of a tile: open, rename, ungroup.
fn tile_menu(
    ctx: &ManageCtx,
    page: &Entity<LibraryPage>,
    group: &LibraryGroup,
    cx: &App,
) -> AnyElement {
    let words = get(cx);
    let (open_ctx, open_id) = (ctx.clone(), SharedString::from(group.id.clone()));
    let kind = group.kind;
    let (rename, ungroup) = (page.clone(), page.clone());
    let (named, loose) = (group.clone(), group.clone());
    OverflowActionMenu::new(format!("library-group-{}-menu", group.id), words.more)
        .item(
            OverflowItem::new(words.open)
                .icon(Icon::FolderOpen)
                .on_select(move |_, cx| {
                    open_library(&open_ctx, Some(kind), Some(open_id.clone()), cx);
                }),
        )
        .item(
            OverflowItem::new(words.rename)
                .icon(Icon::PencilLine)
                .on_select(move |_, cx| {
                    let group = named.clone();
                    rename.update(cx, |_, cx| {
                        LibraryPage::dialog(LibraryDialog::RenameGroup(group), cx);
                    });
                }),
        )
        .item(
            OverflowItem::new(words.groups(kind).ungroup)
                .icon(Icon::X)
                .destructive()
                .on_select(move |_, cx| {
                    let group = loose.clone();
                    ungroup.update(cx, |_, cx| {
                        LibraryPage::dialog(LibraryDialog::Ungroup(group), cx);
                    });
                }),
        )
        .into_any_element()
}

impl LibraryPage {
    /// `GroupTiles`
    pub(crate) fn group_tiles(
        &self,
        kind: LibraryKind,
        groups: &[LibraryGroup],
        limit: usize,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let words = get(cx);
        let over = groups.len() > limit;
        let shown = if over {
            &groups[..limit.saturating_sub(1)]
        } else {
            groups
        };
        let page = cx.entity();
        let mut tiles: Vec<AnyElement> = shown
            .iter()
            .map(|group| {
                let date = (!group.recent.is_empty())
                    .then(|| locale_date(&group.updated_at, words.lang()))
                    .flatten();
                let meta = [Some((words.groups(kind).count)(group.count)), date]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" · ");
                let previews: Vec<GroupTilePreview> =
                    group.recent.iter().map(|item| preview(item, cx)).collect();
                let (ctx, id) = (self.ctx.clone(), SharedString::from(group.id.clone()));
                let tile = GroupTile::new(
                    SharedString::from(format!("library-group-{}", group.id)),
                    group.name.clone(),
                    previews,
                    words.empty,
                )
                .label((words.tile_label)(&group.name, &meta))
                .meta(meta)
                .menu(tile_menu(&self.ctx, &page, group, cx))
                .on_open(move |_, _, cx| open_library(&ctx, Some(kind), Some(id.clone()), cx))
                .drop_id(group.id.clone())
                .drop(self.drop_over(&group.id, cx))
                .drop_hint(SharedString::from((words.drop_add)(&group.name)));
                group_target(&page, format!("library-tile-drop-{}", group.id), group)
                    .child(tile)
                    .into_any_element()
            })
            .collect();
        if over {
            let left = groups.len() - shown.len();
            let ctx = self.ctx.clone();
            tiles.push(
                GroupTileMore::new("library-group-more", left, (words.groups(kind).more)(left))
                    .meta(words.view_all)
                    .on_open(move |_, _, cx| open_library(&ctx, Some(kind), None, cx))
                    .into_any_element(),
            );
        }
        tiles
    }
}
