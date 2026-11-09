//! `useCanonTags.ts`, `CanonTagList.tsx` and `canonFeedback.ts`' `canonWriteFailure`.
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::tag::{LabelTone, Size, Tag, Tone};
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::Error;
use gpui::{
    AnyElement, App, Context, Entity, IntoElement as _, ParentElement as _, SharedString,
    Subscription, div,
};

use super::copy::words;
use super::{RemoveTag, TagCreated};
use crate::ui::manage::{ManageLive, Topic};
use crate::ui::source::fetch::{fetch, fetch_if};
use crate::ui::source::wire::{CanonTag, CanonTagColor, CanonTagCreateInput, EpicTag};
use crate::ui::widgets::anchor;

/// A tag's colour as the DS label tone (an unknown colour reads gray).
pub(super) fn label_tone(color: CanonTagColor) -> LabelTone {
    match color {
        CanonTagColor::Gray | CanonTagColor::Unknown => LabelTone::Gray,
        CanonTagColor::Red => LabelTone::Red,
        CanonTagColor::Orange => LabelTone::Orange,
        CanonTagColor::Yellow => LabelTone::Yellow,
        CanonTagColor::Green => LabelTone::Green,
        CanonTagColor::Teal => LabelTone::Teal,
        CanonTagColor::Blue => LabelTone::Blue,
        CanonTagColor::Purple => LabelTone::Purple,
    }
}

/// A DS label tone as the tag colour that is stored.
pub(super) fn tag_color(tone: LabelTone) -> CanonTagColor {
    match tone {
        LabelTone::Gray => CanonTagColor::Gray,
        LabelTone::Red => CanonTagColor::Red,
        LabelTone::Orange => CanonTagColor::Orange,
        LabelTone::Yellow => CanonTagColor::Yellow,
        LabelTone::Green => CanonTagColor::Green,
        LabelTone::Teal => CanonTagColor::Teal,
        LabelTone::Blue => CanonTagColor::Blue,
        LabelTone::Purple => CanonTagColor::Purple,
    }
}

/// `<Tag size="sm" tone={tag.color}>{tag.name}</Tag>`
pub(super) fn chip(tag: &EpicTag) -> Tag {
    Tag::new(
        SharedString::from(format!("canon-tag-{}", tag.id)),
        tag.name.clone(),
    )
    .size(Size::Sm)
    .tone(Tone::Label(label_tone(tag.color)))
}

/// `canonWriteFailure` without codes (G-codes): a 409 is the conflict (true: the caller reads
/// again), anything else React's fallback copy.
pub(super) fn write_failure(error: &Error, cx: &mut App) -> bool {
    let copy = words(Ds::get(cx).lang());
    let conflict = matches!(error, Error::Http(409));
    let text = if conflict {
        copy.conflict
    } else {
        copy.request_failed
    };
    toast::show(cx, Toast::error(text));
    conflict
}

/// `notifyError(error, appCopy.interfaceFeedback.requestFailed)`
fn request_failed(cx: &mut App) {
    toast::show(cx, Toast::error(words(Ds::get(cx).lang()).request_failed));
}

/// `CanonTagList`
pub(crate) fn tag_list(
    tags: &[EpicTag],
    limit: Option<usize>,
    on_remove: Option<&RemoveTag>,
    cx: &App,
) -> AnyElement {
    if tags.is_empty() {
        return div().into_any_element();
    }
    let copy = words(Ds::get(cx).lang());
    let limit = limit.filter(|limit| *limit > 0);
    let shown = limit.map_or(tags.len(), |limit| limit.min(tags.len()));
    let mut row = Stack::row().gap(Space::Xs).wrap(true);
    for tag in &tags[..shown] {
        let mut item = chip(tag);
        if let Some(remove) = on_remove {
            let (remove, id) = (remove.clone(), SharedString::from(tag.id.clone()));
            item = item.on_remove((copy.tags.remove_tag)(&tag.name), move |_, window, cx| {
                remove(&id, window, cx);
            });
        }
        row = row.child(item);
    }
    if let Some(limit) = limit
        && tags.len() > limit
    {
        row = row
            .child(Tag::new("canon-tag-more", format!("+{}", tags.len() - limit)).size(Size::Sm));
    }
    anchor(div(), "canon-tags").child(row).into_any_element()
}

