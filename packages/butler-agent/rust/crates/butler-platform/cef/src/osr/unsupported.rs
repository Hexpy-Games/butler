//! Uninhabited seam for platforms without an OSR implementation.
use super::{
    OsrAnswer, OsrConfig, OsrError, OsrIme, OsrKey, OsrMouse, OsrProfile, OsrSink, OsrWheel,
    PopupPolicy, PumpScheduler,
};
use std::{convert::Infallible, ops::Range, rc::Rc};

pub struct OsrRuntime {
    never: Infallible,
}
pub struct OsrFrame {
    never: Infallible,
}
impl OsrFrame {
    pub fn get_width(&self) -> usize {
        match self.never {}
    }
    pub fn get_height(&self) -> usize {
        match self.never {}
    }
}
impl OsrRuntime {
    pub fn start(
        _: OsrConfig,
        _: Rc<dyn OsrSink>,
        _: PumpScheduler,
        _: PopupPolicy,
    ) -> Result<Self, OsrError> {
        Err(OsrError("osr_unsupported".into()))
    }
    pub fn pump(&self) {
        match self.never {}
    }
    pub fn open(
        &self,
        _: u64,
        _: &str,
        _: (u32, u32),
        _: f32,
        _: OsrProfile,
    ) -> Result<(), OsrError> {
        match self.never {}
    }
    pub fn open_embed(&self, _: u64, _: &str, _: OsrProfile) -> Result<(), OsrError> {
        match self.never {}
    }
    pub fn print_to_pdf(&self, _: u64, _: &std::path::Path, _: super::PdfSettings) {
        match self.never {}
    }
    pub fn navigate(&self, _: u64, _: &str) {
        match self.never {}
    }
    pub fn devtools(&self, _: u64, _: &str, _: &str) -> Result<i32, OsrError> {
        match self.never {}
    }
    pub fn eval(&self, _: u64, _: &str) {
        match self.never {}
    }
    pub fn answer_dialog(&self, _: u64, _: u64, _: OsrAnswer) {
        match self.never {}
    }
    pub fn cancel_dialogs(&self, _: u64) {
        match self.never {}
    }
    pub fn back(&self, _: u64) {
        match self.never {}
    }
    pub fn forward(&self, _: u64) {
        match self.never {}
    }
    pub fn reload(&self, _: u64) {
        match self.never {}
    }
    pub fn stop(&self, _: u64) {
        match self.never {}
    }
    pub fn resize(&self, _: u64, _: (u32, u32), _: f32) {
        match self.never {}
    }
    pub fn set_visible(&self, _: u64, _: bool) {
        match self.never {}
    }
    pub fn close(&self, _: u64) {
        match self.never {}
    }
    pub fn frame(&self, _: u64) -> Option<OsrFrame> {
        match self.never {}
    }
    pub fn shutdown(self) {
        match self.never {}
    }
    pub fn mouse(&self, _: u64, _: OsrMouse) {
        match self.never {}
    }
    pub fn wheel(&self, _: u64, _: OsrWheel) {
        match self.never {}
    }
    pub fn key(&self, _: u64, _: OsrKey) {
        match self.never {}
    }
    pub fn ime(&self, _: u64) -> Option<OsrIme> {
        match self.never {}
    }
    pub fn ime_set_composition(&self, _: u64, _: &str, _: Range<u32>) {
        match self.never {}
    }
    pub fn ime_commit(&self, _: u64, _: &str) {
        match self.never {}
    }
    pub fn ime_cancel(&self, _: u64) {
        match self.never {}
    }
}
