//! DS FilteredSelectPopover (FilteredSelectPopover.tsx / .module.css): the body of a searchable
//! select popover: a title, a search field with a clear button, filter chips, a fixed-height
//! scroller of titled groups, and a footer of options. Controlled: the owner holds the search
//! text and the active filter and passes the groups it wants shown.
mod parts;

use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _,
    Window, div, px,
};

use crate::tokens::{Color, Length, Number};
use crate::ui::context::Ds;
use crate::ui::scroll::ScrollArea;
use parts::Change;

type Select = Rc<dyn Fn(&mut Window, &mut App)>;

/// A filter chip.
pub struct Filter {
    id: SharedString,
    label: SharedString,
    on_select: Select,
}

impl Filter {
    pub fn new(
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        on_select: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            on_select: Rc::new(on_select),
        }
    }
}

/// A result row.
pub struct Item {
    id: SharedString,
    label: AnyElement,
    description: Option<SharedString>,
    tooltip: Option<SharedString>,
    selected: bool,
    icon: Option<AnyElement>,
    on_select: Option<Select>,
    actions: Option<AnyElement>,
}

impl Item {
    pub fn new(id: impl Into<SharedString>, label: impl IntoElement) -> Self {
        Self {
            id: id.into(),
            label: label.into_any_element(),
            description: None,
            tooltip: None,
            selected: false,
            icon: None,
            on_select: None,
            actions: None,
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn tooltip(mut self, label: impl Into<SharedString>) -> Self {
        self.tooltip = Some(label.into());
        self
    }

    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    pub fn on_select(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_select = Some(Rc::new(handler));
        self
    }

    /// Trailing row actions (an IconButton that opens a row menu), beside the select button.
    /// They show on row hover and while their menu is open.
    pub fn actions(mut self, actions: impl IntoElement) -> Self {
        self.actions = Some(actions.into_any_element());
        self
    }
}

/// A titled group of rows.
pub struct Group {
    id: SharedString,
    title: SharedString,
    items: Vec<Item>,
}

impl Group {
    pub fn new(
        id: impl Into<SharedString>,
        title: impl Into<SharedString>,
        items: Vec<Item>,
    ) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            items,
        }
    }
}

/// A footer option.
pub struct FooterOption {
    label: SharedString,
    selected: bool,
    on_select: Select,
}

impl FooterOption {
    pub fn new(
        label: impl Into<SharedString>,
        selected: bool,
        on_select: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            label: label.into(),
            selected,
            on_select: Rc::new(on_select),
        }
    }
}

/// `width`: the content's width between 280px and 520px, or exactly 320px.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Width {
    #[default]
    Default,
    Fixed,
}

#[derive(IntoElement)]
pub struct FilteredSelectPopover {
    id: ElementId,
    title: SharedString,
    search_placeholder: SharedString,
    search_value: SharedString,
    on_search_change: Change,
    filters: Vec<Filter>,
    active_filter: SharedString,
    groups: Vec<Group>,
    empty_label: SharedString,
    footer_title: Option<SharedString>,
    footer_options: Vec<FooterOption>,
    width: Width,
    results_max_rows: Option<f32>,
}

impl FilteredSelectPopover {
    pub fn new(
        id: impl Into<ElementId>,
        title: impl Into<SharedString>,
        search_placeholder: impl Into<SharedString>,
        empty_label: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            search_placeholder: search_placeholder.into(),
            search_value: SharedString::default(),
            on_search_change: Rc::new(|_, _, _| {}),
            filters: Vec::new(),
            active_filter: SharedString::default(),
            groups: Vec::new(),
            empty_label: empty_label.into(),
            footer_title: None,
            footer_options: Vec::new(),
            width: Width::Default,
            results_max_rows: None,
        }
    }

    /// The text the field shows (controlled), with the change callback.
    pub fn search(
        mut self,
        value: impl Into<SharedString>,
        on_change: impl Fn(&str, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.search_value = value.into();
        self.on_search_change = Rc::new(on_change);
        self
    }

    pub fn filters(mut self, filters: Vec<Filter>, active: impl Into<SharedString>) -> Self {
        self.filters = filters;
        self.active_filter = active.into();
        self
    }

    pub fn groups(mut self, groups: Vec<Group>) -> Self {
        self.groups = groups;
        self
    }

    pub fn footer(mut self, title: Option<SharedString>, options: Vec<FooterOption>) -> Self {
        self.footer_title = title;
        self.footer_options = options;
        self
    }

    pub fn width(mut self, width: Width) -> Self {
        self.width = width;
        self
    }

    /// The results area shows this many 30px rows (default 6.65), at most 42vh.
    pub fn results_max_rows(mut self, rows: f32) -> Self {
        self.results_max_rows = Some(rows);
        self
    }
}

