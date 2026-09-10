"""Delivery checks, measured against the actual project, not a fixed demo."""
import argparse
import json
import os
import re
import subprocess
from pathlib import Path
from contract import atomic_json, digest, validate

def main(project):
    project=Path(project).resolve(); c=validate(project); out=project.parent/'out'
    tl=json.loads((project.parent/'build/timeline.json').read_text()); movie=out/'master.mp4'
    ffmpeg=os.environ.get('FFMPEG','ffmpeg'); probe=os.environ.get('FFPROBE','ffprobe')
    def run(args):
        return subprocess.run(args,capture_output=True,text=True,check=True).stdout
    p=json.loads(run([probe,'-v','error','-count_frames','-show_streams','-show_format','-of','json',str(movie)]))
    v=next(s for s in p['streams'] if s['codec_type']=='video'); a=next(s for s in p['streams'] if s['codec_type']=='audio')
    expected=(c['width'],round(c['width']*(16/9 if c['format']=='9:16' else 9/16)),c['fps'])
    if (v['width'],v['height'],v['r_frame_rate'])!=(expected[0],expected[1],str(expected[2])+'/1'):
        raise ValueError('Master geometry or frame rate mismatch')
    if int(v['nb_read_frames'])!=round(tl['duration']*c['fps']) or abs(float(p['format']['duration'])-tl['duration'])>.05:
        raise ValueError('Master duration or frame count mismatch')
    if a['channels']!=2 or a['sample_rate']!='48000':raise ValueError('Expected stereo 48 kHz')
    # The explainer draws white line art on pure black: about 90 % of every legitimate frame is
    # already under the threshold, so only a frame that is essentially empty counts as black.
    ratio=.998 if c['style']=='sketch' else .98
    decode=subprocess.run([ffmpeg,'-nostdin','-v','info','-i',str(movie),'-vf',f'scale=270:-2,blackdetect=d=0.15:pic_th={ratio}:pix_th=0.02','-an','-f','null','-'],capture_output=True,text=True,check=True)
    (out/'decode.log').write_text(decode.stderr)
    black=re.findall(r'black_start:([\d.]+) black_end:([\d.]+)',decode.stderr)
    if black:raise ValueError(f'Unexpected black interval: {black}')
    levels=subprocess.run([ffmpeg,'-nostdin','-hide_banner','-i',str(movie),'-vn','-af','loudnorm=I=-16:TP=-1.5:LRA=7:print_format=json','-f','null','-'],capture_output=True,text=True,check=True)
    (out/'loudness.log').write_text(levels.stderr)
    match=re.search(r'\{\s*"input_i".*?\}',levels.stderr,re.S)
    if not match:raise ValueError('Loudness measurement missing')
    loud=json.loads(match.group()); lufs=float(loud['input_i']); peak=float(loud['input_tp'])
    target=c.get('loudness',-16)
    if not target-2.5<=lufs<=target+2 or peak>-.8:raise ValueError(f'Audio levels outside target: {lufs} LUFS, {peak} dBTP (target {target})')
    hashes=run([ffmpeg,'-nostdin','-v','error','-i',str(movie),'-an','-vf','fps=6,scale=270:-2','-f','framemd5','-'])
    values=[l.split(',')[-1].strip() for l in hashes.splitlines() if l and not l.startswith('#')]
    streak=longest=0
    for left,right in zip(values,values[1:]):
        streak=streak+1 if left==right else 0;longest=max(streak,longest)
    if longest>=6:raise ValueError('At least one second of identical sampled frames')
    speech=min(s['speech_match'] for s in tl['scenes'])
    if speech<.85:raise ValueError('Speech mismatch')
    report={'status':'PASS','version':'1.0.0','master':'master.mp4','sha256':digest(movie),'width':v['width'],'height':v['height'],'fps':c['fps'],'frames':int(v['nb_read_frames']),'duration':float(p['format']['duration']),'full_decode':'PASS','black_intervals':black,'audio_lufs':lufs,'audio_true_peak_db':peak,'minimum_scene_speech_match':speech,'longest_identical_sample_run':longest,'limitations':['Layout bounds checked at render time; aesthetic and pronunciation review remains with Pearl.','ASR agreement is a content check, not a guarantee of perfect pronunciation.']}
    atomic_json(out/'FINAL-QA.json',report);print('QA_PASS',json.dumps(report),flush=True)
    return report

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('project');main(p.parse_args().project)
