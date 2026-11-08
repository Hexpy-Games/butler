//! `usePatterns` and `PatternsSection`: the habits Butler noticed, each deletable after a
//! confirmation, and the proactive fields ([`super::fields`]).
use butler_ds::ui::blocks::empty_line::EmptyLine;
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::button::{Button, Size as ButtonSize, Variant};
use butler_ds::ui::context::Lang;
use butler_ds::ui::expandable_text::ExpandableText;
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Cross, MinWidth, Space, Stack, StackItem, WithItem as _};
use butler_ds::ui::scroll::{MaxHeight, ScrollArea};
use butler_ds::ui::separator::Separator;
use butler_ds::ui::skeleton::SkeletonRows;
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::toast::Toast;
use butler_ds::ui::typo::{Tone, Typo};
use butler_shell_client::Error;
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _, SharedString};
use serde_json::{Value, json};

use super::copy::{Words, words};
use super::format::pattern_meta;
use super::types::{Pattern, PatternView};
use super::{MemoryPage, lang};
use crate::ui::Icon;
use crate::ui::i18n::settings::words as frame_words;
use crate::ui::settings::confirm::{Detail, Request};
use crate::ui::settings::state::{Load, fetch};

pub(super) struct Patterns {
    view: Load<PatternView>,
    /// The id being deleted.
    deleting: Option<String>,
}

impl Patterns {
    pub(super) fn new() -> Self {
        Self {
            view: Load::Loading,
            deleting: None,
        }
    }
}

impl MemoryPage {
    /// `patterns.reload`: GET /memory/patterns.
    pub(super) fn reload_patterns(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.list_memory_patterns().await },
            |this: &mut Self, result: Result<PatternView, Error>, _| {
                this.patterns.view = match result {
                    Ok(view) => Load::Ready(view),
                    Err(_) => Load::Failed,
                };
            },
        );
    }

    fn ask_delete_pattern(&mut self, item: Pattern, cx: &mut Context<Self>) {
        if self.patterns.deleting.is_some() {
            return;
        }
        let Load::Ready(view) = &self.patterns.view else {
            return;
        };
        let revision = view.revision;
        let copy = words(lang(cx));
        let request = Request::new(copy.delete_pattern_body)
            .title(copy.delete_pattern_title)
            .confirm_label(copy.delete)
            .destructive()
            .detail(Detail {
                label: None,
                text: item.title.clone().into(),
                caption: None,
            });
        let page = cx.weak_entity();
        self.ctx.confirm(
            request,
            move |_, cx| {
                let _ = page.update(cx, |this, cx| this.delete_pattern(item.id, revision, cx));
            },
            cx,
        );
    }

    fn delete_pattern(&mut self, id: String, revision: u64, cx: &mut Context<Self>) {
        self.patterns.deleting = Some(id.clone());
        let body = json!({ "expected_revision": revision });
        fetch(
            cx,
            move |client| async move { client.delete_memory_pattern(&id, &body).await },
            |this: &mut Self, result: Result<Value, Error>, cx| {
                this.patterns.deleting = None;
                let copy = words(lang(cx));
                match result {
                    Ok(_) => {
                        Self::reload_patterns(cx);
                        this.notify("pattern", Toast::success(copy.pattern_deleted), cx);
                    }
                    Err(error) => {
                        if matches!(error, Error::Http(409)) {
                            Self::reload_patterns(cx);
                        }
                        this.notify("pattern", Toast::error(copy.delete_failed), cx);
                    }
                }
            },
        );
    }

    fn pattern_row(
        &self,
        item: &Pattern,
        copy: &Words,
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let deleting = self.patterns.deleting.as_deref() == Some(item.id.as_str());
        let busy = self.patterns.deleting.is_some();
        let id = |prefix: &str| SharedString::from(format!("{prefix}-{}", item.id));
        let label = if busy {
            format!("{} · {}", copy.delete, copy.deleting)
        } else {
            copy.delete.to_owned()
        };
        let text = ExpandableText::new(id("pattern-text"), item.title.clone())
            .collapsed_lines(1)
            .meta(pattern_meta(item, lang));
        let mut delete = IconButton::new(id("pattern-delete"), label);
        delete = if deleting {
            delete.icon(Spinner::new(id("pattern-spinner")).size(14.))
        } else {
            delete.glyph(Icon::Trash2)
        };
        if busy {
            delete = delete.disabled();
        }
        let target = item.clone();
        let delete = delete.on_click(cx.listener(move |this, _, _, cx| {
            this.ask_delete_pattern(target.clone(), cx);
        }));
        Stack::row()
            .cross(Cross::Start)
            .gap(Space::Md)
            .child(
                StackItem::new()
                    .grow()
                    .min_width(MinWidth::Zero)
                    .child(text),
            )
            .child(delete)
            .into_any_element()
    }

    /// The list, or its loading, error and empty body.
    fn pattern_list(&self, copy: &Words, lang: Lang, cx: &mut Context<Self>) -> AnyElement {
        match &self.patterns.view {
            Load::Loading => SkeletonRows::new("pattern-skeleton")
                .rows(2)
                .into_any_element(),
            Load::Failed => {
                let frame = frame_words(lang);
                Stack::new()
                    .gap(Space::Sm)
                    .child(Typo::caption(frame.state_error).tone(Tone::Secondary))
                    .child(
                        Button::new("pattern-retry")
                            .size(ButtonSize::Sm)
                            .variant(Variant::Outline)
                            .text(frame.state_retry)
                            .on_click(cx.listener(|_, _, _, cx| Self::reload_patterns(cx))),
                    )
                    .into_any_element()
            }
            Load::Ready(view) if view.patterns.is_empty() => {
                EmptyLine::new(copy.patterns_empty).into_any_element()
            }
            Load::Ready(view) => {
                let mut rows: Vec<AnyElement> = Vec::new();
                for (index, item) in view.patterns.iter().enumerate() {
                    if index > 0 {
                        rows.push(Separator::new().space(Space::None).into_any_element());
                    }
                    rows.push(self.pattern_row(item, copy, lang, cx));
                }
                ScrollArea::new("pattern-list")
                    .max_height(MaxHeight::Sm)
                    .child(Stack::new().gap(Space::Md).children(rows))
                    .into_any_element()
            }
        }
    }

    pub(super) fn patterns_section(
        &self,
        copy: &Words,
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let mut section = SettingsSection::new(
            "noticed-patterns",
            SettingsSectionKind::Form,
            copy.titles[1],
        )
        .description(copy.descriptions[1]);
        if self.card("profile").and_then(|card| card.health.consent_on) == Some(false) {
            section = section.child(Typo::caption(copy.profile_building_off).tone(Tone::Secondary));
        }
        section = section.child(self.pattern_list(copy, lang, cx));
        for field in self.proactive_fields(copy, lang, cx) {
            section = section.child(field);
        }
        section
    }
}
