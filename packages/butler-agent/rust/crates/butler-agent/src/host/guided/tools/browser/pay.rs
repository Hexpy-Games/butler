//! `browser_pay_fill {tab, card_ref?}` and `browser_autofill_fill {tab,
//! profile_id, targets}`: Butler fills a saved card or autofill
//! profile without the model ever seeing a value. The model sees nicknames
//! and the last four card numbers only. Policy `ask` raises one exact card
//! naming the merchant origin, the amount when the page shows one and the
//! item; a site the user allowed in Settings skips it. Steps only the user
//! can do (secure keypad, card-app or ISP authentication, OTP, 3-D Secure)
//! hand the tab to the user and the call resumes durably on the hand-back.
use super::super::{GuidedTools, dispatch::encoded};
use super::{authority, client, grant, page_data, settle};
use butler_core::json::JsonDocument;
use butler_turn::btcc::{AccessMode, GuidedInvocation, ModelRoundToolCall, ToolExecutionError};
use serde_json::{Value, json};

/// One call's identity and transport, shared by its steps.
struct Call<'a> {
    owner: &'a GuidedTools,
    invocation: &'a GuidedInvocation<'a>,
    call: &'a ModelRoundToolCall,
    occurrence: &'a str,
    client: &'a client::Client,
    tab: &'a Value,
}

/// `browser_sign_in` keeps its own module; the vault fills start here.
pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
    client: client::Client,
    args: Value,
) -> Result<JsonDocument, ToolExecutionError> {
    if call.name == "browser_sign_in" {
        return super::signin::execute(owner, invocation, call, occurrence, client, args).await;
    }
    if call.name == "browser_pay_fill"
        && owner
            .schedule_run()
            .and_then(|run| run.browser)
            .is_some_and(|browser| !browser.payment)
        && let Some(refused) = super::super::turn_guard::schedule_browser_feedback(
            owner,
            call,
            &args,
            args["tab"].as_str().unwrap_or(""),
            "schedule_payment_off",
        )
        .await
    {
        return encoded(&refused);
    }
    if owner.binding.access_mode == AccessMode::ReadOnly {
        return encoded(&json!({"status":"not_dispatched","reason":"read_only"}));
    }
    if let Some(input) = authority::bound(owner, call, occurrence).await?
        && input.get("wait").is_some()
    {
        settle(owner, owner.binding.authority_request_ref.clone(), "ok").await?;
        return encoded(&json!({"status":"ready","observe_required":true,
            "note":"The user finished the step and handed the tab back. Observe before continuing."}));
    }
    let tab = args["tab"].clone();
    let this = Call {
        owner,
        invocation,
        call,
        occurrence,
        client: &client,
        tab: &tab,
    };
    let card = call.name == "browser_pay_fill";
    let (kind, section) = (if card { "card" } else { "profile" }, &args["section_ref"]);
    let signal = invocation.cancellation;
    let request = (
        "pay.inspect",
        &tab,
        &json!({"kind": kind, "section_ref": section, "targets": args["targets"]}),
    );
    let inspected = grant::call(owner, call, occurrence, &client, request, signal).await?;
    if inspected["status"] == "user_required" {
        // A step only the user can do comes before any field (3-D Secure, card app).
        let merchant = inspected["merchant_origin"].as_str().unwrap_or("");
        let site = butler_runtime::browser::site_of(merchant).unwrap_or_default();
        return hand_over(&this, &inspected, &site).await;
    }
    if inspected["status"] != "ok" {
        return encoded(&page_data(inspected));
    }
    let looked = client.call("pay.lookup", &tab, &json!({}), signal).await;
    if looked["status"] != "ok" {
        return encoded(&looked);
    }
    let reference = &args[if card { "card_ref" } else { "profile_id" }];
    match choose(
        &looked[if card { "cards" } else { "profiles" }],
        reference,
        card,
    ) {
        Ok(item) => fill(&this, (&inspected, &looked), &item, kind, &args["targets"]).await,
        Err(refusal) => encoded(&refusal),
    }
}

/// Asks unless the item is allowed on this site, then fills under the token.
async fn fill(
    this: &Call<'_>,
    (inspected, looked): (&Value, &Value),
    item: &Value,
    kind: &str,
    targets: &Value,
) -> Result<JsonDocument, ToolExecutionError> {
    if kind == "card" && this.owner.schedule_run().is_some() && looked["purchase_allowed"] != true {
        super::super::attention::skipped_input(
            this.owner,
            this.call,
            approval_input(inspected, item, kind, this.tab),
            &format!("browser:pay:{}", looked["site"].as_str().unwrap_or("")),
            "schedule_permission_required",
        )
        .await;
        return encoded(&super::super::turn_guard::unattended_feedback(
            this.owner,
            &this.call.name,
            looked["site"].as_str().unwrap_or(""),
        ));
    }
    let mut approval = None;
    if item["allowed"] != true && !(kind == "card" && looked["purchase_allowed"] == true) {
        let input = approval_input(inspected, item, kind, this.tab);
        let target = format!("browser:pay:{}", looked["site"].as_str().unwrap_or(""));
        match authority::gate(this.owner, this.call, this.occurrence, &input, &target).await? {
            authority::Gate::Pending(pending) => return encoded(&pending),
            authority::Gate::Allowed(reference, scope) => {
                approval = reference;
                if scope.as_deref() == Some("site") {
                    let result = allow_site(
                        this.client,
                        this.tab,
                        &looked["site"],
                        this.invocation.cancellation,
                    )
                    .await;
                    if result["status"] != "ok" {
                        settle(this.owner, approval, "failed").await?;
                        return encoded(&result);
                    }
                }
            }
        }
    }
    let op = if kind == "card" {
        "pay.fill"
    } else {
        "autofill.fill"
    };
    let args = json!({"item_id": item["id"], "top_origin": inspected["top_origin"],
        "frame_origins": inspected["frame_origins"], "targets": targets,
        "payment_skip": if kind == "card" && looked["purchase_allowed"] == true { Some(json!({"amount":inspected["amount"]})) } else { None }});
    let result = this
        .client
        .call(op, this.tab, &args, this.invocation.cancellation)
        .await;
    let status = match result["status"].as_str() {
        Some("filled" | "user_required") => "ok",
        Some("unknown") => "unknown",
        _ => "failed",
    };
    settle(this.owner, approval, status).await?;
    if result["status"] == "user_required" {
        return hand_over(this, &result, looked["site"].as_str().unwrap_or("")).await;
    }
    encoded(&page_data(result))
}

