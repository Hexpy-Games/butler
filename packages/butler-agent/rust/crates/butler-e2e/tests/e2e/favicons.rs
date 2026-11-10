//! FAVICON: public gateway admission and immutable raster cache, stub tier only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    fake_servers::FakeServer,
    media,
    scenario::{Scenario, Setup},
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    time::{Duration, Instant, SystemTime},
};

fn path(root: &std::path::Path, host: &str) -> std::path::PathBuf {
    root.join(format!("{:x}.png", Sha256::digest(host.as_bytes())))
}

// test-category: security
#[tokio::test]
async fn favicon_endpoint_rejects_unsafe_hosts_and_serves_immutable_cache()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("FAVICON-01")?;
    let root = setup.sandbox.data.join("cache/favicons");
    fs::create_dir_all(&root)?;
    let png = media::digits_png("32", 12);
    let cached = path(&root, "cached.invalid");
    fs::write(&cached, &png)?;
    fs::write(
        path(&root, "svg.invalid"),
        b"<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>",
    )?;
    let mut oversized = png.clone();
    oversized.resize(100 * 1024 + 1, 0);
    fs::write(path(&root, "oversize.invalid"), oversized)?;
    let stale = path(&root, "stale.invalid");
    fs::write(&stale, &png)?;
    fs::OpenOptions::new().write(true).open(&stale)?.set_times(
        fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_hours(744)),
    )?;
    let mut s = setup.start().await?;
    let unauthorized =
        s.gw.http()
            .get(format!("{}/favicons?host=cached.invalid", s.gw.base))
            .send()
            .await?;
    assert_eq!(unauthorized.status(), 401);
    for host in [
        "localhost",
        "single",
        "foo.local",
        "foo.internal",
        "foo.localhost",
        "foo.test",
        "EXAMPLE.COM",
        "https://example.com",
        "example.com:443",
        "example.com@evil.com",
        "127.0.0.1",
        "10.0.0.1",    // privacy-hygiene: allow-private-ip (unsafe-host classification)
        "172.16.0.1",  // privacy-hygiene: allow-private-ip (unsafe-host classification)
        "192.168.0.1", // privacy-hygiene: allow-private-ip (unsafe-host classification)
        "169.254.169.254",
        "100.64.0.1",
        "224.0.0.1",
        "0.0.0.0",
        "[::1]",
        "[fc00::1]",
        "[fe80::1]",
        "[::ffff:127.0.0.1]",
    ] {
        let reply =
            s.gw.http()
                .get(format!("{}/favicons", s.gw.base))
                .query(&[("host", host)])
                .bearer_auth(&s.gw.token)
                .send()
                .await?;
        assert_eq!(reply.status(), 404, "host={host}");
        assert_eq!(reply.headers()["cache-control"], "private, no-store");
    }
    let before = fs::metadata(&cached)?.modified()?;
    let requests = (0..16).map(|_| {
        s.gw.http()
            .get(format!("{}/favicons?host=cached.invalid", s.gw.base))
            .bearer_auth(&s.gw.token)
            .send()
    });
    let responses = futures_util::future::join_all(requests).await;
    assert_eq!(responses.len(), 16);
    for response in responses {
        let response = response?;
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["content-type"], "image/png");
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert_eq!(
            response.headers()["content-security-policy"],
            "default-src 'none'; sandbox"
        );
        assert_eq!(response.bytes().await?.to_vec(), png);
    }
    s.restart().await?;
    assert_eq!(s.gw.get("/favicons?host=cached.invalid").await?.status, 200);
    assert_eq!(
        fs::metadata(&cached)?.modified()?,
        before,
        "cache hit modified icon"
    );
    for host in ["svg.invalid", "oversize.invalid", "stale.invalid"] {
        let start = Instant::now();
        assert_eq!(
            s.gw.get(&format!("/favicons?host={host}")).await?.status,
            404,
            "{host}"
        );
        butler_e2e::assert_wall_clock_budget!(
            start.elapsed(),
            Duration::from_secs(4),
            "favicon fallback before renderer deadline"
        );
    }
    assert_eq!(fs::read_dir(&root)?.count(), 4, "negative result persisted");
    s.finish().await
}

