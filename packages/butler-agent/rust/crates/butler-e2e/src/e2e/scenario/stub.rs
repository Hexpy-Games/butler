use super::super::cassette::Cassette;
use super::Setup;

impl Setup {
    /// Replays a test-built cassette without loading or recording provider traffic.
    pub fn stub_cassette(mut self, cassette: Cassette) -> Self {
        self.source = super::Source::Stub(cassette);
        self
    }
}
