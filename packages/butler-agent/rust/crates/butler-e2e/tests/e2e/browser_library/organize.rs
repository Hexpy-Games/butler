//! Library organizing: groups per kind (create, rename, reorder, delete),
//! moves with the kind check, shared tags (AND filter, rename, merge,
//! delete), renames with the original title kept searchable, and re-saves
//! that keep what the user organized.
use super::{ok, page, scrap};
use butler_e2e::e2e::{HarnessError, gateway::Gateway, scenario::Setup};
use serde_json::{Value, json};

fn ids(page: &Value) -> Vec<String> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect()
}
async fn group(gw: &Gateway, kind: &str, name: &str) -> Result<String, HarnessError> {
    let created = ok(gw
        .post("/library/groups", json!({"kind": kind, "name": name}))
        .await?);
    assert_eq!(created["name"], name);
    assert_eq!(created["count"], 0);
    Ok(created["id"].as_str().unwrap().to_owned())
}
async fn change(gw: &Gateway, body: Value) -> Result<Value, HarnessError> {
    Ok(ok(gw.patch("/library/items", body).await?))
}
async fn error(
    gw: &Gateway,
    method: &str,
    path: &str,
    body: Value,
) -> Result<(u16, String), HarnessError> {
    let reply = match method {
        "POST" => gw.post(path, body).await?,
        _ => gw.patch(path, body).await?,
    };
    Ok((
        reply.status,
        reply.error_code().unwrap_or_default().to_owned(),
    ))
}

