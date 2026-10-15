//! Native footprint sampling of the isolated agent, including transient ingest allocations.
use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub(super) struct PeakMemory {
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<std::io::Result<u64>>>,
    baseline: u64,
    footprint_equivalent: bool,
}
impl PeakMemory {
    pub(super) fn start(pid: u32) -> Self {
        let usage = butler_platform::process_control::usage::sample(pid)
            .unwrap()
            .unwrap();
        let footprint_equivalent = usage.footprint_bytes.is_some();
        let baseline = sample(pid).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let worker = std::thread::spawn(move || {
            let mut peak = baseline;
            while !done.load(Ordering::Acquire) {
                peak = peak.max(sample(pid)?);
                std::thread::sleep(Duration::from_millis(5));
            }
            Ok(peak.max(sample(pid)?))
        });
        Self {
            stop,
            worker: Some(worker),
            baseline,
            footprint_equivalent,
        }
    }
    pub(super) fn finish(self, budget: u64) {
        let (baseline, peak) = self.measure();
        let delta = peak.saturating_sub(baseline);
        assert!(delta <= budget, "peak footprint growth {delta} > {budget}");
    }
    pub(super) fn finish_peak(self, budget: u64) {
        let equivalent = self.footprint_equivalent;
        let (_, peak) = self.measure();
        if !equivalent {
            eprintln!(
                "SKIP absolute footprint budget: platform supplies PSS/RSS, not physical footprint; no comparable main baseline"
            );
            return;
        }
        assert!(peak <= budget, "peak footprint {peak} > {budget}");
    }
    pub(super) fn measure(mut self) -> (u64, u64) {
        self.stop.store(true, Ordering::Release);
        let peak = self.worker.take().unwrap().join().unwrap().unwrap();
        eprintln!(
            "usage memory: baseline={} peak={peak} delta={}",
            self.baseline,
            peak.saturating_sub(self.baseline)
        );
        (self.baseline, peak)
    }
}
impl Drop for PeakMemory {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn sample(pid: u32) -> std::io::Result<u64> {
    butler_platform::process_control::usage::sample(pid)?
        .map(|usage| {
            usage
                .footprint_bytes
                .or(usage.proportional_bytes)
                .unwrap_or(usage.resident_bytes)
        })
        .ok_or_else(|| std::io::Error::other("native memory sampling unavailable"))
}
