//! `SkillGroup.tsx` and `SkillActions.tsx`.
use butler_ds::ui::blocks::card_list::{CardList, CardListItem};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use gpui::{App, ClickEvent, ParentElement as _, SharedString, Window};

use super::copy::SkillsCopy;
use super::types::Skill;
use crate::ui::Icon;

/// A skills list in its section card; the section owns the title and the empty state.
pub(super) fn skill_group(
    id: &'static str,
    skills: &[Skill],
    max_visible_rows: Option<usize>,
    cx: &App,
) -> CardList {
    let rows = skills.iter().map(|skill| {
        let glyph = if skill.user_invocable {
            Icon::Sparkles
        } else {
            Icon::FileText
        };
        let description = if skill.description.is_empty() {
            &skill.file_path
        } else {
            &skill.description
        };
        let key = format!(
            "{}:{}:{}",
            skill.source,
            skill.project_id.as_deref().unwrap_or("default"),
            skill.name
        );
        CardListItem::new(SharedString::from(key), skill.name.clone())
            .icon(icon(glyph, IconSize::Md, Ds::get(cx)))
            .description(description.clone())
    });
    let list = CardList::new(id).flush().children(rows);
    match max_visible_rows {
        Some(rows) => list.max_visible_rows(rows),
        None => list,
    }
}

/// Section header actions of a skills list: import a zip, create one in a chat.
pub(super) fn skill_actions(
    id: &str,
    copy: &SkillsCopy,
    on_import: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    on_create: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl gpui::IntoElement {
    let outline = |name: &str| {
        Button::new(SharedString::from(format!("{id}-{name}")))
            .size(Size::Sm)
            .variant(Variant::Outline)
    };
    button::container(Size::Sm)
        .child(
            outline("import")
                .text(copy.import_skill)
                .on_click(on_import),
        )
        .child(
            outline("create")
                .text(copy.create_with_chat)
                .on_click(on_create),
        )
}
