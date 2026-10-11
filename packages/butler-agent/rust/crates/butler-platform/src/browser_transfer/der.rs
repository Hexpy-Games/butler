//! Bounded DER reading for NSS algorithm parameters; never evaluates external data.
use super::ImportError;
#[derive(Clone, Copy)]
pub(super) struct Node<'a> {
    pub tag: u8,
    pub value: &'a [u8],
    pub encoded: &'a [u8],
}
impl<'a> Node<'a> {
    pub(super) fn parse(bytes: &'a [u8]) -> Result<Self, ImportError> {
        let tag = *bytes.first().ok_or(ImportError::Format)?;
        let first = *bytes.get(1).ok_or(ImportError::Format)?;
        let (offset, length) = if first < 128 {
            (2, usize::from(first))
        } else {
            let count = usize::from(first & 127);
            if count == 0 || count > 4 {
                return Err(ImportError::Format);
            }
            let raw = bytes.get(2..2 + count).ok_or(ImportError::Format)?;
            (
                2 + count,
                raw.iter().fold(0_usize, |n, b| (n << 8) | usize::from(*b)),
            )
        };
        let end = offset.checked_add(length).ok_or(ImportError::Format)?;
        Ok(Self {
            tag,
            value: bytes.get(offset..end).ok_or(ImportError::Format)?,
            encoded: bytes.get(..end).ok_or(ImportError::Format)?,
        })
    }
    pub(super) fn child(self, index: usize) -> Result<Self, ImportError> {
        if self.tag != 0x30 {
            return Err(ImportError::Format);
        }
        let mut rest = self.value;
        for i in 0..=index {
            let child = Self::parse(rest)?;
            if i == index {
                return Ok(child);
            }
            rest = rest.get(child.encoded.len()..).ok_or(ImportError::Format)?;
        }
        Err(ImportError::Format)
    }
    pub(super) fn bytes(self, tag: u8) -> Result<&'a [u8], ImportError> {
        if self.tag != tag {
            return Err(ImportError::Format);
        }
        Ok(self.value)
    }
    pub(super) fn integer(self) -> Result<u32, ImportError> {
        let bytes = self.bytes(2)?;
        if bytes.is_empty()
            || bytes.len() > 4
            || bytes.first().ok_or(ImportError::Format)? & 0x80 != 0
        {
            return Err(ImportError::Format);
        }
        Ok(bytes.iter().fold(0_u32, |n, b| (n << 8) | u32::from(*b)))
    }
}
