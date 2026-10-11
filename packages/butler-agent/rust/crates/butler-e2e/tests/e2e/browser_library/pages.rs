//! Library listings: every sort pages completely by cursor, combined filters
//! (group, tags, site, dates, words) narrow together, and the same reads stay
//! complete at owner scale.
use super::{ok, page};
use butler_e2e::e2e::{HarnessError, scenario::Scenario, scenario::Setup};
use serde_json::{Value, json};
use std::time::Instant;

/// Every item of a listing, following `next_cursor`, and the page count.
async fn all(s: &Scenario, path: &str) -> Result<(Vec<Value>, usize), HarnessError> {
    let (mut items, mut pages, mut cursor) = (Vec::new(), 0, String::new());
    loop {
        let mut url = reqwest::Url::parse(&format!("http://fixture{path}")).unwrap();
        if !cursor.is_empty() {
            url.query_pairs_mut().append_pair("cursor", &cursor);
        }
        let reply = page(
            s,
            &format!("{}?{}", url.path(), url.query().unwrap_or_default()),
        )
        .await?;
        let batch = reply["items"].as_array().unwrap();
        assert!(batch.len() <= 60);
        items.extend(batch.iter().cloned());
        pages += 1;
        match reply["next_cursor"].as_str() {
            Some(next) => cursor = next.to_owned(),
            None => return Ok((items, pages)),
        }
    }
}
fn ids(items: &[Value]) -> Vec<String> {
    items
        .iter()
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect()
}
/// Scrap `n`: three sites, one capture per minute, names out of capture order.
fn item(n: usize) -> Value {
    let site = ["alpha.example", "beta.example", "gamma.example"][n % 3];
    json!({"id": format!("s{n:03}"), "kind": "scrap", "title": format!("{} note {n}", ["Zebra", "apple", "Mango", "banana"][n % 4]),
        "url": format!("https://{site}/{n}"), "site": site, "text": if n.is_multiple_of(5) { "harbor view" } else { "plain" },
        "crop": "data:image/jpeg;base64,YQ==", "capturedAt": format!("2026-10-01T{:02}:{:02}:00Z", n / 60, n % 60)})
}

