//! Dashboard statistics across the App database and the read-only Ledger owner.

mod app;
mod calendar;
mod ledger;
mod view;

use serde_json::Value;

use super::super::{AppApplication, AppStorageError, GatewayApplicationError, app_error};
use super::contracts::AppProjectDashboardStatisticsQuery;
use super::project::read_project;

pub(super) async fn get(
    application: &AppApplication,
    project_id: &str,
    query: AppProjectDashboardStatisticsQuery,
) -> Result<Value, GatewayApplicationError> {
    let project = read_project(application, project_id).await?;
    let observed_at = application.dependencies.identity_clock.now_iso();
    let calendar = calendar::build(&query.timezone, query.period, observed_at)?;
    let mut output = view::base(&calendar);
    let base = output.clone();
    let app_calendar = calendar.clone();
    let app_project_id = project.id.clone();
    let session_projection = application
        .storage
        .execute(move |db| {
            let transaction = match db.transaction() {
                Ok(transaction) => transaction,
                Err(_) => return Ok(None),
            };
            let mut projection = base;
            if app::populate(
                &transaction,
                &app_project_id,
                &app_calendar,
                &mut projection,
            )
            .is_err()
                || view::source_count(&projection) > 20_000
            {
                return Ok(None);
            }
            transaction.commit().map_err(AppStorageError::sqlite)?;
            Ok(Some(projection))
        })
        .await
        .map_err(app_error)?;
    if let Some(session) = session_projection {
        output = session;
        output["sessionHistoryAvailable"] = Value::Bool(true);
    }

    if let Some(ledger_id) = project.ledger_project_id.clone()
        && let Ok(snapshot) = application
            .dependencies
            .project_dashboard_ledger
            .snapshot(project.id.clone(), ledger_id.clone())
            .await
    {
        let (ledger_history, managed_history) = tokio::join!(
            application
                .dependencies
                .project_dashboard_ledger
                .history(ledger_id.clone()),
            application
                .dependencies
                .project_dashboard_ledger
                .work_history(
                    project.id.clone(),
                    ledger_id,
                    snapshot.revision.clone(),
                    None,
                ),
        );
        let history = match (ledger_history, managed_history) {
            (Ok(ledger), Ok(managed)) if ledger.revision != "absent" => {
                Some((ledger.events, managed))
            }
            _ => None,
        };
        ledger::populate(
            &mut output,
            &calendar,
            &snapshot,
            history
                .as_ref()
                .map(|(ledger, managed)| (ledger.as_slice(), managed.as_slice())),
        );
    }

    filter_available_series(&mut output);
    if view::source_count(&output) > 20_000 {
        return Err(GatewayApplicationError::Internal);
    }
    Ok(output)
}

fn filter_available_series(view: &mut Value) {
    let sessions = view["sessionHistoryAvailable"].as_bool() == Some(true);
    let ledger = view["ledgerHistoryAvailable"].as_bool() == Some(true);
    filter_keys(&mut view["activity"], |key| match key {
        "conversations" => sessions,
        "work" => ledger,
        "materials" => sessions || ledger,
        _ => false,
    });
    for key in ["materials", "materialTypes"] {
        filter_keys(&mut view[key], |metric| match metric {
            "artifacts" => sessions,
            _ => ledger,
        });
    }
}

fn filter_keys(series: &mut Value, keep: impl Fn(&str) -> bool) {
    if let Some(keys) = series["keys"].as_array_mut() {
        keys.retain(|value| value.as_str().is_some_and(&keep));
    }
}
