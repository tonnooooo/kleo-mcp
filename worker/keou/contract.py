"""The production contract. Validation happens before any rental or render."""
import hashlib
import json
import math
import re
from pathlib import Path

VERSION = '1.0.0'
STYLES = {'editorial', 'technical', 'illustrated', 'terminal', 'stickman', 'cinema', 'picture', 'sketch'}
KINDS = {'hero', 'list', 'compare', 'steps', 'metric', 'image', 'quote', 'closing', 'story', 'cinema', 'sketch'}
# Cinema beats: one hero visual each, several per narrated scene for pace.
BEAT_KINDS = {'icon', 'type', 'terminal', 'steps', 'people', 'bars', 'timeline', 'dialog', 'cta', 'split', 'grid'}
BEAT_ICONS = {'coffee', 'desk', 'hoodie', 'keyboard', 'hand', 'bug', 'alarm', 'shield', 'radar', 'car', 'keyfob', 'house', 'amplifier', 'pouch', 'lock', 'timer', 'check', 'cross', 'figure', 'thief', 'phone', 'wave', 'clock'}
BEAT_FX = {'lit', 'dead', 'key', 'open', 'drive', 'alarm', 'point', 'run', 'think'}
CINEMA_ACCENTS = {'green', 'cyan', 'red', 'amber'}
# The explainer (Kleo style 'explainer', Keou style 'sketch'; docs/EXPLAINER-STYLE.md): hand-drawn white
# marker line art on pure black, ONE accent per section and never two in a frame, a camera that only ever
# pushes in, and burned-in karaoke captions as the only text on screen.
SKETCH_ACCENTS = {'red', 'blue', 'green', 'yellow', 'white'}
# The alphabet the explainer draws with. The first nineteen are the hotel film's own world; the rest are
# what every other subject needs, because one drawing per phrase only works when the phrase has a drawing.
SKETCH_ART = {'figure', 'hand', 'keycard', 'door', 'reader', 'phone', 'corridor', 'tag', 'room', 'writer',
              'blank', 'crowbar', 'bell', 'hotels', 'globe', 'face', 'intruder', 'footprints', 'suitcase',
              'crowd', 'handshake', 'eye', 'brain', 'robot', 'laptop', 'server', 'router', 'camera', 'chip',
              'usb', 'car', 'lock', 'key', 'shield', 'bug', 'fingerprint', 'envelope', 'signal', 'chart',
              'graph', 'folder', 'cloud', 'code', 'scale', 'warning', 'question', 'city', 'coin', 'clock',
              'calendar', 'box', 'book', 'rocket', 'bulb', 'magnifier', 'gear', 'chain', 'tree', 'satellite'}
# How far each drawing reaches BELOW its own centre, in design pixels at size 1, measured by running
# every builder against a context that records where it puts ink (scripts/sketch-extent.mjs). It is
# what makes the caption safe area a fact rather than a guess: a tag is 53 pixels tall and a figure is
# 246, so one rule for both is either useless or wrong. The five drawings at 0 are backdrops — the
# space the others stand in — and the caption is meant to sit over them.
SKETCH_DROP = {'figure': 246, 'hand': 117, 'keycard': 104, 'door': 380, 'reader': 472, 'phone': 260,
                 'corridor': 0, 'tag': 53, 'room': 0, 'writer': 150, 'blank': 0, 'crowbar': 440, 'bell': 333,
                 'hotels': 0, 'globe': 259, 'face': 308, 'intruder': 246, 'footprints': 295, 'suitcase': 198,
                 'crowd': 342, 'handshake': 62, 'eye': 135, 'brain': 124, 'robot': 166, 'laptop': 137,
                 'server': 241, 'router': 127, 'camera': 0, 'chip': 184, 'usb': 165, 'car': 126, 'lock': 182,
                 'key': 84, 'shield': 210, 'bug': 106, 'fingerprint': 190, 'envelope': 152, 'signal': 235,
                 'chart': 179, 'graph': 219, 'folder': 162, 'cloud': 35, 'code': 182, 'scale': 190, 'warning': 180,
                 'question': 199, 'city': 0, 'coin': 198, 'clock': 203, 'calendar': 192, 'box': 200, 'book': 141,
                 'rocket': 173, 'bulb': 195, 'magnifier': 202, 'gear': 187, 'chain': 105, 'tree': 238,
                 'satellite': 327}
