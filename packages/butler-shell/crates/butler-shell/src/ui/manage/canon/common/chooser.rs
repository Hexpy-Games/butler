//! `CanonTagChooser.tsx`: a popover of the project's tags to choose from, filter by, create and
//! manage.
use gpui::Styled as _;
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::filtered_select_popover::{
    FilteredSelectPopover, FooterOption, Group, Item, Width,
};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dropdown_menu::{
    DropdownMenu, DropdownMenuContent, Item as MenuItem, Variant as MenuVariant,
};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::popover::{Density, MenuSize, Popover, PopoverContent};
use butler_ds::ui::select_button::{SelectButton, Size as ButtonSize};
use butler_ds::ui::tooltip::Align;
use gpui::{
    AnyElement, App, AppContext as _, Context, ElementId, Entity, IntoElement as _,
    ParentElement as _, Render, SharedString, Subscription, Window, div,
};

use super::OnTags;
use super::copy::{Tags, words};
use super::editor::TagEditor;
use super::manage::TagAction;
use super::tags::chip;
use crate::ui::manage::Pick;
use crate::ui::source::wire::CanonTag;

/// The longest tag name a new tag takes (characters).
const NAME_MAX: usize = 32;

/// What a chooser shows and does (the props of `CanonTagChooser`).
pub(super) struct Props {
    /// Keys the chooser's popover, search text and menus; one per chooser on screen.
    pub(super) id: ElementId,
    pub(super) tags: Vec<CanonTag>,
    pub(super) value: Vec<SharedString>,
    pub(super) on_change: OnTags,
    pub(super) on_create: Option<Pick<SharedString>>,
    pub(super) on_manage: Option<Pick<(CanonTag, TagAction)>>,
    pub(super) disabled: bool,
    pub(super) filter: bool,
    /// The chosen tags as the trigger's own content (a property row).
    pub(super) chips: Option<AnyElement>,
    /// `align="end"`
    pub(super) end: bool,
}

/// What closing the popover does: it forgets the search text.
#[derive(Clone)]
struct Close {
    popover: Popover,
    search: Entity<SharedString>,
}

impl Close {
    fn run(&self, window: &mut Window, cx: &mut App) {
        self.popover.set_open(false, window, cx);
        self.search.update(cx, |search, cx| {
            *search = SharedString::default();
            cx.notify();
        });
    }
}

pub(super) fn chooser(mut props: Props, window: &mut Window, cx: &mut App) -> AnyElement {
    let copy = &words(Ds::get(cx).lang()).tags;
    let search = window.use_keyed_state((props.id.clone(), "search"), cx, |_, _| {
        SharedString::default()
    });
    let forget = search.clone();
    let popover = Popover::new((props.id.clone(), "popover"), window, cx).on_open_change(
        move |open, _, cx| {
            if !open {
                forget.update(cx, |search, cx| {
                    *search = SharedString::default();
                    cx.notify();
                });
            }
        },
    );
    let close = Close { popover, search };
    let list = list(&props, copy, &close, window, cx);
    let trigger = trigger(props.chips.take(), &props, copy, &close);
    let content = close.popover.content(
        PopoverContent::new()
            .align(if props.end { Align::End } else { Align::Start })
            .side_offset(6.)
            .density(Density::List)
            .menu_size(MenuSize::Fit)
            .child(list),
        window,
        cx,
    );
    div().child(trigger).child(content).into_any_element()
}

fn trigger(chips: Option<AnyElement>, props: &Props, copy: &Tags, close: &Close) -> AnyElement {
    let (id, disabled, filter) = (props.id.clone(), props.disabled, props.filter);
    let count = props.value.len();
    close.popover.trigger_fill(|toggle| {
        let mut button = SelectButton::new((id, "trigger"))
            .size(ButtonSize::Sm)
            .on_click(toggle.on_click());
        if disabled {
            button = button.disabled();
        }
        if filter && count > 0 {
            button = button.count(count);
        }
        let button = match chips {
            Some(chips) => button.child(chips),
            None => button.text(if filter { copy.label } else { copy.add }),
        };
        button.into_any_element()
    })
}

fn list(
    props: &Props,
    copy: &Tags,
    close: &Close,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let typed = close.search.read(cx).clone();
    let query = typed.trim().to_owned();
    let mut items = rows(props, copy, &query, close, window, cx);
    if let Some(create) = &props.on_create
        && !query.is_empty()
        && query.chars().count() <= NAME_MAX
        && !props.tags.iter().any(|tag| tag.tag.name == query)
    {
        let (create, close, disabled, name) = (
            create.clone(),
            close.clone(),
            props.disabled,
            SharedString::from(query.clone()),
        );
        items.push(
            Item::new("create", SharedString::from((copy.create)(&query))).on_select(
                move |window, cx| {
                    if !disabled {
                        close.run(window, cx);
                        create(name.clone(), window, cx);
                    }
                },
            ),
        );
    }
    let search = close.search.clone();
    let (on_change, disabled) = (props.on_change.clone(), props.disabled);
    FilteredSelectPopover::new(
        (props.id.clone(), "list"),
        if props.filter {
            copy.filter
        } else {
            copy.label
        },
        copy.search_placeholder,
        copy.empty,
    )
    .search(typed, move |text, window, cx| {
        search.update(cx, |search, cx| {
            *search = text.to_owned().into();
            cx.notify();
        });
        window.refresh();
    })
    .filters(Vec::new(), "all")
    .groups(vec![Group::new("tags", copy.label, items)])
    .footer(
        None,
        vec![FooterOption::new(
            copy.clear_all,
            false,
            move |window, cx| {
                if !disabled {
                    on_change(Vec::new(), window, cx);
                }
            },
        )],
    )
    .width(Width::Fixed)
    .results_max_rows(7.)
    .into_any_element()
}

