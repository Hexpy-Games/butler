//! `shared-progress-reducer.ts`: progress rows folded into work blocks.
use std::collections::HashSet;

use super::row_ops::{
    is_legacy_decision_carrier, is_terminal_state, is_tool_activity_row, merge_tool_row,
    shared_merge_state, sort_projection_rows, strip_block_fields,
};
use crate::ui::source::wire::{ProgressRow, ProgressRowWorkBlockPhase, WorkBlockView};

struct Block {
    view: WorkBlockView,
    closed: bool,
    /// `rowMap`: the block's rows by key, in first-seen order.
    rows: Vec<(String, ProgressRow)>,
}

impl Block {
    fn set_row(&mut self, key: String, row: ProgressRow) {
        match self.rows.iter_mut().find(|(known, _)| *known == key) {
            Some(slot) => slot.1 = row,
            None => self.rows.push((key, row)),
        }
        self.view.rows = self.rows.iter().map(|(_, row)| row.clone()).collect();
    }
}

#[derive(Default)]
pub(crate) struct SharedProgressReducer {
    blocks: Vec<Block>,
    processed: HashSet<String>,
    current_open: Option<String>,
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|text| !text.is_empty())
}

impl SharedProgressReducer {
    fn block_mut(&mut self, id: &str) -> Option<&mut Block> {
        self.blocks.iter_mut().find(|block| block.view.id == id)
    }

    fn position(&self, id: &str) -> Option<usize> {
        self.blocks.iter().position(|block| block.view.id == id)
    }

    pub(crate) fn append(&mut self, row: &ProgressRow) {
        if !self.processed.insert(row.id.clone()) {
            return;
        }
        if row.kind.as_deref() == Some("work_block") {
            self.append_block_marker(row);
            return;
        }
        if is_legacy_decision_carrier(row) {
            let at = self.ensure_block(row, None, true);
            self.blocks[at].set_row(format!("row:{}", row.id), strip_block_fields(row));
            return;
        }
        if is_tool_activity_row(row) {
            self.append_tool_row(row);
        }
    }

    pub(crate) fn snapshot(&self, completed_only: bool) -> Vec<WorkBlockView> {
        self.blocks
            .iter()
            .filter(|block| !block.view.label.trim().is_empty())
            .filter(|block| !completed_only || block.closed || is_terminal_state(&block.view.state))
            .map(|block| block.view.clone())
            .collect()
    }

    fn append_block_marker(&mut self, row: &ProgressRow) {
        let Some(id) = non_empty(row.work_block_id.as_deref()) else {
            return;
        };
        let existing = self.position(id);
        let Some(phase) = &row.work_block_phase else {
            let at = existing.unwrap_or_else(|| self.open_block(row, id, true));
            let block = &mut self.blocks[at];
            block.view.state = shared_merge_state(&block.view.state, &row.state);
            return;
        };
        if *phase == ProgressRowWorkBlockPhase::Started {
            let reopened = existing.is_some_and(|at| self.blocks[at].closed);
            let busy = self.current_open.as_deref().is_some_and(|open| open != id);
            if existing.is_none() && !reopened && !busy {
                self.open_block(row, id, true);
            }
            return;
        }
        let Some(at) = existing else {
            return;
        };
        if self.blocks[at].closed {
            return;
        }
        if *phase == ProgressRowWorkBlockPhase::Updated {
            let block = &mut self.blocks[at];
            block.view.state = shared_merge_state(&block.view.state, &row.state);
            return;
        }
        self.close_block(at, &row.state);
    }

