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
            ("VB-04", "확인한 사람을 기록한다"),
            ("VB-03", "변경 내용을 확인할 수 있다"),
        ],
    )?;
    s.restart().await?;
    let carried = count(&s, &epic, 1, 2).await?;
    assert_eq!(carried["specs"][0]["criteria"][0]["confirmed"], true);
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
            json!({"title":"명세가 없는 과제","assignee":"app-user"}),
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
    null_surfaces(&s, project, &epic, empty.data()["id"].as_str().unwrap()).await?;
    s.finish().await
}

async fn null_surfaces(
    s: &Scenario,
    project: &str,
    epic: &str,
    empty: &str,
) -> Result<(), HarnessError> {
    let sidebar =
        s.gw.get(&format!("/projects/{project}/canon/sidebar"))
            .await?;
    assert_eq!(sidebar.status, 200, "{}", sidebar.text);
    let rows = sidebar.data()["groups"][0]["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    for row in rows {
        assert_eq!(row.get("criteria"), Some(&Value::Null));
    }
    let plan =
        s.gw.post(
            &format!("/projects/{project}/canon/plans"),
            json!({"title":"빈 명세"}),
        )
        .await?;
    assert_eq!(plan.status, 201, "{}", plan.text);
    let plan = plan.data()["id"].as_str().unwrap();
    for id in [epic, empty] {
        let detail = s.gw.get(&format!("/canon/epics/{id}")).await?;
        let moved =
            s.gw.patch(
                &format!("/canon/epics/{id}"),
                json!({"expected_revision":detail.data()["revision"],"plan_id":plan}),
            )
            .await?;
        assert_eq!(moved.status, 200, "{}", moved.text);
    }
    let detail = s.gw.get(&format!("/canon/plans/{plan}")).await?;
    assert_eq!(detail.status, 200, "{}", detail.text);
    let works = detail.data()["works"].as_array().unwrap();
    assert_eq!(works.len(), 2);
    for work in works {
        assert_eq!(work.get("criteria"), Some(&Value::Null));
    }
    Ok(())
}
