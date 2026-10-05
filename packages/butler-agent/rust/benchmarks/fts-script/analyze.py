"""Aggregate only: native ceilings, frozen selection and paired ranking intervals."""
import collections
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
from judge import candidates, load_traces

STYLES = ('keyword', 'paraphrase', 'vague', 'vague-extra', 'original', 'all')


def percentile(values, fraction):
    values = sorted(values)
    position = (len(values)-1)*fraction
    lo = math.floor(position)
    return values[lo] + (values[math.ceil(position)]-values[lo])*(position-lo)


def cohort(questions, ids, style):
    return [i for i in ids if style == 'all' or questions[i]['style'] == style
            or style == 'original' and questions[i]['style'] != 'vague-extra']


def rank(question, order):
    gold = {hashlib.sha256(e.encode()).hexdigest() for e in question['gold_episode_ids']}
    return next((n for n, e in enumerate(order[:30], 1) if e in gold), math.inf)


def metrics(question, order):
    r = rank(question, order)
    return [float(r <= 1), float(r <= 5), 1/r]


def ceiling(questions, traces):
    result = {}
    for style in STYLES:
        ids = cohort(questions, traces, style)
        ranks = [rank(questions[i], [r['episode_sha256'] for r in candidates(traces[i])]) for i in ids]
        result[style] = {'n': len(ids), **{f'top{k}': sum(r <= k for r in ranks) for k in (5, 15, 30)}}
    return result


def freeze(output, questions):
    traces = {name: load_traces(output/(name+'-dev'+suffix+'.jsonl'))
              for name, suffix in (('baseline', '-valid'), ('script', ''))}
    assert all(len(rows) == 120 and all(r['payload']['ok'] for r in rows.values())
               for rows in traces.values())
    scores = {name: ceiling(questions, rows) for name, rows in traces.items()}
    neutral, script = scores['baseline'], scores['script']
    eligible = script['keyword']['top5'] >= neutral['keyword']['top5'] and \
               script['keyword']['top15'] >= neutral['keyword']['top15']
    def key(name):
        return (scores[name]['all']['top30'], scores[name]['all']['top15'],
                -json.loads((output/'dev-lookup.json').read_text())[name]['median_ms'])
    winner = 'script' if eligible and key('script') > key('baseline') else 'baseline'
    report = {'winner': winner, 'dev_ceiling': scores, 'script_eligible': eligible,
              'seed': 20261003, 'summary_chars': 150, 'gate': 'l_score1<.15 AND score1-score2<.05',
              'analyzer_sha256': hashlib.sha256(Path(__file__).with_name('analyzer.py').read_bytes()).hexdigest()}
    (output/'freeze.json').write_text(json.dumps(report, indent=2))
    return report


def paired(questions, before, after, ids):
    left = [metrics(questions[i], before[i]['order']) for i in ids]
    right = [metrics(questions[i], after[i]['order']) for i in ids]
    rng = random.Random(20261003)
    samples = [[rng.randrange(len(ids)) for _ in ids] for _ in range(10000)]
    report = {}
    for m, name in enumerate(('hit1', 'hit5', 'mrr')):
        delta = [b[m]-a[m] for a, b in zip(left, right)]
        means = [statistics.fmean(delta[j] for j in sample) for sample in samples]
        report[name] = {'before': statistics.fmean(v[m] for v in left),
                        'after': statistics.fmean(v[m] for v in right),
                        'delta_ci': [percentile(means, .025), percentile(means, .975)]}
    # Session clusters reflect correlated cues, not an independent real-cue cohort.
    groups = {}
    for i, question_id in enumerate(ids):
        groups.setdefault(questions[question_id]['session_id'], []).append(i)
    clusters = list(groups.values())
    rng = random.Random(20261003)
    clustered = [[j for _ in clusters for j in clusters[rng.randrange(len(clusters))]]
                 for _ in range(10000)]
    for m, name in enumerate(('hit1', 'hit5', 'mrr')):
        delta = [b[m]-a[m] for a, b in zip(left, right)]
        means = [statistics.fmean(delta[j] for j in sample) for sample in clustered]
        report[name]['cluster_delta_ci'] = [percentile(means, .025), percentile(means, .975)]
    return report


