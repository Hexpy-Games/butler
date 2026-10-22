-- App DB snapshot fields from the deployed pre-p14 core schema.
CREATE TABLE projects (
 id TEXT PRIMARY KEY,display_name TEXT NOT NULL,status TEXT NOT NULL,
 workspace_path TEXT NOT NULL,workspace_label TEXT NOT NULL,safe_path_label TEXT NOT NULL,
 ledger_project_id TEXT,pinned INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0,
 error_summary TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
INSERT INTO projects VALUES('legacy-project','Garden','ready','legacy-workspace','Garden','Garden','legacy-ledger',0,0,NULL,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');
CREATE TABLE chats (
 id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL,project_id TEXT,
 conversation_session_id TEXT,runtime_session_hint TEXT,pinned INTEGER NOT NULL DEFAULT 0,
 archived INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
INSERT INTO chats VALUES('legacy-chat','Garden notes','chat','legacy-project','conversation-one','legacy-session',0,0,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');
INSERT INTO chats VALUES('legacy-child-chat','Plant check','chat','legacy-project','conversation-child','legacy-child',0,0,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');
