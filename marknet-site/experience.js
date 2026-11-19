(()=>{
"use strict";
const qs=(s,root=document)=>root.querySelector(s);
const qsa=(s,root=document)=>Array.from(root.querySelectorAll(s));
function initTabs(){
 const tabs=qsa(".expertise-tab");
 if(!tabs.length)return;
 function activate(index,focus){
  tabs.forEach((tab,i)=>{
   const selected=i===index;
   tab.setAttribute("aria-selected",String(selected));
   tab.tabIndex=selected?0:-1;
   const panel=document.getElementById(tab.getAttribute("aria-controls"));
   if(panel)panel.hidden=!selected;
  });
  if(focus)tabs[index].focus({preventScroll:true});
 }
 tabs.forEach((tab,index)=>{
  tab.addEventListener("click",()=>activate(index,false));
  tab.addEventListener("keydown",event=>{
   let next=index;
   if(event.key==="ArrowRight"||event.key==="ArrowDown")next=(index+1)%tabs.length;
   else if(event.key==="ArrowLeft"||event.key==="ArrowUp")next=(index+tabs.length-1)%tabs.length;
   else if(event.key==="Home")next=0;
   else if(event.key==="End")next=tabs.length-1;
   else return;
   event.preventDefault();
   activate(next,true);
   tabs[next].scrollIntoView({block:"nearest",inline:"nearest",behavior:"smooth"});
  });
 });
 activate(0,false);
}
function initIntro(){
 const overlay=document.getElementById("entry-intro");
 if(!overlay)return;
 const reduced=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
 let seen=false;
 try{seen=sessionStorage.getItem("marknet-intro-seen")==="1"}catch{}
 if(reduced||seen){
  document.documentElement.classList.add("intro-seen");
  overlay.remove();return;
 }
 const canvas=qs("#entry-canvas",overlay);
 const context=canvas&&canvas.getContext("2d",{alpha:true});
 document.body.classList.add("entry-lock");
 const start=performance.now();
 let raf=0,closed=false,timer=0,width=0,height=0,dpr=1;
 const rand=(i,s=1)=>{const v=Math.sin(i*78.233+s*197.19)*43758.5453;return v-Math.floor(v)};
 const satellites=[
  [.5,.5],[.13,.17],[.27,.08],[.42,.16],[.65,.12],[.84,.2],[.91,.41],[.82,.64],[.72,.84],[.49,.91],[.28,.79],[.1,.62],[.12,.4],
  [.34,.32],[.64,.37],[.68,.59],[.4,.72],[.26,.5],[.51,.22],[.77,.3],[.9,.73],[.13,.83],[.56,.72],[.34,.92],[.95,.12]
 ];
 const edges=[[0,1],[0,3],[0,5],[0,7],[0,9],[0,11],[0,14],[0,15],[0,17],[0,18],[0,22],[1,2],[2,3],[3,4],[4,5],[5,6],[6,7],[7,8],[8,9],[9,10],[10,11],[11,12],[12,1],[13,3],[13,17],[14,5],[14,19],[15,7],[15,22],[16,9],[16,10],[18,4],[18,13],[19,6],[20,7],[20,8],[21,11],[21,10],[23,9],[24,5]];
 function size(){
  width=Math.max(1,window.innerWidth);height=Math.max(1,window.innerHeight);
  dpr=Math.min(2,window.devicePixelRatio||1);
  if(!context)return;
  canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
  context.setTransform(dpr,0,0,dpr,0,0);
 }
 function paint(now){
  if(closed||!context)return;
  const t=(now-start)/1000;
  context.clearRect(0,0,width,height);
  const scale=Math.min(width,height);
  const centerX=width*.5,centerY=height*.49;
  const rangeX=Math.min(width*.53,560),rangeY=Math.min(height*.56,410);
  const positions=satellites.map(([nx,ny],i)=>({
   x:centerX+(nx-.5)*rangeX*2+(i?Math.sin(t*.45+i)*1.2:0),
   y:centerY+(ny-.5)*rangeY*2+(i?Math.cos(t*.42+i)*1.2:0)
  }));
  const columns=Math.min(80,Math.ceil(width/27));
  context.font="10px ui-monospace,SFMono-Regular,monospace";
  for(let col=0;col<columns;col++){
   const x=(col+.5)*width/columns;
   const y=((t*(30+rand(col)*30)+rand(col,4)*height)%(height+70))-35;
   const char=rand(col+Math.floor(t*6),7)>.5?"1":"0";
   context.fillStyle="rgba(37,151,207,.16)";
   context.fillText(char,x,y);
   context.fillStyle="rgba(255,212,0,.11)";
   context.fillText(char,x,y-30);
  }
  const grow=Math.min(1,t/.82);
  edges.forEach(([a,b],i)=>{
   const from=positions[a],to=positions[b];
   const alpha=Math.min(.47,(.12+rand(i)*.22)*grow);
   context.strokeStyle="rgba(50,183,236,"+alpha+")";
   context.lineWidth=i<12?1.5:1;
   context.beginPath();context.moveTo(from.x,from.y);context.lineTo(to.x,to.y);context.stroke();
   const pulse=(t*(.32+rand(i,3)*.18)+rand(i,9))%1;
   const px=from.x+(to.x-from.x)*pulse,py=from.y+(to.y-from.y)*pulse;
   context.beginPath();context.arc(px,py,i<12?2.3:1.5,0,Math.PI*2);
   context.fillStyle=i%4===0?"rgba(255,220,41,.85)":"rgba(104,220,255,.62)";context.fill();
  });
  positions.forEach((p,i)=>{
   const v=i===0?5.7:2.1+rand(i)*1.2;
   context.beginPath();context.arc(p.x,p.y,v,0,Math.PI*2);
   context.fillStyle=i===0?"rgba(255,221,0,.9)":"rgba(76,201,246,.85)";context.fill();
   if(i===0||i%4===0){
    context.beginPath();context.arc(p.x,p.y,v+6+Math.sin(t*2+i)*2,0,Math.PI*2);
    context.strokeStyle=i===0?"rgba(255,217,0,.35)":"rgba(45,161,226,.21)";
    context.stroke();
   }
  });
  const halo=context.createRadialGradient(centerX,centerY,0,centerX,centerY,Math.max(scale*.43,150));
  halo.addColorStop(0,"rgba(5,127,198,.10)");halo.addColorStop(1,"rgba(5,127,198,0)");
  context.fillStyle=halo;context.fillRect(0,0,width,height);
  raf=requestAnimationFrame(paint);
 }
 function finish(){
  if(closed)return;
  closed=true;
  clearTimeout(timer);
  cancelAnimationFrame(raf);
  window.removeEventListener("resize",size);
  window.removeEventListener("keydown",keyHandler);
  document.body.classList.remove("entry-lock");
  try{sessionStorage.setItem("marknet-intro-seen","1")}catch{}
  overlay.classList.add("is-exiting");
  setTimeout(()=>{document.documentElement.classList.add("intro-seen");overlay.remove()},490);
 }
 function keyHandler(e){if(e.key==="Escape"){e.preventDefault();finish()}}
 qs("#entry-skip",overlay)?.addEventListener("click",finish);
 window.addEventListener("keydown",keyHandler);
 window.addEventListener("resize",size,{passive:true});
 size();
 if(context)raf=requestAnimationFrame(paint);
 timer=setTimeout(finish,3100);
}
initTabs();
initIntro();
})();
