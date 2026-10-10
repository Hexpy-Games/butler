//! Ephemeral browser ownership and network policy; authority is durable in BTCC.
pub mod egress;
pub mod headless;
pub use egress::{ContentOrigin, LoopbackFixtures, fetch_permitted, guarded_client};
pub use headless::{Headless, HeadlessConfig, InstallSource};
use serde_json::Value;
use std::{collections::HashMap, net::IpAddr};
mod signed_in;
pub use signed_in::*;

#[derive(Default)]
pub struct TabRegistry {
    tabs: HashMap<String, Value>,
}
impl TabRegistry {
    pub fn replace(&mut self, tabs: &[Value]) -> Result<(), &'static str> {
        if tabs.len() > 36 {
            return Err("tab_budget_exhausted");
        }
        let mut next = HashMap::new();
        for tab in tabs {
            let id = tab["id"].as_str().ok_or("invalid_tab")?;
            if id.len() > 128 || tab["owner"].as_str().is_none() || tab["epoch"].as_u64().is_none()
            {
                return Err("invalid_tab");
            }
            if next.insert(id.to_owned(), tab.clone()).is_some() {
                return Err("duplicate_tab");
            }
        }
        for tab in next
            .values()
            .filter(|tab| tab.get("opener").is_some_and(Value::is_string))
        {
            let parent = next
                .get(tab["opener"].as_str().unwrap_or(""))
                .ok_or("invalid_opener")?;
            if tab["owner"] != parent["owner"] || tab["profile"] != parent["profile"] {
                return Err("invalid_popup_owner");
            }
            if tab["holder"] == "agent"
                && !popup_permitted(
                    parent["url"].as_str().unwrap_or(""),
                    tab["url"].as_str().unwrap_or(""),
                )
            {
                return Err("popup_policy");
            }
        }
        self.tabs = next;
        Ok(())
    }
    pub fn check(&self, session: &str, id: &str, op: &str) -> Result<&Value, &'static str> {
        let tab = self.tabs.get(id).ok_or("not_your_tab")?;
        if tab["owner"] != format!("conversation:{session}") {
            return Err("not_your_tab");
        }
        if !matches!(
            op,
            "tab.wait" | "tab.waiting" | "tab.cancel" | "tab.selection"
        ) {
            // Signed-in tabs are fenced per call by the conversation's site grants.
            if tab["holder"] == "user" {
                return Err("user_control");
            }
        }
        Ok(tab)
    }
    pub fn get(&self, id: &str) -> Option<&Value> {
        self.tabs.get(id)
    }
    /// Signed-in tabs the user dragged from their own tabs into a conversation
    /// in this snapshot, as `(session, url)`: the drag is that conversation's grant.
    pub fn handovers(&self, next: &[Value]) -> Vec<(String, String)> {
        next.iter()
            .filter(|tab| tab["profile"] == "signed_in")
            .filter_map(|tab| {
                let previous = self.tabs.get(tab["id"].as_str()?)?;
                let session = tab["owner"].as_str()?.strip_prefix("conversation:")?;
                (previous["owner"] == "mine").then(|| {
                    (
                        session.to_owned(),
                        tab["url"].as_str().unwrap_or("").to_owned(),
                    )
                })
            })
            .collect()
    }
    /// This conversation's tab ids, so a mistyped id can be corrected without guessing.
    pub fn owned(&self, session: &str) -> Vec<String> {
        let owner = format!("conversation:{session}");
        let mut ids: Vec<_> = self
            .tabs
            .iter()
            .filter(|(_, tab)| tab["owner"] == owner.as_str())
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }
    /// Whether the App reported this tab, whoever owns it.
    pub fn contains(&self, id: &str) -> bool {
        self.tabs.contains_key(id)
    }
    pub fn is_user(&self, id: &str) -> bool {
        self.tabs.get(id).is_some_and(|tab| tab["holder"] == "user")
    }
    pub fn is_waiting(&self, id: &str) -> bool {
        self.tabs.get(id).is_some_and(|tab| tab["waiting"] == true)
    }
    pub fn ready_waits(&self) -> Vec<Value> {
        self.tabs
            .values()
            // Hand-back clears the UI waiting flag before durable admission may
            // finish. Holder ownership is the durable wait's readiness fact.
            .filter(|tab| tab["holder"] == "agent")
            .cloned()
            .collect()
    }
    pub fn clear(&mut self) {
        self.tabs.clear();
    }
}
pub fn public_url(value: &str) -> Result<url::Url, &'static str> {
    let url = url::Url::parse(value).map_err(|_| "navigation_denied")?;
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("navigation_denied");
    }
    match url.host().ok_or("navigation_denied")? {
        // A trailing dot names the same host ("localhost." is localhost).
        url::Host::Domain(host)
            if host.trim_end_matches('.') == "localhost"
                || host.trim_end_matches('.').ends_with(".localhost") =>
        {
            return Err("navigation_denied");
        }
        url::Host::Ipv4(ip) if private_ip(IpAddr::V4(ip)) => return Err("navigation_denied"),
        url::Host::Ipv6(ip) if private_ip(IpAddr::V6(ip)) => return Err("navigation_denied"),
        _ => (),
    }
    Ok(url)
}
fn private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip.is_unspecified()
                || ip.octets()[0] >= 224
                || ip.octets()[0] == 0
                || (ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))
        }
        IpAddr::V6(ip) => {
            ip.to_ipv4_mapped()
                .is_some_and(|v| private_ip(IpAddr::V4(v)))
                || ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
        }
    }
}
pub fn site_scope(value: &str) -> Result<String, &'static str> {
    let url = url::Url::parse(value).map_err(|_| "navigation_denied")?;
    let host = url.host_str().ok_or("navigation_denied")?;
    let site = if url
        .host()
        .is_some_and(|host| !matches!(host, url::Host::Domain(_)))
    {
        host
    } else {
        psl::domain_str(host).unwrap_or(host)
    };
    Ok(format!("browser:signed_out:{site}"))
}

