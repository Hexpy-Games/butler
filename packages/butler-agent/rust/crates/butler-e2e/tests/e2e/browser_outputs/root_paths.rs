use butler_e2e::e2e::{HarnessError, gateway::Gateway, scenario::Setup, security::AdminClient};
use reqwest::{Client, Response, Url, header, redirect::Policy};

#[tokio::test]
async fn vite_dist_root_paths_resolve_under_capability() -> Result<(), HarnessError> {
    butler_e2e::gate!();

    async fn load(client: &Client, referer: &Url, href: &str) -> (Url, Response) {
        let cap = referer.path_segments().unwrap().nth(1).unwrap();
        let target = referer.join(href).unwrap();
        let response = client
            .get(target.clone())
            .header(header::REFERER, referer.as_str())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 307);
        let loc = response.headers()[header::LOCATION].to_str().unwrap();
        assert!(loc.starts_with(&format!("/__o/{cap}/")) && !loc.contains("://"));
        if let Some(query) = target.query() {
            assert_eq!(loc, format!("/__o/{cap}{}?{query}", target.path()));
        }
        let final_url = target.join(loc).unwrap();
        let response = client
            .get(final_url.clone())
            .header(header::REFERER, referer.as_str())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        (final_url, response)
    }

    let setup = Setup::new("OUTPUT-ROOT-PATHS")?.stub_cassette(super::stub::cassette()?);
    let dist = setup.sandbox.chat_folder("general")?.join("dist");
    let assets = dist.join("assets");
    std::fs::create_dir_all(&assets)?;
    std::fs::write(
        dist.join("index.html"),
        r#"<!doctype html><link rel="stylesheet" href="/assets/app.css"><script type="module" src="/assets/app.js"></script><h1>Vite</h1>"#,
    )?;
    std::fs::write(
        assets.join("app.js"),
        r#"import("/assets/chunk.js").then(m => m.ready());"#,
    )?;
    std::fs::write(
        assets.join("chunk.js"),
        r#"export function ready() { document.body.dataset.ready = "1"; }"#,
    )?;
    std::fs::write(
        assets.join("app.css"),
        "@font-face{font-family:F;src:url(/assets/font.woff2)}body{font-family:F}",
    )?;
    std::fs::write(assets.join("font.woff2"), b"wOF2fixture")?;

    let s = setup.start().await?;
    let (turn, _) = s.turn("general", "Vite").await?;
    let published = super::result(&s, &turn);
    let id = published["output_id"].as_str().unwrap();
    let view_path = format!("/outputs/{id}/view");
    let view = s.gw.get(&view_path).await?;
    assert_eq!(view.status, 200);
    let entry = Url::parse(view.data()["url"].as_str().unwrap()).unwrap();
    let cap = entry.path_segments().unwrap().nth(1).unwrap();
    let origin = entry.origin().ascii_serialization();
    let app_path = format!("/__o/{cap}/assets/app.js");
    let app_url = format!("{origin}/assets/app.js");
    let client = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .build()?;

    let response = client.get(entry.clone()).send().await?;
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["referrer-policy"], "same-origin");

    let (app, response) = load(&client, &entry, "/assets/app.js").await;
    assert_eq!(app.path(), app_path);
    assert!(
        response.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/javascript")
    );
    let (_, response) = load(&client, &app, "/assets/chunk.js").await;
    assert!(response.text().await?.contains("ready"));
    let (css, _) = load(&client, &entry, "/assets/app.css").await;
    let (_, response) = load(&client, &css, "/assets/font.woff2").await;
    assert_eq!(response.headers()[header::CONTENT_TYPE], "font/woff2");
    load(&client, &entry, "/assets/app.js?v=1").await;

    for referer in [entry.path().to_owned(), format!("{entry}?bt=x")] {
        let response = client
            .get(&app_url)
            .header(header::REFERER, referer)
            .send()
            .await?;
        assert_eq!(response.status(), 307);
        assert_eq!(response.headers()[header::LOCATION], app_path.as_str());
    }

    for referer in [
        None,
        Some(format!("{}/", s.gw.base)),
        Some("https://other.example/assets/app.js".to_owned()),
        Some(entry.as_str().replace("/__o/", "/__o/forged")),
        Some(super::security::expired(entry.as_str(), &s.gw.token)),
    ] {
        let mut request = client.get(&app_url);
        if let Some(referer) = referer {
            request = request.header(header::REFERER, referer);
        }
        let response = request.send().await?;
        assert_eq!(response.status(), 404);
        assert!(!response.headers().contains_key(header::LOCATION));
    }

    let response = client
        .get(&app_url)
        .header(header::COOKIE, "butler_preview=unregistered")
        .header(header::REFERER, entry.as_str())
        .send()
        .await?;
    assert_eq!(response.status(), 403);

    for path in [
        "/assets/%2e%2e%2f%2e%2e%2fsecret",
        "/assets%5capp.js",
        "/assets/%00.js",
        "//other.example/x",
    ] {
        let response = client
            .get(format!("{origin}{path}"))
            .header(header::REFERER, entry.as_str())
            .send()
            .await?;
        assert_eq!(response.status(), 404);
        assert!(!response.headers().contains_key(header::LOCATION));
    }

    let security = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap())
        .set_remote(true)
        .await?;
    let lan = security["bind_addresses"][1].as_str();
    if std::env::var_os("BUTLER_E2E_REQUIRE_LAN").is_some() {
        assert!(lan.is_some(), "{security}");
    } else {
        butler_e2e::skip_unless!(lan.is_some(), "no LAN listener");
    }
    let lan_origin = format!("http://{}", lan.unwrap());
    let remote = Gateway::new(lan_origin.clone(), s.gw.token.clone());
    let view = remote.get(&view_path).await?;
    assert_eq!(view.status, 200);
    let lan_entry = Url::parse(view.data()["url"].as_str().unwrap()).unwrap();
    assert_eq!(lan_entry.host(), Url::parse(&lan_origin).unwrap().host());
    let (app, response) = load(&client, &lan_entry, "/assets/app.js").await;
    let lan_cap = lan_entry.path_segments().unwrap().nth(1).unwrap();
    assert_eq!(app.path(), format!("/__o/{lan_cap}/assets/app.js"));
    assert!(
        response.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/javascript")
    );
    let (_, response) = load(&client, &app, "/assets/chunk.js").await;
    assert!(response.text().await?.contains("ready"));

    s.finish().await
}
