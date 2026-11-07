//! Screen-reader copy of a StepSortableList (`stepSortableLabels.ts`). `chain` is the chain's
//! label; `step` the 1-based step number the item has (or would have) after the move. The product
//! container passes localized labels (Korean: 단계, 묶음). The announcements are delivered through
//! `StepSortableList::on_announce` (gpui has no live region).
use std::rc::Rc;

type Name = Rc<dyn Fn(&str) -> String>;
type Placed = Rc<dyn Fn(&str, &str, usize) -> String>;

#[derive(Clone)]
pub struct StepSortableLabels {
    /// Accessible name of a grip (its tooltip); the argument is an item's label or a whole
    /// 묶음's name (`stack`).
    pub grip: Name,
    /// Name of a whole 묶음 dragged as one step: its front item and how many it holds.
    pub stack: Rc<dyn Fn(&str, usize) -> String>,
    pub lifted: Placed,
    /// The keyboard moved the item over a gap: it would become its own step.
    pub new_step: Placed,
    /// The keyboard moved the item onto a step: it would join that step's 묶음.
    pub join: Placed,
    pub dropped: Placed,
    pub cancelled: Name,
    /// The drop left the item where it was.
    pub unchanged: Name,
}

/// English defaults.
impl Default for StepSortableLabels {
    fn default() -> Self {
        let placed = |text: fn(&str, &str, usize) -> String| -> Placed { Rc::new(text) };
        Self {
            grip: Rc::new(|item: &str| format!("Move {item}")),
            stack: Rc::new(|front: &str, count: usize| format!("{front} and {} more", count - 1)),
            lifted: placed(|item, chain, step| format!("Picked up {item}. {chain}, step {step}.")),
            new_step: placed(|item, chain, step| format!("{item}: new step {step} in {chain}.")),
            join: placed(|item, chain, step| {
                format!("{item}: together with step {step} in {chain}.")
            }),
            dropped: placed(|item, chain, step| {
                format!("Dropped {item} in {chain}, step {step}.")
            }),
            cancelled: Rc::new(|item: &str| format!("Move of {item} cancelled.")),
            unchanged: Rc::new(|item: &str| format!("{item} stays where it was.")),
        }
    }
}
