//! One card per turn: another chat, a return to older content or a lost record of
//! the user's answers asks again, and no turn fails over a shared approval slot.
use super::*;

#[tokio::test]
async fn project_hooks_a_second_chat_gets_its_own_card() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-CHATS").await?;
    let first = project.chat.clone();
    project.write(&[project.observer("guard", "Stop", "ran.jsonl")])?;
    let second = project.new_chat(&s).await?;
    let first_turn = s.gw.say_turn(&first, "First chat.").await?;
    let first_card = card(&s, &first).await?;
    let second_turn = s.gw.say_turn(&second, "Second chat.").await?;
    let second_card = card(&s, &second).await?;
    assert_ne!(first_card["request_ref"], second_card["request_ref"]);
    assert_eq!(project.ran("ran.jsonl").len(), 0);
    answer(&s, &first, &first_card, "allow").await?;
    delivered(&s, &first, &first_turn).await?;
    answer(&s, &second, &second_card, "allow").await?;
    delivered(&s, &second, &second_turn).await?;
    assert_eq!(project.ran("ran.jsonl").len(), 2);
    s.finish().await
}

#[tokio::test]
async fn project_hooks_returning_to_older_content_asks_again() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-ABA").await?;
    let chat = project.chat.clone();
    let a = [project.observer("guard", "Stop", "a.jsonl")];
    let b = [project.observer("guard", "Stop", "b.jsonl")];
    for (hooks, name, runs) in [(&a, "a.jsonl", 1), (&b, "b.jsonl", 1), (&a, "a.jsonl", 2)] {
        project.write(hooks)?;
        let turn = s.gw.say_turn(&chat, "Turn.").await?;
        answer(&s, &chat, &card(&s, &chat).await?, "allow").await?;
        delivered(&s, &chat, &turn).await?;
        assert_eq!(project.ran(name).len(), runs, "{name}");
    }
    quiet_turn(&s, &chat, "Same as allowed.").await?;
    assert_eq!(project.ran("a.jsonl").len(), 3);
    assert_eq!(project.ran("b.jsonl").len(), 1);
    s.finish().await
}

#[tokio::test]
async fn project_hooks_a_lost_or_corrupt_record_asks_again() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-LOST").await?;
    let chat = project.chat.clone();
    project.write(&[project.observer("guard", "Stop", "ran.jsonl")])?;
    let store = s.sandbox.data.join("auth/project-hook-trust.json");
    let mut runs = 0;
    for lose in [
        (|_: &Path| Ok(())) as fn(&Path) -> std::io::Result<()>,
        |store| fs::remove_file(store),
        |store| fs::write(store, "{not json"),
    ] {
        lose(&store)?;
        let turn = s.gw.say_turn(&chat, "Turn.").await?;
        let asked = card(&s, &chat).await?;
        assert_eq!(asked["approval"]["project_hooks"]["changed"], false);
        assert_eq!(project.ran("ran.jsonl").len(), runs);
        answer(&s, &chat, &asked, "allow").await?;
        delivered(&s, &chat, &turn).await?;
        runs += 1;
        assert_eq!(project.ran("ran.jsonl").len(), runs);
    }
    s.finish().await
}
