//! Flat ordered steps: membership is the only source of prerequisite edges.
use crate::work_types::WorkId;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub index: usize,
    pub works: Vec<WorkId>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chain {
    pub steps: Vec<Step>,
}
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ChainError {
    #[error("steps must be contiguous and nonempty, with each Work occurring once")]
    Membership,
    #[error("unknown Work or step")]
    Unknown,
    #[error("running Works are pinned")]
    Pinned,
    #[error("task edges must be unique, known, nonself and acyclic")]
    TaskDag,
}
impl Chain {
    /// An empty chain represents the result of removing its last Work.
    pub fn validate(&self) -> Result<(), ChainError> {
        let mut seen = BTreeSet::new();
        for (index, step) in self.steps.iter().enumerate() {
            if index != step.index || step.works.is_empty() {
                return Err(ChainError::Membership);
            }
            for work in &step.works {
                if !seen.insert(work) {
                    return Err(ChainError::Membership);
                }
            }
        }
        Ok(())
    }
    pub fn edges(&self) -> Result<Vec<(WorkId, WorkId)>, ChainError> {
        self.validate()?;
        Ok(self
            .steps
            .windows(2)
            .flat_map(|pair| {
                pair[0].works.iter().flat_map(|pred| {
                    pair[1]
                        .works
                        .iter()
                        .map(move |succ| (pred.clone(), succ.clone()))
                })
            })
            .collect())
    }
    fn locate(&self, id: &WorkId) -> Result<(usize, usize), ChainError> {
        self.steps
            .iter()
            .enumerate()
            .find_map(|(i, s)| s.works.iter().position(|w| w == id).map(|j| (i, j)))
            .ok_or(ChainError::Unknown)
    }
    fn remove(&mut self, id: &WorkId) -> Result<(), ChainError> {
        let (i, j) = self.locate(id)?;
        self.steps[i].works.remove(j);
        if self.steps[i].works.is_empty() {
            self.steps.remove(i);
        }
        Ok(())
    }
    fn finish(&self, mut next: Self, running: &BTreeSet<WorkId>) -> Result<Self, ChainError> {
        self.validate()?;
        for (i, step) in next.steps.iter_mut().enumerate() {
            step.index = i;
        }
        next.validate()?;
        for id in running {
            if self.locate(id).ok() != next.locate(id).ok() {
                return Err(ChainError::Pinned);
            }
        }
        Ok(next)
    }
    /// Index is interpreted in the chain after removing the selected Work.
    pub fn move_to_new_step(
        &self,
        id: &WorkId,
        index: usize,
        running: &BTreeSet<WorkId>,
    ) -> Result<Self, ChainError> {
        let mut next = self.clone();
        next.remove(id)?;
        if index > next.steps.len() {
            return Err(ChainError::Unknown);
        }
        next.steps.insert(
            index,
            Step {
                index,
                works: vec![id.clone()],
            },
        );
        self.finish(next, running)
    }
    pub fn join_stack(
        &self,
        id: &WorkId,
        target: &WorkId,
        running: &BTreeSet<WorkId>,
    ) -> Result<Self, ChainError> {
        let mut next = self.clone();
        next.remove(id)?;
        let (i, _) = next.locate(target)?;
        next.steps[i].works.push(id.clone());
        self.finish(next, running)
    }
    pub fn split_stack(
        &self,
        index: usize,
        running: &BTreeSet<WorkId>,
    ) -> Result<Self, ChainError> {
        let mut next = self.clone();
        let step = next.steps.get(index).ok_or(ChainError::Unknown)?.clone();
        next.steps.splice(
            index..=index,
            step.works.into_iter().map(|work| Step {
                index,
                works: vec![work],
            }),
        );
        self.finish(next, running)
    }
    pub fn detach(&self, id: &WorkId, running: &BTreeSet<WorkId>) -> Result<Self, ChainError> {
        self.delete(id, running)
    }
    pub fn delete(&self, id: &WorkId, running: &BTreeSet<WorkId>) -> Result<Self, ChainError> {
        let mut next = self.clone();
        next.remove(id)?;
        self.finish(next, running)
    }
    /// Insert a new Work after the target's entire step, including all siblings.
    pub fn place_after(
        &self,
        id: WorkId,
        target: &WorkId,
        running: &BTreeSet<WorkId>,
    ) -> Result<Self, ChainError> {
        if self.locate(&id).is_ok() {
            return Err(ChainError::Membership);
        }
        let (i, _) = self.locate(target)?;
        let mut next = self.clone();
        next.steps.insert(
            i + 1,
            Step {
                index: i + 1,
                works: vec![id],
            },
        );
        self.finish(next, running)
    }
}

/// Kahn's algorithm; all nodes and edges belong to the caller's one Work.
pub fn validate_task_dag(tasks: &[String], edges: &[(String, String)]) -> Result<(), ChainError> {
    let mut incoming: BTreeMap<&str, usize> = tasks.iter().map(|id| (id.as_str(), 0)).collect();
    if incoming.len() != tasks.len() {
        return Err(ChainError::TaskDag);
    }
    let mut seen = BTreeSet::new();
    let mut outgoing: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (pred, succ) in edges {
        if pred == succ || !incoming.contains_key(pred.as_str()) || !seen.insert((pred, succ)) {
            return Err(ChainError::TaskDag);
        }
        *incoming.get_mut(succ.as_str()).ok_or(ChainError::TaskDag)? += 1;
        outgoing.entry(pred).or_default().push(succ);
    }
    let mut ready: VecDeque<_> = incoming
        .iter()
        .filter(|(_, n)| **n == 0)
        .map(|(id, _)| *id)
        .collect();
    let mut count = 0;
    while let Some(id) = ready.pop_front() {
        count += 1;
        for succ in outgoing.get(id).into_iter().flatten() {
            let n = incoming.get_mut(succ).ok_or(ChainError::TaskDag)?;
            *n -= 1;
            if *n == 0 {
                ready.push_back(succ);
            }
        }
    }
    if count == tasks.len() {
        Ok(())
    } else {
        Err(ChainError::TaskDag)
    }
}
