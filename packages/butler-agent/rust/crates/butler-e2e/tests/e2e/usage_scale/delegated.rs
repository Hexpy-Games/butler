//! Owner-scale stamped and legacy children, including an arbitrary-depth chain.
use super::*;
use super::super::usage_delegated::fixtures;
pub(super) const ROWS: u64 = 2002;
pub(super) const GENERAL: u64 = 8;
pub(super) fn seed(data: &Path) -> Result<(),HarnessError> {
    let mut links=Vec::new();
    let mut rows=Vec::new();
    for index in 0..2000 {
        let child=format!("scale-child-{index}");
        let root=if index<3 || index%600==0 { "butler/app-general".to_owned() } else {format!("butler/app-scale-{}",index%600)};
        let parent=if index==1 || index==2 {format!("scale-child-{}",index-1)} else {root};
        links.push((child.clone(),parent,Some(if index==0 {"steward"} else {"worker"})));
        rows.push(fixtures::row(&child,None,None,1000,200));
    }
    fixtures::relations(data,&links.iter().map(|(c,p,r)|(c.as_str(),p.as_str(),*r)).collect::<Vec<_>>())?;
    for index in 2000..2002 {
        rows.push(fixtures::row(&format!("scale-child-{index}"),Some("butler/app-general"),Some("worker"),1000,200));
    }
    for row in &mut rows { row["cachedTokens"]=400.into(); }
    fixtures::append(data,&rows)
}
pub(super) fn assert_model(model: &Value, appended: u64) {
    for (key,n) in [("requestCount",SESSION_ROWS+GENERAL+appended),("promptTokens",(SESSION_ROWS+GENERAL+appended)*1000),("cachedTokens",(SESSION_ROWS+GENERAL+appended)*400),("outputTokens",(SESSION_ROWS+GENERAL+appended)*200),("totalTokens",(SESSION_ROWS+GENERAL+appended)*1200)] {
        assert_eq!(model[key].as_f64(),Some(n as f64),"delegated owner-scale {key}");
    }
    for (role,n) in [("main",SESSION_ROWS+appended),("steward",1),("worker",GENERAL-1)] {
        let b=&model["byRole"][role];
        for (key,total) in [("requestCount",n),("promptTokens",n*1000),("cachedTokens",n*400),("outputTokens",n*200),("totalTokens",n*1200)] { assert_eq!(b[key].as_f64(),Some(total as f64),"role {role} {key}"); }
    }
}
pub(super) async fn session_view(gw: &Gateway) -> Result<(),HarnessError> {
    let path="/session-view?session_id=general";
    let (cold,view)=timed(gw,path).await?;
    butler_e2e::assert_wall_clock_budget!(cold,COLD,"session-view cold");
    let n=SESSION_ROWS+GENERAL;
    for (key,total) in [("request_count",n),("input_tokens",n*1000),("cached_input_tokens",n*400),("cache_write_tokens",0),("output_tokens",n*200)] { assert_eq!(view["usage"][key],total,"{key}"); }
    for (role,n) in [("main",SESSION_ROWS),("steward",1),("worker",GENERAL-1)] {
        for (key,total) in [("request_count",n),("input_tokens",n*1000),("cached_input_tokens",n*400),("cache_write_tokens",0),("output_tokens",n*200)] { assert_eq!(view["usage"]["by_role"][role][key],total,"{role} {key}"); }
    }
    let mut worst=Duration::ZERO;
    for _ in 0..5 { let (took,again)=timed(gw,path).await?; assert_eq!(again["usage"],view["usage"]); worst=worst.max(took); }
    eprintln!("USE-06 session-view: cold {cold:?}, warm worst {worst:?}");
    butler_e2e::assert_wall_clock_budget!(worst,WARM,"session-view warm");
    Ok(())
}
