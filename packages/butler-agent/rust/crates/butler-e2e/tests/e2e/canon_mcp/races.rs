//! The former store CAS race now covers the real authenticated HTTP adapter.
use super::*;
#[tokio::test]
async fn cn_11_concurrent_canon_edits_have_one_winner() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("CN-11-EDIT-RACE")?.start().await?;
    let project = project(&s).await?;
    let epic =
        s.gw.post(
            &format!("/projects/{project}/canon/epics"),
            json!({"title":"Original"}),
        )
        .await?
        .data()
        .clone();
    let path = format!("/canon/epics/{}", epic["id"].as_str().unwrap());
    let (a, b) = tokio::join!(
        s.gw.patch(
            &path,
            json!({"expected_revision":epic["revision"],"title":"First"})
        ),
        s.gw.patch(
            &path,
            json!({"expected_revision":epic["revision"],"title":"Second"})
        )
    );
    let mut results = [a?, b?];
    results.sort_by_key(|r| r.status);
    assert_eq!((results[0].status, results[1].status), (200, 409));
    let winner = s.gw.get(&path).await?;
    assert_eq!(winner.data(), results[0].data());
    assert_eq!(
        winner.data()["revision"].as_i64(),
        epic["revision"].as_i64().map(|r| r + 1)
    );
    assert_eq!(results[1].body["error"]["code"], "conflict");
    assert_eq!(
        results[1].body["error"]["current"]["revision"],
        winner.data()["revision"]
    );
    s.finish().await
}
