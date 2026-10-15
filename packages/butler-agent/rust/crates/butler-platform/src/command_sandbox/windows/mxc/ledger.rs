//! Session-only alias ledger. All entrypoints run off Tokio workers.
mod inventory;
mod registry;
mod scan;
#[cfg(feature = "test-support")]
pub(in crate::command_sandbox) mod support;
mod watch;
use crate::command_sandbox::mxc_policy::WinPath;
use inventory::Inventory;
use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};
use watch::{Event, Feed};

// Inside-root aliases are refused at the very next admission. An outside-root
// alias of an in-project file is refused at the next admission >= T after the
// last full verify, or after the next post-run verify. The contained process
// itself cannot create such a link. This is the accepted external-alias window.
const VERIFY_INTERVAL: Duration = Duration::from_secs(120);
const WAIT: Duration = Duration::from_secs(2);
struct Ledger {
    inner: Mutex<State>,
    completed: Condvar,
}
struct State {
    #[cfg(feature = "test-support")]
    verified_files: usize,
    roots: Vec<PathBuf>,
    protected: Vec<WinPath>,
    inventory: Inventory,
    feed: Feed,
    verified_at: Option<Instant>,
    verifying: bool,
    stale: Option<String>,
    generation: u64,
    last_used: Instant,
}
pub(in crate::command_sandbox) struct Admission {
    pub secrets: Vec<PathBuf>,
    pub generation: u64,
}
fn pending() -> io::Error {
    io::Error::new(io::ErrorKind::WouldBlock, "project write inventory pending")
}
fn lock(ledger: &Ledger) -> io::Result<std::sync::MutexGuard<'_, State>> {
    ledger
        .inner
        .lock()
        .map_err(|_| io::Error::other("ledger state poisoned"))
}

pub(in crate::command_sandbox) fn admit(
    root: &Path,
    scratch: &[PathBuf],
    protected: &[WinPath],
    denied: &[WinPath],
) -> io::Result<Admission> {
    let ledger = registry::get(root, scratch)?;
    let mut state = current(&ledger, true)?;
    let _phase = super::timing::Phase::start("ledger_sync");
    state.protected = protected.to_vec();
    let roots = state.roots.clone();
    state.inventory.reclassify(&roots, protected);
    sync(&mut state)?;
    refresh_aliases(&mut state)?;
    if !state.inventory.aliases().is_empty() {
        return Err(io::Error::other(
            "project_write_link_aliases: hard links reach uninspected or protected entries",
        ));
    }
    let secrets = project_secrets(root, &state)?;
    for secret in &secrets {
        let name = super::prepare::physical(secret).map_err(|e| io::Error::other(e.to_string()))?;
        if !denied.iter().any(|p| name.is_within(p)) {
            return Err(io::Error::other("secret inventory changed"));
        }
    }
    Ok(Admission {
        secrets,
        generation: state.generation,
    })
}

