//! `SettingsSidebar`: the back row, the search, then the groups, with a hairline before Advanced.
//! A search with a single matching page opens it (`autoOpenedSearchRef`, in
//! [`SettingsView::set_query`]).
use butler_ds::ui::blocks::nav_row::NavRow;
use butler_ds::ui::blocks::settings_nav::{SettingsNav, SettingsNavItem};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Cross, Space, Stack, WindowDrag};
use butler_ds::ui::scroll::ScrollArea;
use butler_ds::ui::separator::{Separator, SeparatorTone};
use butler_ds::ui::text::{Input, InputVariant};
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _, Styled as _, div};

use super::sections::{self, Group, SectionId};
use super::{SettingsEvent, SettingsView};
use crate::ui::Icon;
use crate::ui::i18n::settings::{search_empty, words};

pub(super) fn settings_sidebar(
    active: SectionId,
    query: &str,
    developer: bool,
    cx: &mut Context<SettingsView>,
) -> AnyElement {
    let lang = Ds::get(cx).lang();
    let copy = words(lang);
    let groups = sections::groups(developer, query, lang);
    let header = Stack::row()
        .cross(Cross::Center)
        .window_drag(WindowDrag::Drag)
        .child(
            NavRow::new("settings-back", copy.back)
                .glyph(Icon::ArrowLeft)
                .on_click(cx.listener(|_, _, _, cx| cx.emit(SettingsEvent::Close))),
        );
    let view = cx.entity().downgrade();
    let search = Input::new("settings-navigation-search")
        .variant(InputVariant::Quiet)
        .placeholder(copy.search_placeholder)
        .value(query.to_owned())
        .on_change(move |text, window, cx| {
            let _ = view.update(cx, |this, cx| this.set_query(text.to_owned(), window, cx));
        });
    let trimmed = query.trim();
    let empty = (!trimmed.is_empty() && groups.is_empty())
        .then(|| Typo::caption(search_empty(lang, trimmed)));
    let mut list = Stack::new().gap(Space::Lg);
    for (index, (group, ids)) in groups.into_iter().enumerate() {
        // A hairline sets the Advanced group apart from everyday settings.
        if group == Group::Advanced && index > 0 {
            list = list.child(
                Separator::new()
                    .space(Space::None)
                    .tone(SeparatorTone::Muted),
            );
        }
        let items: Vec<SettingsNavItem> = ids
            .into_iter()
            .map(|id| {
                SettingsNavItem::new(id.id(), id.copy(lang).label)
                    .glyph(id.icon())
                    .active(id == active)
                    .probe(format!("settings-nav-{}", id.id()))
                    .on_select(cx.listener(move |this, _, window, cx| this.show(id, window, cx)))
            })
            .collect();
        list = list.child(
            SettingsNav::new(format!("settings-nav-{}", group.id()))
                .title(group.label(lang))
                .items(items),
        );
    }
    Stack::new()
        .fill()
        .gap(Space::Md)
        .child(header)
        .child(Stack::new().gap(Space::None).child(search))
        .children(empty)
        .child(
            // The scroll port, named for the harness: a click centres its row in it first, as
            // Electron's `scrollIntoView({block: "center"})` does.
            crate::ui::widgets::anchor(div(), "settings-nav-scroll")
                .flex()
                .flex_col()
                .flex_1()
                .min_h_0()
                .child(
                    ScrollArea::new("settings-navigation-scroll")
                        .fill()
                        .child(list),
                ),
        )
        .into_any_element()
}