/// The tags whose name holds the search text, each toggling its own selection.
fn rows(
    props: &Props,
    copy: &Tags,
    query: &str,
    close: &Close,
    window: &mut Window,
    cx: &mut App,
) -> Vec<Item> {
    let needle = query.to_lowercase();
    let mut items = Vec::new();
    for tag in &props.tags {
        if !tag.tag.name.to_lowercase().contains(&needle) {
            continue;
        }
        let id = SharedString::from(tag.tag.id.clone());
        let selected = props.value.contains(&id);
        let next: Vec<SharedString> = if selected {
            props
                .value
                .iter()
                .filter(|item| **item != id)
                .cloned()
                .collect()
        } else {
            props.value.iter().cloned().chain([id.clone()]).collect()
        };
        let (on_change, disabled) = (props.on_change.clone(), props.disabled);
        let mut item =
            Item::new(id, chip(&tag.tag))
                .selected(selected)
                .on_select(move |window, cx| {
                    if !disabled {
                        on_change(next.clone(), window, cx);
                    }
                });
        if let Some(manage) = &props.on_manage {
            let menu = row_menu(tag, manage, props.disabled, copy, close, window, cx);
            item = item.actions(menu);
        }
        items.push(item);
    }
    items
}

/// The pencil beside a tag: rename, recolor, delete.
fn row_menu(
    tag: &CanonTag,
    manage: &Pick<(CanonTag, TagAction)>,
    disabled: bool,
    copy: &Tags,
    close: &Close,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let id = SharedString::from(format!("canon-tag-menu-{}", tag.tag.id));
    let menu = DropdownMenu::new(id.clone(), window, cx);
    let label = (copy.menu)(&tag.tag.name);
    let trigger = menu.trigger(|toggle| {
        let button = IconButton::new(id, label)
            .glyph(Icon::Pencil)
            .menu_trigger()
            .on_click(toggle.on_click());
        let button = if disabled { button.disabled() } else { button };
        button.into_any_element()
    });
    let entry = |label: &'static str, action: TagAction, variant: MenuVariant| {
        let (manage, tag, close) = (manage.clone(), tag.clone(), close.clone());
        MenuItem::new(label)
            .variant(variant)
            .on_select(move |window, cx| {
                close.run(window, cx);
                manage((tag.clone(), action), window, cx);
            })
    };
    let content = menu.content(
        DropdownMenuContent::new()
            .align(Align::End)
            .side_offset(8.)
            .child(entry(copy.rename, TagAction::Rename, MenuVariant::Default))
            .child(entry(copy.recolor, TagAction::Color, MenuVariant::Default))
            .child(entry(
                copy.remove,
                TagAction::Delete,
                MenuVariant::Destructive,
            )),
        window,
        cx,
    );
    div()
        .flex()
        .child(trigger)
        .child(content)
        .into_any_element()
}

/// `CanonTagChooser` on its own (the board's tag filter): the project's tags to choose from.
/// The filter manages tags like the 과제 picker; creating a tag leaves the filter as it is.
pub(crate) struct TagChooser {
    tags: Entity<super::CanonTags>,
    editor: Entity<TagEditor>,
    _editor: Subscription,
    value: Vec<SharedString>,
    on_change: OnTags,
    filter: bool,
    _tags: Subscription,
}

impl TagChooser {
    pub(crate) fn new(
        tags: Entity<super::CanonTags>,
        value: Vec<SharedString>,
        on_change: OnTags,
        filter: bool,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let subscription = cx.observe(&tags, |_, _, cx| cx.notify());
        let editor = cx.new(|_| TagEditor::new(tags.clone()));
        let observe = cx.observe(&editor, |_, _, cx| cx.notify());
        Self {
            editor,
            _editor: observe,
            tags,
            value,
            on_change,
            filter,
            _tags: subscription,
        }
    }

    /// The owner's own change of the chosen tags.
    pub(crate) fn set_value(&mut self, value: Vec<SharedString>, cx: &mut Context<Self>) {
        if self.value != value {
            self.value = value;
            cx.notify();
        }
    }
}

impl Render for TagChooser {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl gpui::IntoElement {
        let (me, owner) = (cx.entity().downgrade(), self.on_change.clone());
        let on_change: OnTags = Rc::new(move |ids, window, cx| {
            let chosen = ids.clone();
            let _ = me.update(cx, |this, cx| {
                this.value = chosen;
                cx.notify();
            });
            owner(ids, window, cx);
        });
        let props = Props {
            id: ("canon-tag-chooser", cx.entity_id()).into(),
            tags: self.tags.read(cx).tags().to_vec(),
            value: self.value.clone(),
            on_change,
            on_create: Some({
                let editor = self.editor.clone();
                Rc::new(move |name, window, cx| {
                    editor.update(cx, |editor, cx| editor.create(&name, window, cx));
                })
            }),
            on_manage: Some({
                let editor = self.editor.clone();
                Rc::new(move |(tag, action), window, cx| {
                    editor.update(cx, |editor, cx| editor.open(tag, action, window, cx));
                })
            }),
            disabled: self.editor.read(cx).busy(),
            filter: self.filter,
            chips: None,
            end: false,
        };
        div()
            .flex()
            .min_w_0()
            .child(chooser(props, window, cx))
            .children(self.editor.read(cx).dialog())
            .into_any_element()
    }
}
