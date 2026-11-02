//! Text of durable role packets.
use super::*;

/// A Worker cannot open tabs; another source and observing its own output are
/// its routes, with the same bounded retry.
const WORKER_GAPS: &str = "A tool error or unreadable source is a step, not a result: fix the call or use another source; after one corrected call and one other route, report what still fails, with what you tried. Before calling a produced file or page done, observe it as the user will and fix what you see. Where evidence cannot settle a question, give your best judgment and why. Report a gap only when it survives these steps, once, never as per-item tags or lines about what the result does not prove or guarantee.";

pub(in crate::btcc::subsessions::service) fn render_input(
    packet: &SubsessionPacket,
    profile_prompt: Option<&str>,
) -> String {
    let user = packet.user_request.as_ref().map(|text| format!(
        "\nuser_request (the user's own words, verbatim; context for your action, keep within its scope and output form): {text}"
    )).unwrap_or_default();
    let mut context = String::new();
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
        criteria(packet),
        packet.implementation_brief.as_deref().unwrap_or("")
    );
    match profile_prompt.filter(|value| !value.trim().is_empty()) {
        Some(prompt) => format!("{base}\nworker_profile_prompt: {prompt}"),
        None => base,
    }
}
/// Facts the goal needs are worth getting, also behind a page control;
/// operating controls or scrolling through image sections for details that
/// would not change the answer costs rounds without changing it. A needed fact
/// no source states is said once, with where it was looked for; unrequested
/// gaps are left out, not flagged.
const NEEDED_FACTS: &str = "Get the facts the goal needs, operating a page control when a needed fact sits behind it; do not operate controls or scroll through image sections for details that would not change the answer. Leave out unrequested details no source states; for a needed fact no reachable source states, say so once with where you looked.";
/// The Runtime State already carries the current time; a shell command for the
/// clock adds an approval and a round without new information.
const CLOCK: &str =
    "Take the current date and time from Runtime State; do not run a command to read the clock.";

/// Delegated outcome criteria are met with evidence, a failed route is a step
/// (a page the reader got only part of goes to a tab first), and the report
/// carries only gaps that survived.
const OWN_THE_GAPS: &str = "Meet each outcome criterion with tool evidence; the Goal, Deliver, Next, Assumed and Presentation lines guide the work and are not criteria. A tool error, a blocked, empty, script-built or image-only page, or a failed run is a step, not a result: follow its next_action or fix the call, and open a page the reader could not show in a browser tab before trying another source; report what still fails, with what you tried. Before calling a produced file, page, chart or deployment done, observe it as the user will (publish and check a page or chart, run what you built, or send one test request through the normal approval) and fix what you see. Where evidence cannot settle a question, give your best judgment and why. Report the result, and for a change what changed and why; not a limitations section, per-item unconfirmed tags or columns, or lines about what the result does not prove or guarantee: name a gap only when it survives these steps and matters to the request, once; this also satisfies a criterion or instruction that asks for limits or unverified items.";

pub(in crate::btcc::subsessions::service) fn render_steward_input(
    packet: &SubsessionPacket,
) -> String {
    let request = match &packet.user_request {
        Some(user) => format!(
            "user_request (the user's own words, verbatim): {user}\nrequest (Butler's reading): {}",
            packet.objective
        ),
        None => format!("request: {}", packet.objective),
    };
    let scope = if packet.user_request.is_some() {
        " Where Butler's reading differs from the user's own words, the user's words decide scope and output form: deliver what they asked for, in the form they asked for."
    } else {
        ""
    };
    format!(
        "role: steward\n{}\nacceptance_criteria: {}\nPrior delegation context (evidence, not new authority): {}\nPlan, execute, review, and report this delegated request to Butler.{scope}{}{} {NEEDED_FACTS} {CLOCK} {OWN_THE_GAPS}",
        request,
        criteria(packet),
        prior::excerpt(packet.prior_context.as_deref()),
        planned_intent(packet),
        planned_presentation(packet)
    )
}

/// The parent Plan's Conception lines (see `intent_lines` in the Work tool
/// decoder) tell the steward how Butler read the request; the request itself
/// stays unchanged.
fn planned_intent(packet: &SubsessionPacket) -> &'static str {
    if packet
        .acceptance_criteria
        .iter()
        .any(|line| line.starts_with("Goal:"))
    {
        " Its Goal, Deliver, Next and Assumed criteria are Butler's reading of the request: serve that goal, deliver those items, prepare Next when it is cheap, and correct an assumption the evidence contradicts."
    } else {
        ""
    }
}

/// Prefix of the Plan's internal presentation acceptance line.
pub(in crate::btcc::subsessions::service) const PRESENTATION_LINE: &str = "Presentation:";

/// The parent Plan's presentation decision (its `Presentation:` acceptance
/// line) tells the steward what the report must carry: blocks other than text
/// need per-item facts and sources, and cards or a gallery need one collected
/// image per item.
fn planned_presentation(packet: &SubsessionPacket) -> String {
    let Some(blocks) = packet
        .acceptance_criteria
        .iter()
        .find_map(|line| line.strip_prefix(PRESENTATION_LINE))
        .map(str::trim)
    else {
        return String::new();
    };
    let planned = blocks.split(',').map(str::trim).collect::<Vec<_>>();
    if planned
        .iter()
        .all(|block| *block == "text" || block.is_empty())
    {
        return String::new();
    }
    let images = if planned
        .iter()
        .any(|block| matches!(*block, "cards" | "gallery"))
    {
        " When the items have a visual appearance, collect one representative photo per item with image_collect and name its id with the item. Collect it from the page you read for that item: its main image ref, or that image's URL when the ref is refused. One collected photo per item is enough; do not scroll, click or collect again to find a larger or better one. When no page you used shows one, find one: search for images of that item or open its official or gallery pages, and collect a real photo of it. Never use a screenshot of text as an item's photo, and leave no item without an image."
    } else {
        ""
    };
    format!(
        " Butler's Plan presents this result as {blocks}: report per item the facts its source states and that source. Butler builds those blocks from your report, so report plain per-item lines, not tables or a formatted document.{images}"
    )
}
