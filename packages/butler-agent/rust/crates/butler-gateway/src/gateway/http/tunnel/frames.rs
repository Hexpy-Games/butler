use bytes::{Buf, BufMut, Bytes, BytesMut};
use tokio_tungstenite::tungstenite::Message;

pub(super) const MAX_PAYLOAD: usize = 65_536;
pub(super) const HEADER: usize = 5;

pub(super) const OPEN: u8 = 1;
pub(super) const DATA: u8 = 2;
pub(super) const END: u8 = 3;
pub(super) const RESET: u8 = 4;
pub(super) const WINDOW: u8 = 5;

pub(super) const TOO_LARGE: u8 = 2;
pub(super) const DESKTOP_ERROR: u8 = 4;
pub(super) const PROTOCOL: u8 = 6;

pub(super) struct Frame {
    pub(super) kind: u8,
    pub(super) id: u32,
    pub(super) payload: Bytes,
}

impl Frame {
    pub(super) fn parse(mut bytes: Bytes) -> Option<Self> {
        if !(HEADER..=HEADER + MAX_PAYLOAD).contains(&bytes.len()) {
            return None;
        }
        let kind = bytes.get_u8();
        let id = bytes.get_u32();
        let valid = match kind {
            OPEN | END => bytes.is_empty(),
            DATA => !bytes.is_empty(),
            RESET => bytes.len() == 1,
            WINDOW => bytes.len() == 4,
            _ => false,
        };
        valid.then_some(Self {
            kind,
            id,
            payload: bytes,
        })
    }
}

pub(super) fn message(kind: u8, id: u32, payload: &[u8]) -> Message {
    let mut bytes = BytesMut::with_capacity(HEADER + payload.len());
    bytes.put_u8(kind);
    bytes.put_u32(id);
    bytes.extend_from_slice(payload);
    Message::Binary(bytes.freeze())
}
