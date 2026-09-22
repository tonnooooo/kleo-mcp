"""Measured speech timeline, captions and quiet original instrumental bed."""
import argparse
import difflib
import hashlib
import json
import math
import os
import re
import unicodedata
from pathlib import Path
from contract import VERSION, atomic_json, validate

def normalize(word):
    return re.sub(r'[^a-z0-9]', '', unicodedata.normalize('NFD', word.lower()).encode('ascii', 'ignore').decode())

def lexical(word):
    folded=unicodedata.normalize('NFD',word.lower()).encode('ascii','ignore').decode()
    return re.findall(r'[a-z0-9]+',folded)

# A speech recogniser writes numbers as digits ("17,600") while a script may
# spell them ("seventeen thousand six hundred"); both are the same spoken words.
# Folding number words to a canonical value before comparing keeps the review
# gate on pronunciation, where it belongs, instead of on orthography.
_UNITS={'zero':0,'one':1,'two':2,'three':3,'four':4,'five':5,'six':6,'seven':7,'eight':8,
 'nine':9,'ten':10,'eleven':11,'twelve':12,'thirteen':13,'fourteen':14,'fifteen':15,
 'sixteen':16,'seventeen':17,'eighteen':18,'nineteen':19,'twenty':20,'thirty':30,
 'forty':40,'fifty':50,'sixty':60,'seventy':70,'eighty':80,'ninety':90}
_SCALES={'hundred':100,'thousand':1000,'million':1000000}
_ORDINAL={'first':1,'second':2,'third':3,'fourth':4,'fifth':5,'sixth':6,'seventh':7,
 'eighth':8,'ninth':9,'tenth':10,'twelfth':12,'twentieth':20,'thirtieth':30}
_ORD_SUFFIX=re.compile(r'^(\d+)(st|nd|rd|th)$')

def fold_numbers(pieces):
    """Collapse runs of number words, and comma groups, to one canonical token."""
    out,i=[],0
    while i<len(pieces):
        w=pieces[i]
        m=_ORD_SUFFIX.match(w)
        if m:out.append(str(int(m.group(1))));i+=1;continue
        if w.isdigit():
            value=int(w);i+=1
            # "17" "600" from "17,600" - a following 3-digit group continues it
            while i<len(pieces) and pieces[i].isdigit() and len(pieces[i])==3 and value>0:
                value=value*1000+int(pieces[i]);i+=1
            out.append(str(value));continue
        if w in _ORDINAL and (not out or True):
            out.append(str(_ORDINAL[w]));i+=1;continue
        if w in _UNITS or w in _SCALES:
            total=current=0;seen=False
            while i<len(pieces):
                t=pieces[i]
                if t in _UNITS:current+=_UNITS[t];seen=True;i+=1
                elif t=='hundred' and seen:current=max(current,1)*100;i+=1
                elif t in _SCALES and seen:total+=max(current,1)*_SCALES[t];current=0;i+=1
                elif t=='and' and seen and i+1<len(pieces) and pieces[i+1] in _UNITS:i+=1
                else:break
            if seen:out.append(str(total+current))
            else:out.append(w);i+=1
            continue
        out.append(w);i+=1
    return out

def align_words(script, heard, duration):
    """Script words with a start time each, anchored on the recognised words."""
    words=[]
    for word in script.split():
        if words and not lexical(word):words[-1]+=' '+word
        else:words.append(word)
    source_pieces=[(part,i) for i,w in enumerate(words) for part in lexical(w)]
    heard_pieces=[(part,float(w['start'])) for w in heard for part in lexical(w['word'])]
    a,b=[x[0] for x in source_pieces],[x[0] for x in heard_pieces]
    score = difflib.SequenceMatcher(a=''.join(fold_numbers(a)), b=''.join(fold_numbers(b)), autojunk=False).ratio()
    matcher = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    anchors = {}
    for block in matcher.get_matching_blocks():
        for k in range(block.size):
            owner=source_pieces[block.a+k][1]
            anchors.setdefault(owner,heard_pieces[block.b+k][1])
    starts = []
    for i in range(len(words)):
        if i in anchors:
            starts.append(anchors[i]); continue
        left = max((k for k in anchors if k < i), default=-1)
        right = min((k for k in anchors if k > i), default=len(words))
        lo, hi = anchors.get(left, 0), anchors.get(right, duration)
        starts.append(lo+(hi-lo)*(i-left)/(right-left))
    return words, starts, score, bool(anchors)

