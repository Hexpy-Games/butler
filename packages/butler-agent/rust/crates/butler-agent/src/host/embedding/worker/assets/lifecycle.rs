//! The memory model follows the user's choice. Nothing downloads while it is unset
//! or off; on downloads in the background and, once present, backfills vectors.
use super::{
    background::run,
    choice::{self, Choice},
    pinned_assets,
};
use crate::host::EmbeddingOwner;
use butler_gateway::gateway::MemoryModelProgress;
use butler_memory::cognition::MemorySyncConsumer;
use parking_lot::Mutex;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::{sync::watch, task::JoinHandle};
use tokio_util::sync::CancellationToken;

type Slot = Arc<Mutex<Option<(CancellationToken, JoinHandle<()>)>>>;

pub(crate) struct Acquisition {
    root: PathBuf,
    state: watch::Sender<MemoryModelProgress>,
    task: Slot,
    choice: Arc<Mutex<Choice>>,
    owner: Arc<EmbeddingOwner>,
    /// Set by an explicit switch to on; the next ready state starts one backfill.
    backfill_wanted: Arc<AtomicBool>,
    backfill: Slot,
    watcher: Mutex<Option<JoinHandle<()>>>,
    /// Serializes switches: save, in-memory choice and turning on or off.
    switch: tokio::sync::Mutex<()>,
}

/// Runtime owners the model choice controls.
pub(crate) struct ModelOwners {
    pub(crate) owner: Arc<EmbeddingOwner>,
    pub(crate) consumer: Arc<MemorySyncConsumer>,
}

