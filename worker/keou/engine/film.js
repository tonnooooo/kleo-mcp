/* Keou production 1.0 — data-driven compositions, derived from the Pasifika visual language. */
const canvas = document.getElementById('film'), ctx = canvas.getContext('2d', {alpha:false});
let project, timeline, W, H, portrait, C, fontFamily='Manrope', frameTime=0, issues=[], images={}, land;
const themes = {
  terminal:{ink:'#010503',deep:'#061109',white:'#c9ffd7',muted:'#74a680',accent:'#3cff81',second:'#18ab52'},
  stickman:{ink:'#0a0a0c',deep:'#0f1a14',white:'#e6edf3',muted:'#7a8590',accent:'#00ff88',second:'#00d4ff'},
  cinema:{ink:'#050607',deep:'#0a0f0d',white:'#eef2f5',muted:'#6b7681',accent:'#00ff88',second:'#2bb0ff'},
  picture:{ink:'#0b0b0f',deep:'#15151d',white:'#ffffff',muted:'#8b93a1',accent:'#ffd23f',second:'#39d5ff'},
  editorial:{ink:'#041624',deep:'#0a3549',white:'#eef5f2',muted:'#9ab6c4',accent:'#66e7e1',second:'#259ec5'},
  technical:{ink:'#080e13',deep:'#162b2b',white:'#f3f6f2',muted:'#a8b8b6',accent:'#63f2ae',second:'#56cfe3'},
  illustrated:{ink:'#101b19',deep:'#293b30',white:'#f6f2e5',muted:'#b1bbaa',accent:'#c5df88',second:'#7bc6c7'}
};
const clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x)), ease=x=>1-(1-clamp(x))**4;
function line(x,y,a,b,color=C.accent,width=2){ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(a,b);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke()}
function box(x,y,w,h,color=C.deep,stroke=C.accent+'35',r=28){if(project.style==='terminal')r=Math.min(r,3);ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fillStyle=color;ctx.fill();if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=1.5;ctx.stroke()}}
function raw(text,x,y,size=36,color=C.white,weight=500,align='left',max=900){
 ctx.font=`${weight} ${size}px ${fontFamily}`;ctx.textAlign=align;ctx.textBaseline='alphabetic';ctx.fillStyle=color;
 const m=ctx.measureText(text),left=align==='center'?x-m.width/2:align==='right'?x-m.width:x;
 if(m.width>max+1||left<48||left+m.width>W-48||y-size<30||y>H-65)issues.push({time:frameTime,text,width:m.width,max,x,y});
 ctx.fillText(text,x,y);
}
function wrap(value,size,max,weight=600){ctx.font=`${weight} ${size}px ${fontFamily}`;let lines=[''];for(const word of value.split(/\s+/)){let last=lines.at(-1),s=last?last+' '+word:word;if(ctx.measureText(s).width>max&&last)lines.push(word);else lines[lines.length-1]=s;}return lines}
function block(value,x,y,{size=80,min=48,max=850,lines=3,color=C.white,align='left',weight=650,u=3}={}){
 let parts;while(true){parts=wrap(value,size,max,weight);if(parts.length<=lines||size<=min)break;size-=2}
 if(parts.length>lines)issues.push({text:value,error:'Too many lines',time:frameTime});
 parts.forEach((p,i)=>{let a=ease((u-i*.075)/.55);ctx.save();ctx.globalAlpha*=a;raw(p,x,y+i*size*1.18+(1-a)*22,size,color,weight,align,max);ctx.restore()});return parts.length*size*1.18;
}
/* Kleo full-bleed picture (cinema/closing/story scenes with scene.image): cover-fit,
   a slow Ken Burns zoom from 1.0 to 1.08 across the scene, a soft pan whose direction
   is derived from the scene id, then a dark gradient + vignette so the beats, chapter
   label, headline and captions drawn afterwards keep their contrast. Deterministic:
   a pure function of (scene, u). Returns true when a picture was drawn. */
/* @kleo-pure backdropPlan — pure geometry, no canvas: test/engine-image-plan.test.mjs evaluates this block. */
const BACKDROP_ZOOM=.08;                                            // Ken Burns: 1.0 at the first frame, 1.08 at the last
function backdropSeed(id){return [...String(id||'')].reduce((a,ch)=>(a*31+ch.charCodeAt(0))>>>0,7)}
/* Cover-fit + Ken Burns plan for a picture of iw×ih on a W×H frame at scene progress p (0..1).
   The pan direction comes from the seed (a scene id hash) so every scene drifts differently but
   deterministically. The returned rect always covers the whole frame: the pan never exceeds
   60% of the overflow that the cover-fit and the zoom leave on each side. */
function backdropPlan(iw,ih,W,H,p,seed=7){
 p=Math.min(1,Math.max(0,Number(p)||0));const sp=p*p*(3-2*p);
 const dirX=seed%2?1:-1,dirY=(seed>>1)%2?1:-1;
 const zoom=1+BACKDROP_ZOOM*p,z=Math.max(W/iw,H/ih)*zoom,w=iw*z,h=ih*z;
 const ox=Math.max(0,(w-W)/2),oy=Math.max(0,(h-H)/2);
 const panX=dirX*Math.min(ox*.6,W*.04)*(2*sp-1),panY=dirY*Math.min(oy*.6,H*.03)*(2*sp-1);
 return {x:W/2+panX-w/2,y:H/2+panY-h/2,w,h,zoom,panX,panY};
}
/* @end backdropPlan */
/* Kleo full-bleed picture (cinema/closing/story scenes with scene.image): cover-fit, a slow
   Ken Burns zoom across the scene, a soft pan, then a flat dim + top/bottom gradients + vignette
   so the beats, chapter label, headline and captions drawn afterwards keep their contrast.
   A hard cut by default (fade=0), like every other cinema transition. Returns true when a
   picture was drawn so the caller can switch to its "over a photo" text treatment. */
