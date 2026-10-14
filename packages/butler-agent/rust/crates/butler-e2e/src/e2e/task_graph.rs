//! Task graph fixtures through the real Work/Subsession services. No model calls.
#![allow(clippy::expect_used, reason = "fixture assertions")]
mod environment;
mod history;
mod operations;
mod scenarios;
pub use scenarios::actions;

use butler_turn::btcc::SessionRole;
use butler_turn::btcc::*;
use butler_turn::workspace::SessionRole as BindingRole;
use butler_turn::workspace::*;
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
pub type Error = Box<dyn std::error::Error + Send + Sync>;

/// An admitted scope and its durable Work, refreshed after each mutation.
pub struct GraphWork {
    pub scope: WorkTurnScope,
    pub view: WorkView,
}

/// The actual persisted attempt identities produced by SubsessionService.
#[derive(Clone)]
pub struct Attempt {
    pub task: String,
    pub session: String,
    pub turn: String,
}

/// A controlled child queue: dispatches are admitted, but never sent to a model.
pub struct GraphBuilder {
    storage: BtccStorage,
    turns: BtccRepositories,
    bindings: SessionBindingStore,
    pub work: Arc<DurableWorkService>,
    pub children: SubsessionService,
    queue: Arc<environment::Queue>,
    clock: Arc<Mutex<i64>>,
    sequence: usize,
}

impl GraphBuilder {
    /// A strictly increasing clock makes review/result/checkpoint ordering explicit.
    fn tick(&mut self) -> String {
        self.sequence += 1;
        let mut clock = self.clock.lock().expect("fixture clock");
        *clock += 1;
        environment::iso(*clock)
    }

    pub async fn close(self) -> Result<(), Error> {
        self.bindings.close().await?;
        self.storage.close().await?;
        Ok(())
    }
}
