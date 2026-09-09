"""The production contract. Validation happens before any rental or render."""
import hashlib
import json
import math
import re
from pathlib import Path

VERSION = '1.0.0'
STYLES = {'editorial', 'technical', 'illustrated', 'terminal', 'stickman', 'cinema'}
KINDS = {'hero', 'list', 'compare', 'steps', 'metric', 'image', 'quote', 'closing', 'story', 'cinema'}
# Cinema beats: one hero visual each, several per narrated scene for pace.
BEAT_KINDS = {'icon', 'type', 'terminal', 'steps', 'people', 'bars', 'timeline', 'dialog', 'cta', 'split', 'grid'}
BEAT_ICONS = {'coffee', 'desk', 'hoodie', 'keyboard', 'hand', 'bug', 'alarm', 'shield', 'radar', 'car', 'keyfob', 'house', 'amplifier', 'pouch', 'lock', 'timer', 'check', 'cross', 'figure', 'thief', 'phone', 'wave', 'clock'}
BEAT_FX = {'lit', 'dead', 'key', 'open', 'drive', 'alarm', 'point', 'run', 'think'}
CINEMA_ACCENTS = {'green', 'cyan', 'red', 'amber'}
# Stickman story slides (style 'stickman', portrait only). Every value is an
# enum the renderer knows how to draw; nothing here is ever executed.
STORY_ACTS = {'idle', 'explain', 'point-up', 'shrug', 'think', 'alarm', 'hold', 'drop', 'wave', 'walk', 'run', 'crouch'}
STORY_CAST = {'hero', 'thief', 'thief2'}
STORY_PROPS = {'keyfob', 'car', 'house', 'amplifier', 'pouch', 'timer', 'bar', 'check'}
STORY_FX = {'drive-off', 'relay', 'relay-fail', 'signal', 'drop'}
STORY_ACCENTS = {'green', 'red', 'amber'}
VISUALS = {'focus', 'network', 'cycle', 'spark', 'globe', 'check', 'growth'}
VOICES = {'fr': {'ff_siwis'}, 'en': {'af_heart', 'am_michael', 'bf_emma'}, 'it': {'if_sara', 'im_nicola'}}
BASE_MOTION = {'galaxy', 'orbit-compare', 'voice-signal', 'ai-network', 'data-flow'}
# Bounded extension for the incident-timeline edition. Each mode is a native
# animated diagram implemented in engine/modes/. Display only: the renderer never
# executes, resolves or transmits any of these strings.
ESCAPE_MOTION = {'timeline-track', 'package-server', 'sandbox-grid', 'swarm-board',
                 'cluster-intrusion', 'kill-chain', 'flag-grid', 'defense-side',
                 'paper-grader', 'terminal-quote'}
MOTION = BASE_MOTION | ESCAPE_MOTION
LABELLED_MOTION = {'voice-signal', 'ai-network', 'data-flow'} | ESCAPE_MOTION

def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    tmp.replace(path)

def finite(value, low, high, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'{label}: expected a number between {low} and {high}')

def text(value, label, maximum=180):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f'{label}: required text, maximum {maximum} characters')

def local_asset(project, value):
    text(value, 'asset path', 250)
    p = (project.parent / value).resolve()
    if not p.is_relative_to(project.parent.resolve()) or not p.is_file():
        raise ValueError(f'Asset must exist inside the project: {value}')
    if p.suffix.lower() not in {'.png', '.jpg', '.jpeg', '.webp', '.svg'}:
        raise ValueError('Unsupported image format')
    if p.suffix.lower() == '.svg':
        svg = p.read_text()
        if re.search(r'<script|<foreignObject|\bon\w+\s*=|(?:href|src)\s*=\s*[\"\'](?:https?:|//|javascript:)', svg, re.I):
            raise ValueError('SVG must be self-contained, without scripts or external references')
    return p

