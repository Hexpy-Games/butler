//! Native discovery shapes: Ollama /api/show capabilities, LM Studio v0
//! model type, and llama.cpp /props modalities. Values are synthetic.
use super::{Body, Response, Seen, Value, json, json_response};

#[derive(Clone, Debug, Default)]
pub struct LocalCapabilities {
    pub ollama: Option<Vec<String>>,
    pub lm_studio: Option<String>,
    pub llama_cpp: Option<bool>,
    pub input_modalities: Option<Vec<String>>,
}

pub fn carries_image(body: &Value) -> bool {
    body["messages"].as_array().is_some_and(|messages| {
        messages.iter().any(|message| {
            message["content"]
                .as_array()
                .is_some_and(|parts| parts.iter().any(|part| part["type"] == "image_url"))
        })
    })
}

pub(super) fn response(cap: &LocalCapabilities, seen: &Seen) -> Option<Response<Body>> {
    let value = match (seen.method.as_str(), seen.path.as_str()) {
        ("POST", "/api/show") => json!({"capabilities":cap.ollama.as_ref()?}),
        ("GET", path) if path.starts_with("/api/v0/models/") => {
            json!({"type":cap.lm_studio.as_ref()?})
        }
        ("GET", "/props") => json!({"modalities":{"vision":cap.llama_cpp?}}),
        ("GET", "/v1/models") if cap.input_modalities.is_some() => json!({"data":[{
            "id":super::LOCAL_MODEL,"context_length":131_072,"input_modalities":cap.input_modalities
        }]}),
        _ => return None,
    };
    Some(json_response(200, &value))
}
