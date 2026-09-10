"""One local/worker entry point. A job lock, explicit state and verified deliverables."""
import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from contract import VERSION, atomic_json, digest, validate
ROOT=Path(__file__).resolve().parent

def produce(project,workers=2,stills=False,skip_voice=False):
    project=Path(project).resolve(); c=validate(project); out=project.parent/'out';out.mkdir(exist_ok=True)
    build=project.parent/'build';build.mkdir(exist_ok=True)
    with (build/'run.lock').open('w') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise ValueError('This project already has an active job')
        lock.write(str(os.getpid()));lock.flush()
        state={'version':VERSION,'project':c['id'],'status':'running','started_at':time.time()}
        # Invalidate an earlier delivery immediately, so a failed new run cannot look ready.
        if (out/'delivery.json').exists():(out/'delivery.json').unlink()
        def stage(name,args):
            state.update(stage=name,updated_at=time.time());atomic_json(out/'state.json',state)
            print('STAGE',name,flush=True);subprocess.run(args,check=True,cwd=ROOT)
        try:
            if not skip_voice:stage('voice',[sys.executable,str(ROOT/'prepare.py'),str(project)])
            timeline=json.loads((build/'timeline.json').read_text())
            if timeline.get('layout_fixture') and not stills:
                raise ValueError('Layout-only timing cannot be used for a delivered video')
            if len(timeline['scenes'])!=len(c['scenes']) or any(a['voice']!=b['voice'] for a,b in zip(timeline['scenes'],c['scenes'])):
                raise ValueError('Cached timeline does not match the script')
            ffmpeg=os.environ.get('FFMPEG','ffmpeg')
            if not stills:
                target=c.get('loudness',-16)
                chain='[0:a]aresample=48000,highpass=f=75,lowpass=f=12000,acompressor=threshold=0.15:ratio=2:attack=15:release=180,volume=1.6,asplit=2[v][s];[1:a][s]sidechaincompress=threshold=0.025:ratio=5:attack=15:release=320[bed];[v][bed]amix=inputs=2:duration=longest:normalize=0'
                if c['style']=='sketch':
                    # Two passes: a track that is mostly silence lands about 2 dB under the target on
                    # one pass, and the feed plays a quiet Short at half the volume of everything else.
                    probe=subprocess.run([ffmpeg,'-nostdin','-hide_banner','-y','-i',str(build/'voice.wav'),'-i',str(build/'music.wav'),'-filter_complex',chain+f',loudnorm=I={target:.1f}:TP=-1.5:LRA=7:print_format=json[a]','-map','[a]','-t',str(timeline['duration']),'-f','null','-'],capture_output=True,text=True,check=True)
                    m=re.search(r'\{[^{]*"input_i".*?\}',probe.stderr,re.S)
                    if not m:raise ValueError('Loudness measurement failed')
                    d=json.loads(m.group())
                    measured=f":measured_I={d['input_i']}:measured_TP={d['input_tp']}:measured_LRA={d['input_lra']}:measured_thresh={d['input_thresh']}:offset={d['target_offset']}:linear=true"
                else:
                    measured=''
                stage('audio',[ffmpeg,'-nostdin','-v','error','-y','-i',str(build/'voice.wav'),'-i',str(build/'music.wav'),'-filter_complex',chain+f',loudnorm=I={target:.1f}:TP=-1.5:LRA=7'+measured+',aresample=48000[a]','-map','[a]','-ac','2','-t',str(timeline['duration']),'-c:a','pcm_s24le',str(build/'mix.wav')])
            stage('layout' if stills else 'render',['node',str(ROOT/'engine/render.mjs'),str(project),'--workers',str(workers)]+(['--stills'] if stills else []))
            if stills:
                state.update(status='layout_checked');atomic_json(out/'state.json',state);return
            stage('quality',[sys.executable,str(ROOT/'qa.py'),str(project)])
            preview_width=540 if c['format']=='9:16' else 960
            stage('preview',[ffmpeg,'-nostdin','-v','error','-y','-i',str(out/'master.mp4'),'-vf',f'scale={preview_width}:-2','-c:v','libx264','-preset','fast','-crf','23','-c:a','copy','-movflags','+faststart',str(out/'preview.mp4')])
            def stamp(seconds):
                ms=round(seconds*1000);return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'
            captions=[g for s in timeline['scenes'] for g in s['captions']]
            (out/'captions.srt').write_text('\n\n'.join(f"{i+1}\n{stamp(g['start'])} --> {stamp(g['end'])}\n{g['text']}" for i,g in enumerate(captions))+'\n')
            atomic_json(out/'youtube-package.json',{'title':c['title'],'description':c.get('description',''),'language':c['language'],'tags':c.get('tags',[]),'privacyStatus':'private','publication_status':'not_configured','channel_id':None,'synthetic_voice':True,'script':' '.join(s['voice'] for s in c['scenes']),'thumbnail':'qa/001-'+c['scenes'][0]['id']+'.png'})
            files=[project,build/'timeline.json',build/'voice.wav',build/'mix.wav',out/'master.mp4',out/'preview.mp4',out/'FINAL-QA.json',out/'render.json',out/'captions.srt',out/'youtube-package.json']
            files += [project.parent/s['image'] for s in c['scenes'] if s.get('image')]
            files += [project.parent/sh['image'] for s in c['scenes'] for sh in (s.get('shots') or []) if sh.get('image')]
            if c.get('script_file'):files.append(project.parent/c['script_file'])
            files+=sorted((out/'qa').glob('*.png'))
            manifest={str(p.relative_to(project.parent)):{'bytes':p.stat().st_size,'sha256':digest(p)} for p in files}
            atomic_json(out/'delivery.json',{'status':'ready_for_review','version':VERSION,'project':c['id'],'files':manifest,'publication':'not_configured'})
            state.update(status='complete',stage='delivered',finished_at=time.time());atomic_json(out/'state.json',state)
            print('DELIVERED',out/'master.mp4',flush=True)
        except BaseException as e:
            state.update(status='failed',error=str(e),finished_at=time.time());atomic_json(out/'state.json',state);raise

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('project');p.add_argument('--workers',type=int,default=2);p.add_argument('--stills',action='store_true');p.add_argument('--skip-voice',action='store_true');a=p.parse_args()
    produce(a.project,a.workers,a.stills,a.skip_voice)
