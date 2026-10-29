//! ULID-shaped identifiers: a 48-bit millisecond timestamp and 80 random bits.
//! The generator retains a logical clock and increments entropy for equal or
//! backwards timestamps. Encoding is pure; no filesystem or platform calls.
#[derive(Debug, thiserror::Error)]
#[error("invalid identifier: {0}")]
pub struct IdError(pub &'static str);
type Result<T> = std::result::Result<T, IdError>;
use std::sync::Mutex;
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
#[derive(Debug, Clone, Copy)]
pub enum IdKind {
    Plan,
    Work,
    Task,
    Spec,
    Chain,
    Decision,
    Tag,
    Grant,
    Proposal,
}
impl IdKind {
    pub const fn prefix(self) -> &'static str {
        match self {
            Self::Plan => "pl_",
            Self::Work => "wk_",
            Self::Task => "tk_",
            Self::Spec => "sp_",
            Self::Chain => "ch_",
            Self::Decision => "hd_",
            Self::Tag => "tag_",
            Self::Grant => "mg_",
            Self::Proposal => "cp_",
        }
    }
}
pub fn encode(kind: IdKind, millis: u64, entropy: [u8; 10]) -> Result<String> {
    if millis > 0xffff_ffff_ffff {
        return Err(IdError("ID timestamp exceeds 48 bits"));
    }
    let mut bytes = [0u8; 16];
    bytes[..6].copy_from_slice(&millis.to_be_bytes()[2..]);
    bytes[6..].copy_from_slice(&entropy);
    let mut number = u128::from_be_bytes(bytes);
    let mut chars = [b'0'; 26];
    for character in chars.iter_mut().rev() {
        *character = CROCKFORD[(number & 31) as usize];
        number >>= 5;
    }
    Ok(format!(
        "{}{}",
        kind.prefix(),
        String::from_utf8_lossy(&chars)
    ))
}
#[derive(Debug, Default)]
pub struct IdGenerator {
    last: Option<(u64, u128)>,
}
impl IdGenerator {
    /// Entropy is supplied explicitly to keep clock/ordering logic deterministic.
    pub fn next(&mut self, kind: IdKind, millis: u64, entropy: [u8; 10]) -> Result<String> {
        let mut random = [0u8; 16];
        random[6..].copy_from_slice(&entropy);
        let (millis, random) = match self.last {
            Some((last, bits)) if millis <= last => {
                if bits == ((1u128 << 80) - 1) {
                    (last + 1, 0)
                } else {
                    (last, bits + 1)
                }
            }
            _ => (millis, u128::from_be_bytes(random)),
        };
        let mut tail = [0u8; 10];
        tail.copy_from_slice(&random.to_be_bytes()[6..]);
        let id = encode(kind, millis, tail)?;
        self.last = Some((millis, random));
        Ok(id)
    }
    pub fn global_next(kind: IdKind, millis: i64) -> Result<String> {
        static GENERATOR: Mutex<IdGenerator> = Mutex::new(IdGenerator { last: None });
        let mut entropy = [0u8; 10];
        let random = uuid::Uuid::new_v4();
        entropy[..6].copy_from_slice(&random.as_bytes()[..6]);
        entropy[6..].copy_from_slice(&random.as_bytes()[9..13]);
        GENERATOR
            .lock()
            .map_err(|_| IdError("ID generator poisoned"))?
            .next(
                kind,
                u64::try_from(millis).map_err(|_| IdError("negative timestamp"))?,
                entropy,
            )
    }
}