function backdrop(s,u,{top=.55,bottom=.72,dim=.3,fade=0}={}){
 const img=s.image&&images[s.image];if(!img||!img.width||!img.height)return false;
 const dur=Math.max(s.end-s.start,.1),r=backdropPlan(img.width,img.height,W,H,u/dur,backdropSeed(s.id));
 ctx.save();if(fade>0)ctx.globalAlpha*=ease(u/fade);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
 ctx.drawImage(img,r.x,r.y,r.w,r.h);
 ctx.fillStyle=`rgba(0,0,0,${dim})`;ctx.fillRect(0,0,W,H);
 const gt=ctx.createLinearGradient(0,0,0,H*.3);gt.addColorStop(0,`rgba(0,0,0,${top})`);gt.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=gt;ctx.fillRect(0,0,W,H*.3);
 const gb=ctx.createLinearGradient(0,H*.55,0,H);gb.addColorStop(0,'rgba(0,0,0,0)');gb.addColorStop(1,`rgba(0,0,0,${bottom})`);ctx.fillStyle=gb;ctx.fillRect(0,H*.55,W,H*.45);
 const v=ctx.createRadialGradient(W/2,H/2,Math.min(W,H)*.4,W/2,H/2,Math.max(W,H)*.72);v.addColorStop(0,'rgba(0,0,0,0)');v.addColorStop(1,'rgba(0,0,0,.6)');ctx.fillStyle=v;ctx.fillRect(0,0,W,H);
 ctx.restore();return true;
}
function stickApi(){return {ctx,W,H,project,timeline,issues,frameTime,images,backdrop,backdropPlan,raw:(s,x,y,size,color,weight,align,max,family)=>{const f=fontFamily;if(family)fontFamily=family;raw(s,x,y,size,color,weight,align,max);fontFamily=f},block,wrap,box,line,ease,clamp,mono:(s,x,y,size,color,align)=>{ctx.font=`500 ${size}px KeouMono`;ctx.textAlign=align;ctx.textBaseline='alphabetic';ctx.fillStyle=color;const w=ctx.measureText(s).width,left=align==='left'?x:align==='right'?x-w:x-w/2;if(left<48||left+w>W-48||y-size<30||y>H-65)issues.push({time:frameTime,text:s,error:'Story text bounds'});ctx.fillText(s,x,y)},label:(s,x,y,size,color,align)=>{ctx.font=`600 ${size}px Manrope`;ctx.textAlign=align;ctx.textBaseline='alphabetic';ctx.fillStyle=color;ctx.fillText(s,x,y)}}}
function background(t){
 if(project.style==='cinema'||project.style==='picture'){const M=project.style==='picture'?window.KEOU_PICTURE:window.KEOU_CINEMA;M.attach(stickApi());M.background(t);return}
 if(project.style==='stickman'){window.KEOU_STICKMAN.attach(stickApi());window.KEOU_STICKMAN.background(t);return}
 if(project.style==='terminal'){
  ctx.fillStyle=C.ink;ctx.fillRect(0,0,W,H);
  // Quiet phosphor texture; content stays stable and legible.
  for(let yy=0;yy<H;yy+=6){ctx.fillStyle='#3cff8104';ctx.fillRect(0,yy,W,1)}
  const left=portrait?70:60,top=portrait?105:70,right=W-left,bottom=portrait?1580:880;
  box(left,top,right-left,bottom-top,'#010503',C.accent+'45',3);
  line(left,top+100,right,top+100,C.accent+'45',1.5);
  for(let j=0;j<3;j++)box(right-120+j*27,top+42,9,9,j===0?C.accent:C.accent+'44',null,1);
  for(let j=0;j<8;j++){const xx=left+22+j*13;ctx.fillStyle=C.accent+(j<=Math.floor(t*2)%8?'70':'15');ctx.fillRect(xx,bottom-22,7,5)}
  return;
 }

 ctx.fillStyle=C.ink;ctx.fillRect(0,0,W,H);const g=ctx.createRadialGradient(W*.72,H*.55,30,W*.45,H*.52,H*.75);g.addColorStop(0,C.deep);g.addColorStop(1,C.ink);ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
 ctx.save();ctx.globalAlpha=.12;for(let j=0;j<12;j++){ctx.beginPath();for(let i=0;i<=40;i++){const x=i*W/38-30,y=H*.65+j*H*.019+Math.sin(x/390+t*.16+j*.18)*65;i?ctx.lineTo(x,y):ctx.moveTo(x,y)}ctx.strokeStyle=C.second;ctx.lineWidth=1;ctx.stroke()}ctx.restore();
 if(project.style==='technical'){ctx.strokeStyle=C.accent+'09';for(let x=70;x<W;x+=90)line(x,250,x,H-230,C.accent+'09',1);}
}
function mark(x,y,r,t){ctx.save();ctx.translate(x,y);ctx.rotate(t*.04);for(let i=0;i<3;i++){ctx.beginPath();ctx.arc(0,0,r-i*7,.3+i*1.9,1.7+i*1.9);ctx.strokeStyle=C.accent;ctx.lineWidth=2;ctx.stroke()}ctx.restore()}
function globe(x,y,r,t){ctx.save();ctx.translate(x,y);ctx.beginPath();ctx.arc(0,0,r,0,2*Math.PI);ctx.fillStyle=C.deep;ctx.fill();ctx.strokeStyle=C.accent+'88';ctx.lineWidth=2;ctx.stroke();ctx.clip();
 const rotation=(170+t*.8)*Math.PI/180,projectPoint=([lon,lat])=>{const a=lon*Math.PI/180-rotation,b=lat*Math.PI/180;return[r*Math.cos(b)*Math.sin(a),-r*Math.sin(b),Math.cos(b)*Math.cos(a)]};
 function path(coords,fill=false){ctx.beginPath();let active=false;for(const v of coords){const [px,py,z]=projectPoint(v);if(z>0){active?ctx.lineTo(px,py):ctx.moveTo(px,py);active=true}else active=false}if(fill){ctx.closePath();ctx.fill()}else ctx.stroke()}
 ctx.strokeStyle=C.accent+'24';for(let a=-60;a<=60;a+=30)path(Array.from({length:181},(_,i)=>[-180+i*2,a]));for(let a=-180;a<180;a+=30)path(Array.from({length:91},(_,i)=>[a,-90+i*2]));
 ctx.fillStyle=C.second+'77';ctx.strokeStyle=C.accent+'77';for(const f of land.features){const polys=f.geometry.type==='Polygon'?[f.geometry.coordinates]:f.geometry.coordinates;for(const p of polys){path(p[0],true);path(p[0])}}ctx.restore();
}
function symbol(kind,x,y,r,t,u){ctx.save();ctx.translate(x,y+Math.sin(t*.8)*5);const a=ease(u/.7);ctx.scale(.88+.12*a,.88+.12*a);ctx.globalAlpha*=a;
 const ring=(rr,start=0,end=2*Math.PI,col=C.accent+'44')=>{ctx.beginPath();ctx.arc(0,0,rr,start,end);ctx.strokeStyle=col;ctx.lineWidth=2.5;ctx.stroke()};
 if(kind==='globe'){globe(0,0,r,t);ctx.restore();return}
 ring(r,0,2*Math.PI,C.accent+'20');ring(r*.8,t*.09,t*.09+Math.PI*1.45,C.accent+'70');
 if(kind==='network'||kind==='cycle'){
  const n=kind==='cycle'?5:6,points=Array.from({length:n},(_,i)=>[(r*.62)*Math.cos(i*2*Math.PI/n-Math.PI/2),(r*.62)*Math.sin(i*2*Math.PI/n-Math.PI/2)]);
  points.forEach(([px,py],i)=>{const [qx,qy]=kind==='cycle'?points[(i+1)%n]:[0,0];line(px,py,qx,qy,C.accent+'66',3);const p=(t*.25+i*.17)%1;ctx.beginPath();ctx.arc(px+(qx-px)*p,py+(qy-py)*p,4,0,7);ctx.fillStyle=C.accent;ctx.fill();box(px-24,py-24,48,48,C.deep,C.accent,13)});if(kind==='network')box(-42,-42,84,84,C.deep,C.accent,20);
 }else if(kind==='check'){ctx.beginPath();ctx.moveTo(-r*.44,0);ctx.lineTo(-r*.1,r*.32);ctx.lineTo(r*.48,-r*.34);ctx.strokeStyle=C.accent;ctx.lineWidth=12;ctx.lineCap='round';ctx.lineJoin='round';ctx.setLineDash([r*2]);ctx.lineDashOffset=(1-ease((u-.05)/.95))*r*2;ctx.stroke()}
 else if(kind==='growth'){for(let i=0;i<3;i++){const h=(i+1)*r*.36*ease((u-i*.1)/.8);box(-r*.6+i*r*.42,r*.5-h,r*.28,h,C.accent+(i===2?'ee':'55'),null,8)}line(-r*.68,r*.6,r*.7,r*.6,C.accent+'88',2)}
 else if(kind==='spark'){for(let i=0;i<8;i++){const v=i*Math.PI/4+t*.05;line(Math.cos(v)*r*.29,Math.sin(v)*r*.29,Math.cos(v)*r*.57,Math.sin(v)*r*.57,C.accent,6)}ring(r*.16,0,7,C.accent)}
 else {ring(r*.53,0,7,C.accent+'88');ring(r*.22,0,7,C.accent);ctx.beginPath();ctx.arc(0,0,10+Math.sin(t)*2,0,7);ctx.fillStyle=C.accent;ctx.fill();for(let i=0;i<4;i++){const q=i*Math.PI/2;line(Math.cos(q)*r*.67,Math.sin(q)*r*.67,Math.cos(q)*r*.9,Math.sin(q)*r*.9,C.accent,3)}}ctx.restore();
}
// Deterministic scene-local motion: the same timestamp always gives the same frame.
function metricText(s,u){
 if(!s.animate_value)return s.value;
 const match=s.value.match(/^(\d+(?:,\d{3})*(?:\.\d+)?)([^\d]*)$/);
 if(!match)return s.value;
 const progress=clamp((u-.15)/1.45);if(progress===1)return s.value;
 const target=Number(match[1].replaceAll(',','')),decimals=match[1].includes('.')?match[1].split('.')[1].length:(target<10?1:0);
 const value=target*(1-(1-progress)**3);
 return value.toLocaleString('en-US',{minimumFractionDigits:decimals,maximumFractionDigits:decimals})+match[2];
}
function metricSize(s,w){
 if(!s.animate_value)return 190;
 const match=s.value.match(/^(\d+(?:,\d{3})*(?:\.\d+)?)([^\d]*)$/);if(!match)return 190;
 const n=Number(match[1].replaceAll(',','')),d=match[1].includes('.')?match[1].split('.')[1].length:(n<10?1:0);
 const reference=n.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d})+match[2];
 ctx.font=`650 190px ${fontFamily}`;return Math.max(100,Math.min(190,Math.floor(190*(w-50)/Math.max(ctx.measureText(reference).width,ctx.measureText(s.value).width))));
}
function orbitPoint(cx,r,index,u){const angle=Math.PI/2+index*1.9+u*1.1*(155/r)**1.5;return {x:cx+r*Math.cos(angle),y:285+r*Math.sin(angle),angle}}