/// Payment widgets remain per-act authority targets even on signed-out tabs.
pub fn payment_host(host: &str) -> bool {
    PAYMENT_SITES
        .iter()
        .any(|site| host == *site || host.ends_with(&format!(".{site}")))
}

/// Payment widget hosts (release-maintained).
pub const PAYMENT_SITES: &[&str] = &[
    "stripe.com",
    "stripe.network",
    "paypal.com",
    "paypalobjects.com",
    "tosspayments.com",
    "inicis.com",
    "nicepay.co.kr",
    "kakaopay.com",
    "naverpay.com",
    "pay.naver.com",
];

/// Native security keypad containers remain under human control.
pub const SECURE_KEYPAD_MARKERS: &[&str] = &[
    "transkey", "nxkey", "nprotect", "anysign", "wizvera", "touchen",
];

/// Preserve batch cardinality when a fence or lost host prevents native receipts.
pub fn batch_receipts(count: usize, mut result: Value) -> Value {
    if !(1..=10).contains(&count)
        || result["steps"].is_array()
        || result["authority_pending"] == true
        || result["status"] == "dialog_pending"
    {
        return result;
    }
    let status = if result["status"] == "unknown" {
        "unknown"
    } else {
        "not_dispatched"
    };
    let reason = result
        .get("reason")
        .or_else(|| result.get("error"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!("browser_refused"));
    result["steps"] = Value::Array(
        (0..count)
            .map(|index| {
                serde_json::json!({
                    "index": index, "status": status, "reason": reason
                })
            })
            .collect(),
    );
    if status == "unknown" {
        result["observe_required"] = Value::Bool(true);
    }
    result
}

/// Release-maintained auth/utility policy. Payment popups require an owner decision.
pub const POPUP_HOSTS: &[&str] = &[
    "accounts.google.com",
    "login.microsoftonline.com",
    "login.live.com",
    "appleid.apple.com",
    "github.com",
    "kauth.kakao.com",
    "nid.naver.com",
    "postcode.map.daum.net",
    "t1.daumcdn.net",
];

pub fn navigation_policy(content_origin: &str, raw: &str) -> Value {
    let site = site_scope(raw).unwrap_or_default();
    let popup_site = site.strip_prefix("browser:signed_out:").unwrap_or("");
    serde_json::json!({"content_origin":content_origin,"secure_keypads":SECURE_KEYPAD_MARKERS,
        "sites":[site],"popup_sites":[popup_site],"popup_hosts":POPUP_HOSTS})
}

pub fn popup_permitted(parent: &str, target: &str) -> bool {
    if target.is_empty() || target == "about:blank" {
        return url::Url::parse(parent).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.username().is_empty()
                && url.password().is_none()
        });
    }
    let Ok(url) = url::Url::parse(target) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
        && (site_scope(parent).ok() == site_scope(target).ok() || POPUP_HOSTS.contains(&host))
}
