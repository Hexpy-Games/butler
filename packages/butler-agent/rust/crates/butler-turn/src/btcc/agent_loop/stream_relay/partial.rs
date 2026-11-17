use super::super::answer_join::join_cut;

#[derive(Default)]
pub(super) struct Partial {
    cut: String,
    round: String,
    stream: String,
}

impl Partial {
    /// The text to publish for a delta. The first delta of a new stream after
    /// retained answer text starts with that text up to its last line, which a
    /// continuation repeats (see `join_cut`), so the shown answer keeps it.
    pub(super) fn delta(&mut self, stream: &str, text: &str) -> String {
        if self.cut.is_empty() {
            return text.to_owned();
        }
        let mut shown = String::new();
        if self.stream != stream {
            self.stream = stream.to_owned();
            self.round.clear();
            let line = self.cut.rfind('\n').map_or(0, |index| index + 1);
            shown.push_str(&self.cut[..line]);
        }
        self.round.push_str(text);
        shown.push_str(text);
        shown
    }

    pub(super) fn retain(&mut self, text: &str) {
        self.cut = text.to_owned();
        self.round.clear();
        self.stream.clear();
    }

    pub(super) fn reject(&mut self) {
        *self = Self::default();
    }

    pub(super) fn discard(&mut self) {
        self.round.clear();
    }

    pub(super) fn joined(&self) -> Option<String> {
        (!self.cut.is_empty()).then(|| join_cut(&self.cut, &self.round))
    }
}
