"""Stage an instrumented source copy; never edit product sources in the worktree.

The numeric RAII probes include child time. Sequential calls are required; async
probe lifetimes include suspension and cancellation. Outputs remain private.
"""
import argparse
import re
import shutil
from pathlib import Path
from privacy import private_output

PROBE = Path(__file__).with_name('profile_probe.rs').read_text()


def instrument(crate, patterns):
    root = crate / 'src'
    for path in root.rglob('*.rs'):
        relative = str(path.relative_to(root))
        if 'test' in relative or not any(relative.startswith(p) for p in patterns):
            continue
        source = path.read_text()
        # Selected files contain ordinary signatures, without const bodies or
        # braces in their signatures. Reject a match crossing a semicolon.
        pattern = r'\b(?<!const )fn\s+(\w+)([^;{]*?)\{'
        def insert(match):
            watched = {
                'prepare', 'run', 'initial', 'open', 'open_sources', 'close_sources',
                'normalize', 'encode', 'current_vector_matches', 'semantic_seeds', 'temporal_seeds',
                'resolve_active_generation', 'resolve_generation', 'vector_facts',
                'query', 'select', 'size', 'postings', 'document_frequencies',
                'ranked_sources', 'term_weights', 'read_canonical_inventory',
                'projection_coverage', 'expand', 'rank', 'personalized_page_rank',
                'hydrate', 'hydrate_recall_sources', 'validate_schema',
                'search_generation_vectors', 'nearest', 'interpretations',
                'claim_nodes', 'requirements', 'read_message', 'read_session',
                'read_turn', 'read_recall_outcome_page', 'outcomes', 'recovered',
                'fit_minimum', 'upgrade_to_full', 'minimum', 'bytes', 'bind',
                'rebind', 'episode_rows', 'current_rows', 'relationships',
            }
            if match[1] not in watched:
                return match[0]
            label = relative + '::' + match[1]
            return match[0] + '\nlet _profile_probe = crate::perf_trace::Probe::new("' + label + '");\n'
        path.write_text(re.sub(pattern, insert, source))
    (root / 'perf_trace.rs').write_text(PROBE)
    with (root / 'lib.rs').open('a') as stream:
        stream.write('\n#[doc(hidden)]\npub mod perf_trace;\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', type=Path, required=True)
    args = parser.parse_args()
    stage = private_output(args.stage)
    if any(stage.iterdir()):
        raise ValueError('stage must be empty')
    repo = Path(__file__).resolve().parents[2]
    rust = stage / 'packages/butler-agent/rust'
    shutil.copytree(repo / 'packages/butler-agent/rust', rust,
                    ignore=shutil.ignore_patterns('target', '__pycache__'))
    wallpapers = Path('packages/butler-app/client/ui/src/libs/design-system/blocks/Wallpaper/modules')
    shutil.copytree(repo / wallpapers, stage / wallpapers)
    bench = stage / 'benchmarks/real-recall'
    shutil.copytree(repo / 'benchmarks/real-recall', bench,
                    ignore=shutil.ignore_patterns('__pycache__'))
    instrument(rust / 'crates/butler-memory', [
        'cognition/memory_recall', 'cognition/graph/recall',
        'cognition/sources/inventory', 'cognition/sources/recall',
        'cognition/generation/read', 'cognition/generation_vectors',
        'cognition/recall/expansion', 'cognition/lance_store',
    ])
    instrument(rust / 'crates/butler-turn', [
        'conversation/source/reader', 'conversation/codec',
    ])
    manifest = rust / 'Cargo.toml'
    manifest.write_text(manifest.read_text().replace('"bundled", "hooks"', '"bundled", "hooks", "trace"'))
    for crate_name, relative in [
        ('butler-memory', 'cognition/graph/recall.rs'),
        ('butler-turn', 'conversation/source/reader.rs'),
    ]:
        path = rust / 'crates' / crate_name / 'src' / relative
        source = path.read_text()
        marker = 'let connection = Connection::open_with_flags'
        start = source.index(marker)
        end = source.index(';', start) + 1
        source = source[:end] + '\ncrate::perf_trace::attach(&connection);\n' + source[end:]
        path.write_text(source)
    service = rust / 'crates/butler-memory/src/cognition/memory_recall/service.rs'
    source = service.read_text()
    parse = 'let args: RecallToolArgs = crate::lenient::view(&args);'
    assert source.count(parse) == 1
    source = source.replace(parse, 'let args: RecallToolArgs = { let _profile_probe = crate::perf_trace::Probe::new("arguments_parse"); crate::lenient::view(&args) };')
    old = 'Err(_) => vector.code = Some("vector_unavailable".into()),'
    assert source.count(old) == 1
    source = source.replace(old, 'Err(_) => { crate::perf_trace::mark("vector_lane_deadline"); vector.code = Some("vector_unavailable".into()); },')
    service.write_text(source)
    main_rs = bench / 'src/main.rs'
    source = main_rs.read_text()
    source = source.replace('warm(&embedding, &args[3]).await?;',
        'if std::env::var_os("RECALL_PROFILE_COLD").is_none() { warm(&embedding, &args[3]).await?; }')
    source = source.replace('let start = Instant::now();\n            let result',
        'let _ = butler_memory::perf_trace::take();\n'
        '            let _ = butler_turn::perf_trace::take();\n'
        '            let _ = butler_memory::perf_trace::take_sql();\n'
        '            let _ = butler_turn::perf_trace::take_sql();\n'
        '            let start = Instant::now();\n            let result')
    source = source.replace('let record = record(&query, arm, use_vector, elapsed, result, trace)?;',
        'let mut record = record(&query, arm, use_vector, elapsed, result, trace)?;\n'
        '            record["profile_memory"] = json!(butler_memory::perf_trace::take());\n'
        '            record["profile_turn"] = json!(butler_turn::perf_trace::take());\n'
        '            record["sql_memory"] = json!(butler_memory::perf_trace::take_sql());\n'
        '            record["sql_turn"] = json!(butler_turn::perf_trace::take_sql());')
    main_rs.write_text(source)
    print('staged benchmark probes; product worktree unchanged')


if __name__ == '__main__':
    main()
