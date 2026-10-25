//! Single-pass JSON boundary scanner. Only closed render units are decoded.
use serde_json::Value;

#[derive(Debug)]
pub(super) struct Unit {
    pub path: Vec<String>,
    pub value: Option<Value>,
}

struct Container {
    path: Vec<String>,
    start: usize,
    object: bool,
    key: String,
    index: usize,
    phase: u8,
}

/// Bounded incremental scanner; offsets advance only over newly supplied bytes.
#[derive(Default)]
pub(super) struct Scanner {
    bytes: Vec<u8>,
    stack: Vec<Container>,
    token: Option<(usize, bool, bool)>,
    escape: bool,
    failed: bool,
    complete: bool,
}

impl Scanner {
    pub(super) fn push(&mut self, delta: &[u8]) -> Vec<Unit> {
        if self.failed || self.bytes.len() + delta.len() > super::MAX_SPEC_BYTES {
            self.failed = true;
            return Vec::new();
        }
        let start = self.bytes.len();
        self.bytes.extend_from_slice(delta);
        let mut units = Vec::new();
        for offset in start..self.bytes.len() {
            let byte = self.bytes[offset];
            self.byte(offset, byte, &mut units);
            if self.failed {
                break;
            }
        }
        units
    }

    fn byte(&mut self, offset: usize, byte: u8, units: &mut Vec<Unit>) {
        if let Some((start, string, key)) = self.token {
            if string {
                if self.escape {
                    self.escape = false;
                } else if byte == b'\\' {
                    self.escape = true;
                } else if byte == b'"' {
                    self.token = None;
                    if key {
                        if let Ok(name) =
                            serde_json::from_slice::<String>(&self.bytes[start..=offset])
                        {
                            if let Some(parent) = self.stack.last_mut() {
                                parent.key = name;
                                parent.phase = 1;
                            }
                        } else {
                            self.failed = true;
                        }
                    } else {
                        self.closed(start, offset + 1, units);
                    }
                }
                return;
            }
            if !matches!(byte, b',' | b']' | b'}' | b' ' | b'\n' | b'\r' | b'\t') {
                return;
            }
            self.token = None;
            self.closed(start, offset, units);
        }
        if byte.is_ascii_whitespace() {
            return;
        }
        match byte {
            b':' => {
                if let Some(parent) = self.stack.last_mut().filter(|p| p.object && p.phase == 1) {
                    parent.phase = 2;
                } else {
                    self.failed = true;
                }
            }
            b',' => {
                if let Some(parent) = self.stack.last_mut().filter(|p| p.phase == 3) {
                    parent.phase = if parent.object { 4 } else { 2 };
                } else {
                    self.failed = true;
                }
            }
            b']' | b'}' => self.close_container(offset, byte, units),
            _ => self.start(offset, byte),
        }
    }

    fn start(&mut self, offset: usize, byte: u8) {
        let key = self
            .stack
            .last()
            .is_some_and(|p| p.object && matches!(p.phase, 0 | 4));
        if key {
            if byte == b'"' {
                self.token = Some((offset, true, true));
            } else {
                self.failed = true;
            }
            return;
        }
        if self.complete || self.stack.last().is_some_and(|p| !matches!(p.phase, 0 | 2)) {
            self.failed = true;
            return;
        }
        match byte {
            b'{' | b'[' => {
                if self.stack.len() >= 64 {
                    self.failed = true;
                    return;
                }
                self.stack.push(Container {
                    path: self.path(),
                    start: offset,
                    object: byte == b'{',
                    key: String::new(),
                    index: 0,
                    phase: 0,
                });
            }
            b'"' => self.token = Some((offset, true, false)),
            b'-' | b'0'..=b'9' | b't' | b'f' | b'n' => self.token = Some((offset, false, false)),
            _ => self.failed = true,
        }
    }

    fn path(&self) -> Vec<String> {
        let Some(parent) = self.stack.last() else {
            return Vec::new();
        };
        let mut path = parent.path.clone();
        path.push(if parent.object {
            parent.key.clone()
        } else {
            parent.index.to_string()
        });
        path
    }

    fn closed(&mut self, start: usize, end: usize, units: &mut Vec<Unit>) {
        let path = self.path();
        self.unit(path, start, end, units);
        self.advance();
    }

    fn close_container(&mut self, offset: usize, byte: u8, units: &mut Vec<Unit>) {
        let Some(container) = self.stack.pop() else {
            self.failed = true;
            return;
        };
        if container.object != (byte == b'}') || !matches!(container.phase, 0 | 3) {
            self.failed = true;
            return;
        }
        self.unit(container.path, container.start, offset + 1, units);
        self.advance();
    }

    fn unit(&self, path: Vec<String>, start: usize, end: usize, units: &mut Vec<Unit>) {
        if path.first().is_none_or(|key| key != "blocks") {
            return;
        }
        let lists = ["items", "rows", "blocks", "tabs"];
        let structural = path.len() == 2 || (path.len() == 3 && lists.contains(&path[2].as_str()));
        let nested = path.len() == 6 && path[2] == "tabs" && path[4] == "blocks";
        let label = path.len() == 5 && path[2] == "tabs" && path[4] == "label";
        let value = path.len() == 3
            || (path.len() == 4 && lists.contains(&path[2].as_str()))
            || nested
            || label;
        if structural {
            units.push(Unit { path, value: None });
        } else if value {
            units.push(Unit {
                path,
                value: serde_json::from_slice(&self.bytes[start..end]).ok(),
            });
        }
    }

    fn advance(&mut self) {
        if let Some(parent) = self.stack.last_mut() {
            parent.phase = 3;
            parent.index += 1;
        } else {
            self.complete = true;
        }
    }
}
