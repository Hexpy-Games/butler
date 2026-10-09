//! Ephemeral browser ownership and network policy; authority is durable in BTCC.
use serde_json::Value;
use std::{collections::HashMap, net::IpAddr};

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
            if tab["profile"] == "signed_in" {
                return Err("signed_in_unavailable");
            }
            if tab["holder"] == "user" {
                return Err("user_control");
            }
        }
        Ok(tab)
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
        url::Host::Domain(host) if host == "localhost" || host.ends_with(".localhost") => {
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
    const HOSTS: &[&str] = &[
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
    HOSTS
        .iter()
        .any(|site| host == *site || host.ends_with(&format!(".{site}")))
}

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