#[tokio::test]
async fn groups_tags_and_renames_organize_the_library() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("BROWSER-LIBRARY-ORGANIZE")?.start().await?;
    for (id, title) in [
        ("a", "Kyoto temples"),
        ("b", "Osaka food"),
        ("c", "Tax form"),
    ] {
        ok(s.gw.post("/library", scrap(id, title)).await?);
    }
    let mark = json!({"id":"x","kind":"bookmark","title":"Docs","url":"https://docs.example.com/","capturedAt":"2026-10-09T00:00:00Z"});
    let bookmark = ok(s.gw.post("/library", mark).await?)["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Groups: per kind, unique case-insensitively, new ones last; reorder and rename.
    let travel = group(&s.gw, "scrap", "Travel").await?;
    let work = group(&s.gw, "scrap", "Work").await?;
    let folder = group(&s.gw, "bookmark", "Travel").await?;
    assert_eq!(
        error(
            &s.gw,
            "POST",
            "/library/groups",
            json!({"kind":"scrap","name":" travel "})
        )
        .await?,
        (409, "library_group_exists".into())
    );
    assert_eq!(
        error(
            &s.gw,
            "POST",
            "/library/groups",
            json!({"kind":"document","name":"Docs"})
        )
        .await?
        .0,
        400
    );
    assert_eq!(
        error(
            &s.gw,
            "POST",
            "/library/groups",
            json!({"kind":"scrap","name":"x".repeat(101)})
        )
        .await?
        .0,
        400
    );
    let moved = ok(s
        .gw
        .patch(&format!("/library/groups/{work}"), json!({"position": 0}))
        .await?);
    assert_eq!(moved["position"], 0);
    let renamed = ok(s
        .gw
        .patch(
            &format!("/library/groups/{travel}"),
            json!({"name": "Trips"}),
        )
        .await?);
    assert_eq!(
        (renamed["name"].as_str(), renamed["position"].as_i64()),
        (Some("Trips"), Some(1))
    );
    assert_eq!(
        error(
            &s.gw,
            "PATCH",
            &format!("/library/groups/{travel}"),
            json!({"name":"WORK"})
        )
        .await?,
        (409, "library_group_exists".into())
    );

    // Moves: one kind per group; the whole call fails on a mismatch.
    let filed = change(&s.gw, json!({"ids":["a","b"],"group":travel})).await?;
    assert!(
        filed["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["group"] == json!(travel))
    );
    change(&s.gw, json!({"ids":["b"],"group":work})).await?;
    assert_eq!(
        error(
            &s.gw,
            "PATCH",
            "/library/items",
            json!({"ids":["c", bookmark],"group":travel})
        )
        .await?,
        (400, "library_group_kind_mismatch".into())
    );
    assert_eq!(
        error(
            &s.gw,
            "PATCH",
            "/library/items",
            json!({"ids":["c"],"group":folder})
        )
        .await?,
        (400, "library_group_kind_mismatch".into())
    );
    assert_eq!(
        page(&s, "/library?kind=scrap&group=none").await?["items"][0]["id"],
        "c",
        "the failed call moved nothing"
    );
    let overview = page(&s, "/library/groups?kind=scrap").await?;
    assert_eq!(
        (overview["total"].as_i64(), overview["ungrouped"].as_i64()),
        (Some(3), Some(1))
    );
    let groups = overview["groups"].as_array().unwrap();
    assert_eq!(
        groups
            .iter()
            .map(|g| (
                g["name"].as_str().unwrap(),
                g["count"].as_i64().unwrap(),
                g["position"].as_i64().unwrap()
            ))
            .collect::<Vec<_>>(),
        [("Work", 1, 0), ("Trips", 1, 1)]
    );
    assert_eq!(groups[1]["recent"][0]["id"], "a");
    assert_eq!(groups[1]["updatedAt"], "2026-10-09T00:00:00.000Z");
    assert_eq!(
        ids(&page(&s, &format!("/library?kind=scrap&group={travel}")).await?),
        ["a"]
    );
    assert_eq!(
        ids(&page(&s, "/library?kind=scrap&q=trips").await?),
        ["a"],
        "group names are searchable"
    );

    // Tags: shared by kinds, matched case-insensitively; every listed tag must match.
    change(
        &s.gw,
        json!({"ids":["a","b",bookmark],"addTags":["Seoul","Food"]}),
    )
    .await?;
    change(&s.gw, json!({"ids":["b"],"addTags":["seoul"]})).await?;
    change(&s.gw, json!({"ids":["a"],"removeTags":["food"]})).await?;
    assert_eq!(
        page(&s, "/library/tags").await?["tags"],
        json!([{"name":"Seoul","count":3},{"name":"Food","count":2}])
    );
    assert_eq!(
        ids(&page(&s, "/library?kind=scrap&tags=seoul,FOOD").await?),
        ["b"]
    );
    assert_eq!(
        ids(&page(&s, "/library?kind=scrap&tags=Seoul&sort=name").await?),
        ["a", "b"]
    );
    assert_eq!(
        ids(&page(&s, "/library?kind=scrap&q=food&tags=seoul").await?),
        ["b"]
    );
    let renamed = ok(s
        .gw
        .patch("/library/tags", json!({"from":"seoul","to":"서울"}))
        .await?);
    assert_eq!(
        renamed,
        json!({"tag":{"name":"서울","count":3},"merged":false})
    );
    let merged = ok(s
        .gw
        .patch("/library/tags", json!({"from":"Food","to":"서울"}))
        .await?);
    assert_eq!(
        merged,
        json!({"tag":{"name":"서울","count":3},"merged":true})
    );
    assert_eq!(
        page(&s, "/library?kind=scrap&tags=서울").await?["items"][0]["tags"],
        json!(["서울"])
    );
    assert_eq!(
        s.gw.patch("/library/tags", json!({"from":"nothing","to":"x"}))
            .await?
            .status,
        404
    );
    assert_eq!(
        error(
            &s.gw,
            "PATCH",
            "/library/items",
            json!({"ids":["a"],"addTags":["a,b"]})
        )
        .await?
        .0,
        400
    );

    // Renames keep the original title searchable; a re-save keeps the organization.
    let named = change(&s.gw, json!({"ids":["a"],"title":"My Japan plan"})).await?;
    assert_eq!(
        (
            named["items"][0]["title"].as_str(),
            named["items"][0]["autoTitle"].as_str()
        ),
        (Some("My Japan plan"), Some("Kyoto temples"))
    );
    assert_eq!(
        error(
            &s.gw,
            "PATCH",
            "/library/items",
            json!({"ids":["a","b"],"title":"Both"})
        )
        .await?
        .0,
        400
    );
    assert_eq!(ids(&page(&s, "/library?kind=scrap&q=kyoto").await?), ["a"]);
    assert_eq!(ids(&page(&s, "/library?kind=scrap&q=japan").await?), ["a"]);
    let resaved = ok(s
        .gw
        .post("/library", scrap("a", "Kyoto temples, updated"))
        .await?);
    assert_eq!(
        (resaved["title"].as_str(), resaved["autoTitle"].as_str()),
        (Some("My Japan plan"), Some("Kyoto temples, updated"))
    );
    assert_eq!(
        (&resaved["group"], &resaved["tags"]),
        (&json!(travel), &json!(["서울"]))
    );
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    let restored = change(&s.gw, json!({"ids":["a"],"title":"  "})).await?;
    assert_eq!(restored["items"][0]["title"], "Kyoto temples, updated");
    assert!(restored["items"][0].get("autoTitle").is_none());

    // Facets, tag and group deletion: items stay, only the label goes.
    let facets = page(&s, "/library/facets?kind=scrap").await?;
    assert_eq!(
        facets,
        json!({"total":3,"ungrouped":1,"tags":[{"name":"서울","count":2}],"sites":[{"site":"example.com","count":3}]})
    );
    assert_eq!(
        page(&s, "/library/facets?kind=output").await?["ungrouped"],
        Value::Null
    );
    assert_eq!(
        page(&s, &format!("/library/facets?kind=scrap&group={work}")).await?["total"],
        1
    );
    ok(s.gw.delete("/library/tags/%EC%84%9C%EC%9A%B8").await?);
    assert_eq!(page(&s, "/library/tags").await?["tags"], json!([]));
    ok(s.gw.delete(&format!("/library/groups/{work}")).await?);
    let overview = page(&s, "/library/groups?kind=scrap").await?;
    assert_eq!(
        overview["groups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| (g["name"].as_str().unwrap(), g["position"].as_i64().unwrap()))
            .collect::<Vec<_>>(),
        [("Trips", 0)]
    );
    assert_eq!(
        (overview["total"].as_i64(), overview["ungrouped"].as_i64()),
        (Some(3), Some(2))
    );
    assert_eq!(
        page(&s, "/library?kind=scrap&q=Seoul").await?["items"],
        json!([])
    );
    ok(s.gw.delete("/library/a").await?);
    assert_eq!(
        page(&s, "/library/groups?kind=scrap").await?["groups"][0]["count"],
        0
    );
    s.finish().await
}

#[tokio::test]
async fn site_facets_include_every_saved_source() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-LIBRARY-SITES")?.start().await?;
    for n in 0..55 {
        let mut item = scrap(&format!("site-{n}"), "Saved source");
        item["site"] = json!(format!("site{n:02}.example"));
        ok(s.gw.post("/library", item).await?);
    }
    let facets = page(&s, "/library/facets?kind=scrap").await?;
    let sites = facets["sites"].as_array().unwrap();
    assert_eq!(sites.len(), 55);
    assert_eq!(sites.first().unwrap()["site"], "site00.example");
    assert_eq!(sites.last().unwrap()["site"], "site54.example");
    assert!(sites.iter().all(|site| site["count"] == 1));
    assert_eq!(facets["total"], 55);
    s.finish().await
}
