//! DS TagField (TagField.tsx / TagField.module.css): tags as removable chips inside one field,
//! with completion from existing tags under it and a row that creates a new one. Enter or a comma
//! adds the highlighted row; Backspace on an empty field removes the last chip; Escape clears the
//! typed text; Up and Down move the highlight. Controlled: the owner holds the tags.
//! Items are removed with the chip's x, as in React: no menu, no pencil.
use std::collections::HashSet;
use std::rc::Rc;

use gpui::{
    App, ElementId, Entity, EntityInputHandler as _, FocusHandle, Focusable as _,
    InteractiveElement as _, IntoElement, ParentElement as _, RenderOnce, SharedString,
    Styled as _, Window, div,
};
use gpui_elements::editable_text::EditableTextState;

use crate::tokens::Length;
use crate::ui::context::Ds;
use crate::ui::tag::{Size as TagSize, Tag};
use crate::ui::text;

type Changed = Rc<dyn Fn(Vec<SharedString>, &mut Window, &mut App)>;
type Labeler = Rc<dyn Fn(&str) -> SharedString>;

/// An existing tag; `count` is how many items carry it (shown at the end of its row).
#[derive(Clone)]
pub struct Suggestion {
    name: SharedString,
    count: Option<u32>,
}

impl Suggestion {
    pub fn new(name: impl Into<SharedString>) -> Self {
        Self {
            name: name.into(),
            count: None,
        }
    }

    pub fn count(mut self, count: u32) -> Self {
        self.count = Some(count);
        self
    }
}

/// Case and surrounding space do not split tags. (React also folds width and compatibility
/// forms, NFKC; the crate has no normalization dependency, so that part is not ported.)
pub fn tag_key(name: &str) -> String {
    name.trim().to_lowercase()
}

/// Prefix matches first, then matches inside the name; each by count. At most six.
pub fn match_tags(
    query: &str,
    suggestions: &[Suggestion],
    chosen: &[SharedString],
) -> Vec<Suggestion> {
    let key = tag_key(query);
    if key.is_empty() {
        return Vec::new();
    }
    let taken: HashSet<String> = chosen.iter().map(|name| tag_key(name)).collect();
    let mut found: Vec<(bool, &Suggestion)> = suggestions
        .iter()
        .filter_map(|s| {
            let name = tag_key(&s.name);
            (!taken.contains(&name) && name.contains(&key)).then(|| (name.starts_with(&key), s))
        })
        .collect();
    found.sort_by(|(pa, a), (pb, b)| {
        pb.cmp(pa)
            .then(b.count.unwrap_or(0).cmp(&a.count.unwrap_or(0)))
            .then_with(|| a.name.cmp(&b.name))
    });
    found.into_iter().take(6).map(|(_, s)| s.clone()).collect()
}

/// A completion row: an existing tag, or the row that creates the typed one.
struct Row {
    name: SharedString,
    count: Option<u32>,
    create: bool,
}

/// What the handlers need: the owner's tags and callback, and the field's own state.
struct Ctx {
    value: Vec<SharedString>,
    on_change: Changed,
    suggestions: Vec<Suggestion>,
    max_length: usize,
    text: Entity<EditableTextState>,
    active: Entity<usize>,
    handle: FocusHandle,
}

impl Ctx {
    /// The typed text (trimmed, capped) and the rows under the field for `query`.
    fn plan(&self, query: &str) -> (String, Vec<Row>) {
        let typed: String = query.trim().chars().take(self.max_length).collect();
        let matches = match_tags(&typed, &self.suggestions, &self.value);
        let key = tag_key(&typed);
        let exact = matches.iter().any(|s| tag_key(&s.name) == key)
            || self.value.iter().any(|v| tag_key(v) == key);
        let mut rows: Vec<Row> = matches
            .into_iter()
            .map(|s| Row {
                name: s.name,
                count: s.count,
                create: false,
            })
            .collect();
        if !typed.is_empty() && !exact {
            rows.push(Row {
                name: typed.clone().into(),
                count: None,
                create: true,
            });
        }
        (typed, rows)
    }

    fn query(&self, cx: &App) -> String {
        self.text.read(cx).as_str().to_owned()
    }

    /// The IME has marked text in the field: Enter and a comma belong to the composition.
    fn composing(&self, window: &mut Window, cx: &mut App) -> bool {
        self.text.update(cx, |input, cx| {
            input.marked_text_range(window, cx).is_some()
        })
    }

    fn clear(&self, cx: &mut App) {
        self.text.update(cx, |text, cx| text.emplace("", cx));
        self.active.update(cx, |active, cx| {
            *active = 0;
            cx.notify();
        });
    }

    fn add(&self, name: &str, window: &mut Window, cx: &mut App) {
        let key = tag_key(name);
        if !name.is_empty() && !self.value.iter().any(|v| tag_key(v) == key) {
            let mut next = self.value.clone();
            next.push(name.to_owned().into());
            (self.on_change)(next, window, cx);
        }
        self.clear(cx);
    }

    /// Enter or a comma: the highlighted row, or the typed text.
    fn commit(&self, query: &str, window: &mut Window, cx: &mut App) {
        let (typed, rows) = self.plan(query);
        let active = *self.active.read(cx);
        let name = rows.get(active).map_or(typed, |row| row.name.to_string());
        self.add(&name, window, cx);
    }