/// A group or footer title: the menu group-label voice.
fn group_title(text: SharedString, ds: &Ds) -> gpui::Div {
    div()
        .min_w_0()
        .pt(ds.len(Length::SpaceSm))
        .px(ds.len(Length::SpaceSm))
        .pb(ds.len(Length::SpaceXs))
        .text_color(ds.color(Color::MenuGroupLabelColor))
        .text_size(ds.len(Length::MenuGroupLabelSize))
        .line_height(ds.len(Length::MenuGroupLabelLineHeight))
        .font_weight(gpui::FontWeight(ds.number(Number::MenuGroupLabelWeight)))
        .child(text)
}

impl RenderOnce for FilteredSelectPopover {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let viewport = window.viewport_size();
        let room = f32::from(viewport.width) - 32.;
        let root = div()
            .flex()
            .flex_col()
            .gap(ds.len(Length::Space1))
            .min_w_0()
            .text_color(ds.color(Color::TextPrimary));
        let root = match self.width {
            Width::Fixed => root.w(px(320_f32.min(room))), // DS: FilteredSelectPopover.module.css:15
            Width::Default => root
                .min_w(px(280_f32.min(room)))
                .max_w(px(520_f32.min(room))),
        };
        let title = div()
            .min_w_0()
            .pt(px(3.)) // DS: FilteredSelectPopover.module.css:28
            .px(ds.len(Length::Space2))
            .pb(ds.len(Length::SpaceXs))
            .text_size(ds.len(Length::FontSize2))
            .line_height(ds.len(Length::TypoLabelLineHeight))
            .font_weight(gpui::FontWeight(ds.number(Number::FontWeightSemibold)))
            .child(self.title);
        let search = parts::search(
            &self.id,
            &self.search_placeholder,
            &self.search_value,
            &self.on_search_change,
            ds,
        );
        let filters = parts::filters(&self.id, self.filters, &self.active_filter, ds);
        let rows = self.results_max_rows.unwrap_or(6.65); // DS: FilteredSelectPopover.module.css:158
        let height = (rows * 30.).min(f32::from(viewport.height) * 0.42);
        let visible: Vec<Group> = self
            .groups
            .into_iter()
            .filter(|group| !group.items.is_empty())
            .collect();
        let content = if visible.is_empty() {
            div()
                .p(ds.len(Length::Space2))
                .text_color(ds.color(Color::TextSecondary))
                .text_size(ds.len(Length::FontSize3))
                .line_height(ds.len(Length::TypoBodyLineHeight))
                .child(self.empty_label)
                .into_any_element()
        } else {
            let id = self.id.clone();
            let groups = visible.into_iter().map(|group| {
                let key = group.id.clone();
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .min_w_0()
                    .child(group_title(group.title, ds))
                    .child(div().flex().flex_col().gap(px(2.)).min_w_0().children(
                        group.items.into_iter().map(|item| {
                            let row_id: ElementId =
                                (id.clone(), SharedString::from(format!("{key}-{}", item.id)))
                                    .into();
                            parts::row(&row_id, item, ds)
                        }),
                    ))
            });
            div()
                .flex()
                .flex_col()
                .gap(ds.len(Length::Space2))
                .children(groups)
                .into_any_element()
        };
        let results = div()
            .flex()
            .flex_col()
            .h(px(height))
            .min_w_0()
            .border_t(ds.len(Length::BorderHairline))
            .border_b(ds.len(Length::BorderHairline))
            .border_color(ds.color(Color::Line))
            .child(
                ScrollArea::new((self.id.clone(), "results"))
                    .fill()
                    .child(content),
            );
        let footer = (self.footer_title.is_some() || !self.footer_options.is_empty()).then(|| {
            let options = self
                .footer_options
                .into_iter()
                .map(|option| (option.label, option.selected, option.on_select))
                .collect();
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .min_w_0()
                .children(self.footer_title.map(|title| group_title(title, ds)))
                .child(parts::chips(
                    &(self.id.clone(), "footer").into(),
                    options,
                    ds,
                ))
        });
        root.child(title)
            .child(search)
            .child(filters)
            .child(results)
            .children(footer)
    }
}
