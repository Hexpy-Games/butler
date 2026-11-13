//! `useCanonTagEditor.tsx`: shared tag creation and management.
use gpui::AppContext as _;
use gpui::{AnyWindowHandle, Context, Entity, EventEmitter, SharedString, Subscription, Window};

use super::CanonTags;
use super::manage::{TagAction, TagManage, TagManageEvent};
use crate::ui::source::wire::{CanonTag, CanonTagColor, CanonTagCreateInput};

pub(super) enum TagEditorEvent {
    Created(CanonTag),
    Deleted(SharedString),
}

/// Tag create and rename/recolor/delete for every tag picker; each picker decides what a created
/// or deleted tag does to its own selection.
pub(crate) struct TagEditor {
    tags: Entity<CanonTags>,
    busy: bool,
    manage: Option<(Entity<TagManage>, Subscription)>,
}

impl EventEmitter<TagEditorEvent> for TagEditor {}

impl TagEditor {
    pub(super) fn new(tags: Entity<CanonTags>) -> Self {
        Self {
            tags,
            busy: false,
            manage: None,
        }
    }

    pub(super) fn busy(&self) -> bool {
        self.busy
    }

    pub(super) fn dialog(&self) -> Option<Entity<TagManage>> {
        self.manage.as_ref().map(|(dialog, _)| dialog.clone())
    }

    /// `useCanonTagEditor.create`: a new tag starts blue and opens its colour swatches;
    /// every successful create hands the tag to the picker.
    pub(super) fn create(
        &mut self,
        name: &SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.busy {
            return;
        }
        self.busy = true;
        cx.notify();
        let (me, handle): (_, AnyWindowHandle) = (cx.entity().downgrade(), window.window_handle());
        let input = CanonTagCreateInput {
            name: name.to_string(),
            color: CanonTagColor::Blue,
        };
        self.tags.update(cx, |tags, cx| {
            tags.create(
                input,
                Box::new(move |tag, cx| {
                    let _ = handle.update(cx, |_, window, cx| {
                        let _ = me.update(cx, |this, cx| this.created(tag, window, cx));
                    });
                }),
                cx,
            );
        });
    }

    /// The create answered. A tag the list did not hold yet is new (the list is read again
    /// after a create, so it is not in it before that read lands).
    fn created(&mut self, tag: Option<CanonTag>, window: &mut Window, cx: &mut Context<Self>) {
        self.busy = false;
        cx.notify();
        let Some(tag) = tag else { return };
        let new = !self
            .tags
            .read(cx)
            .tags()
            .iter()
            .any(|item| item.tag.id == tag.tag.id);
        cx.emit(TagEditorEvent::Created(tag.clone()));
        if new {
            self.open(tag, TagAction::Color, window, cx);
        }
    }

    pub(super) fn open(
        &mut self,
        tag: CanonTag,
        action: TagAction,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let tags = self.tags.clone();
        let dialog = cx.new(|cx| TagManage::new(tags, tag, action, cx));
        let subscription = cx.subscribe(&dialog, |this, _, event, cx| {
            match event {
                TagManageEvent::Closed => this.manage = None,
                TagManageEvent::Deleted(id) => cx.emit(TagEditorEvent::Deleted(id.clone())),
            }
            cx.notify();
        });
        self.manage = Some((dialog, subscription));
        cx.notify();
    }
}
