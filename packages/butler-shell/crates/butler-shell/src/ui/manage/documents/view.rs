//! `DocumentPage.tsx` and `DocumentLayout`: one title row (the host's `leading` before the
//! title, its `trailing` after the actions), the status note, then the body.
use butler_ds::ui::blocks::document_editor::DocumentEditor;
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Cross, MinWidth, Space, Stack, WithItem as _};
use butler_ds::ui::overlay::place::Align;
use butler_ds::ui::popover::{Popover, PopoverContent};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, ParentElement as _, Render,
    SharedString, Styled as _, Window, div,
};

use super::DocumentPage;
use super::copy::words;
use super::read_view::read_view;

/// `DocumentLayout`: the editor chrome around a heading.
fn layout(
    title: SharedString,
    leading: Option<AnyElement>,
    trailing: Option<AnyElement>,
) -> DocumentEditor {
    let heading = Typo::panel_title(title).tone(Tone::Primary).truncate();
    let title = match leading {
        None => heading.into_any_element(),
        Some(leading) => Stack::row()
            .cross(Cross::Center)
            .gap(Space::Md)
            .wrap(false)
            .child(leading)
            .child(
                Stack::new()
                    .gap(Space::None)
                    .grow()
                    .min_width(MinWidth::Zero)
                    .child(heading),
            )
            .into_any_element(),
    };
    let editor = DocumentEditor::new("document-editor").title(title);
    match trailing {
        Some(controls) => editor.controls(controls),
        None => editor,
    }
}

impl Render for DocumentPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let words = words(Ds::get(cx).lang());
        let (leading, trailing) = (self.leading.take(), self.trailing.take());
        let page = cx.entity().downgrade();
        let popover = Popover::new(
            SharedString::from(format!("document-versions-{}", self.id)),
            window,
            cx,
        )
        .open(self.history_open)
        .on_open_change(move |open, _, cx| {
            let _ = page.update(cx, |this, cx| this.set_history_open(open, cx));
        });
        let Some(head) = self.head.as_ref() else {
            let text = if self.failed {
                words.failed
            } else {
                words.loading
            };
            return crate::ui::widgets::anchor(
                div().id("editable-document").w_full(),
                "editable-document",
            )
            .child(
                layout(SharedString::default(), leading, trailing)
                    .child(Typo::caption(text).tone(Tone::Secondary)),
            )
            .into_any_element();
        };
        let note = if self.editing {
            words.editing
        } else {
            words.saved
        };
        let (actions, items) = self.actions(&popover, window, cx);
        let shown = self.shown().unwrap_or(head);
        let editor = layout(head.title.clone().into(), leading, trailing)
            .note(Typo::caption(note).tone(Tone::Secondary))
            .actions(actions)
            .menu_actions(items)
            .menu_label(words.more_actions)
            .child(read_view(shown, cx));
        let versions = self.versions(head.rev, cx);
        let content = popover.content(
            PopoverContent::new().align(Align::End).child(versions),
            window,
            cx,
        );
        crate::ui::widgets::anchor(div().id("editable-document").w_full(), "editable-document")
            .child(editor)
            .child(content)
            .into_any_element()
    }
}
