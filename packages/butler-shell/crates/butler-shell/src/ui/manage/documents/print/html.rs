#[derive(Default)]
pub(super) struct Out(pub(super) String);

impl Out {
    pub(super) fn open(&mut self, tag: &str, attrs: &[(&str, &str)]) {
        self.void(tag, attrs);
    }

    pub(super) fn close(&mut self, tag: &str) {
        self.raw("</");
        self.0.push_str(tag);
        self.raw(">");
    }

    pub(super) fn void(&mut self, tag: &str, attrs: &[(&str, &str)]) {
        self.raw("<");
        self.0.push_str(tag);
        for (name, value) in attrs {
            self.raw(" ");
            self.0.push_str(name);
            self.raw("=\"");
            self.escape(value, true);
            self.raw("\"");
        }
        self.raw(">");
    }

    pub(super) fn text(&mut self, text: &str) {
        self.escape(text, false);
    }

    pub(super) fn raw(&mut self, markup: &str) {
        self.0.push_str(markup);
    }

    fn escape(&mut self, text: &str, attr: bool) {
        for c in text.chars() {
            match c {
                '&' => self.raw("&amp;"),
                '\u{a0}' => self.raw("&nbsp;"),
                '"' if attr => self.raw("&quot;"),
                '<' if !attr => self.raw("&lt;"),
                '>' if !attr => self.raw("&gt;"),
                _ => self.0.push(c),
            }
        }
    }
}
