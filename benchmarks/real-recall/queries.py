"""Batch source-backed candidate generation and blind tool argument writing."""
import argparse
import hashlib
import json
import random
import re
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from privacy import private_output
from corpus import write_rows
from model import call

STYLES = ('vague', 'paraphrase', 'keyword')


def load(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def sample(episodes, count):
    sessions = defaultdict(list)
    for episode in episodes:
        if episode['messages']:
            sessions[episode['conversation_session_id']].append(episode)
    rng = random.Random(20261002)
    queues = []
    for session in sorted(sessions):
        rows = sorted(sessions[session], key=lambda e: (e['conversation_start'] or '', e['memory_chunk_id']))
        # Shuffle deterministically, then round-robin sessions rather than favoring long chats.
        rng.shuffle(rows)
        queues.append(rows)
    selected = []
    while queues and len(selected) < count:
        for queue in list(queues):
            selected.append(queue.pop())
            if not queue:
                queues.remove(queue)
            if len(selected) == count:
                break
    return selected


def leak_tokens(question, answer, labels):
    # Conservative literal diagnostic, not a quality decision: generic terms may be flagged.
    terms = set()
    for text in [answer, *labels]:
        if len(text.strip()) >= 2:
            terms.add(text.strip())
        terms.update(t for t in re.findall(r'[\w.+/#-]+', text) if len(t) >= 3)
    return sorted(t for t in terms if t.casefold() in question.casefold())


def generate(item, out):
    index, episodes = item
    sources = [{'episode_id': e['memory_chunk_id'], 'entity_labels': e['entity_labels'],
                'messages': [{'turn_id': m['turn_id'], 'role': m['role'], 'text': m['text']}
                             for m in e['messages']]} for e in episodes]
    prompt = ('For EACH episode write up to 3 Korean questions the owner could plausibly ask weeks later, '
        'one per style vague/paraphrase/keyword about DIFFERENT facts. Aim for all three if supported. '
        'vague: associative situational clue, NO distinctive token from answer or episode entity labels. '
        'paraphrase: different wording than source, possibly across languages. '
        'keyword: contains one literal distinctive term. Avoid meta questions about tests or tools. '
        'No invented facts. expected_answer is a short EXACT SUBSTRING of a source message. '
        'gold_turn_ids must contain the answer. Return JSON array '
        '{episode_id,style,query,expected_answer,gold_turn_ids}.\n' + json.dumps(sources, ensure_ascii=False))
    rows = call(prompt, out / 'generation', f'batch-{index:03}')
    by_id = {e['memory_chunk_id']: e for e in episodes}
    valid, rejected, seen = [], [], set()
    for row in rows:
        if row.get('episode_id') not in by_id:
            rejected.append({**row, 'rejection': 'unknown_episode_id'})
            continue
        episode = by_id[row['episode_id']]
        key = (row['episode_id'], row['style'])
        reason = None
        if row['style'] not in STYLES or key in seen:
            reason = 'duplicate_or_invalid_style'
        seen.add(key)
        supporting = {m['turn_id'] for m in episode['messages'] if row['expected_answer'] in m['text']}
        if not row['expected_answer'] or not row['gold_turn_ids'] or not set(row['gold_turn_ids']) <= supporting:
            reason = 'answer_or_turn_not_in_source'
        query_id = hashlib.sha256((row['episode_id']+row['style']).encode()).hexdigest()[:16]
        row.update({'id': query_id, 'query_id': query_id, 'group': episode['group'],
                    'session_id': episode['conversation_session_id'],
                    'gold_episode_ids': [episode['memory_chunk_id']],
                    'leak_tokens': leak_tokens(row['query'], row['expected_answer'], episode['entity_labels'])})
        if reason:
            rejected.append({**row, 'rejection': reason})
        else:
            valid.append(row)
    return valid, rejected


def arguments(item, out, schema):
    index, batch = item
    rows = call('You are Butler answering personal recall questions. Given the REAL tool description/schema '
                'and ONLY each question, write the recall_memory arguments you would send. Use seed_phrases '
                'and vector_queries in Korean and English when useful; do not guess unknown answer names. '
                'Use valid schema fields only; cue required. Return array {id,args}.\nTOOL:\n' +
                json.dumps(schema, ensure_ascii=False) + '\nQUESTIONS:\n' +
                json.dumps([{'id': r['id'], 'query': r['query']} for r in batch], ensure_ascii=False),
                out / 'arguments', f'batch-{index:03}')
    assert len(rows) == len(batch) and {r['id'] for r in rows} == {r['id'] for r in batch}
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--schema', type=Path, required=True)
    args = parser.parse_args()
    args.out = private_output(args.out)
    episodes = load(args.out / 'episodes.jsonl')
    selected = []
    for group, count in [('DAILY', 36), ('SANDY', 36), ('JEV', 14)]:
        selected += sample([e for e in episodes if e['group']==group], count)
    write_rows(args.out / 'selected-episodes.jsonl', selected)
    batches = [selected[i:i+5] for i in range(0, len(selected), 5)]
    schema = json.loads(args.schema.read_text())
    with ThreadPoolExecutor(max_workers=4) as pool:
        generated = list(pool.map(lambda item: generate(item, args.out), enumerate(batches)))
        queries = [r for rows,_ in generated for r in rows]
        rejected = [r for _,rows in generated for r in rows]
        counts, bounded = Counter(), []
        for row in queries:
            key = (row['group'], row['style'])
            cap = 13 if row['group']=='JEV' else 30
            if counts[key] < cap:
                counts[key] += 1
                bounded.append(row)
        write_rows(args.out/'valid-surplus.jsonl', [r for r in queries if r not in bounded])
        batches = [bounded[i:i+25] for i in range(0,len(bounded),25)]
        toolargs = [r for batch in pool.map(lambda item: arguments(item,args.out,schema), enumerate(batches)) for r in batch]
    by_id = {r['id']: r['args'] for r in toolargs}
    allowed = set(schema['parameters']['properties'])
    bindings = json.loads((args.out/'caller-bindings.json').read_text())
    for row in bounded:
        row['model_args'] = by_id[row['id']]
        row['binding'] = bindings[row['group']]
        assert isinstance(row['model_args'].get('cue'), str) and set(row['model_args']) <= allowed
    write_rows(args.out / 'queries.jsonl', bounded)
    write_rows(args.out / 'rejected-queries.jsonl', rejected)
    print(json.dumps({'counts': dict(Counter(r['group']+'/'+r['style'] for r in bounded)),
                      'generated': len(queries)+len(rejected), 'invalid_ground_truth':len(rejected)}))


if __name__ == '__main__':
    main()
