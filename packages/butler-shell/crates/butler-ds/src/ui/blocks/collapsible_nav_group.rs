//! DS CollapsibleNavGroup (CollapsibleNavGroup.tsx / CollapsibleNavGroup.module.css): a nav row
//! that folds the rows under it (a project folder with its sessions). The header is a NavRow
//! with the group's `--sidebar-row-gap: var(--space-2)`; the children reveal on the DS
//! Collapsible, optionally indented one level (`--nav-tree-indent`).
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, IntoElement, ParentElement, RenderOnce, SharedString,
    Styled as _, Window, div,
};

use super::nav_row::{ActionsVisibility, NavRow};
use super::scope;
use crate::tokens::Length;
use crate::ui::Icon;
use crate::ui::collapsible::Collapsible;
use crate::ui::context::Ds;

type Toggle = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct CollapsibleNavGroup {
    id: ElementId,
    icon: Option<AnyElement>,
    glyph: Option<Icon>,
    label: SharedString,
    expanded: bool,
    on_toggle: Option<Toggle>,
    actions: Option<AnyElement>,
    indented: bool,
    children: Vec<AnyElement>,
}

impl CollapsibleNavGroup {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>, expanded: bool) -> Self {
        Self {
            id: id.into(),
            icon: None,
            glyph: None,
            label: label.into(),
            expanded,
            on_toggle: None,
            actions: None,
            indented: false,
            children: Vec::new(),
        }
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    /// A DS glyph at the density's icon size.
    pub fn glyph(mut self, glyph: Icon) -> Self {
        self.glyph = Some(glyph);
        self
    }

    pub fn on_toggle(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_toggle = Some(Rc::new(handler));
        self
    }

    /// Actions on the group header: hover-only, or always shown when `indented`.
    pub fn actions(mut self, actions: impl IntoElement) -> Self {
        self.actions = Some(actions.into_any_element());
        self
    }

    /// An explicit tree: each child level is inset by `--nav-tree-indent`, and the header's
    /// actions stay visible.
    pub fn indented(mut self) -> Self {
        self.indented = true;
        self
    }
}

impl ParentElement for CollapsibleNavGroup {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for CollapsibleNavGroup {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let gap = ds.len(Length::Space1);
        // `--nav-tree-indent`: `--space-sm` in a SidebarShell, else `--space-lg`.
        let indent = ds.len(if scope::in_density(cx) {
            Length::SpaceSm
        } else {
            Length::SpaceLg
        });
        let row_gap = f32::from(ds.len(Length::Space2));
        let mut header = NavRow::new((self.id.clone(), "header"), self.label)
            .row_gap(row_gap)
            .actions_visibility(if self.indented {
                ActionsVisibility::Visible
            } else {
                ActionsVisibility::Hover
            });
        if let Some(icon) = self.icon {
            header = header.icon(icon);
        }
        if let Some(glyph) = self.glyph {
            header = header.glyph(glyph);
        }
        if let Some(actions) = self.actions {
            header = header.actions(actions);
        }
        if let Some(toggle) = self.on_toggle {
            header = header.on_click(move |event, window, cx| toggle(event, window, cx));
        }
        let mut items = div().flex().flex_col().gap(gap).pt(gap);
        if self.indented {
            items = items.pl(indent);
        }
        div().w_full().min_w_0().child(header).child(
            Collapsible::new((self.id, "content"), self.expanded)
                .child(items.children(self.children)),
        )
    }
}
