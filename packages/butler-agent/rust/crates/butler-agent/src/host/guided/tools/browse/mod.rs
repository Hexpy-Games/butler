//! One bounded, stateless browser task, with the existing browser authority lane.
mod journal;
mod prompt;
mod result;
mod step;

use super::{GuidedTools, browser, dispatch::encoded};
use butler_core::json::JsonDocument;
use butler_models::models::{
    PromptUsageAttribution, ProviderPromptLifecycle, ProviderPromptRequest,
};
use butler_turn::btcc::{GuidedInvocation, ModelRoundToolCall, ToolExecutionError};
use serde_json::{Value, json};

struct Run {
    goal: String,
    fields: Value,
    max_steps: usize,
    steps: usize,
    tab: Value,
    observation: Value,
    url: Value,
    opened: Vec<Value>,
    log: Vec<Value>,
    notes: String,
    view: Value,
    seen: Vec<(String, String)>,
}

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    let args = Value::Object(call.arguments.clone());
    let Some(goal) = args["goal"].as_str().filter(|goal| !goal.trim().is_empty()) else {
        return encoded(&json!({"status":"stuck","summary":"goal is required"}));
    };
    if !owner.binding.authorized_names.contains("browse") {
        return encoded(&json!({"status":"not_dispatched","reason":"tool_not_admitted"}));
    }
    let effort = serde_json::from_value(json!(owner.binding.reasoning_effort))
        .unwrap_or(butler_models::models::ReasoningEffort::Medium);
    let setting = owner.monitoring.browsing_agent_setting().await;
    let model = owner
        .web_session
        .browsing_model(
            &invocation.model_execution.active_model_ref(),
            effort,
            &setting,
        )
        .await;
    let Some(model) = model else {
        return encoded(
            &json!({"status":"executor_unavailable","error_code":"executor_not_configured"}),
        );
    };
    let mut run = Run::new(goal, &args);
    start(owner, invocation, occurrence, &args, &model, &mut run).await
}

async fn start(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    occurrence: &str,
    args: &Value,
    model: &butler_runtime::web_access::BrowseModel,
    run: &mut Run,
) -> Result<JsonDocument, ToolExecutionError> {
    if args.get("url").is_some() {
        let result = step::open(owner, invocation, occurrence, run, &args["url"]).await?;
        if result["status"] != "ok" {
            return encoded(&run.finish(result, &model.model));
        }
    }
    if run.tab.as_str().is_none_or(str::is_empty) {
        return encoded(&run.finish(json!({"status":"stuck","summary":"No tab selected","needs":"Provide url or an open tab."}), &model.model));
    }
    let observed = step::observe(owner, invocation, occurrence, &run.tab).await?;
    if observed["status"] != "ok" {
        return encoded(&run.finish(observed, &model.model));
    }
    run.remember(observed);
    drive(owner, invocation, occurrence, model, run).await
}

async fn drive(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    occurrence: &str,
    model: &butler_runtime::web_access::BrowseModel,
    run: &mut Run,
) -> Result<JsonDocument, ToolExecutionError> {
    for index in 1..=run.max_steps {
        run.steps = index;
        let response = request(owner, invocation, model, run).await;
        let next = match response {
            Ok(response) => match step::parse(&response) {
                Ok((notes, next)) => {
                    run.notes = notes;
                    next
                }
                Err(reason) => {
                    return encoded(
                        &run.finish(json!({"status":"stuck","summary":reason}), &model.model),
                    );
                }
            },
            Err(code) => {
                return encoded(&run.finish(
                    json!({"status":"executor_unavailable","error_code":code}),
                    &model.model,
                ));
            }
        };
        if let Some(done) = result::terminal(run, &next) {
            return encoded(&run.finish(done, &model.model));
        }
        let step_occurrence = format!("{occurrence}:step:{index}");
        let outcome = step::execute(owner, invocation, &step_occurrence, run, &next).await?;
        if outcome["status"] == "needs_approval" {
            return encoded(&run.finish(outcome, &model.model));
        }
        run.log.push(json!({"step":index,"action":next,"outcome":outcome["action"].get("status").unwrap_or(&outcome["status"])}));
        if outcome["status"] == "ok" || outcome["ok"] == true {
            run.remember(outcome);
        } else {
            return encoded(&run.finish(json!({"status":"stuck","summary":outcome}), &model.model));
        }
    }
    encoded(&run.finish(json!({"status":"step_limit","summary":format!("{} Latest page: {} (observation {}).",run.notes,run.url.as_str().unwrap_or(""),run.observation.as_str().unwrap_or(""))}), &model.model))
}

async fn request(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    model: &butler_runtime::web_access::BrowseModel,
    run: &Run,
) -> Result<String, String> {
    let scope = json!({"fields":run.fields,
        "step":format!("{} of {}", run.steps, run.max_steps),
        "action_log":run.log,"notes":run.notes,"view":run.view})
    .to_string();
    let prompt = format!("User request:\n{}\nCurrent scope:\n{scope}", run.goal);
    let attribution = PromptUsageAttribution {
        root_session_id: owner.web_session.browse_usage_root(),
        role: Some("browse"),
        turn_id: Some(&owner.binding.turn_id),
        ..PromptUsageAttribution::for_phase("browse-executor")
    };
    model
        .prompt
        .run_prompt(
            ProviderPromptRequest {
                prompt: &prompt,
                model: Some(&model.model),
                reasoning_effort: Some(&model.effort),
                instructions: Some(prompt::EXECUTOR_INSTRUCTIONS),
                response_format: None,
                cache_scope: Some("browse-executor"),
                cache_boundary: None,
                cancellation: invocation.cancellation.clone(),
                attachments: &[],
                butler_data: None,
                usage_attribution: Some(&attribution),
                stream_observer: None,
                provider_retry_attempts: Some(0.0),
            },
            ProviderPromptLifecycle::none(),
        )
        .await
        .map(|result| result.text)
        .map_err(|error| match error {
            butler_turn::btcc::ModelRoundError::Provider(error) => error.code,
            butler_turn::btcc::ModelRoundError::InvocationFailure { code, .. } => {
                code.unwrap_or_else(|| "executor_request_failed".into())
            }
            butler_turn::btcc::ModelRoundError::Cancelled => "turn_cancelled".into(),
            _ => "executor_request_failed".into(),
        })
}

impl Run {
    fn new(goal: &str, args: &Value) -> Self {
        Run {
            goal: goal.into(),
            fields: args["fields"].clone(),
            max_steps: usize::try_from(args["max_steps"].as_u64().unwrap_or(12).clamp(1, 30))
                .unwrap_or(12),
            steps: 0,
            tab: args["tab"].clone(),
            observation: Value::Null,
            url: Value::Null,
            opened: vec![],
            log: vec![],
            notes: String::new(),
            view: Value::Null,
            seen: vec![],
        }
    }
}