// test-category: security
#[tokio::test]
async fn favicon_lru_evicts_old_hosts_without_writing_hits() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("FAVICON-02")?;
    let root = setup.sandbox.data.join("cache/favicons");
    fs::create_dir_all(&root)?;
    let png = media::digits_png("32", 12);
    for index in 0..257 {
        fs::write(path(&root, &format!("cache-{index}.invalid")), &png)?;
    }
    let recent = path(&root, "cache-256.invalid");
    let before = fs::metadata(&recent)?.modified()?;
    let s = setup.start().await?;
    for index in 0..257 {
        let response =
            s.gw.http()
                .get(format!("{}/favicons?host=cache-{index}.invalid", s.gw.base))
                .bearer_auth(&s.gw.token)
                .send()
                .await?;
        assert_eq!(response.status(), 200, "cache-{index}");
        assert_eq!(response.bytes().await?.to_vec(), png);
    }
    assert_eq!(fs::metadata(&recent)?.modified()?, before);
    assert_eq!(fs::read_dir(&root)?.count(), 257);
    // Removing fixtures distinguishes a retained memory entry from a disk reload.
    fs::remove_file(&recent)?;
    fs::remove_file(path(&root, "cache-0.invalid"))?;
    assert_eq!(
        s.gw.get("/favicons?host=cache-256.invalid").await?.status,
        200
    );
    assert_eq!(
        s.gw.get("/favicons?host=cache-0.invalid").await?.status,
        404
    );
    assert_eq!(
        fs::read_dir(&root)?.count(),
        255,
        "miss wrote a negative entry"
    );
    s.finish().await
}

const BROWSER: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) \
                       Chrome/152.0.0.0 Safari/537.36 Butler/0";

async fn icon(s: &Scenario, host: &str, user_agent: &str) -> Result<u16, HarnessError> {
    let reply =
        s.gw.http()
            .get(format!("{}/favicons?host={host}", s.gw.base))
            .header("user-agent", user_agent)
            .bearer_auth(&s.gw.token)
            .send()
            .await?;
    Ok(reply.status().as_u16())
}

#[tokio::test]
async fn favicon_fetch_sends_viewer_identity_and_remembers_refusals() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let site = FakeServer::favicons().await?;
    let setup = Setup::new("FAVICON-03")?.env("BUTLER_E2E_FAVICON_ORIGIN", &site.base_url);
    let root = setup.sandbox.data.join("cache/favicons");
    let mut s = setup.start().await?;
    assert_eq!(icon(&s, "viewer.invalid", BROWSER).await?, 200);
    let seen = site.seen();
    for (path, accept) in [
        ("/", "text/html,application/xhtml+xml,*/*;q=0.8"),
        ("/favicon.ico", "image/*"),
    ] {
        let request = seen.iter().find(|r| r.path == path).expect(path);
        assert_eq!(request.headers["user-agent"], BROWSER, "{path}");
        assert_eq!(request.headers["accept"], accept, "{path}");
    }
    assert_eq!(icon(&s, "refused.invalid", "fixture-bot/1").await?, 404);
    let asked = site.seen().len();
    let miss = root.join(format!("{:x}.miss", Sha256::digest(b"refused.invalid")));
    assert_eq!(fs::metadata(&miss)?.len(), 0, "refusal remembered on disk");
    s.restart().await?;
    assert_eq!(icon(&s, "refused.invalid", "fixture-bot/1").await?, 404);
    assert_eq!(site.seen().len(), asked, "restart asked the site again");
    assert_eq!(icon(&s, "after-restart.invalid", BROWSER).await?, 200);
    s.finish().await
}