def caption_groups(script, heard, duration, defer=False, portrait=False, compact=False):
    words, starts, score, anchored = align_words(script, heard, duration)
    if score < .85 and not defer:
        raise ValueError(f'Speech review required: script/transcript match {score:.1%}')
    if not anchored:
        raise ValueError('No speech anchors found')
    # Portrait captions are drawn large: shorter groups, broken at punctuation first.
    # The explainer is stricter still: 1-4 words a block, about a quarter second per word.
    max_words, max_chars = (4, 26) if compact else (5, 32) if portrait else (7, 48)
    brief_floor = .35 if compact else .55
    groups, current, first = [], [], 0
    for i, word in enumerate(words):
        if current and (len(current) >= max_words or len(' '.join(current+[word])) > max_chars):
            groups.append({'text':' '.join(current), 'start':starts[first], 'end':starts[i]})
            current, first = [], i
        current.append(word)
        if portrait and word[-1:] in '.?!' and i + 1 < len(words):
            groups.append({'text':' '.join(current), 'start':starts[first], 'end':starts[i+1]})
            current, first = [], i + 1
    if current:
        groups.append({'text':' '.join(current), 'start':starts[first], 'end':duration})
    if portrait:
        # A group too brief to read is merged into its neighbour rather than shown for a blink.
        merged = []
        for g in groups:
            if merged and (g['end']-g['start'] < brief_floor or (len(g['text'].split()) <= 1 and not compact)) and len((merged[-1]['text']+' '+g['text']).split()) <= max_words and len(merged[-1]['text']+' '+g['text']) <= max_chars + 12:
                merged[-1] = {'text': merged[-1]['text']+' '+g['text'], 'start': merged[-1]['start'], 'end': g['end']}
            else:
                merged.append(g)
        groups = merged
    if compact:
        # A block too brief to read borrows a word from its neighbour rather than being merged past
        # the four-word ceiling the engine enforces.
        for _ in range(4):
            moved = False
            for k, g in enumerate(groups):
                if g['end'] - g['start'] >= brief_floor: continue
                prev = groups[k-1] if k else None
                if prev and len(prev['text'].split()) > 1:
                    w = prev['text'].split()
                    if len(g['text'].split()) < max_words and len(w[-1] + ' ' + g['text']) <= max_chars:
                        prev['text'] = ' '.join(w[:-1])
                        g['text'] = w[-1] + ' ' + g['text']
                        span = (g['start'] - prev['start']) / (len(w))
                        g['start'] = prev['end'] = max(prev['start'] + .05, g['start'] - span)
                        moved = True; break
            if not moved: break
    # A GROUP TOO BRIEF TO READ IS REPAIRED, NEVER FATAL (22 September 2026). Until this line a last group of one
    # word could kill a paid render: the trimmed tail (trim_edges) leaves the last word ~0.3 s of audio, the group
    # ends where the audio ends, and `raise` failed the voice pass three times on gt_xrnffqsx — five credits, a
    # rented card, no video, for a caption nobody had asked to be that short. In every mode: merge it into the
    # group before it when the line stays readable, else move the boundary with a neighbour that has time to
    # spare, else let it run a little past the sound (the scene's hold covers it).
    floor = .25 if compact else brief_floor
    limit_words, limit_chars = max_words + (0 if compact else 2), max_chars + (0 if compact else 12)
    for _ in range(len(groups) + 1):
        brief = next((k for k, g in enumerate(groups) if g['end'] - g['start'] < floor), None)
        if brief is None: break
        g, prev = groups[brief], groups[brief - 1] if brief else None
        nxt = groups[brief + 1] if brief + 1 < len(groups) else None
        joined = (prev['text'] + ' ' + g['text']) if prev else ''
        if prev and len(joined.split()) <= limit_words and len(joined) <= limit_chars:
            groups[brief - 1] = {'text': joined, 'start': prev['start'], 'end': g['end']}; del groups[brief]
        elif prev and prev['end'] - prev['start'] > floor + .3:
            g['start'] = prev['end'] = max(prev['start'] + floor, g['end'] - floor)
        elif nxt and nxt['end'] - nxt['start'] > floor + .3:
            g['end'] = nxt['start'] = min(nxt['end'] - floor, g['start'] + floor)
        else:
            g['end'] = g['start'] + floor
        print('CAPTION_REPAIRED', repr(g['text']), flush=True)
    return groups, score

