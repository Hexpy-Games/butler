//! Publishing commands over the authenticated App API.
use super::{
    setup::{envelope, not_found},
    subsessions::decode_component,
    *,
};
use crate::gateway::{AppLibraryCommand as C, PublishSource, PublishingRequest as P};
use serde_json::{Value, json};

pub(super) async fn item(
    state: &HttpState,
    method: &Method,
    id: &str,
) -> Result<Response, HttpError> {
    let setup = state.application.setup()?;
    let status = setup.publishing(P::Status).await?;
    if status["signed_in"] == false {
        return Err(HttpError::public(
            401,
            "butler_account_signed_out",
            "Sign in to your Butler account first.",
        ));
    }

    let id = id.to_owned();
    let item = state
        .application
        .library(C::Item { id: id.clone() })
        .await?;
    let source = source(&item)?;
    let data = match *method {
        Method::GET => setup.publishing(P::Preview { source }).await?,
        Method::POST => {
            let published = setup
                .publishing(P::Publish {
                    item_id: id.clone(),
                    title: item["title"].as_str().unwrap_or_default().to_owned(),
                    source,
                })
                .await?;
            state
                .application
                .library(C::SetPublished {
                    id,
                    published: Some(
                        json!({"page_id": published["page_id"], "url": published["url"]}),
                    ),
                })
                .await?;
            published
        }
        Method::DELETE => {
            let page_id = item["published"]["page_id"].as_str().ok_or_else(|| {
                HttpError::public(404, "not_published", "This item is not published.")
            })?;
            setup
                .publishing(P::Unpublish {
                    page_id: page_id.to_owned(),
                })
                .await?;
            state
                .application
                .library(C::SetPublished {
                    id,
                    published: None,
                })
                .await?;
            json!({"unpublished": true})
        }
        _ => {
            return Err(HttpError::public(
                405,
                "method_not_allowed",
                "Method not allowed.",
            ));
        }
    };
    envelope(StatusCode::OK, data)
}

fn source(item: &Value) -> Result<PublishSource, HttpError> {
    if let Some(output_id) = item["output"].as_str() {
        return Ok(PublishSource::Output {
            output_id: output_id.to_owned(),
        });
    }

    let file = &item["file"];
    if let (Some(mime), Some(file_id), Some(name)) = (
        file["mime_type"].as_str(),
        file["id"].as_str(),
        file["safe_name"].as_str(),
    ) && (mime == "text/html" || mime.starts_with("image/") || mime == "application/pdf")
    {
        return Ok(PublishSource::File {
            file_id: file_id.to_owned(),
            name: name.to_owned(),
        });
    }
    Err(HttpError::public(
        400,
        "not_publishable",
        "This item can't be published.",
    ))
}

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let operation = match (request.method(), request.uri().path()) {
        (&Method::GET, "/publishing") => P::Status,
        (&Method::GET, "/publishing/pages") => P::Pages,
        (&Method::DELETE, path) => {
            let encoded = path
                .strip_prefix("/publishing/pages/")
                .filter(|id| !id.is_empty() && !id.contains('/'))
                .ok_or_else(not_found)?;
            let page_id = decode_component(encoded).map_err(|_| not_found())?;
            if page_id.is_empty() || page_id.contains('/') {
                return Err(not_found());
            }
            P::Unpublish { page_id }
        }
        _ => return Err(not_found()),
    };
    envelope(
        StatusCode::OK,
        state.application.setup()?.publishing(operation).await?,
    )
}
