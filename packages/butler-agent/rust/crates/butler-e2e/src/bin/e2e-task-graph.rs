//! Dev-only Work/Subsession fixture builder shared by Rust and real-App smokes.
use butler_e2e::e2e::task_graph::{Error, GraphBuilder, actions};
use std::path::Path;

#[tokio::main]
async fn main() -> Result<(), Error> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [data, command, rest @ ..] = args.as_slice() else {
        return Err("expected data command arguments".into());
    };
    let data = Path::new(data);
    let mut builder = GraphBuilder::open(data).await?;
    match command.as_str() {
        "seed" => {
            let [parent, states, count] = rest else {
                return Err("expected parent states count".into());
            };
            let ids = Box::pin(builder.seed(
                parent,
                &serde_json::from_str::<Vec<String>>(states)?,
                count.parse()?,
            ))
            .await?;
            println!("{}", serde_json::to_string(&ids)?);
        }
        "phase" => {
            let [id, phase] = rest else {
                return Err("expected Work graph id and phase".into());
            };
            let mut work = builder.existing(data, id).await?;
            builder.complete_pending_attempts(data, &work).await?;
            builder.advance_phase(&mut work, phase).await?;
        }
        "plan-child" => {
            let [id] = rest else {
                return Err("expected parent Work graph id".into());
            };
            builder.plan_child(data, id).await?;
        }
        "finish" => {
            builder.finish_all(data).await?;
        }
        "revise" => {
            let [id] = rest else {
                return Err("expected Work graph id".into());
            };
            let mut work = builder.existing(data, id).await?;
            let count = work
                .view
                .current_plan
                .as_ref()
                .ok_or("missing plan")?
                .actions
                .len();
            builder
                .plan(&mut work, "workers", actions(count + 1))
                .await?;
        }
        _ => return Err("unknown builder command".into()),
    }
    builder.close().await
}
