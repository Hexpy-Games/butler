//! Empty summary evidence must preserve recall without a provider request.
use super::{HarnessError, episode_ids, judge_count, memory_stubs, recall, setup};

#[tokio::test]
async fn mem_judge_empty_summaries_preserve_all_candidates_without_call() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let s = setup().await?;
    for summary in ["", " \t\n"] {
        let graph = memory_stubs::graph_path(&s.sandbox.data)?;
        {
            let db = butler_platform::sqlite::open(&graph)?;
            assert!(db.execute("UPDATE memory_chunks SET summary=?1", [summary])? >= 2);
        }
        let baseline = recall(&s, "faster").await?;
        assert!(baseline.len() >= 2);
        let accurate = recall(&s, "accurate").await?;
        assert_eq!(episode_ids(&accurate), episode_ids(&baseline));
        assert_eq!(accurate.len(), baseline.len());
        assert_eq!(judge_count(&s), 0);
    }
    // Restoring useful evidence must still invoke the judge through the same gate.
    {
        let graph = memory_stubs::graph_path(&s.sandbox.data)?;
        let db = butler_platform::sqlite::open(&graph)?;
        db.execute("UPDATE memory_chunks SET summary='September activity'", [])?;
    }
    let baseline = recall(&s, "faster").await?;
    let judged = recall(&s, "accurate").await?;
    assert_eq!(judge_count(&s), 1);
    assert_eq!(judged.len(), baseline.len());
    assert_eq!(judged[0]["episode_ref"], baseline[1]["episode_ref"]);
    s.finish().await
}
