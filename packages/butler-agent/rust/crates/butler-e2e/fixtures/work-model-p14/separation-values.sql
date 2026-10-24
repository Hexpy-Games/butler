-- Private rows, orphaned canon spec, histories and receipts in a dev data folder.
INSERT INTO wm_plans VALUES('pl_private','butler','Private','',NULL,'open','private',0,1,1,'{}');
INSERT INTO wm_spec_bodies VALUES('private-body',X'00',1);
INSERT INTO wm_spec_nodes(node_id,scope_kind,scope_ref,work_id,concern_id,visibility,lifecycle,source,created_at,updated_at,created_by)
 VALUES('sp_private','session','chat_minutes','wk_minutes','private','private','draft','local',1,1,'{}'),
 ('sp_orphan','project','butler','wk_minutes','orphan','canon','draft','local',1,1,'{}');
INSERT INTO wm_spec_revisions VALUES('sp_private',1,'private-body','1','published',NULL);
INSERT INTO wm_audit VALUES(1,'work','wk_canon',1,'{}','create',1,'{}');
INSERT INTO wm_outbox VALUES(1,'canon.changed','{"project_id":"butler","kind":"work","id":"wk_canon","revision":1,"origin":"local"}',0,1),
 (2,'canon.changed','{}',1,1),(3,'work_model.changed','{"scope":"tasks","work_id":"wk_canon"}',0,1);
INSERT INTO wm_counts VALUES('project','butler','backlog_revision',17);
INSERT INTO wm_cross_db_intents VALUES('pending-op','projection','{}',3,'pending',1),('applied-op','projection','{}',1,'applied',1);
INSERT INTO wm_runtime_marker VALUES(1,'old-boot',1,NULL);
INSERT INTO wm_holds VALUES('hold','chat_canon','user','pause',NULL);
INSERT INTO wm_legacy_map VALUES('old','1','wk_canon','hash',1,'batch');
INSERT INTO wm_migration VALUES(1,'pending','{}','{}',1,0,'{}');
UPDATE wm_works SET canon_status_source=NULL WHERE id='wk_bookmarks';
