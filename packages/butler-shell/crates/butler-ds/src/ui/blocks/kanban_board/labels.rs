//! Screen-reader copy of a KanbanDragScope drag (`kanbanDragLabels.ts`). Positions are 1-based
//! places in the lane. The product container passes localized labels. gpui has no live region:
//! the announcements go to [`super::KanbanDragScope::on_announce`].
use std::rc::Rc;

use gpui::SharedString;

type Name = Rc<dyn Fn(&str) -> String>;
type Placed = Rc<dyn Fn(&str, &str, usize) -> String>;

#[derive(Clone)]
pub struct KanbanDragLabels {
    /// How to drag with the keyboard; the shell's accessibility layer reads it with every card.
    pub instructions: SharedString,
    /// Role description of a draggable card.
    pub role_description: SharedString,
    pub lifted: Placed,
    /// The keyboard moved the card to a new place (not yet dropped).
    pub over: Placed,
    pub dropped: Placed,
    pub cancelled: Name,
    /// The drop was not accepted (`can_drop`) or left the item where it was.
    pub unchanged: Name,
}

/// English defaults.
impl Default for KanbanDragLabels {
    fn default() -> Self {
        let placed = |text: fn(&str, &str, usize) -> String| -> Placed { Rc::new(text) };
        Self {
            instructions: "Press Space to pick the card up. Use the arrow keys to move it within or between lanes, Space to drop it, Escape to cancel.".into(), // DS: kanbanDragLabels.ts:15
            role_description: "draggable card".into(), // DS: kanbanDragLabels.ts:16
            lifted: placed(|item, lane, position| format!("Picked up {item}. {lane}, position {position}.")),
            over: placed(|item, lane, position| format!("{item}: {lane}, position {position}.")),
            dropped: placed(|item, lane, position| format!("Dropped {item} in {lane}, position {position}.")),
            cancelled: Rc::new(|item: &str| format!("Move of {item} cancelled.")),
            unchanged: Rc::new(|item: &str| format!("{item} stays where it was.")),
        }
    }
}