pub(in crate::command_sandbox) fn secrets(root: &Path) -> io::Result<Vec<PathBuf>> {
    let ledger = registry::get(root, &[])?;
    let mut state = current(&ledger, false)?;
    let _phase = super::timing::Phase::start("ledger_sync");
    sync(&mut state)?;
    project_secrets(root, &state)
}
fn project_secrets(root: &Path, state: &State) -> io::Result<Vec<PathBuf>> {
    let canonical = fs::canonicalize(root)?;
    Ok(state
        .inventory
        .secrets
        .iter()
        .filter_map(|p| p.strip_prefix(&canonical).ok())
        .map(|p| root.join(p))
        .collect())
}
fn current(ledger: &Arc<Ledger>, verify_age: bool) -> io::Result<std::sync::MutexGuard<'_, State>> {
    let deadline = Instant::now() + WAIT;
    let mut state = lock(ledger)?;
    state.last_used = Instant::now();
    let needs = state.stale.is_some()
        || state.verified_at.is_none()
        || (verify_age
            && state
                .verified_at
                .is_some_and(|at| at.elapsed() >= VERIFY_INTERVAL));
    if needs && !state.verifying {
        start_verify(ledger, &mut state)?;
    }
    while state.verifying {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(pending());
        }
        state = ledger
            .completed
            .wait_timeout(state, remaining)
            .map_err(|_| io::Error::other("ledger wait poisoned"))?
            .0;
    }
    if let Some(reason) = &state.stale {
        return Err(io::Error::other(reason.clone()));
    }
    Ok(state)
}
fn start_verify(ledger: &Arc<Ledger>, state: &mut State) -> io::Result<()> {
    let rebuilding = state.verified_at.is_none() || state.stale.is_some();
    if state.stale.is_some() {
        state.feed = Feed::start(&state.roots)?;
    }
    state.feed.begin_verify()?;
    state.verifying = true;
    let (roots, protected, ledger) = (
        state.roots.clone(),
        state.protected.clone(),
        Arc::clone(ledger),
    );
    let spawned = std::thread::Builder::new()
        .name("project ledger verify".into())
        .spawn(move || {
            let _phase = super::timing::Phase::start(if rebuilding {
                "ledger_build"
            } else {
                "ledger_verify"
            });
            #[cfg(feature = "test-support")]
            support::wait(&roots, false);
            let result = std::panic::catch_unwind(|| scan::walk(&roots, &roots, &protected))
                .unwrap_or_else(|_| Err(io::Error::other("ledger build panic")));
            #[cfg(feature = "test-support")]
            support::wait(&roots, true);
            if let Ok(mut state) = lock(&ledger) {
                let result = result.and_then(|inventory| {
                    // Keep the old inventory until the full scan AND queued delta succeed.
                    #[cfg(feature = "test-support")]
                    let verified_files = inventory.opened_files;
                    let mut fresh = inventory;
                    let replay = state.feed.finish_verify()?;
                    apply(&state.feed, &roots, &protected, &mut fresh, replay)?;
                    state.inventory = fresh;
                    #[cfg(feature = "test-support")]
                    {
                        state.verified_files = verified_files;
                    }
                    state.verified_at = Some(Instant::now());
                    state.generation += 1;
                    Ok(())
                });
                state.stale = result.err().map(|e| e.to_string());
                state.verifying = false;
                ledger.completed.notify_all();
            }
        });
    if let Err(error) = spawned {
        state.verifying = false;
        state.stale = Some(error.to_string());
        return Err(error);
    }
    Ok(())
}
fn sync(state: &mut State) -> io::Result<()> {
    if let Some(reason) = &state.stale {
        return Err(io::Error::other(reason.clone()));
    }
    let result = apply(
        &state.feed,
        &state.roots,
        &state.protected,
        &mut state.inventory,
        Vec::new(),
    );
    if let Err(error) = &result {
        state.stale = Some(error.to_string());
    }
    if result.is_ok() {
        state.generation += 1;
    }
    result
}
fn apply(
    feed: &Feed,
    roots: &[PathBuf],
    protected: &[WinPath],
    inventory: &mut Inventory,
    mut events: Vec<Event>,
) -> io::Result<()> {
    let deadline = Instant::now() + WAIT;
    loop {
        if events.is_empty() {
            events = feed.drain()?;
        }
        if events.is_empty() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(pending());
        }
        let changes_phase = super::timing::Phase::start("ledger_changes");
        let mut added = HashSet::new();
        let mut removed = HashSet::new();
        for event in std::mem::take(&mut events) {
            match event {
                Event::Added(path) => {
                    removed.insert(path.as_os_str().to_owned());
                    added.insert(path.into_os_string());
                }
                Event::Removed(path) => {
                    removed.insert(path.as_os_str().to_owned());
                    added.retain(|p| !Path::new(p).starts_with(&path));
                }
                Event::Rescan => return Err(io::Error::other("ledger notification overflow")),
                Event::Lost => return Err(io::Error::other("ledger watcher lost")),
            }
        }
        inventory.remove_all(&removed);
        // Directory renames remove the old prefix and rescan the new prefix.
        // Coalesce descendants already covered by an added directory.
        let paths: Vec<_> = added
            .iter()
            .filter(|p| {
                !Path::new(p)
                    .ancestors()
                    .skip(1)
                    .take_while(|a| !roots.iter().any(|r| r == a))
                    .any(|a| added.contains(a.as_os_str()))
            })
            .map(PathBuf::from)
            .collect();
        drop(changes_phase);
        let _scan_phase = super::timing::Phase::start("ledger_delta_scan");
        inventory.merge(scan::walk(&paths, roots, protected)?);
    }
}
fn refresh_aliases(state: &mut State) -> io::Result<()> {
    let paths: Vec<_> = state.inventory.aliases().into_iter().flatten().collect();
    if paths.is_empty() || paths.len() > 2_000 {
        return Ok(());
    }
    let result = scan::walk(&paths, &state.roots, &state.protected);
    match result {
        Ok(fresh) => {
            for path in paths {
                state.inventory.remove(&path);
            }
            state.inventory.merge(fresh);
            Ok(())
        }
        Err(error) => {
            state.stale = Some(error.to_string());
            Err(error)
        }
    }
}

pub(in crate::command_sandbox) fn sweep(
    root: &Path,
    since: &[PathBuf],
    data: &Path,
) -> io::Result<Vec<PathBuf>> {
    let ledger = registry::get(root, &[])?;
    let found = {
        let mut state = lock(&ledger)?;
        if state.verified_at.is_none() || sync(&mut state).is_err() {
            crate::command_sandbox::project_secrets::portable::tree::walk(root, false)?
                .into_iter()
                .map(|p| root.join(p))
                .collect()
        } else {
            project_secrets(root, &state)?
        }
    };
    let result =
        crate::command_sandbox::project_secrets::portable::quarantine_new(root, since, data, found);
    let mut state = lock(&ledger)?;
    if !state.verifying
        && (state.stale.is_some()
            || state
                .verified_at
                .is_none_or(|at| at.elapsed() >= VERIFY_INTERVAL))
    {
        start_verify(&ledger, &mut state)?;
    }
    result
}
