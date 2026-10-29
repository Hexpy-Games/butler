use super::*;
#[tokio::test]
async fn decisions_carry_only_while_id_and_text_survive_every_revision() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (mut s, _, epic) = fixture("CC-revisions").await?;
    toggle(&s, true, 1).await?;
    s.agent.terminate().await?;
    publish(
        &s,
        2,
        &[
            ("VB-03", "변경 내용을 확인할 수 있다"),
            ("VB-04", "확인한 사람을 기록한다"),
        ],
    )?;
    s.restart().await?;
    count(&s, &epic, 1, 2).await?;
    s.agent.terminate().await?;
    publish(
        &s,
        3,
        &[
            ("VB-03", "기준마다 변경 내용을 확인할 수 있다"),
            ("VB-04", "확인한 사람을 기록한다"),
        ],
    )?;
    s.restart().await?;
    assert_eq!(
        count(&s, &epic, 0, 2).await?["specs"][0]["criteria"][0]["confirmed"],
        false
    );
    s.agent.terminate().await?;
    publish(
        &s,
        4,
        &[
            ("VB-03", "변경 내용을 확인할 수 있다"),
            ("VB-04", "확인한 사람을 기록한다"),
        ],
    )?;
    s.restart().await?;
    count(&s, &epic, 0, 2).await?; // Restoring old text does not restore the decision.
    toggle(&s, true, 4).await?;
    s.agent.terminate().await?;
    publish(&s, 5, &[("VB-04", "확인한 사람을 기록한다")])?;
    s.restart().await?;
    count(&s, &epic, 0, 1).await?;
    s.agent.terminate().await?;
    publish(&s, 6, &[])?;
    s.restart().await?;
    let detail = s.gw.get(&format!("/canon/epics/{epic}")).await?;
    assert_eq!(detail.data()["criteria"], Value::Null);
    assert!(detail.data().get("criteria").is_some());
    let project = detail.data()["project_id"].as_str().unwrap();
    let empty =
        s.gw.post(
            &format!("/projects/{project}/canon/epics"),
            json!({"title":"명세가 없는 과제"}),
        )
        .await?;
    assert_eq!(empty.status, 201, "{}", empty.text);
    assert_eq!(empty.data()["criteria"], Value::Null);
    assert!(empty.data().get("criteria").is_some());
    for path in [
        format!("/projects/{project}/canon"),
        format!("/canon/list?project={project}"),
    ] {
        let reply = s.gw.get(&path).await?;
        let rows = reply.data()[if path.contains("canon/list") {
            "epics"
        } else {
            "backlog"
        }]
        .as_array()
        .unwrap();
        assert_eq!(rows.len(), 2);
        for row in rows {
            assert_eq!(row.get("criteria"), Some(&Value::Null));
        }
    }
    s.finish().await
}
