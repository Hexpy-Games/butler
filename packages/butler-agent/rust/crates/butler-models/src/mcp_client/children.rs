//! Live stdio MCP process groups; deadline cleanup cannot rely on destructors.

use butler_platform::process_control::{GroupSignal, signal_group};
use std::{
    collections::HashSet,
    io,
    sync::{LazyLock, Mutex, PoisonError},
};

#[derive(Default)]
struct Children {
    stopping: bool,
    groups: HashSet<u32>,
}

static CHILDREN: LazyLock<Mutex<Children>> = LazyLock::new(Mutex::default);

pub(super) struct ChildGroup(u32);

impl ChildGroup {
    pub(super) fn register(child: &tokio::process::Child) -> io::Result<Self> {
        butler_platform::process_control::contain(child)?;
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("MCP child already exited"))?;
        let mut children = CHILDREN.lock().unwrap_or_else(PoisonError::into_inner);
        if children.stopping {
            let _ = signal_group(pid, GroupSignal::Kill);
            return Err(io::Error::other("MCP owner is stopping"));
        }
        children.groups.insert(pid);
        Ok(Self(pid))
    }
}

impl Drop for ChildGroup {
    fn drop(&mut self) {
        let mut children = CHILDREN.lock().unwrap_or_else(PoisonError::into_inner);
        if children.groups.remove(&self.0) {
            // The direct child was reaped by the session. End any descendants too.
            let _ = signal_group(self.0, GroupSignal::Kill);
        }
    }
}

/// Stops only process groups this MCP owner started, including descendants.
/// Used before a forced deadline exit, where Rust destructors do not run.
pub fn stop_mcp_children() {
    let mut children = CHILDREN.lock().unwrap_or_else(PoisonError::into_inner);
    children.stopping = true;
    for pid in children.groups.drain() {
        let _ = signal_group(pid, GroupSignal::Kill);
    }
}
