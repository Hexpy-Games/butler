use super::*;
use butler_runtime::capabilities::answer_blocks;
pub(super) async fn validate(owner: &GuidedTools, body: &str) -> Result<(), Value> {
    if body.len() > markdown::MAX_BODY_BYTES {
        return Err(failure("invalid_body", "Body exceeds 256 KB."));
    }
    let parsed = markdown::parse(body);
    let images =
        super::super::browser::lookup_assets(owner, parsed.images.iter().cloned().collect()).await;
    let mut problems = Vec::new();
    for (index, fence) in parsed.fences.iter().enumerate() {
        match serde_json::from_str::<Value>(&fence.content) {
            Ok(mut spec) => {
                answer_blocks::normalize(&mut spec);
                let errors = super::super::answer_blocks::validate_spec(owner, &spec)
                    .await
                    .map_err(|_| {
                        failure(
                            "document_validation_unavailable",
                            "Document evidence is unavailable; try reading again.",
                        )
                    })?;
                for error in errors {
                    problems.push(
                        json!({"fence":index,"line":fence.line,"path":error.path,"fix":error.fix}),
                    );
                }
            }
            Err(error) => problems
                .push(json!({"fence":index,"line":fence.line,"path":"","fix":error.to_string()})),
        }
        if problems.len() >= 10 {
            break;
        }
    }
    for image in parsed.images.difference(&images.into_iter().collect()) {
        problems.push(json!({"path":"","image":image,"line":parsed.image_lines.get(image),"fix":"Image id does not exist."}));
        if problems.len() >= 10 {
            break;
        }
    }
    problems.truncate(10);
    if problems.is_empty() {
        Ok(())
    } else {
        Err(
            json!({"ok":false,"error":{"code":"invalid_embeds","message":"Correct the listed embeds and resend.","problems":problems}}),
        )
    }
}