/* --- THE AI THAT ESCAPED - bounded motion extension (revision 1.2+escape.1) ---
   Modules in engine/modes/*.js register themselves on window.KEOU_MODES and are
   called with this API. They draw inside an 880x620 diagram space that film.js
   has already translated, scaled and clipped. Display only: nothing is executed,
   no network is touched, every string comes from the project JSON. */
const PALETTE={green:'#00ff88',cyan:'#00d4ff',red:'#ff3b3b',amber:'#ffb020',dim:'#3a4048',pale:'#c9ffd7'};
function escapeApi(dot,label,glow,u,absTime,labels,scene){
 const DW=880,DH=620;
 const mono=(value,x,y,size=24,color=C.accent,align='center',max=840)=>{
  let s=size;ctx.font=`400 ${s}px KeouMono`;
  while(ctx.measureText(value).width>max&&s>11){s--;ctx.font=`400 ${s}px KeouMono`}
  ctx.textAlign=align;ctx.textBaseline='alphabetic';ctx.fillStyle=color;
  const width=ctx.measureText(value).width,left=align==='left'?x:align==='right'?x-width:x-width/2;
  if(left<8||left+width>DW-8||y-s<8||y>DH-6)issues.push({time:frameTime,text:value,error:'Motion text bounds'});
  ctx.fillText(value,x,y);return width;
 };
 const hex=(x,y,r,color=C.accent,lw=3,fill=0,rot=0)=>{
  ctx.beginPath();for(let i=0;i<6;i++){const a=rot+i*Math.PI/3,px=x+r*Math.cos(a),py=y+r*Math.sin(a);i?ctx.lineTo(px,py):ctx.moveTo(px,py)}ctx.closePath();
  if(fill>0){ctx.globalAlpha*=fill;ctx.fillStyle=color;ctx.fill();ctx.globalAlpha/=fill}
  ctx.strokeStyle=color;ctx.lineWidth=lw;ctx.stroke();
 };
 const agent=(x,y,r,color=C.accent,pulse=0,lw=3)=>{
  const p=pulse?.5+.5*Math.sin(absTime*2.2+pulse):0;
  glow(x,y,r*2.1,color);hex(x,y,r,color,lw);hex(x,y,r*.44,color,1,.55+.45*p);
 };
 const rnd=(...seed)=>{let x=2166136261;for(const v of seed){x^=Math.round(v*7919);x=Math.imul(x,16777619)}return((x>>>8)&0xffff)/0xffff};
 const drawPath=(pts,frac,color=C.accent,lw=2.5)=>{
  frac=clamp(frac);if(frac<=0||pts.length<2)return;
  const seg=[];let total=0;
  for(let i=0;i<pts.length-1;i++){const d=Math.hypot(pts[i+1][0]-pts[i][0],pts[i+1][1]-pts[i][1]);seg.push(d);total+=d}
  let want=total*frac,acc=0;ctx.beginPath();ctx.moveTo(pts[0][0],pts[0][1]);
  for(let i=0;i<seg.length;i++){
   if(acc+seg[i]<=want){ctx.lineTo(pts[i+1][0],pts[i+1][1]);acc+=seg[i]}
   else{const k=seg[i]?(want-acc)/seg[i]:0;ctx.lineTo(pts[i][0]+(pts[i+1][0]-pts[i][0])*k,pts[i][1]+(pts[i+1][1]-pts[i][1])*k);break}
  }
  ctx.strokeStyle=color;ctx.lineWidth=lw;ctx.lineCap='round';ctx.lineJoin='round';ctx.stroke();ctx.lineCap='butt';
 };
 const packets=(pts,color=C.accent,n=4,speed=.5,r=5,phase=0)=>{
  if(pts.length<2)return;const seg=[];let total=0;
  for(let i=0;i<pts.length-1;i++){const d=Math.hypot(pts[i+1][0]-pts[i][0],pts[i+1][1]-pts[i][1]);seg.push(d);total+=d}
  for(let k=0;k<n;k++){
   const f=((absTime*speed+k/n+phase)%1)*total;let acc=0;
   for(let i=0;i<seg.length;i++){
    if(acc+seg[i]>=f){const q=seg[i]?(f-acc)/seg[i]:0;dot(pts[i][0]+(pts[i+1][0]-pts[i][0])*q,pts[i][1]+(pts[i+1][1]-pts[i][1])*q,r,color);break}
    acc+=seg[i];
   }
  }
 };
 const counter=(value,x,y,size=86,color=C.accent,delay=.15,span=1.45,align='center')=>{
  const p=clamp((u-delay)/span),v=value*(1-(1-p)**3);
  return mono(Math.round(v).toLocaleString('en-US'),x,y,size,color,align,820);
 };
 const strike=(x0,y0,x1,y1,frac=1,color=PALETTE.red,lw=5)=>drawPath([[x0,y0],[x1,y1]],frac,color,lw);
 const typed=(value,cps=38,delay=.2)=>value.slice(0,Math.max(0,Math.floor((u-delay)*cps)));
 const cursorOn=()=>Math.floor(u*2)%2===0;
 return {ctx,W:DW,H:DH,C,P:PALETTE,u,t:absTime,
  labels:labels||null,text:scene.motion_text||null,date:scene.motion_date||null,
  count:typeof scene.motion_count==='number'?scene.motion_count:null,
  total:typeof scene.motion_total==='number'?scene.motion_total:null,
  stage:typeof scene.motion_stage==='number'?scene.motion_stage:0,
  scene,ease,clamp,dot,label,glow,mono,hex,agent,rnd,drawPath,packets,counter,strike,typed,cursorOn,
  line,box,issues};
}
function movingDiagram(kind,x,y,w,h,u,customLabels,scene,absTime){
 ctx.save();ctx.beginPath();ctx.roundRect(x,y,w,h,project.style==='terminal'?3:25);ctx.clip();ctx.fillStyle=C.deep;ctx.fillRect(x,y,w,h);
 const scale=Math.min(w/880,h/620);ctx.translate(x+(w-880*scale)/2,y+(h-620*scale)/2);ctx.scale(scale,scale);ctx.globalAlpha*=ease(u/.6);
 const dot=(px,py,r,color)=>{ctx.beginPath();ctx.arc(px,py,r,0,Math.PI*2);ctx.fillStyle=color;ctx.fill()};
 const label=(text,px,py,size=24,color=C.white,align='center')=>{ctx.font=`600 ${size}px ${fontFamily}`;ctx.textAlign=align;ctx.textBaseline='alphabetic';ctx.fillStyle=color;const width=ctx.measureText(text).width,left=align==='left'?px:px-width/2;if(left<12||left+width>868||py-size<10||py>607)issues.push({time:frameTime,text,error:'Animated diagram label bounds'});ctx.fillText(text,px,py)};
 const glow=(px,py,r,color)=>{const g=ctx.createRadialGradient(px,py,0,px,py,r);g.addColorStop(0,color+'77');g.addColorStop(1,color+'00');ctx.fillStyle=g;ctx.fillRect(px-r,py-r,r*2,r*2)};
 if(window.KEOU_MODES&&window.KEOU_MODES[kind]){
  const api=escapeApi(dot,label,glow,u,absTime||0,customLabels,scene||{});
  try{window.KEOU_MODES[kind](api)}catch(e){issues.push({time:frameTime,error:'Motion mode failed: '+kind+' :: '+e.message})}
  ctx.restore();return;
 }
 if(['voice-signal','ai-network','data-flow'].includes(kind)){
  const defaults={'voice-signal':['VOICE SIGNAL','AI CAN IMITATE','VOICE ≠ IDENTITY'],'ai-network':['INPUT','MODEL','OUTPUT'],'data-flow':['INCOMING','VERIFY','DECISION']};
  const labels=customLabels||defaults[kind],amber=project.style==='terminal'?'#80c991':'#ffc778';
  const tag=(value,px,py,max=225)=>{let size=25;ctx.font=`600 ${size}px ${fontFamily}`;while(ctx.measureText(value).width>max&&size>17){size--;ctx.font=`600 ${size}px ${fontFamily}`}label(value,px,py,size)};
  if(kind==='voice-signal'){
   for(let row=0;row<2;row++){
    const top=row?332:110,cy=top+72,color=row?amber:C.accent;
    label(labels[row],80,top-24,24,color,'left');box(60,top,760,145,C.ink+'88',color+'33',18);
    line(85,cy,795,cy,color+'25',1);
    for(let i=0;i<54;i++){
     const px=90+i*13.1,v=u*2.5-row*.2,amp=8+46*(.28+.72*Math.sin(i*.13-v)**2)*Math.abs(Math.sin(i*.8-v*1.8));
     box(px,cy-amp,5,amp*2,color,null,2.5);
    }
    const scan=85+(u*.19%1)*705;line(scan,top+10,scan,top+135,color+'66',1);
   }
   tag(labels[2],440,545,735);label((scene&&scene.motion_text)||'ILLUSTRATIVE SIGNAL · NOT AN IDENTITY DETECTOR',440,597,17,C.muted);
  }else if(kind==='ai-network'){
   const layers=[3,4,3].map((n,col)=>Array.from({length:n},(_,i)=>({x:150+col*290,y:170+i*260/(n-1)})));
   for(let col=0;col<2;col++)for(let i=0;i<layers[col].length;i++)for(let j=0;j<layers[col+1].length;j++){
    const a=layers[col][i],b=layers[col+1][j];line(a.x,a.y,b.x,b.y,C.accent+'24',1.5);
    const f=(u*.38+col*.21+i*.11+j*.17)%1;dot(a.x+(b.x-a.x)*f,a.y+(b.y-a.y)*f,4,col?C.second:C.accent);
   }
   for(let col=0;col<3;col++)for(let i=0;i<layers[col].length;i++){
    const a=layers[col][i],pulse=.5+.5*Math.sin(u*2.4-col*.8-i*.5);glow(a.x,a.y,30+pulse*10,C.accent);dot(a.x,a.y,17,C.ink);ctx.beginPath();ctx.arc(a.x,a.y,18,0,Math.PI*2);ctx.strokeStyle=C.accent;ctx.lineWidth=2;ctx.stroke();dot(a.x,a.y,4+pulse*4,C.accent);
   }
   for(let i=0;i<3;i++)tag(labels[i],150+i*290,510);
   label('SIMPLIFIED AI CONCEPT · SIGNALS IN MOTION',440,596,18,C.muted);
  }else{
   const centers=[160,440,720];
   for(let j=0;j<2;j++){
    const a=centers[j]+76,b=centers[j+1]-76;line(a,280,b,280,C.accent+'55',3);
    for(let i=0;i<3;i++){const f=(u*.48+i/3)%1;dot(a+(b-a)*f,280,6,j?C.accent:amber);}
   }
   centers.forEach((cx,j)=>{glow(cx,280,100,C.accent);dot(cx,280,73,C.ink);ctx.beginPath();ctx.arc(cx,280,74,-Math.PI/2,-Math.PI/2+2*Math.PI*ease((u-j*.12)/.85));ctx.strokeStyle=j===0?amber:C.accent;ctx.lineWidth=2;ctx.stroke();tag(labels[j],cx,430)});
   box(124,254,72,51,C.deep,amber,7);line(124,254,160,278,amber,2);line(160,278,196,254,amber,2);
   ctx.beginPath();ctx.moveTo(440,237);ctx.lineTo(474,251);ctx.lineTo(469,285);ctx.quadraticCurveTo(463,310,440,326);ctx.quadraticCurveTo(417,310,411,285);ctx.lineTo(406,251);ctx.closePath();ctx.strokeStyle=C.accent;ctx.lineWidth=3;ctx.stroke();
   ctx.beginPath();ctx.arc(440,280,57,u*.8,u*.8+Math.PI*1.4);ctx.strokeStyle=C.second;ctx.lineWidth=2;ctx.stroke();
   ctx.beginPath();ctx.moveTo(694,280);ctx.lineTo(714,300);ctx.lineTo(752,254);ctx.strokeStyle=C.accent;ctx.lineWidth=6;ctx.lineCap='round';ctx.stroke();
   label((scene&&scene.motion_text)||'PAUSE BETWEEN THE REQUEST AND THE ACTION',440,532,23,C.accent);label('ILLUSTRATIVE PROCESS · NOT LIVE SECURITY DATA',440,593,17,C.muted);
  }
 }else
 if(kind==='orbit-compare'){
  for(const [cx,bh] of [[215,false],[665,true]]){
   label(bh?'BLACK HOLE':'OUR SUN',cx,65,28);
   for(const [index,r] of [75,112,155].entries()){
    ctx.beginPath();ctx.arc(cx,285,r,0,Math.PI*2);ctx.strokeStyle=index===2?C.accent+'77':C.accent+'25';ctx.lineWidth=index===2?2.5:1.5;ctx.stroke();
    const p=orbitPoint(cx,r,index,u),color=index===2?C.accent:index===1?'#edc78f':'#aebac4';
    ctx.beginPath();ctx.arc(cx,285,r,p.angle-.75,p.angle);ctx.strokeStyle=color+'77';ctx.lineWidth=index===2?4:2;ctx.stroke();
    glow(p.x,p.y,index===2?23:12,color);dot(p.x,p.y,index===2?11:index===1?7:5,color);
    if(index===2){dot(p.x-3,p.y-3,2.5,C.white);}
   }
   if(bh){glow(cx,285,59,C.accent);dot(cx,285,24,C.ink);ctx.beginPath();ctx.arc(cx,285,27,u*.8,u*.8+Math.PI*1.7);ctx.strokeStyle=C.accent;ctx.lineWidth=3;ctx.stroke()}
   else {glow(cx,285,80+Math.sin(u*2)*5,'#ffd28c');for(let i=0;i<12;i++){const a=i*Math.PI/6+u*.12;line(cx+Math.cos(a)*45,285+Math.sin(a)*45,cx+Math.cos(a)*53,285+Math.sin(a)*53,'#ffd28c66',2)}const g=ctx.createRadialGradient(cx-8,275,3,cx,285,36);g.addColorStop(0,'#fff5cc');g.addColorStop(1,'#ffd28c');dot(cx,285,35,g)}
   dot(cx-98,490,6,C.accent);label('EARTH’S ORBIT',cx+12,498,23,C.white);
  }
  line(413,285,467,285,C.white,3);line(457,275,467,285,C.white,3);line(457,295,467,285,C.white,3);
  label('SAME MASS → SAME ORBITS',440,552,28,C.accent);
  label('SCHEMATIC · NOT TO SCALE · TIME COMPRESSED',440,598,18,C.muted);
 }else{
  glow(405,290,270,C.accent);
  // Four stylized arms; angular motion is illustrative, not a measured galaxy simulation.
  for(let arm=0;arm<4;arm++)for(let j=0;j<150;j++){
   const r=27+j*1.8,a=j*.026+arm*Math.PI/2+u*.15,noise=Math.sin(j*73.31+arm*17.3),px=405+Math.cos(a)*r+noise*9,py=290+Math.sin(a)*r*.68+Math.cos(j*23.1)*7;
   ctx.globalAlpha=ease(u/.6)*(.32+.44*(.5+.5*Math.sin(j*1.8+u*.8)));
   dot(px,py,1.1+(j%5)*.25,C.white);
  }
  ctx.globalAlpha=ease(u/.6);glow(405,290,72,C.accent);dot(405,290,25,C.ink);
  ctx.save();ctx.translate(405,290);ctx.scale(1,.68);ctx.beginPath();ctx.arc(0,0,38,u*.5,u*.5+Math.PI*1.75);ctx.strokeStyle=C.accent;ctx.lineWidth=3;ctx.stroke();ctx.restore();
  line(405,260,405,126,C.accent,2);line(170,126,405,126,C.accent,2);label('CENTRAL BLACK HOLE',170,106,24,C.white,'left');
  const a=.38+u*.15,px=405+230*Math.cos(a),py=290+230*Math.sin(a)*.68;
  glow(px,py,26,'#fff1c6');dot(px,py,8,'#fff1c6');line(px,py,726,462,'#fff1c6',2);line(726,462,794,462,'#fff1c6',2);label('WE ARE HERE',707,499,24);
  label('MILKY WAY · SCHEMATIC · TIME COMPRESSED',440,592,19,C.muted);
 }
 ctx.restore();
}

