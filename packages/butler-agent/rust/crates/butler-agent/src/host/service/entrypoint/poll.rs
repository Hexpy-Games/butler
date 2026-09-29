//! The service's poll loop: inbound dispatch, maintenance and the stop
//! conditions (a stop request, the shutdown flag, the App's foreground lease,
//! or an interrupted turn that needs a new process).

use std::sync::Arc;
use std::time::Duration;

use tokio::{sync::oneshot, task::JoinSet, time::MissedTickBehavior};

use butler_turn::btcc::BtccError;

use super::ServiceLogMode;
use super::maintenance::{
    maintenance_join_result, run_service_maintenance, unexpected_maintenance_exit,
};
use super::stop_signal::StopSignal;
use super::support::{failure, io};
use crate::host::app::gateway_lifecycle::ActiveAppEndpoint;
use crate::host::service::foreground_lease::ForegroundLease;
use crate::host::service::ingress::IngressDispatcher;
use crate::host::{ProgressPublisher, ServiceConfiguration};

const INBOUND_QUEUE_FALLBACK_POLL: Duration = Duration::from_millis(500);

/// What the poll loop drives.
pub(super) struct PollOwners<'a> {
    pub(super) dispatcher: &'a IngressDispatcher,
    pub(super) queue: Arc<butler_gateway::gateway::InboundQueue>,
    pub(super) progress: Arc<ProgressPublisher>,
    pub(super) config: &'a ServiceConfiguration,
    pub(super) subsessions: &'a butler_turn::btcc::SqliteSubsessionRepository,
    pub(super) parent_client: &'a reqwest::Client,
    pub(super) app_endpoint: &'a ActiveAppEndpoint,
    pub(super) logs: ServiceLogMode,
}

/// What ends the poll loop besides a failure.
pub(super) struct PollShutdown<'a> {
    pub(super) stop: &'a StopSignal,
    pub(super) foreground_lease: Option<ForegroundLease>,
}

pub(super) async fn poll_service(
    owners: PollOwners<'_>,
    shutdown: PollShutdown<'_>,
) -> Result<(), BtccError> {
    let PollOwners {
        dispatcher,
        queue,
        progress,
        config,
        subsessions,
        parent_client,
        app_endpoint,
        logs,
    } = owners;
    let PollShutdown {
        stop,
        foreground_lease,
    } = shutdown;
    let shutdown_flag = crate::host::service::instance::shutdown_flag_path(&config.data_root);
    let (stop_maintenance, maintenance_stop) = oneshot::channel();
    let mut maintenance = JoinSet::new();
    maintenance.spawn(run_service_maintenance(
        progress,
        parent_client.clone(),
        subsessions.clone(),
        app_endpoint.clone(),
        maintenance_stop,
    ));
    let mut fallback_poll = tokio::time::interval_at(
        tokio::time::Instant::now() + INBOUND_QUEUE_FALLBACK_POLL,
        INBOUND_QUEUE_FALLBACK_POLL,
    );
    fallback_poll.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let result = loop {
        if stop.requested() || stop.flag_requested(&shutdown_flag) {
            stop.request();
            break Ok(());
        }
        let summary = match dispatcher.poll().await {
            Ok(summary) => summary,
            Err(error) => break Err(failure(error.code, error.message)),
        };
        if summary.claimed + summary.handled + summary.failed + summary.interrupted > 0 {
            logs.write(&format!(
                "[inbound-queue] claimed={} handled={} delivered={} failed={} interrupted={}",
                summary.claimed,
                summary.handled,
                summary.delivered,
                summary.failed,
                summary.interrupted
            ));
        }
        if summary.interrupted > 0 {
            // Unrequested: non-zero, so launchd and systemd start a new one.
            break Err(failure(
                "native_service_replacement_required",
                "an interrupted turn needs a new service process",
            ));
        }
        tokio::select! {
            () = stop.wait() => break Ok(()),
            lease = wait_for_foreground_close(foreground_lease.as_ref()), if foreground_lease.is_some() => {
                // The App released its lease: a requested stop.
                break lease.map(|()| stop.request()).map_err(io);
            },
            joined = maintenance.join_next() => break unexpected_maintenance_exit(joined),
            () = queue.wait_for_enqueue() => {},
            _ = fallback_poll.tick() => {},
        }
    };
    let _ = stop_maintenance.send(());
    let maintenance_result = match maintenance.join_next().await {
        Some(joined) => maintenance_join_result(joined),
        None => Ok(()),
    };
    result.and(maintenance_result)
}

async fn wait_for_foreground_close(
    lease: Option<&ForegroundLease>,
) -> Result<(), crate::host::HostError> {
    match lease {
        Some(lease) => lease.closed().await,
        None => std::future::pending().await,
    }
}
