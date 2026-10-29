//! Flat ordered steps: membership is the only source of prerequisite edges.
use crate::work_types::EpicId;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub index: usize,
    pub tasks: Vec<EpicId>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chain {
    pub steps: Vec<Step>,
}
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ChainError {
    #[error("steps must be contiguous and nonempty, with each Task occurring once")]
    Membership,
    #[error("unknown Task or step")]
    Unknown,
    #[error("running Tasks are pinned")]
    Pinned,
    #[error("task edges must be unique, known, nonself and acyclic")]
    TaskDag,
}
/// Destination in another chain. New-step indices refer to the target chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Placement {
    NewStep(usize),
    Stack(EpicId),
}

impl Chain {
    /// An empty chain represents the result of removing its last Task.
    pub fn validate(&self) -> Result<(), ChainError> {
        let mut seen = BTreeSet::new();
        for (index, step) in self.steps.iter().enumerate() {
            if index != step.index || step.tasks.is_empty() {
                return Err(ChainError::Membership);
            }
            for work in &step.tasks {
                if !seen.insert(work) {
                    return Err(ChainError::Membership);
                }
            }
        }
        Ok(())
    }
    pub fn edges(&self) -> Result<Vec<(EpicId, EpicId)>, ChainError> {
        self.validate()?;
        Ok(self
            .steps
            .windows(2)
            .flat_map(|pair| {
                pair[0].tasks.iter().flat_map(|pred| {
                    pair[1]
                        .tasks
                        .iter()
                        .map(move |succ| (pred.clone(), succ.clone()))
                })
            })
            .collect())
    }
    fn locate(&self, id: &EpicId) -> Result<(usize, usize), ChainError> {
        self.steps
            .iter()
            .enumerate()
            .find_map(|(i, s)| s.tasks.iter().position(|w| w == id).map(|j| (i, j)))
            .ok_or(ChainError::Unknown)
    }
    fn remove(&mut self, id: &EpicId) -> Result<(), ChainError> {
        let (i, j) = self.locate(id)?;
        self.steps[i].tasks.remove(j);
        if self.steps[i].tasks.is_empty() {
            self.steps.remove(i);
        }
        Ok(())
    }
    fn pin(&self, id: &EpicId) -> Option<(usize, BTreeSet<EpicId>)> {
        let (index, _) = self.locate(id).ok()?;
        let predecessors = index.checked_sub(1).map(|i| &self.steps[i].tasks);
        Some((index, predecessors.into_iter().flatten().cloned().collect()))
    }
    fn finish(&self, mut next: Self, running: &BTreeSet<EpicId>) -> Result<Self, ChainError> {
        self.validate()?;
        for (i, step) in next.steps.iter_mut().enumerate() {
            step.index = i;
        }
        next.validate()?;
        for id in running {
            if self.pin(id) != next.pin(id) {
                return Err(ChainError::Pinned);
            }
        }
        Ok(next)
    }
    /// Index is interpreted in the chain after removing the selected Task.
    pub fn move_to_new_step(
        &self,
        id: &EpicId,
        index: usize,
        running: &BTreeSet<EpicId>,
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
                tasks: vec![id.clone()],
            },
        );
        self.finish(next, running)
    }
    pub fn join_stack(
        &self,
        id: &EpicId,
        target: &EpicId,
        running: &BTreeSet<EpicId>,
    ) -> Result<Self, ChainError> {
        let mut next = self.clone();
        next.remove(id)?;
        let (i, _) = next.locate(target)?;
        next.steps[i].tasks.push(id.clone());
        self.finish(next, running)
    }
    pub fn split_stack(
        &self,
        index: usize,
        running: &BTreeSet<EpicId>,
    ) -> Result<Self, ChainError> {
        let mut next = self.clone();
        let step = next.steps.get(index).ok_or(ChainError::Unknown)?.clone();
        next.steps.splice(
            index..=index,
            step.tasks.into_iter().map(|work| Step {
                index,
                tasks: vec![work],
            }),
        );
        self.finish(next, running)
    }
    pub fn detach(&self, id: &EpicId, running: &BTreeSet<EpicId>) -> Result<Self, ChainError> {
        self.delete(id, running)
    }
    pub fn delete(&self, id: &EpicId, running: &BTreeSet<EpicId>) -> Result<Self, ChainError> {
        let mut next = self.clone();
        next.remove(id)?;
        self.finish(next, running)
    }
    /// Join the next step's stack, or append a last step if the target is last.
    pub fn place_after(
        &self,
        id: EpicId,
        target: &EpicId,
        running: &BTreeSet<EpicId>,
    ) -> Result<Self, ChainError> {
        if self.locate(&id).is_ok() {
            return Err(ChainError::Membership);
        }
        let (i, _) = self.locate(target)?;
        let mut next = self.clone();
        if let Some(step) = next.steps.get_mut(i + 1) {
            step.tasks.push(id);
        } else {
            next.steps.push(Step {
                index: i + 1,
                tasks: vec![id],
            });
        }
        self.finish(next, running)
    }
    /// Move between distinct chains; the caller checks that both belong to one Work.
    /// Both results must be persisted atomically under their graph-revision CAS.
    pub fn move_between(
        &self,
        target: &Self,
        id: &EpicId,
        placement: Placement,
        running: &BTreeSet<EpicId>,
    ) -> Result<(Self, Self), ChainError> {
        self.validate()?;
        target.validate()?;
        if self
            .steps
            .iter()
            .flat_map(|s| &s.tasks)
            .any(|w| target.locate(w).is_ok())
        {
            return Err(ChainError::Membership);
        }
        let source = self.delete(id, running)?;
        let mut next = target.clone();
        match placement {
            Placement::NewStep(index) => {
                if index > next.steps.len() {
                    return Err(ChainError::Unknown);
                }
                next.steps.insert(
                    index,
                    Step {
                        index,
                        tasks: vec![id.clone()],
                    },
                );
            }
            Placement::Stack(work) => {
                let (index, _) = next.locate(&work)?;
                next.steps[index].tasks.push(id.clone());
            }
        }
        Ok((source, target.finish(next, running)?))
    }
}

/// Kahn's algorithm; all nodes and edges belong to the caller's one Task.
pub fn validate_part_dag(tasks: &[String], edges: &[(String, String)]) -> Result<(), ChainError> {
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
