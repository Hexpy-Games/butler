use super::super::*;
use super::Handler;

pub(in crate::gateway::http) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    client: Client,
) -> Result<Response, HttpError> {
    if state
        .application
        .data_reset()
        .is_some_and(|p| p.resetting())
        && !matches!(
            *request.method(),
            Method::GET | Method::HEAD | Method::OPTIONS
        )
        && request.uri().path() != "/data/reset"
    {
        return Err(HttpError::public(
            503,
            "service_resetting",
            "Service is resetting.",
        ));
    }
    let uri = request.uri().clone();
    let Some(handler) = super::select::handler(&request) else {
        return if request.method() == Method::GET {
            static_ui::serve(
                state.static_ui_root.as_deref(),
                uri.path(),
                static_ui::accepts_html(request.headers()),
            )
            .await
        } else {
            Err(HttpError::public(404, "not_found", "Route not found."))
        };
    };
    match handler {
        Handler::PendingAsks => pending_asks::route(state, request).await,
        Handler::DataReset => data_reset::route(state, request).await,
        Handler::NotFound => Err(HttpError::public(404, "not_found", "Route not found.")),
        Handler::Logs => logs::route(state, request, &uri).await,
        Handler::Documents => documents::route(state, request).await,
        Handler::Library => library::route(state, request).await,
        Handler::History => library::history::route(state, request).await,
        Handler::Browser => browser_host::route(state, request, &client).await,
        Handler::BrowserStills => browser_stills::route(state, request).await,
        Handler::Preview => content::preview::view(&state, &request),
        Handler::Output => content::view(state, request).await,
        Handler::Security => security_settings::route(state, request).await,
        Handler::Plugins => plugins::route(state, request).await,
        Handler::Hooks => hooks::route(state, request).await,
        Handler::OpenedFiles => opened_files::route(state, request).await,
        Handler::Settings if request.method() == Method::GET => {
            settings::get(state, Some(client)).await
        }
        Handler::Favicons if request.method() == Method::GET => favicons::get(state, &uri).await,
        Handler::Live if request.method() == Method::GET => {
            let scope = request
                .extensions()
                .get::<listeners::ListenerScope>()
                .cloned();
            get_live_events(state, &uri, scope, &client.keys).await
        }
        _ => commands(handler, state, request, &uri).await,
    }
}
async fn commands(
    handler: Handler,
    state: Arc<HttpState>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    match handler {
        Handler::ImageModels => image_models::route(state, request).await,
        #[cfg(feature = "e2e-fixtures")]
        Handler::ImageFixtures => image_fixtures::route(state, request).await,
        Handler::CanonSidebar => canon_sidebar::route(state, request, uri).await,
        Handler::Canon => canon::route(state, request, uri).await,
        Handler::TaskGraphs => task_graphs::route(state, request, uri).await,
        Handler::Subsessions => required(subsessions::route(state, request, uri).await?),
        Handler::Authority => authority::route(state, request, uri).await,
        Handler::Models => model_catalog::route(state, request, uri).await,
        Handler::Personalization => personalization::route(state, request, uri).await,
        Handler::Monitors => monitors::route(state, request, uri).await,
        Handler::Space => required(space_mutations::route(state, request, uri).await?),
        Handler::Dashboard => required(dashboard::route(state, request, uri).await?),
        Handler::Controls => required(session_controls::route(state, request, uri).await?),
        Handler::ProjectSession => {
            required(project_session_mutations::route(state, request, uri).await?)
        }
        Handler::Shell if request.method() == Method::GET => shell::route(state, uri).await,
        Handler::Automations => automations::route(state, request, uri).await,
        Handler::Updates => updates::route(state, request).await,
        Handler::MessageFiles if request.method() == Method::GET => {
            message_files::route(state, request).await
        }
        Handler::MessageUpload if request.method() == Method::POST => {
            message_files::route(state, request).await
        }
        Handler::Wallpapers => wallpapers::route(state, request).await,
        Handler::Queue
            if matches!(
                *request.method(),
                Method::POST | Method::PATCH | Method::DELETE
            ) =>
        {
            session_queue::route(state, request, uri).await
        }
        Handler::Mcp => mcp_servers::route(state, request, uri).await,
        Handler::Operation => required(operation_output::route(state, request, uri).await?),
        Handler::Retry => required(retry::route(state, request.method(), uri).await?),
        Handler::Cancel if request.method() == Method::POST => {
            required(retry::cancel(&state, request.method(), uri).await?)
        }
        Handler::Setup => setup::route(state, request, uri).await,
        #[cfg(feature = "e2e-fixtures")]
        Handler::Expire => logs::expire().await,
        #[cfg(feature = "e2e-fixtures")]
        Handler::LogWriter => logs::writer_fixture::route(uri).await,
        _ => super::super::route(state, request, handler).await,
    }
}
fn required(response: Option<Response>) -> Result<Response, HttpError> {
    response.ok_or_else(|| HttpError::public(404, "not_found", "Route not found."))
}