impl Acquisition {
    /// Reads the persisted choice off Tokio's workers, then starts only what it allows.
    pub(crate) async fn open(root: PathBuf, owners: ModelOwners) -> Self {
        let read_root = root.clone();
        let (choice, ready) = tokio::task::spawn_blocking(move || choice::read(&read_root))
            .await
            .unwrap_or((Choice::Unset, false));
        if choice == Choice::On && ready {
            owners.owner.enable();
        }
        if choice == Choice::Off {
            // A switch to off that could not delete the files (Windows keeps a
            // file a live process holds) finishes here, before any worker runs.
            let off_root = root.clone();
            if let Ok(Err(code)) =
                tokio::task::spawn_blocking(move || choice::remove_model(&off_root)).await
            {
                butler_core::diagnostic!("[memory-model] off: model files kept ({code})");
            }
        }
        let this = Self {
            root,
            state: watch::channel(idle_view(choice)).0,
            task: Arc::default(),
            choice: Arc::new(Mutex::new(choice)),
            owner: owners.owner,
            backfill_wanted: Arc::default(),
            backfill: Arc::default(),
            watcher: Mutex::new(None),
            switch: tokio::sync::Mutex::new(()),
        };
        *this.watcher.lock() = Some(this.watch_ready(owners.consumer));
        this.retry();
        this
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<MemoryModelProgress> {
        self.state.subscribe()
    }

    /// Restarts a stopped or failed download; a no-op unless the choice is on.
    pub(crate) fn retry(&self) {
        if *self.choice.lock() != Choice::On {
            return;
        }
        let mut slot = self.task.lock();
        if self.state.borrow().state == "ready" {
            return;
        }
        if slot.as_ref().is_some_and(|(_, task)| !task.is_finished()) {
            return;
        }
        self.state.send_modify(|view| {
            view.state = "queued".into();
            view.reason = None;
        });
        let root = self.root.clone();
        let state = self.state.clone();
        let stop = CancellationToken::new();
        let cancelled = stop.clone();
        let runtime = tokio::runtime::Handle::current();
        let task = tokio::task::spawn_blocking(move || {
            runtime.block_on(async {
                tokio::select! {
                    () = cancelled.cancelled() => {},
                    () = run(root, state) => {},
                }
            });
        });
        *slot = Some((stop, task));
    }

    /// Persists the choice, then downloads (on) or stops the model and frees its files (off).
    pub(crate) async fn choose(&self, on: bool) -> Result<MemoryModelProgress, &'static str> {
        // Concurrent switches apply in order; the saved and running choice agree.
        let _switch = self.switch.lock().await;
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || choice::persist(&root, on))
            .await
            .map_err(|_| "memory_model_choice_unsaved")??;
        let wanted = if on { Choice::On } else { Choice::Off };
        if std::mem::replace(&mut *self.choice.lock(), wanted) == wanted {
            return Ok(self.state.borrow().clone());
        }
        if on {
            self.backfill_wanted.store(true, Ordering::Release);
            self.retry();
        } else {
            self.turn_off().await;
        }
        Ok(self.state.borrow().clone())
    }

    async fn turn_off(&self) {
        self.backfill_wanted.store(false, Ordering::Release);
        stop(&self.task).await;
        stop(&self.backfill).await;
        self.owner.disable().await;
        self.state.send_replace(idle_view(Choice::Off));
        let root = self.root.clone();
        let removed = tokio::task::spawn_blocking(move || choice::remove_model(&root)).await;
        if let Ok(Err(code)) = removed {
            butler_core::diagnostic!("[memory-model] off: model files kept ({code})");
        }
    }

    /// Ready enables the owner; after an explicit switch to on it also backfills once.
    fn watch_ready(&self, consumer: Arc<MemorySyncConsumer>) -> JoinHandle<()> {
        let mut progress = self.state.subscribe();
        let (choice, owner) = (self.choice.clone(), self.owner.clone());
        let (wanted, backfill) = (self.backfill_wanted.clone(), self.backfill.clone());
        tokio::spawn(async move {
            while progress.changed().await.is_ok() {
                if progress.borrow_and_update().state != "ready" {
                    continue;
                }
                {
                    // Held across enable so a concurrent switch to off cannot be undone.
                    let current = choice.lock();
                    if *current != Choice::On {
                        continue;
                    }
                    owner.enable();
                }
                butler_memory::cognition::signal_memory_work();
                if wanted.swap(false, Ordering::AcqRel) {
                    start_backfill(&backfill, consumer.clone());
                }
            }
        })
    }

    pub(crate) async fn close(&self) {
        if let Some(watcher) = self.watcher.lock().take() {
            watcher.abort();
        }
        stop(&self.task).await;
        stop(&self.backfill).await;
    }
}

impl Drop for Acquisition {
    fn drop(&mut self) {
        for slot in [&self.task, &self.backfill] {
            if let Some((stop, _)) = slot.lock().take() {
                stop.cancel();
            }
        }
        if let Some(watcher) = self.watcher.get_mut().take() {
            watcher.abort();
        }
    }
}

/// Unset and off advertise the download size so the choice can show it.
fn idle_view(choice: Choice) -> MemoryModelProgress {
    let total = if choice == Choice::On {
        0
    } else {
        pinned_assets().iter().map(|asset| asset.bytes).sum()
    };
    MemoryModelProgress {
        state: choice.idle_state().into(),
        bytes_done: 0,
        bytes_total: total,
        reason: None,
    }
}

/// Embeds the units written without the model, in the background; chat never waits.
fn start_backfill(slot: &Slot, consumer: Arc<MemorySyncConsumer>) {
    let stop = CancellationToken::new();
    let cancelled = stop.clone();
    let task = tokio::spawn(async move {
        match consumer.drain_vectors(&cancelled).await {
            Ok(()) => butler_core::diagnostic!("[memory-model] backfill complete"),
            Err(error) => butler_core::diagnostic!("[memory-model] backfill {}", error.code()),
        }
    });
    if let Some((previous, _)) = slot.lock().replace((stop, task)) {
        previous.cancel();
    }
}

async fn stop(slot: &Slot) {
    let task = slot.lock().take();
    if let Some((stop, task)) = task {
        stop.cancel();
        let _ = task.await;
    }
}
