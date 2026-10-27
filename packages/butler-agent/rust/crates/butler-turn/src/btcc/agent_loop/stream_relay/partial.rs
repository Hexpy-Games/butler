use super::super::answer_join::join_cut;

#[derive(Default)]
pub(super) struct Partial {
    cut: String,
    round: String,
    stream: String,
}

impl Partial {
    pub(super) fn delta(&mut self, stream: &str, text: &str) {
        if self.cut.is_empty() {
            return;
        }
        if self.stream != stream {
            self.stream = stream.to_owned();
            self.round.clear();
        }
        self.round.push_str(text);
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
