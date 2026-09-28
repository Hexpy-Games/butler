//! Wire-format pins for inline images on each carrier.

use serde_json::json;

use super::*;

#[test]
fn anthropic_and_gemini_put_inline_images_before_the_text() {
    let anthropic = user_content(
        Carrier::Anthropic,
        "What is this?",
        vec![image_part(Carrier::Anthropic, "image/png", "QUJD")],
    );
    assert_eq!(
        anthropic,
        json!([
            {"type":"image","source":{"type":"base64","media_type":"image/png","data":"QUJD"}},
            {"type":"text","text":"What is this?"}
        ])
    );
    let gemini = user_content(
        Carrier::Gemini,
        "What is this?",
        vec![image_part(Carrier::Gemini, "image/jpeg", "QUJD")],
    );
    assert_eq!(
        gemini,
        json!([
            {"inline_data":{"mime_type":"image/jpeg","data":"QUJD"}},
            {"text":"What is this?"}
        ])
    );
}

#[test]
fn openai_shapes_keep_text_before_data_url_images() {
    let responses = user_content(
        Carrier::Responses,
        "Hi",
        vec![image_part(Carrier::Responses, "image/png", "QUJD")],
    );
    assert_eq!(
        responses,
        json!([{"role":"user","content":[
            {"type":"input_text","text":"Hi"},
            {"type":"input_image","image_url":"data:image/png;base64,QUJD"}
        ]}])
    );
    let chat = user_content(
        Carrier::Chat { stream: false },
        "",
        vec![image_part(
            Carrier::Chat { stream: false },
            "image/png",
            "QUJD",
        )],
    );
    assert_eq!(
        chat,
        json!([{"type":"image_url","image_url":{"url":"data:image/png;base64,QUJD"}}])
    );
}

#[test]
fn the_first_user_row_of_each_carrier_body_receives_the_content() {
    let content = json!([{"type":"text","text":"x"}]);
    let mut anthropic =
        json!({"messages":[{"role":"user","content":"x"},{"role":"user","content":"y"}]});
    replace_first_user(&mut anthropic, Carrier::Anthropic, content.clone());
    assert_eq!(anthropic["messages"][0]["content"], content);
    assert_eq!(anthropic["messages"][1]["content"], "y");
    let mut gemini =
        json!({"contents":[{"role":"model","parts":[]},{"role":"user","parts":[{"text":"x"}]}]});
    replace_first_user(&mut gemini, Carrier::Gemini, content.clone());
    assert_eq!(gemini["contents"][1]["parts"], content);
}
