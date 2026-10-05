"""Frozen script analyzer using regex 2026.9.29 Unicode Script properties.

No language detection or stemmer. Complete fields are analyzed. The research's
Hangul cue stopwords affect only Hangul; other scripts retain every word.
"""
from functools import lru_cache
import unicodedata
import regex

STOP = set('그 그때 그거 내가 우리가 뭐 어떤 어떻게 언제 어디 다시 했던 했었지 했지 좀 알려줘 찾아줘 있던 있었던'.split())
# Enumerate Unicode's scripts, not languages; aliases share the same property ID.
NAMES = {}
for name, number in regex._regex.get_properties()['SCRIPT'][1].items():
    NAMES.setdefault(number, name)
SCRIPTS = [(name, regex.compile(r'\p{sc=' + name + '}'))
           for name in NAMES.values() if name not in ('COMMON', 'INHERITED', 'UNKNOWN')]
GRAM = {'HANGUL', 'HAN', 'HIRAGANA', 'KATAKANA', 'THAI', 'LAO', 'KHMER',
        'MYANMAR', 'TIBETAN', 'TAILE', 'NEWTAILUE', 'TAITHAM', 'TAIVIET',
        'BALINESE', 'JAVANESE', 'SUNDANESE'}
FOLD = {'LATIN', 'CYRILLIC', 'GREEK'}


@lru_cache(maxsize=16384)
def script(char):
    return next((name for name, pattern in SCRIPTS if pattern.fullmatch(char)), 'COMMON')


def runs(text):
    result, word, previous = [], '', None
    for char in text:
        category = unicodedata.category(char)
        if not (char.isalnum() or category.startswith('M')):
            if word:
                result.append((word, previous))
            word, previous = '', None
            continue
        kind = previous if category.startswith('M') and word else script(char)
        if word and kind != previous:
            result.append((word, previous))
            word = ''
        word += char
        previous = kind
    if word:
        result.append((word, previous))
    return list(dict.fromkeys(result))


def tokens(text, query=False):
    normalized = unicodedata.normalize('NFKC', text).casefold()
    words = runs(normalized)
    result = []
    single = sum(script(c) in GRAM for c in normalized) == 1
    for run, kind in words:
        if kind == 'HANGUL' and (run in STOP or len(run) < 2):
            if not single or not query:
                # Index single-character postings even for standalone Hangul.
                if not query:
                    result.extend(f'uni{ord(c):x}' for c in run)
                continue
        if kind in FOLD:
            run = ''.join(c for c in unicodedata.normalize('NFD', run)
                          if not unicodedata.category(c).startswith('M'))
        result.append(run)
        if kind in GRAM:
            # Retain repeated grams across distinct words, as research ko2 did.
            result.extend('cjk' + 'x'.join(f'{ord(c):x}' for c in run[i:i+2])
                          for i in range(len(run)-1))
            if not query or single:
                result.extend(f'uni{ord(c):x}' for c in run)
    return result


def expression(text):
    return ' OR '.join('"' + token.replace('"', '""') + '"'
                       for token in sorted(set(tokens(text, query=True))))
