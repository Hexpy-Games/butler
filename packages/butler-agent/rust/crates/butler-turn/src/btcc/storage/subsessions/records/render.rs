//! Render a persisted Worker packet, including when a waiting Task is admitted.
use super::SubsessionPacket;
const WORKER_GAPS: &str = "Fix a tool error or try another source; after one corrected call and one other route, report what still fails and what you tried. Observe produced files as the user will and fix them. Where evidence cannot settle a question, give your judgment and why. Report surviving gaps once, without per-item caveats. Stay inside your Task: use its inputs as given, and report a gap outside your scope instead of researching or editing it.";

impl SubsessionPacket {
    pub(crate) fn render_worker_input(&self, profile_prompt: Option<&str>) -> String {
        let packet = self;
        let user = packet.user_request.as_ref().map(|text| format!(
        "\nuser_request (the user's own words, verbatim; context for your action, keep within its scope and output form): {text}"
    )).unwrap_or_default();
        let mut context = packet.task_context.clone();
        if let Some(path) = &packet.target_path {
            context.push_str(&format!(
            "\ntarget_path: {path}. Revise and check this path; it is the one that gets published."
        ));
        }
        if !packet.earlier_steps.is_empty() {
            context.push_str("\nearlier_steps: Results of the actions this one depends on. Use their facts as confirmed; research only the gaps they name and what this action newly needs, and re-check a confirmed fact only when this action is to verify it.");
            for step in &packet.earlier_steps {
                context.push_str(&format!("\n- {step}"));
            }
        }
        let base = format!(
            "role: worker{user}\nassigned_objective: {}\nacceptance_criteria: {}\nimplementation_brief: {}{context}\nReport the bounded result to the Steward. {WORKER_GAPS}",
            packet.objective,
            serde_json::to_string(&packet.acceptance_criteria).unwrap_or_default(),
            packet.implementation_brief.as_deref().unwrap_or("")
        );
        match profile_prompt.filter(|value| !value.trim().is_empty()) {
            Some(prompt) => format!("{base}\nworker_profile_prompt: {prompt}"),
            None => base,
        }
    }
}