function terminalCode(s,u){
 const x=100,y=portrait?660:565,w=portrait?880:790,h=portrait?158:178;
 const code=s.terminal_lines||[`// ${s.kind} :: explainer`, 'await verify(context);', 'return next_step;'];
 box(x,y,w,h,C.deep,C.accent+'26',3);
 let size=portrait?25:26;ctx.font=`400 ${size}px ${fontFamily}`;while(Math.max(...code.map(v=>ctx.measureText(v).width))>w-120&&size>18){size--;ctx.font=`400 ${size}px ${fontFamily}`}
 const lineH=42,startY=y+42,budget=Math.floor(Math.max(0,u-.35)*38);
 let used=0,cursor=null;
 code.forEach((value,i)=>{
  const shown=value.slice(0,Math.max(0,budget-used));
  raw(String(i+1).padStart(2,'0'),x+20,startY+i*lineH,20,C.muted,400,'left',40);
  if(shown)raw(shown,x+75,startY+i*lineH,size,shown.startsWith('//')?C.muted:C.accent,400,'left',w-105);
  if(budget>=used&&budget<=used+value.length)cursor={x:x+75+ctx.measureText(shown).width,y:startY+i*lineH};
  used+=value.length+6;
 });
 if(budget>used-6){ctx.font=`400 ${size}px ${fontFamily}`;cursor={x:x+75+ctx.measureText(code.at(-1)).width,y:startY+(code.length-1)*lineH};}
 if(cursor&&Math.floor(u*2)%2===0){ctx.fillStyle=C.accent;ctx.fillRect(cursor.x+4,cursor.y-size+5,12,size);}
}
function header(i,t){
 if(project.style==='cinema'||project.style==='picture')return;   // neither style draws a header
 if(project.style==='stickman'){window.KEOU_STICKMAN.header(i,t);return}
 if(project.style==='terminal'){
  raw('>_',100,portrait?176:139,36,C.accent,650,'left',70);
  raw(project.brand,170,portrait?172:135,25,C.accent,400,'left',portrait?630:1250);
  raw(`${String(i+1).padStart(2,'0')}/${String(timeline.scenes.length).padStart(2,'0')}`,W-105,portrait?244:206,22,C.muted,400,'right',150);
  return;
 }
 mark(105,portrait?153:100,25,t);raw(project.brand,150,portrait?165:112,29,C.white,650,'left',660);raw(`${String(i+1).padStart(2,'0')} / ${String(timeline.scenes.length).padStart(2,'0')}`,W-100,portrait?162:108,23,C.muted,500,'right',200);line(100,portrait?215:152,W-100,portrait?215:152,C.accent+'24',1)
}
function scene(s,u,t){
 if(project.style==='cinema'||project.style==='picture'){(project.style==='picture'?window.KEOU_PICTURE:window.KEOU_CINEMA).scene(s,u,t,timeline.scenes.indexOf(s));return}
 if(project.style==='stickman'){if(s.kind==='closing')window.KEOU_STICKMAN.closing(s,u,t);else window.KEOU_STICKMAN.scene(s,u,t);return}
 const terminal=project.style==='terminal';
 const titleX=100,titleY=portrait?405:340,body={x:portrait?100:1030,y:portrait?(terminal?865:790):255,w:portrait?880:790,h:portrait?(terminal?570:620):560};
 if(terminal)terminalCode(s,u);
 if(s.eyebrow)raw(s.eyebrow.toUpperCase(),100,portrait?305:235,23,C.accent,700,'left',portrait?880:820);
 block(s.title,titleX,titleY,{size:terminal?(portrait?80:72):(portrait?94:82),max:portrait?875:820,min:50,lines:3,color:terminal?C.accent:C.white,u});
 const x=body.x,y=body.y,w=body.w,h=body.h,cx=x+w/2,cy=y+h/2;
 if(s.kind==='hero'||s.kind==='closing')symbol(s.kind==='closing'?'check':s.visual||'focus',cx,cy,Math.min(w,h)*.42,t,u-.12);
 if(s.kind==='list'||s.kind==='steps')s.items.forEach((item,j)=>{const a=ease((u-.2-j*.16)/.6),yy=y+j*(h/3);ctx.save();ctx.globalAlpha=a;ctx.translate(0,(1-a)*24);box(x,yy,w,h/3-28,C.deep+'bb');raw(String(j+1).padStart(2,'0'),x+35,yy+74,27,C.accent,650,'left',60);block(item,x+108,yy+76,{size:47,min:36,max:w-145,lines:2,u:3});if(s.kind==='steps'&&j<2){line(cx,yy+h/3-23,cx,yy+h/3-4,C.accent,2)}ctx.restore()});
 if(s.kind==='compare')s.items.forEach((item,j)=>{const yy=y+j*h/2,a=ease((u-j*.2)/.6);ctx.save();ctx.globalAlpha=a;box(x,yy,w,h/2-35,j?C.accent+'18':C.deep+'bb',j?C.accent+'aa':C.muted+'44');raw(j?'02':'01',x+35,yy+65,24,j?C.accent:C.muted,650,'left',100);block(item,x+35,yy+140,{size:68,min:42,max:w-70,lines:2,u:3,color:j?C.accent:C.white});ctx.restore()});
 if(s.kind==='metric'){ctx.save();ctx.globalAlpha=.32;ctx.beginPath();ctx.arc(cx,cy,Math.min(w,h)*.43,t*.06,t*.06+Math.PI*1.65);ctx.strokeStyle=C.accent;ctx.lineWidth=2;ctx.stroke();ctx.restore();block(metricText(s,u),cx,cy+35,{size:metricSize(s,w),min:100,max:w-50,align:'center',lines:1,color:C.accent,u});block(s.unit,cx,cy+125,{size:39,min:30,max:w-50,align:'center',lines:2,u:u-.15});}
 if(s.kind==='quote'){line(x+10,y+20,x+10,y+h-30,C.accent,5);block(s.quote,x+50,y+100,{size:68,min:46,max:w-85,lines:5,u:u-.1});if(s.source)block(s.source,x+50,y+h-20,{size:25,min:23,max:w-85,lines:1,color:C.muted,u:3})}
 if(s.kind==='image'&&s.motion)movingDiagram(s.motion,x,y,w,h,u,s.motion_labels,s,t);
 if(s.kind==='image'&&!s.motion){const img=images[s.image],a=ease(u/.7);ctx.save();ctx.beginPath();ctx.roundRect(x,y,w,h,project.style==='terminal'?3:25);ctx.clip();ctx.fillStyle=C.deep;ctx.fillRect(x,y,w,h);const z=Math.min(w/img.width,h/img.height)*(1+.025*clamp(u/8));ctx.globalAlpha=.45+.55*a;ctx.drawImage(img,cx-img.width*z/2,cy-img.height*z/2+(1-a)*18,img.width*z,img.height*z);ctx.restore()}
 if(s.detail)block(s.detail,portrait?100:100,portrait?1490:770,{size:30,min:26,max:portrait?880:790,lines:2,color:C.muted,u:u-.2});
 if(s.kind==='closing'&&s.button){const by=portrait?(terminal?1470:1420):800,bw=portrait?880:790;box(100,by,bw,82,C.accent,null,41);block(s.button,100+bw/2,by+54,{size:32,min:26,max:bw-70,lines:1,color:C.ink,align:'center',u:u-.2})}
}
function subtitle(s,t){if(project.style==='cinema'||project.style==='picture'){(project.style==='picture'?window.KEOU_PICTURE:window.KEOU_CINEMA).subtitle(s,t);return}if(project.style==='stickman'){window.KEOU_STICKMAN.subtitle(s,t);return}const group=(s.captions||[]).find(c=>t>=c.start&&t<c.end);if(!group)return;const size=portrait?38:34,max=portrait?810:1490,lines=wrap(group.text,size,max,550);if(lines.length>2)issues.push({time:t,error:'Caption exceeds two lines',text:group.text});const hh=lines.length*size*1.3+32,yy=portrait?1630:H-175,ww=portrait?880:1600,xx=(W-ww)/2;box(xx,yy,ww,hh,C.ink+'e8',C.accent+'22',20);lines.forEach((l,j)=>raw(l,W/2,yy+size+12+j*size*1.3,size,C.white,550,'center',max))}
window.init=async function(config,tl,width){project=config;timeline=tl;portrait=config.format==='9:16';W=portrait?1080:1920;H=portrait?1920:1080;C=themes[config.style];fontFamily=config.style==='terminal'?'KeouMono':'Manrope';canvas.width=width;canvas.height=width*H/W;await document.fonts.load('650 80px Manrope');await document.fonts.load('800 80px Manrope');await document.fonts.load('400 80px KeouMono');if(config.style==='picture')await Promise.allSettled(['800 80px KleoCartoon','700 80px KleoCartoon','700 80px KleoReal','600 80px KleoReal'].map(f=>document.fonts.load(f)));await document.fonts.ready;if(!document.fonts.check(`400 80px ${fontFamily}`))throw Error('Font unavailable');land=await (await fetch('/engine/assets/world.json')).json();
 for(const s of tl.scenes)if(s.image&&!images[s.image]){const img=new Image();img.src='/project/'+s.image;await img.decode();images[s.image]=img;}
 // Picture style: every shot of every scene carries its own picture; decode them all before the first frame.
 for(const s of tl.scenes)for(const shot of (s.shots||[]))if(shot.image&&!images[shot.image]){const img=new Image();img.src='/project/'+shot.image;await img.decode();images[shot.image]=img;}
 return true;};
window.renderFrame=function(t){issues=[];frameTime=t;ctx.setTransform(canvas.width/W,0,0,canvas.height/H,0,0);ctx.globalAlpha=1;background(t);let i=timeline.scenes.findIndex(s=>t>=s.start&&t<s.end);if(i<0)throw Error('Time outside timeline: '+t);const s=timeline.scenes[i];header(i,t);scene(s,t-s.start,t);subtitle(s,t);if(project.style==='cinema'||project.style==='picture'){(project.style==='picture'?window.KEOU_PICTURE:window.KEOU_CINEMA).progress(t)}else if(project.style==='stickman'){window.KEOU_STICKMAN.progress(t)}else{line(100,H-89,W-100,H-89,C.accent+'22',2);line(100,H-89,100+(W-200)*clamp(t/timeline.duration),H-89,C.accent,2)}return issues;};

// 🥚 kanaky.ai
