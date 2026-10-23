//! No polling: bootstrap once, then react to committed BTCC changes.
use butler_turn::btcc::{BtccStorage, SubsessionService};
use butler_work::store;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(crate) async fn run(
    storage: BtccStorage,
    service: Arc<SubsessionService>,
    stop: CancellationToken,
) {
    let mut changes = storage.subscribe_changes();
    loop {
        changes.borrow_and_update();
        let result = async {
            if let Err(error) = service.reconcile_handoffs().await {
                butler_core::diagnostic!(
                    "[task-sessions] handoff reconcile failed code={}",
                    error.code()
                );
            }
            let ready = storage.work_model_read(store::ready_starts).await?;
            for task in ready {
                if let Err(error) = service.start_task_session(task).await {
                    butler_core::diagnostic!(
                        "[task-sessions] assignment failed code={}",
                        error.code()
                    );
                }
            }
            Ok::<(), butler_turn::btcc::StorageError>(())
        };
        tokio::select! {
            ()=stop.cancelled()=>return,
            result=result=>if let Err(error)=result { tracing::error!(%error,"Task scheduler read failed"); }
        }
        tokio::select! { ()=stop.cancelled()=>return, result=changes.changed()=>if result.is_err(){return;} }
    }
}
