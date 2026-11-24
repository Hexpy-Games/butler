/// One publishing operation; the host runs it against butler-cloud with the Butler account's token.
#[derive(Debug, Clone)]
pub enum PublishingRequest {
    /// `{signed_in}` from the stored token only; no network.
    Status,
    /// Local file count and bytes of one item, plus `signed_in`; no network.
    Preview {
        source: PublishSource,
    },
    /// `GET /v1/pages`, each page with `item_id` when it came from this device.
    Pages,
    Publish {
        item_id: String,
        title: String,
        source: PublishSource,
    },
    Unpublish {
        page_id: String,
    },
}

#[derive(Debug, Clone)]
pub enum PublishSource {
    Output { output_id: String },
    File { file_id: String, name: String },
}
