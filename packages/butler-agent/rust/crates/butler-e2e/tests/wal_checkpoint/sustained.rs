//! Continuous commits while a bounded neighboring file creates CPU/I/O pressure.
use super::*;
use std::{
    io::{Seek, SeekFrom, Write},
    sync::{Arc, atomic::AtomicBool},
    thread::{self, JoinHandle},
    time::Instant,
};

struct Pressure {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl Pressure {
    fn start(path: &Path) -> Self {
        let mut file = File::create(path).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let (ready, started) = mpsc::sync_channel(0);
        let thread = thread::spawn(move || {
            let mut bytes = vec![0_u8; 1024 * 1024];
            ready.send(()).unwrap();
            while !stopping.load(SeqCst) {
                for byte in &mut bytes {
                    *byte = std::hint::black_box(byte.wrapping_add(1));
                }
                file.seek(SeekFrom::Start(0)).unwrap();
                file.write_all(&bytes).unwrap();
                file.sync_all().unwrap();
            }
        });
        started.recv().unwrap();
        Self {
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for Pressure {
    fn drop(&mut self) {
        self.stop.store(true, SeqCst);
        self.thread.take().unwrap().join().unwrap();
    }
}

#[test]
fn sustained_writes_bound_active_wal_under_cpu_and_io_pressure()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().unwrap();
    LAST.store(0, SeqCst);
    MAX.store(0, SeqCst);
    RESTARTS.store(0, SeqCst);
    let store = Store::new();
    let pressure = Pressure::start(&store.path.with_extension("pressure"));
    let owner = store.worker();
    let mut peak = 0;
    let mut timings = Vec::with_capacity(20_000);
    for _ in 0..20_000 {
        let started = Instant::now();
        store.insert();
        timings.push(started.elapsed().as_micros());
        peak = peak.max(store.bytes());
    }
    owner.close().unwrap();
    drop(pressure);
    store.counts(20_000);
    timings.sort_unstable();
    eprintln!(
        "sustained WAL: commits=20000 peak_bytes={peak} restarts={} \
        commit_us p50={} p99={} max={}",
        RESTARTS.load(SeqCst),
        timings[9999].midpoint(timings[10000]),
        timings[19799],
        timings[19999]
    );
    assert!(peak <= JOURNAL_LIMIT, "active sustained WAL grew to {peak}");
    assert!(RESTARTS.load(SeqCst) > 0);
    Ok(())
}
