//! `library/LibraryMain.tsx`: the 서랍 main screen. Per kind, group tiles and ungrouped items
//! (scraps, bookmarks) or the latest row, each with "View all"; plus the card, its reads and its
//! copy.
pub(crate) mod card;
pub(crate) mod copy;
pub(crate) mod data;
pub(crate) mod media;
pub(crate) mod open;
mod section;
pub(crate) mod tiles;

use butler_ds::ui::blocks::measure;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::layout::{Columns, Preset, Responsive, Space, Stack};
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _, Styled as _, Window, div};

use self::copy::Words;
use self::data::KINDS;
use super::LibraryPage;
use crate::ui::manage::{LibraryView, ManageCtx};

/// `CARD_COLUMNS`: 2 on a phone page, 3, and 4 from 48rem.
pub(crate) const CARD_COLUMNS: Columns = Columns::Responsive(Responsive {
    compact: Some(2),
    base: Preset::Fixed(3),
    wide: Some(Preset::Fixed(4)),
});

/// `useCardColumns`: the card grid's column count at the page's width (rem is 16px).
fn card_columns(width: f32) -> usize {
    if width <= 0. {
        4
    } else if width < 36. * 16. {
        2
    } else if width < 48. * 16. {
        3
    } else {
        4
    }
}

/// The empty bookmark list's way in: import from another browser.
pub(crate) fn import_button(ctx: &ManageCtx, words: &Words) -> Button {
    let ctx = ctx.clone();
    Button::new("library-import")
        .size(Size::Sm)
        .variant(Variant::Ghost)
        .text(words.browser_import)
        .on_click(move |_, _, cx| ctx.open_settings("browser-import", cx))
}

impl LibraryPage {
    /// `LibraryMain`
    pub(crate) fn main_screen(
        &self,
        view: &LibraryView,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (size, recorder) = measure::track("library-main", window, cx);
        let columns = card_columns(f32::from(size.width));
        let sections: Vec<AnyElement> = KINDS
            .iter()
            .map(|kind| self.main_section(*kind, columns, view, cx))
            .collect();
        div()
            .relative()
            .w_full()
            .child(recorder)
            .child(Stack::new().gap(Space::Xl).children(sections))
            .into_any_element()
    }
}
