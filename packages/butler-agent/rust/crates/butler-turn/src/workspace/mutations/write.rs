use super::contracts::{
    CommitObserver, CommittedFile, GuardedPath, MutationFailure, WriteMutation,
};
use super::{failure, io};

pub(super) fn execute(
    input: WriteMutation,
    path: GuardedPath,
    observer: &dyn CommitObserver,
) -> Result<CommittedFile, MutationFailure> {
    let snapshot = io::observe(path, input.create_parents)?;
    if snapshot.exists && !input.overwrite {
        let mut failed = failure::new(Some(snapshot.path.public.clone()), "file_exists");
        failed.before_sha256 = snapshot.sha256;
        return Err(failed);
    }
    if !snapshot.exists && input.overwrite {
        let mut failed = failure::new(Some(snapshot.path.public.clone()), "invalid_arguments");
        failed.message = "Creation requires overwrite=false.".into();
        failed.recovery_hint = "Retry creation with overwrite=false.".into();
        return Err(failed);
    }
    let prepared = io::prepare(
        snapshot,
        input.content.into_bytes(),
        input.expected_sha256.as_deref(),
        true,
    )?;
    if input.create_parents {
        io::ensure_parent(&prepared, &input.context.root)?;
    } else {
        // The observation checked an existing parent; recheck after preparation.
        io::ensure_existing_parent(&prepared.before.path)?;
    }
    io::commit(prepared, observer)
}
