//! Non-secret process identity carried by the detached restart helper.

use super::InstanceRecord;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RestartIdentity {
    pub(crate) pid: u32,
    pub(crate) process_start: String,
    pub(crate) nonce: String,
    pub(crate) executable: String,
}

impl RestartIdentity {
    pub(crate) fn matches(&self, record: &InstanceRecord) -> bool {
        self.pid == record.pid
            && self.process_start == record.process_start
            && self.nonce == record.nonce
            && self.executable == record.executable
    }
}
