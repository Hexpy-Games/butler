-- F3-legacy (synthetic): an App DB in the previous-generation shape.
-- Hand-written for the E2E suite; contains no real user data. Compared with
-- the current schema it lacks the columns the product adds on open
-- (chats.pinned/archived/conversation_session_id, messages.turn_id/
-- updated_at/retryable/..., session_queued_messages identity columns) and
-- carries one column the product does not know (messages.legacy_note).
CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  project_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  legacy_note TEXT
);
CREATE TABLE session_queued_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  controls_json TEXT NOT NULL,
  attachments_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  safe_error_code TEXT,
  dispatched_message_id TEXT,
  turn_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO chats VALUES
  ('general', 'Garden planning', 'chat', NULL, '2025-11-02T09:00:00.000Z', '2025-11-02T09:05:00.000Z'),
  ('chat-legacy-0002', 'Tomato varieties', 'chat', NULL, '2025-11-03T18:20:00.000Z', '2025-11-03T18:31:00.000Z');
INSERT INTO messages VALUES
  ('legacy-m-0001', 'general', 'user', 'Which vegetables can I plant in early spring?', 'sent', '2025-11-02T09:00:00.000Z', 'imported-from-v0'),
  ('legacy-m-0002', 'general', 'assistant', 'Peas, spinach, radishes and lettuce tolerate early spring cold.', 'delivered', '2025-11-02T09:00:07.000Z', NULL),
  ('legacy-m-0003', 'general', 'user', 'How deep should peas be sown?', 'sent', '2025-11-02T09:04:30.000Z', NULL),
  ('legacy-m-0004', 'general', 'assistant', 'About 2 to 3 cm deep, 5 cm apart.', 'delivered', '2025-11-02T09:05:00.000Z', NULL),
  ('legacy-m-0101', 'chat-legacy-0002', 'user', 'Name three paste tomatoes.', 'sent', '2025-11-03T18:20:00.000Z', NULL),
  ('legacy-m-0102', 'chat-legacy-0002', 'assistant', 'Roma, San Marzano and Amish Paste.', 'delivered', '2025-11-03T18:31:00.000Z', NULL);
INSERT INTO session_queued_messages VALUES
  ('legacy-q-0001', 'chat-legacy-0002', 'Which one is best for sauce?', '{"model":"openai/gpt-6-sol","reasoning_effort":"low","access_mode":"full_access","plan_mode":false}', '[]', 'cancelled', NULL, NULL, NULL, '2025-11-03T18:32:00.000Z', '2025-11-03T18:33:00.000Z');