const HUMAN_STEPS: &[&str] = &[
    "secure_keypad",
    "app_auth",
    "otp",
    "three_ds",
    "captcha",
    "unknown_form",
];

/// The saved item the call names (nickname, last four or id), or the only one.
fn choose(items: &Value, reference: &Value, card: bool) -> Result<Value, Value> {
    let list: Vec<&Value> = items.as_array().into_iter().flatten().collect();
    let options: Vec<Value> = list
        .iter()
        .map(|item| {
            if card {
                json!({"card_ref": item["nickname"], "last4": item["last4"], "brand": item["brand"]})
            } else {
                json!({"profile_id": item["id"], "nickname": item["nickname"], "fields": item["fields"]})
            }
        })
        .collect();
    if list.is_empty() {
        let reason = if card {
            "no_saved_card"
        } else {
            "no_saved_autofill"
        };
        return Err(json!({"status":"not_dispatched","reason":reason,
            "recovery":"Nothing is saved for this. Ask the user to enter the details in the tab, then call browser_wait_for_user with reason secure_field; they can save items in Settings."}));
    }
    let wanted = reference.as_str().map(str::trim).filter(|r| !r.is_empty());
    if !card && wanted.is_none() {
        return Err(
            json!({"status":"not_dispatched","reason":"choose_one","options":options,
            "recovery":"Pass the profile_id the user chose."}),
        );
    }
    let matches: Vec<&Value> = match wanted {
        Some(wanted) => list
            .iter()
            .copied()
            .filter(|item| {
                item["id"] == wanted
                    || card
                        && item["nickname"]
                            .as_str()
                            .is_some_and(|n| n.eq_ignore_ascii_case(wanted))
                    || card && item["last4"] == wanted.trim_start_matches(['*', '•', ' '])
            })
            .collect(),
        None => list,
    };
    match matches.as_slice() {
        [one] => Ok((*one).clone()),
        _ => Err(json!({"status":"not_dispatched",
            "reason": if wanted.is_some() { "no_match" } else { "choose_one" }, "options": options,
            "recovery":"Pass the ref of the item the user chose; ask the user when they have not said which."})),
    }
}

/// The exact facts the user decides on: where, how much, and which item.
fn approval_input(inspected: &Value, item: &Value, kind: &str, tab: &Value) -> Value {
    let nickname = item["nickname"].as_str().unwrap_or("");
    let label = if kind == "card" {
        format!("{nickname} · •••• {}", item["last4"].as_str().unwrap_or(""))
    } else {
        nickname.to_owned()
    };
    json!({"pay": {"kind": kind, "item": item["id"], "label": label,
        "merchant": inspected["merchant_origin"], "top": inspected["top_origin"],
        "fields": if kind == "profile" { inspected["fields"].clone() } else { Value::Null }, "frames": inspected["frame_origins"], "amount": inspected["amount"]},
        "tab": tab, "always_confirm": true,
        "allow_site": if kind == "card" { Some("payment") } else { None }})
}

/// Main already gave the tab to the user; wait durably for the hand-back.
async fn hand_over(
    this: &Call<'_>,
    result: &Value,
    site: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    let reason = result["reason"]
        .as_str()
        .filter(|reason| HUMAN_STEPS.contains(reason))
        .unwrap_or("unknown_form");
    let input = json!({"wait":{"site":site,"reason":reason},"tab":this.tab,"always_confirm":true});
    let target = this.tab.as_str().unwrap_or("");
    match authority::gate(this.owner, this.call, this.occurrence, &input, target).await? {
        authority::Gate::Pending(mut pending) => {
            this.client
                .waiting(this.tab, true, this.invocation.cancellation)
                .await;
            pending["status"] = json!("user_required");
            pending["reason"] = json!(reason);
            pending["filled"] = result["filled"].clone();
            pending["recovery"] = json!(
                "The user finishes this step in the tab; Butler resumes when they hand it back."
            );
            encoded(&pending)
        }
        authority::Gate::Allowed(reference, _) => {
            settle(this.owner, reference, "ok").await?;
            encoded(&json!({"status":"ready","observe_required":true}))
        }
    }
}

/// The gateway binds this write to the tab's current merchant site.
pub(super) async fn allow_site(
    client: &client::Client,
    tab: &Value,
    site: &Value,
    signal: &tokio_util::sync::CancellationToken,
) -> Value {
    client
        .call("pay.allow_site", tab, &json!({"site":site}), signal)
        .await
}
