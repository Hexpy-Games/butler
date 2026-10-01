use butler_e2e::e2e::{HarnessError, gateway::Gateway, scenario::Scenario, security::AdminClient};
use reqwest::Method;
use serde_json::Value;

pub(crate) fn admin(s: &Scenario) -> AdminClient {
    AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap())
}
pub(crate) fn browser() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}
pub(crate) async fn issue(app: &AdminClient) -> Result<Value, HarnessError> {
    let reply = app
        .send(Method::POST, "/security/pairing", None, &[])
        .await?;
    assert_eq!(reply.status, 200);
    Ok(reply.data().clone())
}
pub(crate) async fn devices(app: &AdminClient) -> Result<Value, HarnessError> {
    let reply = app
        .send(Method::GET, "/security/devices", None, &[])
        .await?;
    assert_eq!(reply.status, 200);
    Ok(reply.data().clone())
}
pub(crate) async fn advance(app: &AdminClient, seconds: u64) -> Result<(), HarnessError> {
    let reply = app
        .send(
            Method::POST,
            &format!("/security/pairing/clock?seconds={seconds}"),
            None,
            &[],
        )
        .await?;
    assert_eq!(reply.status, 200);
    Ok(())
}
pub(crate) async fn connect(
    gw: &Gateway,
    browser: &reqwest::Client,
    code: &str,
) -> Result<reqwest::Response, HarnessError> {
    Ok(browser
        .post(format!("{}/connect", gw.base))
        .header("origin", &gw.base)
        .header("sec-fetch-site", "same-origin")
        .form(&[("code", code)])
        .send()
        .await?)
}
pub(crate) fn cookie_pair(response: &reqwest::Response) -> String {
    response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .into()
}
pub(crate) async fn read(
    gw: &Gateway,
    browser: &reqwest::Client,
    cookie: &str,
) -> Result<u16, HarnessError> {
    Ok(browser
        .get(format!("{}/settings", gw.base))
        .header("cookie", cookie)
        .header("sec-fetch-site", "same-origin")
        .send()
        .await?
        .status()
        .as_u16())
}
pub(crate) async fn rejected(
    gw: &Gateway,
    browser: &reqwest::Client,
    code: &str,
) -> Result<String, HarnessError> {
    let reply = connect(gw, browser, code).await?;
    assert_eq!(reply.status().as_u16(), 401);
    assert!(reply.headers().get("set-cookie").is_none());
    Ok(reply.text().await?)
}
pub(crate) fn assert_no_secrets(s: &Scenario, secrets: &[&str]) -> Result<(), HarnessError> {
    for entry in std::fs::read_dir(&s.sandbox.logs)? {
        let path = entry?.path();
        if path.is_file() {
            let log = std::fs::read_to_string(path)?;
            for secret in secrets {
                assert!(!log.contains(secret), "credential leaked in logs");
                assert!(
                    !log.contains(secret.rsplit('.').next().unwrap()),
                    "raw credential leaked in logs"
                );
            }
        }
    }
    Ok(())
}