    fn append_tool_row(&mut self, row: &ProgressRow) {
        let id = non_empty(row.work_block_id.as_deref())
            .map(str::to_string)
            .unwrap_or_else(|| {
                format!(
                    "unbound:{}",
                    non_empty(row.tool_call_id.as_deref()).unwrap_or(&row.id)
                )
            });
        let explicit = non_empty(row.work_decision_id.as_deref()).is_some()
            || row.work_block_sequence.is_some();
        let at = match self.position(&id) {
            Some(at) => at,
            None if explicit => return,
            None => self.ensure_block(row, Some(&id), false),
        };
        if self.blocks[at].closed || self.current_open.as_deref() != Some(id.as_str()) {
            return;
        }
        let key = non_empty(row.tool_call_id.as_deref())
            .map_or_else(|| format!("row:{}", row.id), |call| format!("tool:{call}"));
        let block = &mut self.blocks[at];
        let next = match block.rows.iter().find(|(known, _)| *known == key) {
            Some((_, previous)) => merge_tool_row(previous, row),
            None => strip_block_fields(row),
        };
        block.set_row(key, next);
        block.view.state = shared_merge_state(&block.view.state, &row.state);
    }

    /// `#ensureCompatibilityBlock`: the index of the block `id` names (default `row:<row id>`).
    fn ensure_block(&mut self, row: &ProgressRow, id: Option<&str>, carry: bool) -> usize {
        let id = id
            .map(str::to_string)
            .or_else(|| row.work_block_id.clone())
            .unwrap_or_else(|| format!("row:{}", row.id));
        self.position(&id)
            .unwrap_or_else(|| self.open_block(row, &id, carry))
    }

    fn open_block(&mut self, row: &ProgressRow, id: &str, carry: bool) -> usize {
        if let Some(open) = self.current_open.clone()
            && open != id
            && let Some(current) = self.block_mut(&open)
        {
            current.closed = true;
        }
        let label = row
            .work_decision_title
            .clone()
            .or_else(|| row.work_block_label.clone())
            .unwrap_or_else(|| {
                if non_empty(row.work_block_id.as_deref()).is_some() {
                    String::new()
                } else {
                    row.safe_label.clone()
                }
            });
        let decision = |value: &Option<String>| if carry { value.clone() } else { None };
        let view = WorkBlockView {
            id: id.to_string(),
            label,
            state: row.state.clone(),
            rows: Vec::new(),
            decision_title: decision(&row.work_decision_title),
            decision_summary: decision(&row.work_decision_summary),
            decision_rationale: decision(&row.work_decision_rationale),
            decision_next_step: decision(&row.work_decision_next_step),
            decision_source: decision(&row.work_decision_source),
            decision_evidence_refs: if carry {
                row.work_decision_evidence_refs.clone()
            } else {
                None
            },
            created_at: row.created_at.clone(),
        };
        self.blocks.push(Block {
            view,
            closed: false,
            rows: Vec::new(),
        });
        self.current_open = Some(id.to_string());
        self.blocks.len() - 1
    }

    fn close_block(&mut self, at: usize, state: &str) {
        let block = &mut self.blocks[at];
        block.view.state = shared_merge_state(&block.view.state, state);
        block.closed = true;
        if self.current_open.as_deref() == Some(block.view.id.as_str()) {
            self.current_open = None;
        }
    }
}

/// `projectSharedWorkBlocks`.
pub(crate) fn project_shared_work_blocks(
    rows: &[ProgressRow],
    completed_only: bool,
) -> Vec<WorkBlockView> {
    let phases: HashSet<&str> = rows
        .iter()
        .filter(|row| {
            row.kind.as_deref() == Some("message")
                && row.work_decision_source.as_deref() == Some("model-authored")
                && non_empty(row.work_decision_summary.as_deref()).is_some()
                && non_empty(row.work_block_id.as_deref()).is_none()
        })
        .filter_map(|row| non_empty(row.semantic_block_id.as_deref()))
        .collect();
    let mut reducer = SharedProgressReducer::default();
    for row in sort_projection_rows(rows) {
        let skipped = row.bridge_phase.as_deref() == Some("btcc_operation")
            && non_empty(row.semantic_block_id.as_deref())
                .is_some_and(|block| phases.contains(block));
        if !skipped {
            reducer.append(row);
        }
    }
    reducer.snapshot(completed_only)
}
