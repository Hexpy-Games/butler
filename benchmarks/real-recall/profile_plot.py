"""Export aggregate recall byte curves with optional matplotlib, outside Git."""
import argparse
import json
from pathlib import Path
from privacy import private_output


def main():
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt

    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    out = private_output(args.out)
    report = json.loads((out/'bytes-summary.json').read_text())
    fig, axes = plt.subplots(1, 2, figsize=(12, 4), constrained_layout=True)
    for ax, key, title, label in zip(axes, ['top_k', 'excerpt_caps'],
                                    ['Existing top k', 'Excerpt byte cap per result'],
                                    ['k', 'budget']):
        rows = report[key]
        x = [row['bytes']['median']/1024 for row in rows]
        for metric, name in [('gold_hit_percent', 'Gold hit (k / @5)'),
                             ('answer_substring_percent', 'Answer substring proxy')]:
            ax.plot(x, [r[metric] for r in rows], 'o-', label=name)
        ax.fill_between(x, [r['external_answer_lower_percent'] for r in rows],
                        [r['external_answer_upper_percent'] for r in rows],
                        alpha=.15, color='grey', label='External bounds (monotonic presence)')
        for row, xx in zip(rows, x):
            ax.annotate(str(row[label]), (xx, row['answer_substring_percent']),
                        xytext=(3, -12), textcoords='offset points', fontsize=8)
        ax.set(title=title, xlabel='Median JSON KiB', ylabel='Queries (%)', ylim=(0, 70))
        ax.grid(alpha=.2)
        ax.legend(fontsize=7, loc='lower right')
    for extension in ['svg', 'png', 'pdf']:
        fig.savefig(out/f'bytes-tradeoff-standard.{extension}', dpi=180)
    plt.close(fig)


if __name__ == '__main__':
    main()