/// `useCanonTags`: a project's tags, read again when its canon topic moves.
pub(crate) struct CanonTags {
    project: SharedString,
    tags: Vec<CanonTag>,
    /// The newest read; an older answer is dropped (`epoch`).
    epoch: u64,
    /// The canon topic revision the tags were last read at.
    seen: u64,
    _live: Subscription,
}

impl CanonTags {
    pub(crate) fn new(
        project: SharedString,
        live: &Entity<ManageLive>,
        cx: &mut Context<Self>,
    ) -> Self {
        super::people::warm_person_name(cx);
        let seen = live.read(cx).revision(&Topic::Canon(project.clone()));
        let subscription = cx.observe(live, |this, live, cx| {
            let revision = live.read(cx).revision(&Topic::Canon(this.project.clone()));
            if revision != this.seen {
                this.seen = revision;
                this.refresh(cx);
            }
        });
        let mut tags = Self {
            project,
            tags: Vec::new(),
            epoch: 0,
            seen,
            _live: subscription,
        };
        tags.refresh(cx);
        tags
    }

    pub(crate) fn tags(&self) -> &[CanonTag] {
        &self.tags
    }

    /// `create`: `done` gets the created tag (or the existing one when the name is taken), `None`
    /// on a failure.
    pub(crate) fn create(
        &mut self,
        input: CanonTagCreateInput,
        done: TagCreated,
        cx: &mut Context<Self>,
    ) {
        let Ok(body) = serde_json::to_value(&input) else {
            done(None, cx);
            return;
        };
        let project = self.project.to_string();
        fetch(
            cx,
            move |client| async move { client.create_canon_tag(&project, &body).await },
            move |this, result: Result<CanonTag, Error>, cx| match result {
                Ok(tag) => {
                    this.refresh(cx);
                    done(Some(tag), cx);
                }
                Err(Error::Http(409)) => this.select_existing(&input.name, done, cx),
                Err(error) => {
                    write_failure(&error, cx);
                    done(None, cx);
                }
            },
        );
    }

    /// `tag_exists`: the answer carries no body (G-codes), so the existing tag is found in a
    /// fresh read by its name.
    fn select_existing(&mut self, name: &str, done: TagCreated, cx: &mut Context<Self>) {
        let (project, name) = (self.project.to_string(), name.to_lowercase());
        self.epoch += 1;
        fetch(
            cx,
            move |client| async move { client.get_canon_tags(&project).await },
            move |this, result: Result<Vec<CanonTag>, Error>, cx| match result {
                Ok(tags) => {
                    let existing = tags
                        .iter()
                        .find(|tag| tag.tag.name.to_lowercase() == name)
                        .cloned();
                    this.tags = tags;
                    if existing.is_none() {
                        request_failed(cx);
                    }
                    done(existing, cx);
                }
                Err(_) => {
                    request_failed(cx);
                    done(None, cx);
                }
            },
        );
    }

    /// `refresh`
    pub(crate) fn refresh(&mut self, cx: &mut Context<Self>) {
        self.epoch += 1;
        let (epoch, project) = (self.epoch, self.project.to_string());
        fetch_if(
            cx,
            move |client| async move { client.get_canon_tags(&project).await },
            move |this, result: Result<Vec<CanonTag>, Error>, cx| {
                if this.epoch != epoch {
                    return false;
                }
                match result {
                    Ok(tags) => {
                        let changed = this.tags != tags;
                        this.tags = tags;
                        changed
                    }
                    Err(_) => {
                        request_failed(cx);
                        false
                    }
                }
            },
        );
    }
}
