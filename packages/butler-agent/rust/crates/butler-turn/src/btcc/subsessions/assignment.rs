//! Native assignments retain the existing transport projection, never a child Work.
use crate::btcc::StoredSubsessionDelegation;

#[derive(Clone, Debug)]
pub struct ChildAssignment {
    pub delegation: StoredSubsessionDelegation,
    pub work_id: String,
    pub task_id: String,
    pub part_id: Option<String>,
    pub attempt_id: String,
}

#[derive(Clone, Debug)]
pub enum Child {
    Legacy(StoredSubsessionDelegation),
    Assigned(ChildAssignment),
}

impl std::ops::Deref for Child {
    type Target = StoredSubsessionDelegation;
    fn deref(&self) -> &Self::Target {
        match self {
            Self::Legacy(row) => row,
            Self::Assigned(row) => &row.delegation,
        }
    }
}

impl std::ops::Deref for ChildAssignment {
    type Target = StoredSubsessionDelegation;
    fn deref(&self) -> &Self::Target {
        &self.delegation
    }
}