def validate(path, approved=True):
    path = Path(path).resolve()
    c = json.loads(path.read_text())
    if c.get('schema_version') != 1:
        raise ValueError('schema_version must be 1')
    if approved and c.get('editorial_status') != 'ready':
        raise ValueError('Pearl must finish the editorial preparation before rendering')
    text(c.get('id'), 'id', 70)
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', c['id']):
        raise ValueError('id must use lowercase ASCII letters, numbers and hyphens')
    text(c.get('title'), 'title', 120)
    text(c.get('brand'), 'brand', 28)
    if c.get('style') not in STYLES:
        raise ValueError(f'style must be one of {sorted(STYLES)}')
    if c.get('format') not in {'9:16', '16:9'} or c.get('fps') not in {30, 60}:
        raise ValueError('format: 9:16 or 16:9; fps: 30 or 60')
    if c.get('style') == 'stickman' and c.get('format') != '9:16':
        raise ValueError('The stickman style is laid out for 9:16 only')
    if c.get('width') not in ({540, 1080, 2160} if c['format'] == '9:16' else {960, 1920, 3840}):
        raise ValueError('Invalid width for aspect ratio')
    if c.get('language') not in VOICES or c.get('voice') not in VOICES[c['language']]:
        raise ValueError('Unsupported language/voice combination')
    finite(c.get('speed', 1), .8, 1.3, 'speed')
    if 'music' in c and c['music'] not in {'bed', 'none'}:
        raise ValueError('music must be bed or none')
    finite(c.get('max_duration', 600), 5, 1800, 'max_duration')
    scenes = c.get('scenes')
    if not isinstance(scenes, list) or not 2 <= len(scenes) <= 240:
        raise ValueError('A project needs 2–240 scenes')
    ids = set()
    for i, s in enumerate(scenes):
        label = f'scene {i + 1}'
        text(s.get('id'), label + ' id', 50)
        if not re.fullmatch(r'[a-z0-9-]+', s['id']) or s['id'] in ids:
            raise ValueError('Scene IDs must be unique slugs')
        ids.add(s['id'])
        if s.get('kind') not in KINDS:
            raise ValueError(label + ': unknown composition')
        if c['style'] == 'cinema' and s['kind'] not in {'cinema', 'closing'}:
            raise ValueError(label + ': the cinema style only draws cinema and closing scenes')
        if s['kind'] == 'cinema' or (s['kind'] == 'closing' and c['style'] == 'cinema' and 'beats' in s):
            if c['style'] != 'cinema':
                raise ValueError(label + ': cinema scenes need the cinema style')
            beats = s.get('beats')
            if not isinstance(beats, list) or not 1 <= len(beats) <= 8:
                raise ValueError(label + ': beats must list one to eight hero visuals')
            for j, b in enumerate(beats):
                bl = f'{label} beat {j + 1}'
                if not isinstance(b, dict) or b.get('kind') not in BEAT_KINDS:
                    raise ValueError(bl + f': kind must be one of {sorted(BEAT_KINDS)}')
                k = b['kind']
                if 'at' in b:
                    text(b['at'], bl + ' at', 24)
                    if b['at'].lower() not in s['voice'].lower():
                        raise ValueError(bl + ': at must quote words from this scene\'s voice')
                if 'label' in b and k in {'icon', 'split', 'grid'}: text(b['label'], bl + ' label', 24)
                if k in {'split', 'grid'}:
                    items = b.get('items')
                    lo, hi = (2, 2) if k == 'split' else (2, 3)
                    if not isinstance(items, list) or not lo <= len(items) <= hi or not set(items) <= BEAT_ICONS: raise ValueError(bl + f': {k} needs {lo}-{hi} icon names')
                    if 'fx' in b and b['fx'] not in BEAT_FX: raise ValueError(bl + ': unknown fx')
                if k == 'icon':
                    if b.get('name') not in BEAT_ICONS: raise ValueError(bl + f': icon name must be one of {sorted(BEAT_ICONS)}')
                    if 'fx' in b and b['fx'] not in BEAT_FX: raise ValueError(bl + ': unknown icon fx')
                    if 'size' in b: finite(b['size'], .3, 1.0, bl + ' size')
                if k == 'type':
                    text(b.get('text'), bl + ' text', 40)
                    if 'slam' in b and type(b['slam']) is not bool: raise ValueError(bl + ': slam must be a boolean')
                    if 'hl' in b: text(b['hl'], bl + ' hl', 20)
                    if 'icon' in b and b['icon'] not in BEAT_ICONS: raise ValueError(bl + f': icon must be one of {sorted(BEAT_ICONS)}')
                    if 'fx' in b and b['fx'] not in BEAT_FX: raise ValueError(bl + ': unknown type fx')
                if k == 'terminal':
                    lines = b.get('lines')
                    if not isinstance(lines, list) or not 1 <= len(lines) <= 4: raise ValueError(bl + ': terminal needs 1-4 lines')
                    for ln in lines:
                        text(ln, bl + ' line', 48)
                        if any(ord(ch) < 32 or ord(ch) == 127 for ch in ln): raise ValueError(bl + ': lines must be printable')
                    if 'label' in b: text(b['label'], bl + ' label', 16)
                if k == 'steps':
                    items = b.get('items')
                    if not isinstance(items, list) or not 2 <= len(items) <= 4: raise ValueError(bl + ': steps need 2-4 items')
                    for it in items: text(it, bl + ' item', 14)
                    if 'lit' in b and (isinstance(b['lit'], bool) or not isinstance(b['lit'], int) or not 0 <= b['lit'] <= len(items)): raise ValueError(bl + ': lit out of range')
                if k == 'people':
                    for key in ('total', 'lit'):
                        if isinstance(b.get(key), bool) or not isinstance(b.get(key), int) or not 0 <= b[key] <= 12: raise ValueError(bl + f': {key} must be 0-12')
                    if b['lit'] > b['total']: raise ValueError(bl + ': lit exceeds total')
                    if 'label' in b: text(b['label'], bl + ' label', 32)
                if k == 'bars':
                    labels, values = b.get('labels'), b.get('values')
                    if not isinstance(labels, list) or not isinstance(values, list) or not 1 <= len(labels) <= 4 or len(labels) != len(values): raise ValueError(bl + ': bars need 1-4 labels with matching values')
                    for lb in labels: text(lb, bl + ' label', 14)
                    for v in values:
                        if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= 1000000: raise ValueError(bl + ': values must be integers 0-1000000')
                if k == 'timeline':
                    labels = b.get('labels')
                    if not isinstance(labels, list) or not 2 <= len(labels) <= 4: raise ValueError(bl + ': timeline needs 2-4 labels')
                    for lb in labels: text(lb, bl + ' label', 14)
                    if 'icons' in b and (not isinstance(b['icons'], list) or len(b['icons']) != len(labels) or not set(b['icons']) <= BEAT_ICONS): raise ValueError(bl + ': icons must name one icon per label')
                if k == 'dialog':
                    text(b.get('text'), bl + ' text', 32)
                    if 'count' in b and (isinstance(b['count'], bool) or not isinstance(b['count'], int) or not 1 <= b['count'] <= 5): raise ValueError(bl + ': count must be 1-5')
                if k == 'cta':
                    if 'label' in b: text(b['label'], bl + ' label', 24)
                    if 'toggles' in b:
                        if not isinstance(b['toggles'], list) or not 1 <= len(b['toggles']) <= 3: raise ValueError(bl + ': 1-3 toggles')
                        for tg in b['toggles']: text(tg, bl + ' toggle', 14)
            if 'chapter' in s: text(s['chapter'], label + ' chapter', 32)
            if 'accent' in s and s['accent'] not in CINEMA_ACCENTS: raise ValueError(label + ': accent must be green, cyan, red or amber')
            if 'hl' in s: text(s['hl'], label + ' hl', 24)
        if s['kind'] == 'closing' and c['style'] == 'cinema':
            if 'chapter' in s: text(s['chapter'], label + ' chapter', 32)
            if 'accent' in s and s['accent'] not in CINEMA_ACCENTS: raise ValueError(label + ': accent must be green, cyan, red or amber')
        if c['style'] == 'stickman' and s['kind'] not in {'story', 'closing'}:
            raise ValueError(label + ': the stickman style only draws story and closing scenes')
        if s['kind'] == 'story':
            if c['style'] != 'stickman':
                raise ValueError(label + ': story scenes need the stickman style')
            if s.get('act', 'idle') not in STORY_ACTS:
                raise ValueError(label + f': act must be one of {sorted(STORY_ACTS)}')
            cast = s.get('cast', ['hero'])
            if not isinstance(cast, list) or not 1 <= len(cast) <= 3 or not set(cast) <= STORY_CAST or 'hero' not in cast:
                raise ValueError(label + ': cast must list hero and at most thief, thief2')
            props = s.get('props', [])
            if not isinstance(props, list) or len(props) > 3 or not set(props) <= STORY_PROPS or len(set(props)) != len(props):
                raise ValueError(label + f': props must be up to three distinct names from {sorted(STORY_PROPS)}')
            if 'fx' in s and s['fx'] not in STORY_FX:
                raise ValueError(label + f': fx must be one of {sorted(STORY_FX)}')
            if 'accent' in s and s['accent'] not in STORY_ACCENTS:
                raise ValueError(label + ': accent must be green, red or amber')
            for key, limit in (('bubble', 40), ('hl', 24)):
                if key in s:
                    text(s[key], label + ' ' + key, limit)
                    if any(ord(ch) < 32 or ord(ch) == 127 for ch in s[key]):
                        raise ValueError(label + f': {key} must be single-line printable text')
        if s['kind'] == 'closing' and c['style'] == 'stickman':
            for key, limit in (('bubble', 40), ('hl', 24)):
                if key in s: text(s[key], label + ' ' + key, limit)
        text(s.get('voice'), label + ' voice', 350)
        text(s.get('title'), label + ' title', 90)
        for key, limit in [('eyebrow', 40), ('detail', 110), ('source', 80), ('button', 40)]:
            if key in s:
                text(s[key], label + ' ' + key, limit)
        if s.get('visual', 'focus') not in VISUALS:
            raise ValueError(label + ': unknown visual')
        if s['kind'] in {'steps', 'list', 'compare'}:
            items = s.get('items')
            n = 2 if s['kind'] == 'compare' else 3
            if not isinstance(items, list) or len(items) != n:
                raise ValueError(label + f': {n} items required')
            for item in items:
                text(item, label + ' item', 42)
        if 'terminal_lines' in s:
            if c['style'] != 'terminal' or not isinstance(s['terminal_lines'], list) or not 1 <= len(s['terminal_lines']) <= 3:
                raise ValueError(label + ': terminal_lines requires terminal style and 1–3 lines')
            for item in s['terminal_lines']:
                text(item, label + ' terminal line', 48)
                if any(ord(ch)<32 or ord(ch)==127 for ch in item):
                    raise ValueError(label + ': terminal lines must be single-line printable text')
        if 'motion' in s and (s['kind'] != 'image' or s['motion'] not in MOTION):
            raise ValueError(label + ': motion requires a supported image animation')
        if 'motion_labels' in s:
            if s.get('motion') not in LABELLED_MOTION or not isinstance(s['motion_labels'],list) or len(s['motion_labels']) != 3:
                raise ValueError(label + ': motion_labels needs exactly three cyber labels')
            for item in s['motion_labels']:text(item,label + ' motion label',20)
        for key in ('motion_text', 'motion_date', 'motion_count', 'motion_total', 'motion_stage'):
            if key in s and s.get('motion') not in ESCAPE_MOTION and not (key == 'motion_text' and s.get('motion') in {'voice-signal', 'ai-network', 'data-flow'}):
                raise ValueError(label + f': {key} requires an incident-timeline motion mode')
        if 'motion_text' in s:
            text(s['motion_text'], label + ' motion_text', 64)
            if any(ord(ch) < 32 or ord(ch) == 127 for ch in s['motion_text']):
                raise ValueError(label + ': motion_text must be single-line printable text')
        if 'motion_date' in s:
            text(s['motion_date'], label + ' motion_date', 18)
        for key in ('motion_count', 'motion_total'):
            if key in s:
                if isinstance(s[key], bool) or not isinstance(s[key], int) or not 0 <= s[key] <= 1000000:
                    raise ValueError(label + f': {key} must be an integer between 0 and 1000000')
        if 'motion_stage' in s:
            finite(s['motion_stage'], 0, 1, label + ' motion_stage')
        if 'animate_value' in s:
            if s['kind'] != 'metric' or type(s['animate_value']) is not bool:
                raise ValueError(label + ': animate_value must be a metric boolean')
            if s['animate_value'] and not re.fullmatch(r'\d+(?:,\d{3})*(?:\.\d+)?[^\d]*', s.get('value','')):
                raise ValueError(label + ': animated value needs an English-formatted numeric prefix')
        if s['kind'] == 'metric':
            text(s.get('value'), label + ' value', 12)
            text(s.get('unit'), label + ' unit', 45)
        if s['kind'] == 'quote':
            text(s.get('quote'), label + ' quote', 120)
        if s['kind'] == 'closing' and s.get('button') and s.get('detail'):
            raise ValueError(label + ': use either a closing button or a detail line')
        if s['kind'] == 'image':
            local_asset(path, s.get('image'))
            text(s.get('image_credit'), label + ' image_credit', 180)
        finite(s.get('hold', .65), .15, 3, label + ' hold')
    if scenes[-1]['kind'] != 'closing':
        raise ValueError('Last scene must be a closing')
    # One deliberate near-silence window in the music bed, addressed by scene id.
    if 'music_quiet' in c:
        q = c['music_quiet']
        order = [s['id'] for s in scenes]
        if not isinstance(q, dict) or set(q) != {'from', 'to'}:
            raise ValueError('music_quiet needs exactly a from and a to scene id')
        if q['from'] not in order or q['to'] not in order:
            raise ValueError('music_quiet must reference existing scene ids')
        if order.index(q['from']) > order.index(q['to']):
            raise ValueError('music_quiet from must not come after to')
    # The narrated text is immutable across editorial preparation.
    if c.get('script_file'):
        sp = (path.parent / c['script_file']).resolve()
        if not sp.is_relative_to(path.parent) or not sp.is_file():
            raise ValueError('script_file must exist inside the project')
        norm = lambda x: ' '.join(x.split())
        if norm(sp.read_text()) != norm(' '.join(s['voice'] for s in scenes)):
            raise ValueError('Narration differs from the supplied script')
    return c
