//! Native ledger controls, compiled only for isolated E2E fixtures.
use super::*;
pub(in crate::command_sandbox) fn operate(root: &Path, operation: &str) -> io::Result<()> {
    let ledger = registry::get(root, &[])?;
    match operation {
        "verify" => {
            let mut state = current(&ledger, false)?;
            state.verified_at = Instant::now().checked_sub(VERIFY_INTERVAL);
            drop(state);
            drop(current(&ledger, true)?);
        }
        "overflow" => lock(&ledger)?.stale = Some("injected notification overflow".into()),
        "age" => lock(&ledger)?.verified_at = Instant::now().checked_sub(VERIFY_INTERVAL),
        _ => return Err(io::Error::other("unknown ledger fixture operation")),
    }
    Ok(())
}
pub(in crate::command_sandbox) fn aliases(root: &Path) -> io::Result<Vec<Vec<PathBuf>>> {
    let ledger = registry::get(root, &[])?;
    let state = lock(&ledger)?;
    let canonical = fs::canonicalize(root)?;
    Ok(state
        .inventory
        .aliases()
        .into_iter()
        .map(|group| {
            group
                .into_iter()
                .map(|path| {
                    path.strip_prefix(&canonical)
                        .map_or_else(|_| path.clone(), |relative| root.join(relative))
                })
                .collect()
        })
        .collect())
}
pub(in crate::command_sandbox) fn snapshot(root: &Path) -> io::Result<(u64, bool)> {
    let ledger = registry::get(root, &[])?;
    let state = lock(&ledger)?;
    Ok((
        state.verified_at.map_or(u64::MAX, |at| {
            u64::try_from(at.elapsed().as_millis()).unwrap_or(u64::MAX)
        }),
        state.verifying,
    ))
}
pub(in crate::command_sandbox) fn admit(root: &Path, denied: &[PathBuf]) -> io::Result<()> {
    let denied = denied
        .iter()
        .map(|p| super::super::prepare::physical(p).map_err(|e| io::Error::other(e.to_string())))
        .collect::<io::Result<Vec<_>>>()?;
    super::admit(root, &[], &[], &denied).map(|_| ())
}
pub(in crate::command_sandbox) fn tree(root: &Path) -> io::Result<Vec<PathBuf>> {
    Ok(
        crate::command_sandbox::project_secrets::portable::tree::walk(root, false)?
            .into_iter()
            .map(|p| root.join(p))
            .collect(),
    )
}

type Pause = Arc<(Mutex<bool>, Condvar)>;
static PAUSES: std::sync::OnceLock<Mutex<std::collections::HashMap<PathBuf, Pause>>> =
    std::sync::OnceLock::new();
pub(in crate::command_sandbox) fn pause(root: &Path, paused: bool) -> io::Result<()> {
    let key = fs::canonicalize(root)?;
    let mut pauses = PAUSES
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| io::Error::other("pause poisoned"))?;
    if paused {
        pauses.insert(key, Arc::new((Mutex::new(true), Condvar::new())));
    } else if let Some(pause) = pauses.remove(&key) {
        *pause
            .0
            .lock()
            .map_err(|_| io::Error::other("pause poisoned"))? = false;
        pause.1.notify_all();
    }
    Ok(())
}
pub(super) fn wait(roots: &[PathBuf]) {
    let Some(pauses) = PAUSES.get() else {
        return;
    };
    let pause = pauses
        .lock()
        .ok()
        .and_then(|p| roots.iter().find_map(|r| p.get(r).cloned()));
    if let Some(pause) = pause
        && let Ok(guard) = pause.0.lock()
    {
        // A failed test must not leak a permanently blocked verifier.
        let _ = pause
            .1
            .wait_timeout_while(guard, Duration::from_secs(5), |paused| *paused);
    }
}

pub(in crate::command_sandbox) fn verified_files(root: &Path) -> io::Result<usize> {
    let ledger = registry::get(root, &[])?;
    Ok(lock(&ledger)?.verified_files)
}
