//! Incremental SSE metadata: skip payload strings without retaining their contents.

#[derive(Default)]
pub(super) struct Line {
    prefix: Vec<u8>,
    json: Metadata,
    event: Vec<u8>,
}
impl Line {
    pub(super) fn push(&mut self, byte: u8) {
        if self.prefix.len() < 6 && !self.prefix.ends_with(b":") {
            self.prefix.push(byte);
        } else if self.prefix == b"data:" {
            self.json.push(byte);
        } else if self.prefix == b"event:" && self.event.len() < 8192 {
            self.event.push(byte);
        }
    }
    pub(super) fn finish(&mut self) -> (Option<String>, Option<String>) {
        let line = std::mem::take(self);
        if line.prefix == b"event:" {
            return (
                Some(String::from_utf8_lossy(&line.event).trim().into()),
                None,
            );
        }
        if line.prefix != b"data:" {
            return (None, None);
        }
        let metadata = line.json;
        let reason = metadata.reason.or_else(|| {
            (metadata.kind.as_deref() == Some("response.completed")).then(|| "completed".into())
        });
        (
            Some(metadata.kind.unwrap_or_else(|| "message".into())),
            reason,
        )
    }
}
#[derive(Default)]
struct Frame {
    array: bool,
    index: usize,
    key: Option<String>,
    expecting_key: bool,
}
#[derive(Default)]
enum StringState {
    #[default]
    Outside,
    Quoted,
    Escape,
}
#[derive(Default)]
struct Metadata {
    stack: Vec<Frame>,
    string_state: StringState,
    token: Vec<u8>,
    oversized: bool,
    invalid: bool,
    kind: Option<String>,
    reason: Option<String>,
}
impl Metadata {
    fn push(&mut self, byte: u8) {
        if self.invalid {
            return;
        }
        if !matches!(self.string_state, StringState::Outside) {
            if self.token.len() < 8192 {
                self.token.push(byte);
            } else {
                self.oversized = true;
            }
            match self.string_state {
                StringState::Escape => self.string_state = StringState::Quoted,
                StringState::Quoted if byte == b'\\' => self.string_state = StringState::Escape,
                StringState::Quoted if byte == b'"' => {
                    self.string_state = StringState::Outside;
                    self.string();
                }
                _ => {}
            }
            return;
        }
        match byte {
            b'"' => {
                self.string_state = StringState::Quoted;
                self.oversized = false;
                self.token.clear();
                self.token.push(byte);
            }
            b'{' | b'[' => {
                if self.stack.len() == 128 {
                    self.invalid = true;
                    return;
                }
                self.stack.push(Frame {
                    array: byte == b'[',
                    expecting_key: byte == b'{',
                    ..Frame::default()
                });
            }
            b'}' | b']' => {
                self.stack.pop();
            }
            b',' => {
                if let Some(frame) = self.stack.last_mut() {
                    frame.index += 1;
                    frame.key = None;
                    frame.expecting_key = !frame.array;
                }
            }
            _ => {}
        }
    }
    fn string(&mut self) {
        let value = (!self.oversized)
            .then(|| serde_json::from_slice::<String>(&self.token).ok())
            .flatten();
        let depth = self.stack.len();
        let Some(frame) = self.stack.last_mut() else {
            return;
        };
        if frame.expecting_key {
            frame.key = value;
            frame.expecting_key = false;
            return;
        }
        let key = frame.key.as_deref();
        if depth == 1 && key == Some("type") {
            self.kind = value;
        } else if self.finish_key() {
            self.reason = value;
        }
    }
    fn finish_key(&self) -> bool {
        let keys: Vec<_> = self
            .stack
            .iter()
            .map(|frame| frame.key.as_deref())
            .collect();
        match keys.as_slice() {
            [Some("choices"), None, Some("finish_reason")]
            | [Some("candidates"), None, Some("finishReason")] => self.stack[1].index == 0,
            [Some("delta"), Some("stop_reason")] => true,
            _ => false,
        }
    }
}
