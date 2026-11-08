//! DS CollapsibleList: keyed rows that reveal when inserted and fold away, in their old place,
//! when removed. The removal fold starts two animation frames after the commit that removed the
//! row. Rows present on the first render, the first rows after an empty list and rows after a
//! `scope` change do not animate.
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement as _,
    RenderOnce, SharedString, Styled as _, Window, div,
};

use super::Collapsible;
use crate::tokens::{Duration as DsDuration, Easing};
use crate::ui::context::Ds;
use crate::ui::layout::Space;
use crate::ui::motion::Timing;

type Render = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;

/// A keyed row. The list keeps `render` so a removed row can keep drawing while it folds away.
#[derive(Clone)]
pub struct Row {
    key: SharedString,
    render: Render,
}

impl Row {
    pub fn new(
        key: impl Into<SharedString>,
        render: impl Fn(&mut Window, &mut App) -> AnyElement + 'static,
    ) -> Self {
        Self {
            key: key.into(),
            render: Rc::new(render),
        }
    }
}

struct Exit {
    row: Row,
    index: usize,
    closing: bool,
}

#[derive(Default)]
struct List {
    scope: Option<SharedString>,
    keys: HashSet<SharedString>,
    last: Vec<Row>,
    exiting: HashMap<SharedString, Exit>,
    /// Frames waited since a removal was committed.
    waited: u8,
}

#[derive(IntoElement)]
pub struct CollapsibleList {
    id: ElementId,
    scope: SharedString,
    gap: Space,
    rows: Vec<Row>,
}

impl CollapsibleList {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            scope: SharedString::default(),
            gap: Space::None,
            rows: Vec::new(),
        }
    }

    /// What the rows belong to (a tab, a folder). A scope change swaps the rows without motion.
    pub fn scope(mut self, scope: impl Into<SharedString>) -> Self {
        self.scope = scope.into();
        self
    }

    /// The space between rows. In React the rows are items of the parent's flex gap; here they
    /// are one column, which carries that gap.
    pub fn gap(mut self, gap: Space) -> Self {
        self.gap = gap;
        self
    }

    pub fn rows(mut self, rows: impl IntoIterator<Item = Row>) -> Self {
        self.rows.extend(rows);
        self
    }
}

impl List {
    /// Folds this render's rows into the state: which rows enter, and the rows to draw (removed
    /// ones at their last index) with whether each is present.
    fn merge(
        &mut self,
        scope: &SharedString,
        rows: &[Row],
    ) -> (HashSet<SharedString>, Vec<(Row, bool)>) {
        let quiet = self.scope.as_ref() != Some(scope) || self.keys.is_empty();
        let keys: HashSet<SharedString> = rows.iter().map(|row| row.key.clone()).collect();
        if quiet {
            self.exiting.clear();
        } else {
            for (index, row) in self.last.iter().enumerate() {
                if !keys.contains(&row.key) && !self.exiting.contains_key(&row.key) {
                    self.exiting.insert(
                        row.key.clone(),
                        Exit {
                            row: row.clone(),
                            index,
                            closing: false,
                        },
                    );
                }
            }
            self.exiting.retain(|key, _| !keys.contains(key));
        }
        let entering = if quiet {
            HashSet::new()
        } else {
            keys.difference(&self.keys).cloned().collect()
        };
        let mut merged: Vec<(Row, bool)> = rows.iter().map(|row| (row.clone(), true)).collect();
        let mut gone: Vec<&Exit> = self.exiting.values().collect();
        gone.sort_by_key(|exit| exit.index);
        for exit in gone {
            merged.insert(
                exit.index.min(merged.len()),
                (exit.row.clone(), !exit.closing),
            );
        }
        self.scope = Some(scope.clone());
        self.keys = keys;
        self.last = rows.to_vec();
        (entering, merged)
    }

    /// Waits two frames after a removal commit, then lets the removed rows fold. True while
    /// frames are still needed.
    fn tick(&mut self) -> bool {
        if !self.exiting.values().any(|exit| !exit.closing) {
            self.waited = 0;
            return false;
        }
        if self.waited >= 2 {
            self.waited = 0;
            for exit in self.exiting.values_mut() {
                exit.closing = true;
            }
        } else {
            self.waited += 1;
        }
        true
    }
}

impl RenderOnce for CollapsibleList {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let state = window.use_keyed_state((self.id.clone(), "list"), cx, |_, _| {
            Rc::new(RefCell::new(List::default()))
        });
        let list = state.read(cx).clone();
        let (entering, merged, again) = {
            let mut list = list.borrow_mut();
            let (entering, merged) = list.merge(&self.scope, &self.rows);
            let again = list.tick();
            (entering, merged, again)
        };
        if again {
            crate::ui::motion::remeasure(window);
        }
        if merged.is_empty() {
            return div().hidden();
        }
        let ds = Ds::get(cx);
        let gap = self.gap.px(ds);
        let timing = Timing::token(ds, DsDuration::MotionBase, Easing::MotionEaseStandard);
        let exit = Timing::token(ds, DsDuration::MotionExitBase, Easing::MotionEaseAccelerate);
        let reduced = ds.reduced_motion();
        let rows = merged.into_iter().map(|(row, present)| {
            let (list, state) = (list.clone(), state.clone());
            let key = row.key.clone();
            let id = ElementId::from(SharedString::from(format!("{}-{key}", self.id)));
            let row_id = (id.clone(), "row");
            let mut item = Collapsible::new(id, present)
                .on_exit_complete(move |_, cx| {
                    if list.borrow_mut().exiting.remove(&key).is_some() {
                        state.update(cx, |_, cx| cx.notify());
                    }
                })
                .child((row.render)(window, cx));
            if entering.contains(&row.key) {
                item = item.appear();
            }
            let timing = if present { timing } else { exit };
            div()
                .id(row_id)
                .layout_motion(gpui::LayoutMotion {
                    duration_ms: if reduced { 0 } else { timing.ms() },
                    easing: timing.easing(),
                })
                .child(item)
        });
        div().flex().flex_col().gap(gap).children(rows)
    }
}
