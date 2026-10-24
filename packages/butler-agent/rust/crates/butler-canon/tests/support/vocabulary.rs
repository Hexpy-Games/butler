use butler_canon::work_types::*;
pub(super) fn roundtrips_match_sql() {
    macro_rules! pin {
        ($ty:ident, $table:literal, $column:literal) => {{
            let values = $ty::ALL
                .iter()
                .map(|v| {
                    let wire = v.as_str();
                    assert_eq!(wire.parse::<$ty>().unwrap(), *v);
                    assert_eq!(serde_json::to_string(v).unwrap(), format!("\"{wire}\""));
                    assert_eq!(
                        serde_json::from_str::<$ty>(&format!("\"{wire}\"")).unwrap(),
                        *v
                    );
                    format!("'{wire}'")
                })
                .collect::<Vec<_>>()
                .join(",");
            let sql = super::enum_columns::COLUMNS
                .iter()
                .find(|(t, c, _)| *t == $table && *c == $column)
                .unwrap()
                .2;
            assert_eq!(values, sql);
            assert!("unknown".parse::<$ty>().is_err());
        }};
    }
    pin!(CanonStatus, "canon_epics", "canon_status");
    pin!(CanonStatusSource, "canon_epics", "canon_status_source");
    pin!(Origin, "canon_epics", "origin");
    pin!(PlanStatus, "canon_plans", "status");
    pin!(ScopeKind, "canon_spec_nodes", "scope_kind");
    pin!(Visibility, "canon_spec_nodes", "visibility");
    pin!(SpecLifecycle, "canon_spec_nodes", "lifecycle");
    pin!(SpecSource, "canon_spec_nodes", "source");
    pin!(SpecState, "canon_spec_revisions", "state");
    pin!(IntentState, "canon_intents", "state");
}
