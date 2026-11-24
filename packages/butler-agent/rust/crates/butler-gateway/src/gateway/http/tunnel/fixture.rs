use super::noise::{self, RecordReader, ReplayGuard};

pub struct FixtureResponder {
    private: [u8; 32],
    ephemeral: [u8; 32],
    tunnel_id: String,
    replay: ReplayGuard,
}

pub struct FixtureOutput {
    pub head_json: Vec<u8>,
    pub body: Vec<u8>,
    pub remote_static: [u8; 32],
    pub message2: Vec<u8>,
    pub transport: Vec<Vec<u8>>,
}

impl FixtureResponder {
    pub fn new(desktop_private: [u8; 32], desktop_ephemeral: [u8; 32], tunnel_id: &str) -> Self {
        Self {
            private: desktop_private,
            ephemeral: desktop_ephemeral,
            tunnel_id: tunnel_id.to_owned(),
            replay: ReplayGuard::default(),
        }
    }

    pub fn respond(
        &self,
        request_records: &[u8],
        now_ms: u64,
        response_payload: &[u8],
        transport_plaintexts: &[&[u8]],
    ) -> Result<FixtureOutput, &'static str> {
        let handshake = noise::responder(&self.private, &self.tunnel_id, Some(&self.ephemeral))?;
        let mut reader = RecordReader::default();
        reader.push(request_records);
        let first = reader.next()?.ok_or("message1")?;
        let opened = noise::open(handshake, &first, &self.replay, now_ms)?;
        let mut body = Vec::new();
        let mut chunks = opened.body;
        while let Some(record) = reader.next()? {
            let plaintext = chunks.as_mut().ok_or("extra_body")?.decrypt(&record)?;
            body.extend_from_slice(&plaintext);
        }
        reader.finish()?;
        if let Some(chunks) = chunks {
            chunks.finish()?;
        }
        let (message2, mut transport) = noise::response(opened.handshake, response_payload)?;
        Ok(FixtureOutput {
            head_json: opened.head_json,
            body,
            remote_static: opened.remote_static,
            message2,
            transport: transport_plaintexts
                .iter()
                .map(|plaintext| noise::transport_record(&mut transport, plaintext))
                .collect::<Result<_, _>>()?,
        })
    }
}
