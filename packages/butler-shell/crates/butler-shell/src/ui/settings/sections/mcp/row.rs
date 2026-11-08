//! `McpServerRow.tsx`: a server's card row with test, enable, edit and delete. The buttons'
//! aria labels have no gpui slot.
use butler_ds::ui::blocks::card_list::CardListItem;
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::switch::Switch;
use butler_ds::ui::typo::Typo;
use gpui::prelude::FluentBuilder as _;
use gpui::{Context, ParentElement as _, SharedString};

use super::form::Server;
use super::{McpPage, Words};
use crate::ui::Icon;

impl McpPage {
    pub(super) fn server_row(
        &self,
        server: &Server,
        w: &'static Words,
        cx: &mut Context<Self>,
    ) -> CardListItem {
        let id = server.id.clone();
        let busy = self.busy;
        // CARVE-OUT(G-card): React shows the review note and the subtitle as two caption lines;
        // CardListItem has one truncating description line, so they share it.
        let description = if server.tool_filter_review_required {
            format!("{} · {}", w.tool_filter_review, server.subtitle())
        } else {
            server.subtitle()
        };
        let meta = if server.needs_secret() {
            w.needs_secret
        } else if server.enabled {
            w.enabled_meta
        } else {
            w.disabled_meta
        };
        let outline = |kind: &str| {
            Button::new(SharedString::from(format!("mcp-{kind}-{id}")))
                .size(Size::Xs)
                .variant(Variant::Outline)
                .when(busy, Button::disabled)
        };
        let glyph = |glyph| icon(glyph, IconSize::Sm, Ds::get(cx));
        let probe = {
            let id = id.clone();
            outline("probe")
                .child(glyph(Icon::RefreshCcw))
                .on_click(cx.listener(move |this, _, _, cx| this.probe(&id, cx)))
        };
        let toggle = {
            let id = id.clone();
            Switch::new(SharedString::from(format!("mcp-toggle-{id}")))
                .checked(server.enabled)
                .when(busy, Switch::disabled)
                .on_checked_change(cx.processor(move |this, _: bool, _, cx| this.toggle(&id, cx)))
        };
        let edit = {
            let id = id.clone();
            outline("edit")
                .child(glyph(Icon::PencilLine))
                .on_click(cx.listener(move |this, _, _, cx| this.edit(&id, cx)))
        };
        let remove = {
            let id = id.clone();
            outline("remove")
                .child(glyph(Icon::Trash2))
                .on_click(cx.listener(move |this, _, _, cx| this.remove(&id, cx)))
        };
        let actions = button::container(Size::Xs)
            .child(probe)
            .child(toggle)
            .child(edit)
            .child(remove);
        CardListItem::new(
            SharedString::from(format!("mcp-server-{id}")),
            server.display_name.clone(),
        )
        .description(description)
        .meta(Typo::caption(meta))
        .actions(actions)
    }
}
