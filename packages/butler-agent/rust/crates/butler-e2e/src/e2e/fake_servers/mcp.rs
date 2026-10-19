//! Stateless legacy MCP handshake and tools over real HTTP.
use super::*;

pub(super) fn response(method: &Method, body: &str, tool: &str) -> Response<Body> {
    if method != Method::POST {
        return json_response(405, &json!({}));
    }
    let request: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let id = request["id"].clone();
    if id.is_null() {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::OK;
        return response;
    }
    let result = match request["method"].as_str().unwrap_or_default() {
        "server/discover" => {
            return json_response(
                200,
                &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}}),
            );
        }
        "initialize" => {
            json!({"protocolVersion":request["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":"http-fixture","version":"1"}})
        }
        "tools/list" => {
            json!({"tools":[{"name":tool,"description":"Echo text","inputSchema":{"type":"object","properties":{}}}]})
        }
        "tools/call" => {
            json!({"content":[{"type":"text","text":"HTTP fixture reply"}],"isError":false})
        }
        "resources/list" => json!({"resources":[]}),
        "resources/templates/list" => json!({"resourceTemplates":[]}),
        _ => json!({}),
    };
    json_response(200, &json!({"jsonrpc":"2.0","id":id,"result":result}))
}
