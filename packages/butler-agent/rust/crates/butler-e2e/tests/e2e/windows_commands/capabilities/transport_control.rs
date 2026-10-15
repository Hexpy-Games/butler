//! Independent no-op HTTP and scheduling observations during the actual sample.
use butler_e2e::e2e::{HarnessError, gateway::Gateway};
use std::{
    io, thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::watch;

const PERIOD: Duration = Duration::from_millis(20);

pub(super) struct Control {
    stop: watch::Sender<bool>,
    worker: Option<thread::JoinHandle<Result<(), HarnessError>>>,
}

impl Control {
    pub(super) fn start(gateway: &Gateway) -> io::Result<Self> {
        let base = gateway.base.clone();
        let token = gateway.token.clone();
        let (stop, receiver) = watch::channel(false);
        let (ready, initialized) = std::sync::mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("e2e-noop-control".into())
            .spawn(move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()?
                    .block_on(run(base, token, receiver, ready))
            })?;
        let control = Self {
            stop,
            worker: Some(worker),
        };
        initialized.recv().map_err(io::Error::other)?;
        Ok(control)
    }

    pub(super) async fn finish(mut self) -> Result<(), HarnessError> {
        self.stop.send_replace(true);
        let worker = self.worker.take().expect("owned control thread");
        tokio::task::spawn_blocking(move || worker.join())
            .await
            .map_err(io::Error::other)?
            .map_err(|_| io::Error::other("no-op control thread panicked"))?
    }
}

impl Drop for Control {
    fn drop(&mut self) {
        self.stop.send_replace(true);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

async fn run(
    base: String,
    token: String,
    mut stop: watch::Receiver<bool>,
    ready: std::sync::mpsc::SyncSender<()>,
) -> Result<(), HarnessError> {
    // Own this client's runtime and connection: the scenario's log printing or
    // callback work must not delay the scheduling control on its executor.
    let gateway = Gateway::new(base, token);
    ready.send(()).map_err(io::Error::other)?;
    let mut expected = Instant::now();
    let mut observations = Observations(Vec::new());
    loop {
        let started = Instant::now();
        let wake = started.saturating_duration_since(expected);
        let utc = unix_us();
        tokio::select! {
            biased;
            _ = stop.changed() => break,
            reply = health(&gateway) => reply?,
        };
        let elapsed = started.elapsed();
        observations.0.push(Observation {
            start: utc,
            end: unix_us(),
            elapsed,
            wake,
        });
        expected = Instant::now() + PERIOD;
        tokio::select! {
            biased;
            _ = stop.changed() => break,
            () = tokio::time::sleep(PERIOD) => {},
        }
    }
    Ok(())
}

fn unix_us() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros()
}

async fn health(gateway: &Gateway) -> Result<(), HarnessError> {
    // Bypass Gateway's optional timing logger: no shared stderr lock may stall
    // this independent control while the scenario prints its diagnostics.
    let response = gateway
        .http()
        .get(format!("{}/health", gateway.base))
        .bearer_auth(&gateway.token)
        .send()
        .await?;
    assert_eq!(response.status().as_u16(), 200, "complete no-op response");
    let body: serde_json::Value = response.json().await?;
    assert_eq!(body["data"]["ok"], true, "correct no-op response");
    Ok(())
}

struct Observation {
    start: u128,
    end: u128,
    elapsed: Duration,
    wake: Duration,
}
struct Observations(Vec<Observation>);
impl Drop for Observations {
    fn drop(&mut self) {
        let mut max_http = Duration::ZERO;
        let mut max_wake = Duration::ZERO;
        for sample in &self.0 {
            max_http = max_http.max(sample.elapsed);
            max_wake = max_wake.max(sample.wake);
            eprintln!(
                "REFUSAL-CONTROL-LIVE start_utc_us={} end_utc_us={} http_us={} wake_late_us={}",
                sample.start,
                sample.end,
                sample.elapsed.as_micros(),
                sample.wake.as_micros()
            );
        }
        eprintln!(
            "REFUSAL-CONTROL-LIVE-SUMMARY n={} max_http_us={} max_wake_late_us={}",
            self.0.len(),
            max_http.as_micros(),
            max_wake.as_micros()
        );
    }
}
