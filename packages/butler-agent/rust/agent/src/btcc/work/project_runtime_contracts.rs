//! Neutral Project Work runtime contracts. The Project Ledger owns semantic Work;
//! this port only observes committed records in the existing BTCC SQLite lane.

mod identity;
mod legacy;
mod material;
mod ports;

pub(crate) use identity::*;
pub(crate) use legacy::*;
pub(crate) use material::*;
pub(crate) use ports::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProjectWorkToolResultEvidence {
    pub tool_call_id: String,
    pub tool_name: String,
    pub status: &'static str,
    pub result_sha256: String,
    pub origin_turn_id: String,
    pub source_turn_rowid: Option<i64>,
    pub source_turn_sequence: Option<i64>,
}
