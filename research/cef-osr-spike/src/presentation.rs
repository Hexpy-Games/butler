use core_foundation::base::TCFType;
use core_video::pixel_buffer::CVPixelBuffer;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};
#[derive(Clone)]
struct Frame {
    id: usize,
    seq: u64,
    path: String,
    input: Option<Instant>,
}
#[derive(Default)]
struct Stats {
    pending: HashMap<usize, Frame>,
    presented: u64,
    last: Option<Frame>,
    latencies: Vec<f64>,
}
static STATS: OnceLock<Mutex<Stats>> = OnceLock::new();
fn recording() -> bool {
    static RECORD: OnceLock<bool> = OnceLock::new();
    *RECORD.get_or_init(|| crate::flag("--self-test"))
}
fn stats() -> &'static Mutex<Stats> {
    STATS.get_or_init(Mutex::default)
}
pub fn received(f: &CVPixelBuffer, seq: u64, path: &str, input: Option<Instant>) {
    if recording() {
        crate::log(
            if path == "software" {
                "OnPaint"
            } else {
                "accelerated_frame"
            },
            json!({"seq":seq,"path":path,"width":f.get_width(),"height":f.get_height()}),
        );
    }
    let mut s = stats().lock().unwrap();
    s.pending.retain(|_, f| f.seq + 4096 > seq);
    s.pending.insert(
        f.as_concrete_TypeRef() as usize,
        Frame {
            id: f.as_concrete_TypeRef() as usize,
            seq,
            path: path.into(),
            input,
        },
    );
}
pub fn install() {
    assert!(gpui_apple::surface_observer::install(Arc::new(
        |ids, time| {
            if time <= 0. {
                return;
            }
            let mut s = stats().lock().unwrap();
            for id in ids {
                if let Some(f) = s.pending.remove(id) {
                    if let Some(at) = f.input {
                        s.latencies.push(at.elapsed().as_secs_f64() * 1000.);
                    }
                    s.presented += 1;
                    if recording() {
                        crate::log(
                            "surface_presented",
                            json!({"seq":f.seq,"path":f.path,"metal_presented_time":time}),
                        );
                    }
                    if s.presented == 1 {
                        crate::log(
                            "first_presented",
                            json!({"seq":f.seq,"path":f.path,"metal_presented_time":time}),
                        );
                    }
                    s.last = Some(f);
                }
            }
        }
    )));
}
pub fn snapshot() -> Value {
    let s = stats().lock().unwrap();
    json!({"presented":s.presented,"last_seq":s.last.as_ref().map(|f|f.seq),"last_path":s.last.as_ref().map(|f|&f.path)})
}
pub fn latency() -> Value {
    let mut s = stats().lock().unwrap();
    let result = crate::perf::stats(&mut s.latencies);
    s.latencies.clear();
    result
}

// Window-only captures can include a composited buffer that was never shown on
// the physical display (for example while occluded). Keep that proof separate.
pub fn encoded(frame: &CVPixelBuffer) {
    if !recording() {
        return;
    }
    let id = frame.as_concrete_TypeRef() as usize;
    let s = stats().lock().unwrap();
    let f = s
        .pending
        .get(&id)
        .or_else(|| s.last.as_ref().filter(|f| f.id == id));
    let data = json!({"seq":f.map(|f|f.seq),"path":f.map(|f|&f.path),"width":frame.get_width(),"height":frame.get_height()});
    drop(s);
    crate::log("gpui_surface_encoded", data);
}
