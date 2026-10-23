-- Non-default preserved fields and populated dependent rows for upgrade fidelity.
UPDATE wm_works SET description='preserved description',kind='delivery',assignee='reviewer',
  run_generation=7,revision=19,created_at=23,updated_at=29,created_by='{"person":"author","via":"board"}',
  spec_node_id='sp_canon',tier=2,draft=1,import_note='preserved import',
  home_session_id=COALESCE(home_session_id,'home-'||id);
INSERT INTO wm_works(id,scope_kind,scope_ref,title,run_state,failure_reason,visibility,origin,created_at,updated_at,created_by)
  SELECT 'state-'||column1,'project','upgrade-project',column1,column1,
    CASE WHEN column1='failed' THEN 'old failure' END,'private','migration',41,43,'{"person":"migrator"}'
  FROM (VALUES('running'),('in_review'),('blocked'),('failed'),('paused'),('stopped'),('done'),('cancelled'));
INSERT INTO wm_session_exec(session_id,tier,phase,control_state,control_epoch,current_task_id,last_applied_seq)
  VALUES('upgrade-session',2,'execution','running',17,'tk_schema',31);
INSERT INTO wm_results(id,revision,task_id,task_revision,attempt_id,spec_ref,body_ref,criterion_results_json,created_at)
  VALUES('upgrade-result',3,'tk_schema',1,'at_schema','{}','body','[]',47);
INSERT INTO wm_counts(scope_kind,scope_ref,key,count) VALUES
  ('project','butler','works',99),('project','butler','run_state:failed',97),
  ('session','chat_canon','works',98),('session','chat_canon','run_state:running',96),
  ('project','butler','backlog_revision',13);