#[tokio::test]
async fn every_sort_and_filter_pages_completely() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-LIBRARY-FILTERS")?.start().await?;
    let total = 150;
    for n in 0..total {
        ok(s.gw.post("/library", item(n)).await?);
    }
    let group = ok(s
        .gw
        .post(
            "/library/groups",
            json!({"kind":"scrap","name":"Collection"}),
        )
        .await?)["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // Keep group metadata distinct from the words tested below.
    let evens: Vec<String> = (0..total)
        .filter(|n| n.is_multiple_of(2))
        .map(|n| format!("s{n:03}"))
        .collect();
    ok(s.gw
        .patch("/library/items", json!({"ids": evens, "group": group}))
        .await?);
    let thirds: Vec<String> = (0..total)
        .filter(|n| n % 3 != 2)
        .map(|n| format!("s{n:03}"))
        .collect();
    ok(s.gw
        .patch(
            "/library/items",
            json!({"ids": thirds, "addTags": ["Port"]}),
        )
        .await?);
    let fours: Vec<String> = (0..total)
        .filter(|n| n.is_multiple_of(4))
        .map(|n| format!("s{n:03}"))
        .collect();
    ok(s.gw
        .patch(
            "/library/items",
            json!({"ids": fours, "addTags": ["Night"]}),
        )
        .await?);
    let items: Vec<Value> = (0..total).map(item).collect();
    let key = |item: &Value| item["title"].as_str().unwrap().to_lowercase();
    let text = |item: &Value, field: &str| item[field].as_str().unwrap().to_owned();
    let newest = |a: &&Value, b: &&Value| {
        (text(b, "capturedAt"), text(b, "id")).cmp(&(text(a, "capturedAt"), text(a, "id")))
    };
    let mut expected: Vec<(&str, Vec<&Value>)> = Vec::new();
    let mut by = items.iter().collect::<Vec<_>>();
    by.sort_by(newest);
    expected.push(("new", by.clone()));
    by.reverse();
    expected.push(("old", by.clone()));
    by.sort_by_key(|item| (key(item), item["id"].as_str().unwrap().to_owned()));
    expected.push(("name", by.clone()));
    by.sort_by(|a, b| text(a, "site").cmp(&text(b, "site")).then(newest(a, b)));
    expected.push(("site", by.clone()));
    for (sort, order) in &expected {
        let (listed, pages) = all(&s, &format!("/library?kind=scrap&sort={sort}")).await?;
        assert_eq!(
            ids(&listed),
            order
                .iter()
                .map(|i| i["id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
            "sort {sort}"
        );
        assert_eq!(pages, 3, "sort {sort}");
    }
    // Every filter at once, in every sort: group ∧ both tags ∧ site ∧ date range ∧ words.
    let wanted = |n: usize| {
        n.is_multiple_of(2)
            && n.is_multiple_of(3)
            && n.is_multiple_of(4)
            && n.is_multiple_of(5)
            && (12..=140).contains(&n)
    };
    for (sort, order) in &expected {
        let path = format!(
            "/library?kind=scrap&sort={sort}&group={group}&tags=port,NIGHT&site=alpha.example&since=2026-10-01T00:12:00Z&until=2026-10-01T02:20:00%2B00:00&q=harbor"
        );
        let (listed, _) = all(&s, &path).await?;
        let want: Vec<String> = order
            .iter()
            .map(|i| i["id"].as_str().unwrap().to_owned())
            .filter(|id| wanted(id[1..].parse().unwrap()))
            .collect();
        assert_eq!(ids(&listed), want, "filtered sort {sort}");
        assert_eq!(want.len(), 2);
    }
    let (ungrouped, _) = all(&s, "/library?kind=scrap&group=none&tags=Port").await?;
    assert_eq!(
        ungrouped.len(),
        (0..total).filter(|n| n % 2 == 1 && n % 3 != 2).count()
    );
    let (sited, pages) = all(&s, "/library?kind=scrap&site=beta.example&sort=old").await?;
    assert_eq!((sited.len(), pages), (50, 1));
    for bad in ["sort=size", "since=yesterday", "kind=file"] {
        assert_eq!(
            s.gw.get(&format!("/library?{bad}")).await?.status,
            400,
            "{bad}"
        );
    }
    s.finish().await
}

/// Owner-scale seed: 10k scraps and 10k bookmarks written as a version-1
/// Library (bookmark folders in payloads), so startup migrates all of them.
fn seed(data: &std::path::Path) {
    let db = butler_platform::sqlite::open(data.join("app-server/butler-client.sqlite")).unwrap();
    db.execute_batch("BEGIN;
        DELETE FROM browser_library_migration WHERE version=2;
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<9999)
        INSERT INTO browser_library(id,kind,title,url,payload,created_at)
        SELECT 'scale-s'||i,'scrap','Scrap '||i,'https://site'||(i%40)||'.example/'||i,
          json_object('id','scale-s'||i,'kind','scrap','title','Scrap '||i,'url','https://site'||(i%40)||'.example/'||i,'site','site'||(i%40)||'.example','text',CASE WHEN i%100=0 THEN 'lighthouse' ELSE 'scale body' END,'crop','data:image/jpeg;base64,YQ==','capturedAt',strftime('%Y-%m-%dT%H:%M:%fZ','2026-01-01',printf('+%d seconds',i*60))),
          strftime('%Y-%m-%dT%H:%M:%fZ','2026-01-01',printf('+%d seconds',i*60)) FROM n;
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<9999)
        INSERT INTO browser_library(id,kind,title,url,payload,created_at)
        SELECT 'scale-b'||i,'bookmark','Bookmark '||i,'https://mark'||(i%40)||'.example/'||i,
          json_object('id','scale-b'||i,'kind','bookmark','title','Bookmark '||i,'url','https://mark'||(i%40)||'.example/'||i,'folder','Folder '||(i%50),'capturedAt',strftime('%Y-%m-%dT%H:%M:%fZ','2026-01-01',printf('+%d seconds',i*60))),
          strftime('%Y-%m-%dT%H:%M:%fZ','2026-01-01',printf('+%d seconds',i*60)) FROM n;
        INSERT INTO browser_library_tag(norm,name) VALUES('common','Common'),('rare','Rare');
        INSERT INTO browser_library_item_tag(item_id,norm) SELECT id,'common' FROM browser_library WHERE id LIKE 'scale-%' AND CAST(substr(id,8) AS INTEGER)%2=0;
        INSERT INTO browser_library_item_tag(item_id,norm) SELECT id,'rare' FROM browser_library WHERE id LIKE 'scale-s%' AND CAST(substr(id,8) AS INTEGER)%500=0;
        COMMIT;").unwrap();
}

#[tokio::test]
async fn owner_scale_library_reads_are_complete() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("BROWSER-LIBRARY-SCALE")?.start().await?;
    s.agent.terminate().await?;
    let data = s.sandbox.data.clone();
    tokio::task::spawn_blocking(move || seed(&data))
        .await
        .unwrap();
    let started = Instant::now();
    s.gw = s.agent.start_again().await?;
    eprintln!(
        "LIBRARY-SCALE migrate_and_start items=20000 elapsed_ms={}",
        started.elapsed().as_millis()
    );
    let groups = page(&s, "/library/groups?kind=bookmark").await?;
    assert_eq!(groups["groups"].as_array().unwrap().len(), 50);
    assert_eq!(groups["total"], 10_000);
    let folder = groups["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["name"] == "Folder 7")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let checks: Vec<(&str, String, usize)> = vec![
        ("page_new", "/library?kind=scrap".into(), 10_000),
        ("page_name", "/library?kind=scrap&sort=name".into(), 10_000),
        (
            "page_site",
            "/library?kind=bookmark&sort=site".into(),
            10_000,
        ),
        (
            "group",
            format!("/library?kind=bookmark&group={folder}"),
            200,
        ),
        (
            "tag_common",
            "/library?kind=scrap&tags=common".into(),
            5_000,
        ),
        ("tag_rare", "/library?kind=scrap&tags=rare".into(), 20),
        ("site", "/library?kind=scrap&site=site3.example".into(), 250),
        ("words", "/library?kind=scrap&q=lighthouse".into(), 100),
    ];
    for (name, path, count) in checks {
        let started = Instant::now();
        let first = page(&s, &path).await?;
        let elapsed = started.elapsed().as_micros();
        let (items, pages) = all(&s, &path).await?;
        assert_eq!(items.len(), count, "{name}");
        let unique = items
            .iter()
            .map(|item| item["id"].as_str().unwrap())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(unique.len(), count, "{name}: no repeats across pages");
        if name == "page_new" {
            assert_eq!(first["items"][0]["id"], "scale-s9999");
        }
        assert_eq!(
            first["items"].as_array().unwrap().len(),
            items.len().min(60),
            "{name}"
        );
        eprintln!(
            "LIBRARY-SCALE {name} first_page_us={elapsed} items={} pages={pages}",
            items.len()
        );
    }
    for (name, path) in [
        ("groups", "/library/groups?kind=bookmark"),
        ("facets", "/library/facets?kind=scrap"),
        ("tags", "/library/tags"),
    ] {
        let started = Instant::now();
        let reply = page(&s, path).await?;
        eprintln!("LIBRARY-SCALE {name} us={}", started.elapsed().as_micros());
        if name == "tags" {
            assert_eq!(reply["tags"][0], json!({"name":"Common","count":10_000}));
        }
        if name == "facets" {
            assert_eq!(
                (
                    reply["total"].as_i64(),
                    reply["sites"].as_array().unwrap().len()
                ),
                (Some(10_000), 40)
            );
        }
    }
    s.finish().await
}
