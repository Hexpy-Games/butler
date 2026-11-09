//! `AutomationActions.tsx`: Back, the breadcrumb, the "more" menu (run now, pause or resume,
//! delete) and Save.
use butler_ds::ui::blocks::breadcrumb::{
    Breadcrumb, BreadcrumbButton, BreadcrumbItem, BreadcrumbList, BreadcrumbPage,
    BreadcrumbSeparator,
};
use butler_ds::ui::button::{self, Button, Size};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dropdown_menu::{DropdownMenu, DropdownMenuContent, Item, Variant};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Cross, Justify, MinWidth, Space, Stack, StackItem, WithItem as _};
use butler_ds::ui::tooltip::Align;
use gpui::{
    AnyElement, App, ClickEvent, Context, IntoElement as _, ParentElement as _, SharedString,
    Styled as _, Window, div,
};

use super::copy::Words;
use super::flow::Mutation;
use super::{AutomationDetail, on_press};
use crate::ui::Icon;
use crate::ui::widgets::anchor;

/// The Back handler shared by the breadcrumb and the arrow button.
fn back_press(
    cx: &Context<AutomationDetail>,
) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
    on_press(cx, |this, _, cx| {
        let on_back = this.on_back.clone();
        this.run_action(&on_back, cx);
    })
}

impl AutomationDetail {
    pub(super) fn actions(
        &self,
        words: &Words,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let title: SharedString = if self.is_new {
            words.new_title.into()
        } else if self.form.title.is_empty() {
            words.detail_fallback.into()
        } else {
            self.form.title.clone().into()
        };
        let trail = BreadcrumbList::new()
            .child(
                BreadcrumbItem::new().child(
                    BreadcrumbButton::new("automation-crumb-list")
                        .child(words.title)
                        .on_click(back_press(cx)),
                ),
            )
            .child(BreadcrumbSeparator::new())
            .child(BreadcrumbItem::new().child(BreadcrumbPage::new().child(title)));
        let leading = Stack::row()
            .cross(Cross::Center)
            .gap(Space::Sm)
            .child(
                IconButton::new("automation-back", words.back_label)
                    .glyph(Icon::ArrowLeft)
                    .on_click(back_press(cx)),
            )
            .child(
                StackItem::new()
                    .grow()
                    .min_width(MinWidth::Zero)
                    .child(Breadcrumb::new(words.breadcrumb).child(trail)),
            );
        let mut buttons = button::container(Size::Sm);
        if !self.is_new {
            buttons = buttons.child(self.more_menu(words, window, cx));
        }
        let save = Button::new("automation-save")
            .size(Size::Sm)
            .icon_start(icon(Icon::Save, IconSize::Sm, Ds::get(cx)))
            .text(words.save)
            .on_click(on_press(cx, |this, _, cx| this.save(cx)));
        let save = if self.saving { save.disabled() } else { save };
        let bar = Stack::row()
            .justify(Justify::Between)
            .cross(Cross::Center)
            .gap(Space::Md)
            .child(
                StackItem::new()
                    .grow()
                    .min_width(MinWidth::Zero)
                    .child(leading),
            )
            .child(buttons.child(save));
        anchor(div().child(bar), "automation-detail-titlebar").into_any_element()
    }

    /// The ⋯ menu of a saved schedule.
    fn more_menu(&self, words: &Words, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let menu = DropdownMenu::new("automation-more-menu", window, cx);
        let trigger = menu.trigger(|toggle| {
            IconButton::new("automation-more", words.more)
                .glyph(Icon::MoreHorizontal)
                .on_click(toggle.on_click())
                .into_any_element()
        });
        let this = cx.entity().downgrade();
        let run = move |mutation: Mutation| {
            let this = this.clone();
            move |_: &mut Window, cx: &mut App| {
                let _ = this.update(cx, |this, cx| this.mutate(mutation, cx));
            }
        };
        let (label, glyph, mutation) = if self.form.state == "paused" {
            (words.resume, Icon::RotateCcw, Mutation::Resume)
        } else {
            (words.pause, Icon::Clock3, Mutation::Pause)
        };
        let ask = {
            let this = cx.entity().downgrade();
            move |_: &mut Window, cx: &mut App| {
                let _ = this.update(cx, |this, cx| {
                    this.confirm_delete = true;
                    cx.notify();
                });
            }
        };
        // CARVE-OUT(G-ds): developer mode adds "Latest run logs" (`openLogTrace({ turnId })` for
        // the newest run with a turn); the Logs trace page has no seam to open from outside Settings.
        let content = DropdownMenuContent::new()
            .align(Align::End)
            .child(
                Item::new(words.run_now)
                    .icon(Icon::Play)
                    .on_select(run(Mutation::Run)),
            )
            .child(Item::new(label).icon(glyph).on_select(run(mutation)))
            .separator()
            .child(
                Item::new(words.delete)
                    .icon(Icon::Trash2)
                    .variant(Variant::Destructive)
                    .on_select(ask),
            );
        div()
            .flex()
            .child(trigger)
            .child(menu.content(content, window, cx))
            .into_any_element()
    }
}
