"""Read immutable snapshot; select complete-vector episodes using external session decisions."""
import argparse
import json
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path
from privacy import private_output

GROUP_NAMES = ('DAILY', 'JEV', 'SANDY')


def read_groups(path):
    rows = [dict(row) for row in json.loads(path.read_text())]
    assert len(rows) == len(GROUP_NAMES)
    assert {r['group'] for r in rows} == set(GROUP_NAMES)
    groups = {r['project_id']: r['group'] for r in rows}
    assert len(groups) == len(rows), 'duplicate project scopes'
    return groups


def read_db(path):
    connection = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def write_rows(path, rows):
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows))


def text_parts(connection, session):
    rows = connection.execute("""SELECT m.id,m.turn_id,m.role,m.created_at,p.content_json
        FROM conversation_messages m JOIN conversation_parts p ON p.message_id=m.id
        WHERE m.session_id=? AND m.role IN ('user','assistant') AND p.kind='text'
        AND m.origin_kind!='internal_control' ORDER BY m.seq,p.part_index""", (session,))
    result = []
    for row in rows:
        content = json.loads(row['content_json'])
        text = content if isinstance(content, str) else content.get('text', '')
        if text:
            result.append({**dict(row), 'text': text})
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    args.out = private_output(args.out)
    args.out.mkdir(parents=True, exist_ok=True)
    groups = read_groups(args.out / 'project-groups.json')
    active = json.loads((args.data / 'cognition/memory/active-generation.json').read_text())
    generation = active.get('generationId') or active.get('generation_id')
    graph = read_db(args.data / 'cognition/memory/generations' / generation / 'graph.sqlite')
    conversation = read_db(args.data / 'runtime/conversation-store.sqlite')
    candidates = [dict(row) for row in graph.execute("""SELECT c.* FROM memory_chunks c
        WHERE c.origin_kind='user_input' AND c.status='active' AND c.summary_status='complete'
        AND EXISTS (SELECT 1 FROM memory_projection_jobs j WHERE j.episode_id=c.memory_chunk_id
          AND j.revision=c.current_revision AND json_extract(j.episode_vectors_state,'$.state')='complete'
          AND EXISTS (SELECT 1 FROM memory_vector_units u WHERE u.job_id=j.job_id AND u.record_kind='episode')
          AND NOT EXISTS (SELECT 1 FROM memory_vector_units u WHERE u.job_id=j.job_id
                         AND u.record_kind='episode' AND u.state!='complete'))
        ORDER BY c.conversation_start,c.memory_chunk_id""") if row['project_id'] in groups]
    sessions = defaultdict(list)
    for episode in candidates:
        sessions[episode['conversation_session_id']].append(episode)
    digests, texts = [], {}
    for session, episodes in sessions.items():
        messages = text_parts(conversation, session)
        texts[session] = messages
        users = [m['text'] for m in messages if m['role'] == 'user']
        digest = {'first_user_messages': [s[:450] for s in users[:2]],
                  'middle_sample': [s[:450] for s in users[len(users)//2:len(users)//2+2]],
                  'message_count': len(messages),
                  'time_span': [messages[0]['created_at'], messages[-1]['created_at']] if messages else []}
        digests.append({'session_id': session, 'digest': json.dumps(digest, ensure_ascii=False)[:2000]})
    write_rows(args.out / 'digests.jsonl', digests)
    labels = [json.loads(line) for line in (args.out / 'final-sessions.jsonl').read_text().splitlines()]
    by_id = {r['session_id']: r for r in labels}
    assert len(by_id) == len(labels)
    assert set(sessions) <= set(by_id), 'missing external session decisions'
    output, episodes_out = [], []
    for session, episodes in sessions.items():
        label = by_id[session]
        assert label['label'] in ('genuine', 'test')
        assert label['group'] == groups[episodes[0]['project_id']]
        output.append({**label, 'group': groups[episodes[0]['project_id']], 'episode_count': len(episodes)})
        if label['label'] != 'genuine':
            continue
        for episode in episodes:
            sources = list(graph.execute('SELECT conversation_message_id FROM memory_chunk_sources WHERE episode_id=? AND revision=?',
                                         (episode['memory_chunk_id'], episode['current_revision'])))
            ids = {s[0] for s in sources}
            turns = {m['turn_id'] for m in texts[session] if m['id'] in ids}
            turns.add(episode['conversation_turn_id'])
            messages = [m for m in texts[session] if m['turn_id'] in turns]
            episode['messages'] = messages
            episode['group'] = groups[episode['project_id']]
            episode['entity_labels'] = [r[0] for r in graph.execute('''SELECT DISTINCT n.label_original FROM memory_nodes n
                JOIN memory_evidence e ON e.node_id=n.id WHERE e.episode_id=? AND e.revision=? AND n.type!='claim' ''',
                (episode['memory_chunk_id'], episode['current_revision']))]
            episodes_out.append(episode)
    write_rows(args.out / 'kept-sessions.jsonl', [r for r in output if r['label']=='genuine'])
    write_rows(args.out / 'episodes.jsonl', episodes_out)
    counts = Counter((r['group'], r['label']) for r in output)
    print(json.dumps({f'{g}/{label}': count for (g,label),count in counts.items()}))
    write_rows(args.out / 'filter-counts.jsonl', [{'group': g, 'label': label, 'sessions': n,
        'episodes': sum(r['episode_count'] for r in output if r['group']==g and r['label']==label)} for (g,label),n in counts.items()])


if __name__ == '__main__':
    main()