def distribution(values):
    return {'n': len(values), 'median': statistics.median(values), 'p95': percentile(values, .95)} if values else None


def report(output, questions):
    frozen = json.loads((output/'freeze.json').read_text())
    names = ['baseline15', 'script15', frozen['winner']+'30', 'vectors15']
    arms = {name: json.loads((output/name/'results.json').read_text()) for name in names}
    result = {'freeze': frozen, 'ceilings': {}, 'arms': {}, 'comparisons': {}}
    for name, values in arms.items():
        result['arms'][name] = {'slices': {}, 'gate': sum(r['gate'] for r in values.values()),
            'fallbacks': sum(r['gate'] and not r['valid'] for r in values.values()),
            'missing_api_usage': sum(r['gate'] and 'usage' not in r for r in values.values()),
            'payload_tokens': distribution([r['payload_tokens'] for r in values.values() if r['gate']]),
            'api_input_tokens': distribution([r['usage']['input_tokens'] for r in values.values() if 'usage' in r]),
            'api_cached_input_tokens': distribution([r['usage'].get('cached_input_tokens', 0) for r in values.values() if 'usage' in r]),
            'api_output_tokens': distribution([r['usage']['output_tokens'] for r in values.values() if 'usage' in r]),
            'wall_s': distribution([r['wall_s'] for r in values.values() if r['gate']])}
        for style in STYLES:
            ids = cohort(questions, values, style)
            vals = [metrics(questions[i], values[i]['order']) for i in ids]
            result['arms'][name]['slices'][style] = {'n': len(ids),
                **dict(zip(('hit1', 'hit5', 'mrr'), (statistics.fmean(v[m] for v in vals) for m in range(3)))),
                'conditional_ceiling': sum(rank(questions[i], values[i]['base']) <=
                    ((30 if name.endswith('30') else 15) if values[i]['gate'] else 5) for i in ids)}
    for before, after in [('baseline15', 'script15'), (frozen['winner']+'15', frozen['winner']+'30'),
                           ('vectors15', frozen['winner']+'30')]:
        result['comparisons'][before+'->'+after] = {style: paired(questions, arms[before], arms[after],
            cohort(questions, arms[before], style)) for style in STYLES}
    for name in ('baseline', 'script'):
        result['ceilings'][name] = ceiling(questions, load_traces(output/(name+'-heldout-valid.jsonl')))
    comparison = result['comparisons'][frozen['winner']+'15->'+frozen['winner']+'30']
    chosen = result['arms'][frozen['winner']+'30']
    original = chosen['slices']['original']
    extra = chosen['slices']['vague-extra']
    targets = round(original['hit5']*original['n']) >= 70 and round(extra['hit5']*extra['n']) >= 16
    improvement = comparison['all']['hit5']['delta_ci'][0] > 0
    keyword_ok = comparison['keyword']['hit5']['delta_ci'][1] >= 0
    latency_ok = chosen['wall_s'] is not None and chosen['wall_s']['p95'] < 8
    result['acceptance'] = {'targets': targets, 'ci_supported_improvement': improvement,
                            'keyword_no_regression_beyond_ci': keyword_ok, 'latency': latency_ok,
                            'accepted': (targets or improvement and keyword_ok) and latency_ok}
    result['tool_calls'] = sum(e['type'] == 'item.completed' and e['item']['type'] in
        ('command_execution', 'mcp_tool_call', 'web_search') for file in output.glob('*/*.events.jsonl')
        for e in map(json.loads, file.open()))
    result['native_partial'] = {name: {'n': len(rows), 'status': dict(collections.Counter(
        r['payload']['status'] for r in rows.values()))} for name in ('baseline', 'script')
        for rows in [load_traces(output/(name+'-heldout-valid.jsonl'))]}
    (output/'report.json').write_text(json.dumps(result, indent=2))
    return result


if __name__ == '__main__':
    import sys
    questions = json.loads(Path(sys.argv[2]).read_text())
    if sys.argv[1] == 'freeze':
        print(json.dumps(freeze(Path(sys.argv[3]), questions), indent=2))
    else:
        report(Path(sys.argv[3]), questions)
        print('Aggregate report written')
