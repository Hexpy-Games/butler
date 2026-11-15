//! Isolated-world browser reader and selection wire types.
mod copy;
mod follow;
mod geometry;
mod input;
mod probe;
mod reader;
use serde_json::Value;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
};
#[derive(Clone, Default)]
pub(crate) struct Session {
    worlds: Rc<RefCell<HashMap<Vec<usize>, i64>>>,
    frames: Rc<RefCell<HashMap<Vec<usize>, String>>>,
    generation: Rc<Cell<u64>>,
    revision: Rc<Cell<u64>>,
    pending: Rc<Cell<bool>>,
    point: Rc<Cell<Option<(f64, f64)>>>,
    pub(super) focus_requested: Rc<Cell<bool>>,
    pub(super) viewport: Rc<Cell<(f64, f64)>>,
    preferred: Rc<RefCell<Option<String>>>,
    #[cfg(feature = "cef")]
    wheel: Rc<Cell<f32>>,
    #[cfg(feature = "cef")]
    press_id: Rc<Cell<u64>>,
    down: Rc<RefCell<Option<input::Press>>>,
    watches: Rc<RefCell<HashMap<Vec<usize>, gpui::Task<()>>>>,
}
#[derive(Clone)]
pub(crate) struct Item {
    pub(crate) data: Value,
    frame: probe::Frame,
    pub(crate) hidden: bool,
    area: Option<Area>,
}
#[derive(Clone)]
struct Area {
    rect: Value,
    scroll: (f64, f64),
}
#[derive(Clone)]
pub(crate) struct Hover {
    levels: Vec<probe::Level>,
    index: usize,
    pub(crate) rect: Value,
    pub(crate) label: String,
}
