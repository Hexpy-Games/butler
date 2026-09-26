#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ByteSpan {
    pub(crate) start: usize,
    pub(crate) end: usize,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug)]
pub(crate) struct WindowPart<'a> {
    pub(crate) text: &'a str,
    pub(crate) bytes: f64,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ByteMidpoint {
    pub(crate) part_index: usize,
    pub(crate) local_byte: usize,
}