    /// Up or Down, wrapping.
    fn step(&self, up: bool, cx: &mut App) {
        let (_, rows) = self.plan(&self.query(cx));
        let len = rows.len();
        if len == 0 {
            return;
        }
        let delta = if up { len - 1 } else { 1 };
        self.active.update(cx, |active, cx| {
            *active = (*active + len + delta) % len;
            cx.notify();
        });
    }

    fn remove_last(&self, window: &mut Window, cx: &mut App) {
        let mut next = self.value.clone();
        next.pop();
        (self.on_change)(next, window, cx);
    }

    /// The typed text changed: a comma or newline commits it, the cap clips it, and the
    /// highlight returns to the first row.
    fn typed(&self, text: &str, window: &mut Window, cx: &mut App) {
        if text.contains([',', '\n']) && !self.composing(window, cx) {
            let clean: String = text.chars().filter(|c| !matches!(c, ',' | '\n')).collect();
            self.commit(&clean, window, cx);
            return;
        }
        let clipped: String = text.chars().take(self.max_length).collect();
        if clipped != text {
            self.text
                .update(cx, |state, cx| state.emplace(&clipped, cx));
        }
        self.active.update(cx, |active, cx| {
            *active = 0;
            cx.notify();
        });
    }
}

#[derive(IntoElement)]
pub struct TagField {
    id: ElementId,
    label: SharedString,
    value: Vec<SharedString>,
    on_change: Changed,
    suggestions: Vec<Suggestion>,
    placeholder: Option<SharedString>,
    remove_label: Labeler,
    create_label: Labeler,
    max_length: usize,
    auto_focus: bool,
}

impl TagField {
    /// `label` is the field's accessible name ("Tags"); gpui draws none of it.
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            value: Vec::new(),
            on_change: Rc::new(|_, _, _| {}),
            suggestions: Vec::new(),
            placeholder: None,
            remove_label: Rc::new(|name| name.to_owned().into()),
            create_label: Rc::new(|name| name.to_owned().into()),
            max_length: 40,
            auto_focus: false,
        }
    }

    pub fn label(&self) -> &SharedString {
        &self.label
    }

    /// The chosen tags (controlled) and the callback with the next list.
    pub fn value(
        mut self,
        value: Vec<SharedString>,
        on_change: impl Fn(Vec<SharedString>, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.value = value;
        self.on_change = Rc::new(on_change);
        self
    }

    /// Existing tags; the field matches them against what is typed.
    pub fn suggestions(mut self, suggestions: Vec<Suggestion>) -> Self {
        self.suggestions = suggestions;
        self
    }

    pub fn placeholder(mut self, placeholder: impl Into<SharedString>) -> Self {
        self.placeholder = Some(placeholder.into());
        self
    }

    /// A chip's remove button name ("Remove ca").
    pub fn remove_label(mut self, label: impl Fn(&str) -> SharedString + 'static) -> Self {
        self.remove_label = Rc::new(label);
        self
    }

    /// The row that adds a new tag ("Create tag “ca”").
    pub fn create_label(mut self, label: impl Fn(&str) -> SharedString + 'static) -> Self {
        self.create_label = Rc::new(label);
        self
    }

    pub fn max_length(mut self, max_length: usize) -> Self {
        self.max_length = max_length;
        self
    }

    pub fn auto_focus(mut self) -> Self {
        self.auto_focus = true;
        self
    }
}

mod parts;
use parts::option;

impl RenderOnce for TagField {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let input_id: ElementId = (self.id.clone(), "input").into();
        let text = text::state(input_id.clone(), window, cx);
        let handle = text.read(cx).focus_handle(cx);
        let active = window.use_keyed_state((self.id.clone(), "active"), cx, |_, _| 0usize);
        if self.auto_focus {
            let once = window.use_keyed_state((self.id.clone(), "auto-focus"), cx, |_, _| false);
            if !*once.read(cx) {
                once.update(cx, |once, _| *once = true);
                handle.focus(window, cx);
            }
        }
        let ctx = Rc::new(Ctx {
            value: self.value,
            on_change: self.on_change,
            suggestions: self.suggestions,
            max_length: self.max_length,
            text,
            active,
            handle,
        });
        let (_, rows) = ctx.plan(&ctx.query(cx));
        let current = (*ctx.active.read(cx)).min(rows.len().saturating_sub(1));
        let ds = Ds::get(cx);
        let tags = ctx.value.iter().map(|name| {
            let (remove, owner, key) = (ctx.clone(), ctx.clone(), name.clone());
            Tag::new(
                (self.id.clone(), SharedString::from(format!("tag-{name}"))),
                name.clone(),
            )
            .size(TagSize::Sm)
            .on_remove((self.remove_label)(&name[..]), move |_, window, cx| {
                let next = owner.value.iter().filter(|v| **v != key).cloned().collect();
                (remove.on_change)(next, window, cx);
            })
        });
        let tags: Vec<Tag> = tags.collect();
        let field = parts::field(input_id, self.placeholder, tags, &ctx, window, ds);
        let list = (!rows.is_empty()).then(|| {
            let items = rows.into_iter().enumerate().map(|(index, row)| {
                option(
                    &self.id,
                    index,
                    row,
                    index == current,
                    &self.create_label,
                    &ctx,
                    ds,
                )
            });
            div().flex().flex_col().children(items)
        });
        div()
            .id(self.id.clone())
            .flex()
            .flex_col()
            .min_w_0()
            .gap(ds.len(Length::SpaceXs))
            .child(field)
            .children(list)
    }
}
