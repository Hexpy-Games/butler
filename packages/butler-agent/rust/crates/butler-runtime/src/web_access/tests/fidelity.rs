//! Reader content invariants, independent of the model's available tool surface.
use super::super::{LivePage, WebSession};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

pub(super) async fn tab_reads(session: &WebSession, endpoint: &str, paragraph: &str) {
    let html = format!(
        "<html><title>Study</title><article><h1>Study results</h1><p>{}</p><p>End of the document.</p></article></html>",
        paragraph.repeat(4)
    );
    let live = || LivePage {
        tab: "reader-tab".into(),
        epoch: 1,
        final_url: endpoint.into(),
        html: html.clone(),
    };
    let ranked_args = json!({"url":endpoint,"query":"source details","max_chunks":1});
    let first = session
        .web_read_from(&ranked_args, Some(live()), true, &CancellationToken::new())
        .await
        .unwrap();
    assert!(first["total_chunks"].as_u64().unwrap() >= 3);
    assert!(first["next_start_chunk"].is_number());
    // Reader fidelity stays covered independently of whether a model is offered it.
    let whole_args = json!({"url":endpoint,"max_chunks":8,"max_chars":8000});
    let whole = session
        .web_read_from(&whole_args, Some(live()), true, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(whole["returned_chunks"], whole["total_chunks"]);
    assert_eq!(whole["content_has_more"], false);
    assert!(
        whole["markdown"]
            .as_str()
            .unwrap()
            .contains("End of the document.")
    );
    let repeated = session
        .web_read_from(&whole_args, Some(live()), true, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(repeated["unchanged"], true);
    assert_eq!(repeated["same_as"], whole["read_id"]);
    assert!(repeated.get("markdown").is_none());
    let mut changed = live();
    changed.html = html
        .replace("Study results", "Study results moved to Sunday")
        .replace(
            "End of the document.",
            "The result moved to Sunday. End of the document.",
        );
    let refreshed = session
        .web_read_from(&whole_args, Some(changed), true, &CancellationToken::new())
        .await
        .unwrap();
    assert_ne!(refreshed["content_sha256"], whole["content_sha256"]);
    assert_eq!(refreshed["title"], "Study results moved to Sunday");
    assert_eq!(refreshed["returned_chunks"], refreshed["total_chunks"]);
    assert_eq!(refreshed["content_has_more"], false);
    assert!(
        refreshed["markdown"]
            .as_str()
            .unwrap()
            .contains("moved to Sunday"),
        "{refreshed}"
    );
    chunks(session, endpoint, &html, &first, &whole).await;
    continuation(session, endpoint, &html, &whole).await;
}

async fn chunks(session: &WebSession, endpoint: &str, html: &str, first: &Value, whole: &Value) {
    let live = || LivePage {
        tab: "reader-tab".into(),
        epoch: 1,
        final_url: endpoint.into(),
        html: html.to_owned(),
    };
    let complete_args = json!({"url":endpoint,"query":"unmatched","max_chunks":8,"max_chars":8000});
    let empty = session
        .web_read_from(
            &complete_args,
            Some(live()),
            true,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(empty["passages"], json!([]));
    assert!(empty["next_start_chunk"].is_null());
    for passage in first["passages"].as_array().unwrap() {
        let chunk = usize::try_from(passage["chunk"].as_u64().unwrap()).unwrap();
        let start = usize::try_from(passage["span"][0].as_u64().unwrap()).unwrap();
        let end = usize::try_from(passage["span"][1].as_u64().unwrap()).unwrap();
        let full = session
            .web_read_from(
                &json!({"url":endpoint,"start_chunk":chunk}),
                Some(live()),
                true,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        let text = full["markdown"].as_str().unwrap();
        assert_eq!(
            passage["text"],
            text.chars()
                .skip(start)
                .take(end - start)
                .collect::<String>()
        );
        assert!(whole["markdown"].as_str().unwrap().contains(text));
    }
}

async fn continuation(session: &WebSession, endpoint: &str, html: &str, whole: &Value) {
    let live = || LivePage {
        tab: "reader-tab".into(),
        epoch: 1,
        final_url: endpoint.into(),
        html: html.into(),
    };
    let args = json!({"url":endpoint,"max_chunks":1,"max_chars":2000});
    let first = session
        .web_read_from(&args, Some(live()), true, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(first["content_has_more"], true);
    let rest_args = json!({"url":endpoint,"start_chunk":first["next_start_chunk"],"max_chunks":8,"max_chars":8000});
    let rest = session
        .web_read_from(&rest_args, Some(live()), true, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(rest["content_has_more"], false);
    assert_eq!(
        first["returned_chunks"].as_u64().unwrap() + rest["returned_chunks"].as_u64().unwrap(),
        whole["total_chunks"].as_u64().unwrap()
    );
    assert!(
        rest["markdown"]
            .as_str()
            .unwrap()
            .contains("End of the document.")
    );
    assert_eq!(rest["content_sha256"], whole["content_sha256"]);
}
