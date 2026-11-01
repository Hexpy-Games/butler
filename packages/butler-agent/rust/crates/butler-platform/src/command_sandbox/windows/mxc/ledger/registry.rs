//! One registry per process. Timed eviction releases idle directory handles.
use super::*;
use std::{collections::HashMap, sync::OnceLock};
const IDLE: Duration = Duration::from_mins(15);
struct Registry {
    entries: Mutex<HashMap<PathBuf, Arc<Ledger>>>,
    changed: Condvar,
}
static REGISTRY: OnceLock<Registry> = OnceLock::new();
fn registry() -> &'static Registry {
    REGISTRY.get_or_init(|| {
        std::thread::spawn(evict);
        Registry {
            entries: Mutex::new(HashMap::new()),
            changed: Condvar::new(),
        }
    })
}
fn evict() {
    // Initialization is complete before this accessor can return.
    let registry = registry();
    let Ok(mut entries) = registry.entries.lock() else {
        return;
    };
    loop {
        entries.retain(|_, ledger| {
            lock(ledger).is_ok_and(|s| s.verifying || s.last_used.elapsed() < IDLE)
        });
        let delay = entries
            .values()
            .filter_map(|ledger| {
                lock(ledger).ok().map(|s| {
                    if s.verifying {
                        IDLE
                    } else {
                        IDLE.saturating_sub(s.last_used.elapsed())
                    }
                })
            })
            .min()
            .unwrap_or(IDLE);
        let Ok((next, _)) = registry.changed.wait_timeout(entries, delay) else {
            return;
        };
        entries = next;
    }
}
pub(super) fn get(root: &Path, scratch: &[PathBuf]) -> io::Result<Arc<Ledger>> {
    let canonical = crate::secure_fs::canonicalize_extended(root)?;
    let mut roots = vec![canonical.clone()];
    for path in scratch {
        roots.push(crate::secure_fs::canonicalize_extended(path)?);
    }
    roots.sort();
    roots.dedup();
    // Never count overlapping grants twice.
    roots = roots
        .iter()
        .filter(|p| {
            !roots
                .iter()
                .any(|other| *p != other && p.starts_with(other))
        })
        .cloned()
        .collect();
    let registry = registry();
    let mut entries = registry
        .entries
        .lock()
        .map_err(|_| io::Error::other("ledger registry poisoned"))?;
    if let Some(ledger) = entries.get(&canonical).cloned() {
        let mut state = lock(&ledger)?;
        state.last_used = Instant::now();
        let replace = !scratch.is_empty() && state.roots.iter().any(|p| !roots.contains(p));
        let additional: Vec<_> = roots
            .iter()
            .filter(|p| !state.roots.iter().any(|r| p.starts_with(r)))
            .cloned()
            .collect();
        drop(state);
        drop(entries);
        registry.changed.notify_one();
        if replace {
            let mut state = current(&ledger, false, true)?;
            state.feed = Feed::start(&roots)?;
            state.roots = roots;
            state.stale = Some("ledger writable roots changed".into());
        } else if !additional.is_empty() {
            let mut state = current(&ledger, false, true)?;
            state.feed.extend(&additional)?;
            state.roots.extend(additional.clone());
            let result = scan::walk(&additional, &state.roots, &state.protected);
            match result {
                Ok(inventory) => state.inventory.merge(inventory),
                Err(error) => {
                    state.stale = Some(error.to_string());
                    return Err(error);
                }
            }
        }
        return Ok(ledger);
    }
    let feed = Feed::start(&roots)?;
    let ledger = Arc::new(Ledger {
        inner: Mutex::new(State {
            #[cfg(feature = "test-support")]
            verified_files: 0,
            roots,
            protected: Vec::new(),
            inventory: Inventory::default(),
            feed,
            verified_at: None,
            verifying: false,
            stale: None,
            scan_rate: None,
            last_used: Instant::now(),
        }),
        completed: Condvar::new(),
    });
    entries.insert(canonical, Arc::clone(&ledger));
    registry.changed.notify_one();
    Ok(ledger)
}
