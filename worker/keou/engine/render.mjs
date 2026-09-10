import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,mkdirSync,existsSync,renameSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {resolve,dirname,extname,relative,sep} from 'node:path';
import {readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const engine=import.meta.dirname,root=resolve(engine,'..'),file=resolve(process.argv[2]);
const project=JSON.parse(readFileSync(file)),dir=dirname(file),out=resolve(dir,'out'),build=resolve(dir,'build');
const opts=process.argv.slice(3),value=(k,d)=>opts.includes(k)?opts[opts.indexOf(k)+1]:d;
const width=Number(value('--width',project.width)),fps=project.fps,workers=Number(value('--workers','2')),stills=opts.includes('--stills');
const ffmpeg=process.env.FFMPEG||'ffmpeg',ffprobe=process.env.FFPROBE||'ffprobe';
const timeline=JSON.parse(readFileSync(resolve(build,'timeline.json'))),height=width*(project.format==='9:16'?16/9:9/16),total=Math.round(timeline.duration*fps);
if(!Number.isInteger(width)||width%2||!Number.isInteger(height)||height%2||!Number.isInteger(workers)||workers<1||workers>16||total<=0)throw Error('Invalid render options');
if(timeline.scenes[0].start!==0||Math.abs(timeline.scenes.at(-1).end-timeline.duration)>.001)throw Error('Invalid timeline');
for(const [i,s] of timeline.scenes.entries())if(s.audio_start<s.start||s.audio_end>s.end||s.end<=s.start||(i&&Math.abs(s.start-timeline.scenes[i-1].end)>.001))throw Error('Invalid scene timing: '+s.id);
mkdirSync(resolve(out,'qa'),{recursive:true});
const hash=createHash('sha256');
for(const f of [file,resolve(build,'timeline.json'),resolve(engine,'film.js'),resolve(engine,'film.html'),resolve(engine,'render.mjs'),resolve(engine,'stickman.js'),resolve(engine,'cinema.js'),resolve(engine,'picture.js'),resolve(engine,'assets/font.ttf'),resolve(engine,'assets/mono.ttf'),resolve(engine,'assets/cartoon.ttf'),resolve(engine,'assets/real.ttf'),resolve(engine,'assets/world.json'),...readdirSync(resolve(engine,'modes')).filter(f=>f.endsWith('.js')).sort().map(f=>resolve(engine,'modes',f)),...project.scenes.filter(s=>s.image).map(s=>resolve(dir,s.image)),...project.scenes.flatMap(s=>(s.shots||[]).filter(x=>x.image).map(x=>resolve(dir,x.image)))].filter(existsSync))hash.update(readFileSync(f));
hash.update(`${width}:${height}:${fps}`);const fingerprint=hash.digest('hex');
const probe=p=>JSON.parse(execFileSync(ffprobe,['-v','error','-count_frames','-show_streams','-show_format','-of','json',p],{maxBuffer:2e6}));
const validPart=(p,count)=>{try{const v=probe(p).streams.find(s=>s.codec_type==='video');return Number(v.nb_read_frames)===count&&v.width===width&&v.height===height&&v.r_frame_rate===fps+'/1'}catch{return false}};
const types={'.html':'text/html','.js':'text/javascript','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.webp':'image/webp','.ttf':'font/ttf'};
const server=createServer((req,res)=>{try{const url=new URL(req.url,'http://localhost');const mount=url.pathname.startsWith('/project/')?dir:engine;let sub=url.pathname.startsWith('/project/')?url.pathname.slice(9):url.pathname.replace(/^\/engine\//,'');if(url.pathname==='/')sub='film.html';const p=resolve(mount,decodeURIComponent(sub));const rel=relative(mount,p);if(rel.startsWith('..'+sep)||rel==='..'||!rel){res.writeHead(403);res.end();return}res.setHeader('Content-Type',types[extname(p)]||'application/octet-stream');res.end(readFileSync(p))}catch{res.writeHead(404);res.end()}});
server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const children=new Set();let fatal;
async function pageAt(w){const page=await browser.newPage({viewport:{width:project.format==='9:16'?1080:1920,height:project.format==='9:16'?1920:1080}});page.on('pageerror',e=>fatal=e);await page.goto(base);await page.evaluate(({p,t,w})=>window.init(p,t,w),{p:project,t:timeline,w});return page}
async function frame(page,t){if(fatal)throw fatal;return page.evaluate(t=>{const issues=window.renderFrame(t);if(issues.length)throw Error(JSON.stringify(issues));return document.querySelector('canvas').toDataURL('image/png').split(',')[1]},t)}
try{
 const page=await pageAt(project.format==='9:16'?540:960);
 for(const [i,s] of timeline.scenes.entries()){
  // Validate the moving entrance, settled composition, caption changes and exit.
  const times=[s.start+.05,Math.min(s.start+.8,s.end-.1),(s.start+s.end)/2,s.end-.05,...s.captions.map(c=>(c.start+c.end)/2)];
  for(const t of times)await frame(page,t);
  writeFileSync(resolve(out,'qa',`${String(i+1).padStart(3,'0')}-${s.id}.png`),Buffer.from(await frame(page,(s.start+s.end)/2),'base64'));
 }await page.close();console.log('LAYOUT_PASS',timeline.scenes.length,'scenes');
 if(!stills){
  const paths=[];
  await Promise.all(Array.from({length:workers},async(_,id)=>{
   const first=Math.floor(total*id/workers),last=Math.floor(total*(id+1)/workers),part=resolve(build,`part-${width}-${fps}-${id}.mp4`),marker=part+'.json';paths[id]=part;
   if(existsSync(part)&&existsSync(marker)){const old=JSON.parse(readFileSync(marker));if(old.fingerprint===fingerprint&&old.first===first&&old.last===last&&validPart(part,last-first)){console.log('RESUME_VALIDATED',id);return}}
   const tmp=part+'.partial.mp4';const proc=spawn(ffmpeg,['-nostdin','-v','error','-y','-f','image2pipe','-vcodec','png','-framerate',String(fps),'-i','pipe:0','-an','-c:v','libx264','-preset','veryfast','-crf','17','-threads','4','-pix_fmt','yuv420p','-r',String(fps),'-frames:v',String(last-first),'-movflags','+faststart',tmp],{stdio:['pipe','ignore','pipe']});children.add(proc);let err='';proc.stderr.on('data',d=>err=(err+d).slice(-8000));proc.stdin.on('error',e=>fatal=e);proc.on('error',e=>fatal=e);const done=once(proc,'close');const page=await pageAt(width);
   try{for(let f=first;f<last;f++){const data=await frame(page,f/fps);if(proc.exitCode!==null)throw Error('Encoder exited: '+err);if(!proc.stdin.write(Buffer.from(data,'base64')))await once(proc.stdin,'drain');if(f%180===0)console.log('FRAME',id,f,'/',total)}proc.stdin.end();const [code]=await done;if(code!==0)throw Error('FFmpeg failed: '+err);if(!validPart(tmp,last-first))throw Error('Invalid encoded segment');renameSync(tmp,part);writeFileSync(marker,JSON.stringify({fingerprint,first,last}));console.log('SEGMENT_OK',id)}finally{await page.close();if(proc.exitCode===null)proc.kill('SIGTERM');children.delete(proc)}
  }));
  const concat=resolve(build,'concat.txt');writeFileSync(concat,paths.map(p=>`file '${p.replace(/'/g,"'\\''")}'`).join('\n')+'\n');
  const temp=resolve(out,'master.partial.mp4');execFileSync(ffmpeg,['-nostdin','-v','error','-y','-f','concat','-safe','0','-i',concat,'-i',resolve(build,'mix.wav'),'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','256k','-ar','48000','-ac','2','-t',String(timeline.duration),'-metadata','title='+project.title,'-movflags','+faststart',temp],{maxBuffer:2e6});
  if(!validPart(temp,total))throw Error('Invalid master');const q=probe(temp);if(!q.streams.some(s=>s.codec_type==='audio')||Math.abs(Number(q.format.duration)-timeline.duration)>1/fps+.015)throw Error('Invalid audio or duration');renameSync(temp,resolve(out,'master.mp4'));
  writeFileSync(resolve(out,'render.json'),JSON.stringify({status:'PASS',fingerprint,width,height,fps,frames:total,duration:timeline.duration,version:'1.0.0'},null,2));console.log('RENDER_COMPLETE',timeline.duration,'seconds');
 }
}finally{for(const p of children)p.kill('SIGTERM');await browser.close();server.close()}
