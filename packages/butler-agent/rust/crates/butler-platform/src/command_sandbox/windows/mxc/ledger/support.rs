//! Native ledger controls, compiled only for isolated E2E fixtures.
use super::*;
pub(in crate::command_sandbox) fn operate(root: &Path, operation: &str) -> io::Result<()> {
    let ledger = registry::get(root, &[])?;
    match operation {
        "verify" => {
            let mut state = current(&ledger, false, false)?;
            state.verified_at = Instant::now().checked_sub(VERIFY_INTERVAL);
            drop(state);
            drop(current(&ledger, true, false)?);
        }
        "native-overflow" | "completions" | "changes" => lock(&ledger)?
            .feed
            .exercise(operation.strip_prefix("native-").unwrap_or(operation))?,
        "lose-journal" => lock(&ledger)?.feed.lose_journal()?,
        "overflow" => lock(&ledger)?.stale = Some("injected notification overflow".into()),
        "age" => lock(&ledger)?.verified_at = Instant::now().checked_sub(VERIFY_INTERVAL),
        _ => return Err(io::Error::other("unknown ledger fixture operation")),
    }
    Ok(())
}
pub(in crate::command_sandbox) fn aliases(root: &Path) -> io::Result<Vec<Vec<PathBuf>>> {
    let ledger = registry::get(root, &[])?;
    let state = lock(&ledger)?;
    let canonical = crate::secure_fs::canonicalize_extended(root)?;
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
    super::admit(root, &[], &[], &denied)
}
pub(in crate::command_sandbox) fn tree(root: &Path) -> io::Result<Vec<PathBuf>> {
    Ok(
        crate::command_sandbox::project_secrets::portable::tree::walk(root, false)?
            .into_iter()
            .map(|p| root.join(p))
            .collect(),
    )
}

type Pause = Arc<(Mutex<(bool, bool)>, Condvar)>;
static PAUSES: std::sync::OnceLock<Mutex<std::collections::HashMap<(PathBuf, bool), Pause>>> =
    std::sync::OnceLock::new();
pub(in crate::command_sandbox) fn pause(
    root: &Path,
    paused: bool,
    after_scan: bool,
) -> io::Result<()> {
    let key = (crate::secure_fs::canonicalize_extended(root)?, after_scan);
    let mut pauses = PAUSES
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| io::Error::other("pause poisoned"))?;
    if paused {
        pauses.insert(key, Arc::new((Mutex::new((true, false)), Condvar::new())));
    } else if let Some(pause) = pauses.remove(&key) {
        pause
            .0
            .lock()
            .map_err(|_| io::Error::other("pause poisoned"))?
            .0 = false;
        pause.1.notify_all();
    }
    Ok(())
}
pub(super) fn wait(roots: &[PathBuf], after_scan: bool) {
    let Some(pauses) = PAUSES.get() else {
        return;
    };
    let pause = pauses.lock().ok().and_then(|p| {
        roots
            .iter()
            .find_map(|r| p.get(&(r.clone(), after_scan)).cloned())
    });
    if let Some(pause) = pause
        && let Ok(mut guard) = pause.0.lock()
    {
        guard.1 = true;
        // A failed test must not leak a permanently blocked verifier.
        let _ = pause
            .1
            .wait_timeout_while(guard, Duration::from_secs(5), |state| state.0);
    }
}

pub(in crate::command_sandbox) fn verified_files(root: &Path) -> io::Result<usize> {
    let ledger = registry::get(root, &[])?;
    Ok(lock(&ledger)?.verified_files)
}

pub(in crate::command_sandbox) fn commit_paused(root: &Path) -> io::Result<bool> {
    let key = (crate::secure_fs::canonicalize_extended(root)?, true);
    let pause = PAUSES.get().and_then(|p| p.lock().ok()?.get(&key).cloned());
    Ok(pause.is_some_and(|p| p.0.lock().is_ok_and(|s| s.1)))
}