def trim_edges(audio, sr, keep_head=.12, keep_tail=.18, floor=.02):
    """The synthesised sentence without the silence Kokoro pads it with: everything below `floor` of the peak at
    the head and the tail is cut, `keep_head` / `keep_tail` seconds of it are kept so the first and the last word
    are never clipped. A sentence with nothing above the floor is returned as it is."""
    import numpy as np
    a = np.asarray(audio)
    if not len(a):
        return a
    peak = float(np.abs(a).max())
    if peak <= 0:
        return a
    loud = np.flatnonzero(np.abs(a) > peak * floor)
    if not len(loud):
        return a
    start = max(0, int(loud[0]) - int(keep_head * sr))
    end = min(len(a), int(loud[-1]) + 1 + int(keep_tail * sr))
    return a[start:end]

def main():
    p = argparse.ArgumentParser(); p.add_argument('project'); args = p.parse_args()
    project = Path(args.project).resolve(); c = validate(project)
    out = project.parent/'build'; cache = out/'voice'; cache.mkdir(parents=True, exist_ok=True)
    import numpy as np
    import soundfile as sf
    try:
        import torch; device = 'cuda' if torch.cuda.is_available() else 'cpu'
    except ImportError:
        device = 'cpu'
    # Kokoro lang codes: en → 'a'/'b' (misaki G2P), fr → 'f' and it → 'i' (espeak-ng G2P).
    lang = {'fr': 'f', 'it': 'i'}.get(c['language']) or ('b' if c['voice'].startswith('b') else 'a')
    models = {}
    def synth():
        # Loaded on the first uncached scene only: a fully cached project (re-timing a
        # cut, changing holds) can be prepared on a machine without Kokoro or a GPU.
        if not models:
            from kokoro import KPipeline
            from faster_whisper import WhisperModel
            models['voice'] = KPipeline(lang_code=lang, device=device, repo_id='hexgrad/Kokoro-82M')
            # CPU alignment avoids sharing GPU library paths with CTranslate2.
            models['asr'] = WhisperModel('small', device='cpu', compute_type='int8', cpu_threads=min(8, os.cpu_count() or 2))
        return models['voice'], models['asr']
    scenes, wavs, cursor, speech_failures = [], [], 0, []
    fps = c['fps']; sr = 24000
    for index, source in enumerate(c['scenes']):
        s = dict(source); key = hashlib.sha256(json.dumps({'v':VERSION,'script':s['voice'],'voice':c['voice'],'speed':c.get('speed',1),'language':c['language'],'align':'small-v2','trim':1},sort_keys=True).encode()).hexdigest()
        wav, meta = cache/(key+'.wav'), cache/(key+'.json')
        if wav.exists() and meta.exists():
            audio, rate = sf.read(wav); timing = json.loads(meta.read_text())
            if rate != sr or not np.isfinite(audio).all():
                raise ValueError('Invalid cached voice')
            print('VOICE_CACHE', s['id'], flush=True)
        else:
            voice, asr = synth()
            chunks = list(voice(s['voice'], voice=c['voice'], speed=c.get('speed',1)))
            audio = np.concatenate([np.asarray(chunk.audio) for chunk in chunks])
            if not np.isfinite(audio).all() or len(audio) < sr*.3:
                raise ValueError('Speech synthesis failed')
            # THE SILENCE AT THE EDGES OF A SENTENCE (22 September 2026). Kokoro hands back each sentence with
            # about half a second of nothing before the first word and after the last; with the lead and the hold
            # on top, a 30-second animatic (gt_w4tuqvgh) had six pauses of 1.8 s and ran 39 s. The edges are cut
            # here, BEFORE the alignment and the cache, so every word time downstream is measured on what is kept:
            # 0.12 s kept before the first sound, 0.18 s after the last, the breath between sentences is the hold's.
            audio = trim_edges(audio, sr)
            sf.write(wav, audio, sr, subtype='PCM_24')
            segments, _ = asr.transcribe(str(wav), language=c['language'], beam_size=5, word_timestamps=True, vad_filter=False)
            segments = list(segments)
            heard = [{'word':w.word,'start':w.start,'end':w.end} for seg in segments for w in (seg.words or [])]
            atomic_json(cache/(key+'.asr.json'),{'script':s['voice'],'heard':heard,'transcript':' '.join(seg.text.strip() for seg in segments)})
            captions, score = caption_groups(s['voice'], heard, len(audio)/sr, defer=True, portrait=c['format']=='9:16', compact=c['style']=='sketch')
            w_words, w_starts, _, _ = align_words(s['voice'], heard, len(audio)/sr)
            word_times = [{'text': w, 'start': st} for w, st in zip(w_words, w_starts)]
            if score < .85:
                # Report every scene that needs a speech review in one pass. Finding
                # them one render at a time costs an editorial cycle per sentence.
                speech_failures.append((s['id'], round(score, 3), s['voice'],
                                        ' '.join(seg.text.strip() for seg in segments)))
            timing = {'captions':captions,'match':score,'transcript':' '.join(seg.text.strip() for seg in segments),'words':word_times}
            atomic_json(meta, timing)
            print('VOICE_NEW',s['id'],round(len(audio)/sr,2),'seconds',round(score,3),flush=True)
        duration = len(audio)/sr
        # IL PRIMO SECONDO DECIDE SE QUALCUNO GUARDA. `lead` e' il silenzio prima che una scena cominci a parlare,
        # e serve: un attacco esattamente sul fotogramma zero fa uno scatto e le scene attaccate si accavallano.
        # Ma sulla PRIMA scena quel silenzio e' il gancio, ed era lungo quanto quello di tutte le altre. Su uno
        # Short 0,22 s di nero muto all'inizio sono il momento in cui il pollice scorre. Il primo attacco tiene
        # solo quel tanto che basta a non fare clic; tutte le altre scene restano come sono, perche' li il silenzio
        # separa due frasi invece di ritardare la prima.
        lead = c.get('lead', .15 if c['style'] == 'sketch' else .22)
        if index == 0:
            lead = min(lead, float(c.get('lead_first', .06)))
        # Landscape keeps the editorial floor; a Short cuts on the word, so its scenes keep
        # the hold the project asked for (the last one still leaves a beat before the loop).
        # The explainer ends on its last drawn frame in both formats: no tail, no loop pad.
        # The picture style (Kleo's films and animatics) keeps a beat between two sentences in landscape too, not
        # the editorial floor of the cinema style: 0.65 s of hold on top of Kokoro's own tail was the dead air
        # measured on 22 September. The last scene still leaves a longer beat before the film ends.
        floor = (.05, .05) if c['style'] == 'sketch' else (.15, .4) if c['format'] == '9:16' else (.3, .9) if c['style'] == 'picture' else (.65, 1.5)
        hold = max(s.get('hold',.65), floor[1] if index == len(c['scenes'])-1 else floor[0])
        end = math.ceil((cursor+lead+duration+hold)*fps)/fps
        audio_start = cursor+lead
        s.update(start=cursor,end=end,audio_start=audio_start,audio_end=audio_start+duration,
                 captions=[dict(g,start=audio_start+g['start'],end=min(audio_start+g['end']+.12,end-.1)) for g in timing['captions']],speech_match=timing['match'],transcript=timing['transcript'],
                 words=[dict(w,start=audio_start+w['start']) for w in timing.get('words',[])])
        # Adjacent caption groups must not overlap.
        for i in range(len(s['captions'])-1):
            s['captions'][i]['end'] = min(s['captions'][i]['end'],s['captions'][i+1]['start'])
        wavs.append((audio_start,audio)); scenes.append(s); cursor=end
    if speech_failures:
        for sid, score, script, heard in speech_failures:
            print(f'SPEECH_REVIEW {sid} {score:.1%}\n  script: {script}\n  heard : {heard}', flush=True)
        raise ValueError(f'Speech review required on {len(speech_failures)} scene(s): '
                         + ', '.join(f'{sid} {score:.0%}' for sid, score, _, _ in speech_failures))
    if cursor>c.get('max_duration',600):
        raise ValueError(f'Narration requires {cursor:.2f}s, exceeds max_duration; nothing was truncated')
    vo = np.zeros(round(cursor*sr),dtype=np.float32)
    for start,audio in wavs:
        a=round(start*sr);vo[a:a+len(audio)]+=audio
    sf.write(out/'voice.wav',vo,sr,subtype='PCM_24')
    # Original procedural music; restrained enough to leave room for narration.
    sr=48000;t=np.arange(round(cursor*sr))/sr;bed=np.zeros_like(t)
    chords=[[130.8128,195.9977,293.6648,329.6276],[110,164.8138,246.9417,293.6648],[87.3071,130.8128,195.9977,261.6256],[97.9989,146.8324,220,293.6648]]
    for k,st in enumerate(np.arange(0,cursor,4)):
        mask=(t>=st)&(t<st+5.5);tt=t[mask]-st;env=np.minimum(tt/1.1,1)*np.minimum((5.5-tt)/1.5,1)
        for j,f in enumerate(chords[k%4]):bed[mask]+=.012*np.sin(2*np.pi*f*tt+.2*np.sin(tt*.7+j))*env
    for k,st in enumerate(np.arange(.15,cursor,.75)):
        mask=(t>=st)&(t<st+1.8);tt=t[mask]-st;f=chords[(k//5)%4][k%4]*4
        bed[mask]+=.025*np.sin(2*np.pi*f*tt)*np.exp(-tt*4)*(1-np.exp(-tt*100))
    bed*=np.minimum(t/.7,1)*np.minimum((cursor-t)/1.2,1)
    # One scripted near-silence: the bed steps back for the reveal instead of
    # swelling under it. Narration is untouched; only the instrumental dips.
    quiet=c.get('music_quiet')
    if quiet:
        spans={s['id']:(s['start'],s['end']) for s in scenes}
        a,b=spans[quiet['from']][0],spans[quiet['to']][1];fade=.9
        dip=np.minimum(np.clip((t-(a-fade))/fade,0,1),np.clip(((b+fade)-t)/fade,0,1))
        bed*=1-.94*dip
        print('MUSIC_QUIET',round(a,2),'->',round(b,2),'seconds',flush=True)
    # 'track' (22 September 2026) is the user's own music: the Kleo worker writes it over this file after this pass,
    # so what is written here is silence — a track that never arrives leaves a quiet film, never the sine bed.
    if c.get('music') in ('none','track'):bed=np.zeros_like(bed);print('MUSIC_NONE' if c.get('music')=='none' else 'MUSIC_TRACK_PENDING',flush=True)   # voice only
    sf.write(out/'music.wav',np.column_stack([bed,np.roll(bed,151)*.97]),sr,subtype='PCM_24')
    atomic_json(out/'timeline.json',{'duration':cursor,'fps':fps,'scenes':scenes,'tts':'Kokoro-82M','device':device,'version':VERSION})
    print('PREPARED',round(cursor,3),'seconds',len(scenes),'scenes',flush=True)

if __name__ == '__main__':
    main()