SKETCH_MOODS = {'worried', 'scared', 'calm'}
SKETCH_MOTION = {'turn', 'slide', 'rise', 'tap', 'shake', 'walk', 'pulse', 'drift'}
SKETCH_ENTER = {'whip', 'cut'}
SKETCH_EXIT = {'flare', 'cut'}
# Kleo picture style (docs/PICTURE-STYLE.md): full-screen pictures cut on the narration, no beats
# and no icons. `look` picks the typography; every shot is one generated picture in img/.
LOOKS = {'cartoon', 'realistic'}
# The camera moves the server resolves a shot_kind into (src/shot-grammar.ts). The engine never sees shot_kind:
# the server writes the resolved move here, so the grammar lives in one place and this file only has to draw it.
# The first four are the old hand-written vocabulary, still accepted so a storyboard written before the grammar renders.
SHOT_MOTIONS = {'in', 'out', 'left', 'right',
                'crash_zoom_in', 'push_in', 'push_in_dutch', 'pull_out', 'track_left', 'track_right',
                'track_alongside', 'orbit_left', 'orbit_right', 'crane_down', 'crane_up', 'whip_pan', 'static_hold'}
SHOT_FIELDS = {'image', 'caption', 'hl', 'at', 'motion', 'strength'}
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
    if c['style'] == 'picture':
        if c.get('look') not in LOOKS:
            raise ValueError(f'look must be one of {sorted(LOOKS)} when style is picture')
    elif 'look' in c:
        raise ValueError('look belongs to the picture style only')
    if c.get('format') not in {'9:16', '16:9'} or c.get('fps') not in {30, 60}:
        raise ValueError('format: 9:16 or 16:9; fps: 30 or 60')
    # Read by prepare.py (the silence before the first word) and run.py (the mix target). The
    # loudness window is the one qa.py will hold the master to, so the contract cannot accept a
    # target the render is then failed for hitting.
    finite(c.get('lead', .22), 0, 2, 'lead')
    finite(c.get('loudness', -16), -18, -14, 'loudness')
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
        if c['style'] != 'picture' and (s['kind'] == 'cinema' or (s['kind'] == 'closing' and c['style'] == 'cinema' and 'beats' in s)):
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
        if c['style'] == 'picture':
            if s['kind'] not in {'cinema', 'closing'}:
                raise ValueError(label + ': the picture style only draws cinema and closing scenes')
            if 'beats' in s:
                raise ValueError(label + ': the picture style has no beats; use shots')
            shots = s.get('shots')
            most = 2 if s['kind'] == 'closing' else 4
            if not isinstance(shots, list) or not 1 <= len(shots) <= most:
                raise ValueError(label + f': shots must list one to {most} pictures')
            for j, shot in enumerate(shots):
                sl = f'{label} shot {j + 1}'
                if not isinstance(shot, dict):
                    raise ValueError(sl + ': each shot is an object')
                unknown = set(shot) - SHOT_FIELDS
                if unknown:
                    raise ValueError(sl + f': unknown shot fields {sorted(unknown)}')
                if 'image' in shot:
                    local_asset(path, shot['image'])
                if 'caption' in shot:
                    text(shot['caption'], sl + ' caption', 40)
                if 'hl' in shot:
                    text(shot['hl'], sl + ' hl', 20)
                if 'at' in shot:
                    text(shot['at'], sl + ' at', 24)
                    if j == 0:
                        raise ValueError(sl + ': the first shot opens the scene, it takes no at')
                    if shot['at'].lower() not in str(s.get('voice') or '').lower():
                        raise ValueError(sl + ': at must quote words from this scene\'s voice')
                if 'strength' in shot and not (isinstance(shot['strength'], (int, float))
                                              and not isinstance(shot['strength'], bool) and 0 <= shot['strength'] <= 1):
                    raise ValueError(sl + ': strength scales the camera move and runs from 0 to 1')
                if 'motion' in shot and shot['motion'] not in SHOT_MOTIONS:
                    raise ValueError(sl + f': motion must be one of {sorted(SHOT_MOTIONS)}')
            if 'chapter' in s:
                text(s['chapter'], label + ' chapter', 32)
            if 'accent' in s and s['accent'] not in CINEMA_ACCENTS:
                raise ValueError(label + ': accent must be green, cyan, red or amber')
            if 'hl' in s:
                text(s['hl'], label + ' hl', 24)
            if s['kind'] == 'closing' and 'button' in s:
                text(s['button'], label + ' button', 24)
        elif 'shots' in s:
            raise ValueError(label + ': shots belong to the picture style only')
        # --- explainer (Keou style 'sketch') ------------------------------------------------
        if c['style'] == 'sketch' and s['kind'] != 'sketch':
            raise ValueError(label + ': the explainer style only draws explainer scenes')
        if s['kind'] == 'sketch':
            if c['style'] != 'sketch':
                raise ValueError(label + ': explainer scenes need the explainer style')
            # The art is authored in the frame's own pixels, so the bounds follow the format.
            fw, fh = (1080, 1920) if c['format'] == '9:16' else (1920, 1080)
            if s.get('accent', 'white') not in SKETCH_ACCENTS:
                raise ValueError(label + f': accent must be one of {sorted(SKETCH_ACCENTS)}')
            if s.get('enter', 'cut') not in SKETCH_ENTER or s.get('exit', 'cut') not in SKETCH_EXIT:
                raise ValueError(label + f': enter must be one of {sorted(SKETCH_ENTER)}, exit one of {sorted(SKETCH_EXIT)}')
            shot = s.get('shot', {})
            if not isinstance(shot, dict):
                raise ValueError(label + ': shot must be an object')
            zoom = shot.get('zoom', [1, 1.2])
            if not isinstance(zoom, list) or len(zoom) != 2:
                raise ValueError(label + ': shot zoom needs a start and an end')
            for z in zoom:
                finite(z, .5, 4, label + ' zoom')
            # Not taste: qa.py fails a master with a second of identical frames, and a camera that
            # does not move produces exactly that.
            if zoom[1] <= zoom[0]:
                raise ValueError(label + ': the camera never stops pushing in - zoom must increase')
            focus = shot.get('focus', [fw / 2, fh / 2])
            if not isinstance(focus, list) or len(focus) != 2:
                raise ValueError(label + ': shot focus needs x and y')
            finite(focus[0], 0, fw, label + ' focus x')
            finite(focus[1], 0, fh, label + ' focus y')
            art = s.get('art')
            if not isinstance(art, list) or not 1 <= len(art) <= 8:
                raise ValueError(label + ': art must list one to eight drawn elements')
            for j, e in enumerate(art):
                el = f'{label} art {j + 1}'
                if not isinstance(e, dict) or e.get('name') not in SKETCH_ART:
                    raise ValueError(el + f': name must be one of {sorted(SKETCH_ART)}')
                # A cue is either a fraction of the shot or the words it must land on. The engine
                # matches the words on a folded character stream, so quote them exactly.
                for key in ('at', 'until'):
                    if key in e and isinstance(e[key], str):
                        text(e[key], el + ' ' + key, 32)
                        if e[key].lower() not in s.get('voice', '').lower():
                            raise ValueError(el + f": {key} must quote words from this scene's voice")
                if 'at' in e and not isinstance(e['at'], str):
                    finite(e['at'], 0, .95, el + ' at')
                if 'until' in e and not isinstance(e['until'], str):
                    finite(e['until'], .05, 1, el + ' until')
                    if not isinstance(e.get('at', 0), str) and e['until'] <= e.get('at', 0):
                        raise ValueError(el + ': until must come after at')
                if 'motion' in e and e['motion'] not in SKETCH_MOTION:
                    raise ValueError(el + f': motion must be one of {sorted(SKETCH_MOTION)}')
                if 'motion_over' in e: finite(e['motion_over'], .1, 4, el + ' motion_over')
                if 'drawn' in e and type(e['drawn']) is not bool: raise ValueError(el + ': drawn must be a boolean')
                if 'x' in e: finite(e['x'], -fw * .4, fw * 1.4, el + ' x')
                if 'y' in e:
                    finite(e['y'], -fh * .25, fh * 1.25, el + ' y')
                    # THE CAPTION OWNS THE BOTTOM OF THE FRAME. It is burned in at 81.8 % of the height and
                    # it is the only text in the film, so a drawing that reaches into it is a drawing the
                    # viewer reads words through. SKETCH_DROP says how far this particular drawing actually
                    # reaches below its centre; the band starts at 78 %.
                    # Its outer edge may pass under the caption — a panel, a skyline and a corridor all
                    # do, and a thin line under a word costs nothing — but only its last quarter: at half,
                    # measured against real films, a face could put its mouth behind the words and pass.
                    drop = SKETCH_DROP.get(e.get('name'), 250) * float(e.get('size') or 1) * .75
                    if float(e['y']) + drop > fh * .78:
                        raise ValueError(el + ": y %g puts %s behind the caption, which is burned in at 78-86%% "
                                              "of the frame; at this size keep y at or under %d"
                                         % (e['y'], e.get('name'), fh * .78 - drop))
                if 'size' in e: finite(e['size'], .1, 6, el + ' size')
                for key in ('tint', 'led', 'beam', 'chip', 'no_col'):
                    if key in e and e[key] not in SKETCH_ACCENTS:
                        raise ValueError(el + f': {key} must be one of {sorted(SKETCH_ACCENTS)}')
                if 'mood' in e and e['mood'] not in SKETCH_MOODS:
                    raise ValueError(el + f': mood must be one of {sorted(SKETCH_MOODS)}')
                if 'count' in e and (isinstance(e['count'], bool) or not isinstance(e['count'], int) or not 1 <= e['count'] <= 12):
                    raise ValueError(el + ': count must be 1-12')
                for flag in ('no', 'sweat', 'xray', 'flash', 'flip', 'leader'):
                    if flag in e and type(e[flag]) is not bool:
                        raise ValueError(el + f': {flag} must be a boolean')
                if 'text' in e: text(e['text'], el + ' text', 24)
                for key in ('open', 'open_to'):
                    if key in e: finite(e[key], 0, 1, el + ' ' + key)
                if 'swing_over' in e: finite(e['swing_over'], .2, 3, el + ' swing_over')
                if 'reach' in e:
                    if not isinstance(e['reach'], list) or len(e['reach']) != 2:
                        raise ValueError(el + ': reach needs x and y')
                    for v in e['reach']:
                        finite(v, -600, 600, el + ' reach')
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
        # The explainer draws no title: its captions are the only text on screen.
        if s['kind'] == 'sketch':
            if 'title' in s: text(s['title'], label + ' title', 90)
        else:
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
        elif 'image' in s:
            # Kleo backdrop: a full-bleed animated picture behind cinema, story and closing
            # scenes. Same local-asset rules as the image kind; other kinds never carry one.
            if s['kind'] not in {'cinema', 'story', 'closing'}:
                raise ValueError(label + ': image is only accepted on image, cinema, story and closing scenes')
            local_asset(path, s['image'])
        finite(s.get('hold', .65), .05 if s['kind'] == 'sketch' else .15, 3, label + ' hold')
    # The explainer ends on its last drawn frame: no end card, no logo, no subscribe.
    if c['style'] != 'sketch' and scenes[-1]['kind'] != 'closing':
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
