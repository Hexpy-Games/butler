#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ByteSpan {
    pub(crate) start: usize,
    pub(crate) end: usize,
}
