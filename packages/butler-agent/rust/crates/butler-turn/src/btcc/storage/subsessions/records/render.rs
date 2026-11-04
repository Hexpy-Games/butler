//! Render a persisted Worker packet, including when a waiting Task is admitted.
use super::SubsessionPacket;
const WORKER_GAPS: &str = "Fix a tool error or try another source; after one corrected call and one other route, report what still fails and what you tried. Observe produced files as the user will and fix them. Where evidence cannot settle a question, give your judgment and why. Report surviving gaps once, without per-item caveats. Stay inside your Task: use its inputs as given, and report a gap outside your scope instead of researching or editing it.";

impl SubsessionPacket {
    pub(crate) fn render_worker_input(&self, profile_prompt: Option<&str>) -> String {
        let packet = self;
        let user = packet.user_request.as_ref().map(|text| format!(
        "\nuser_request (the user's own words, verbatim; context only, your assignment below is your scope): {text}"
    )).unwrap_or_default();
        let context = packet.task_context.clone();
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
