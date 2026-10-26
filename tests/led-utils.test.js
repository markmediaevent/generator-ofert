'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
require('../public/led-utils.js');
const {calculate,logistics}=globalThis.MM_LED;

test('Yes Tech 50×50: 5.5×2.5 m',()=>{
 const c=calculate({model:'yes-tech-p39',width:5.5,height:2.5});
 assert.equal(c.columns,11);assert.equal(c.rows,5);assert.equal(c.total,55);assert.equal(c.exact,true);
 const l=logistics(c);
 assert.equal(l.cases,7);assert.equal(l.dataRuns,2);assert.equal(l.dataJumpers,53);
 assert.equal(l.powerRuns,7);assert.equal(l.powerJumpers,48);
});
test('Gloshine 50×50: 5×3 m',()=>{
 const c=calculate({model:'gloshine-p4',width:5,height:3});
 assert.equal(c.total,60);
});
test('Dicolor 50×100: 5×3 m',()=>{
 const c=calculate({model:'dicolor-p4',width:5,height:3,orientation:'vertical'});
 assert.equal(c.columns,10);assert.equal(c.rows,3);assert.equal(c.total,30);
 assert.equal(logistics(c).cases,4);
});
test('Dicolor rotacja zmienia liczbę kabinetów',()=>{
 const vertical=calculate({model:'dicolor-p4',width:4.5,height:2.5});
 const horizontal=calculate({model:'dicolor-p4',width:4.5,height:2.5,orientation:'horizontal'});
 assert.equal(vertical.total,27);assert.equal(horizontal.total,25);
 assert.equal(vertical.exact,false);assert.equal(horizontal.exact,false);
});
test('Pojemność skrzyń, ciągów i zapas edytowalne',()=>{
 const c=calculate({model:'yes-tech-p39',width:5,height:3});
 const l=logistics(c,{caseSize:6,dataChainSize:12,powerChainSize:5,spares:2});
 assert.equal(l.count,60);assert.equal(l.totalCabinets,62);
 assert.equal(l.cases,11);assert.equal(l.dataRuns,2);assert.equal(l.dataJumpers,58);
 assert.equal(l.powerRuns,12);assert.equal(l.powerJumpers,48);
});
test('Nieprawidłowe wymiary nie generują checklisty',()=>{
 assert.equal(calculate({model:'dicolor-p4',width:0,height:3}),null);
 assert.equal(calculate({model:'inny',width:5,height:3}),null);
 assert.equal(logistics(null),null);
});
test('Porty DATA: piksele, podział ręczny, backup i limity',()=>{
 const c=calculate({model:'yes-tech-p39',width:6,height:3});
 const cfg={pixelWidth:128,pixelHeight:128,portCapacity:650000,portCount:4,backup:true,portCabinets:'36,36'};
 const p=logistics(c,cfg);
 assert.equal(p.dataRuns,2);assert.equal(p.dataJumpers,70);assert.equal(p.backupFeeds,2);
 assert.equal(p.signal.required,4);assert.equal(p.signal.ports[0].pixels,589824);
 assert.ok(Math.abs(p.signal.ports[0].load-90.74215384615385)<1e-9);
 assert.equal(p.signal.insufficient,false);
 assert.equal(logistics(c,{...cfg,portCount:3}).signal.insufficient,true);
 assert.equal(logistics(c,{...cfg,portCabinets:'72'}).signal.overloaded,true);
 assert.equal(logistics(c,{...cfg,portCabinets:'36,35'}).signal.valid,false);
 assert.equal(logistics(c,{...cfg,portCabinets:'',backup:false}).dataRuns,2);
 assert.equal(logistics(c,{...cfg,portCabinets:'',backup:false}).backupFeeds,0);
 assert.equal(logistics(c,{...cfg,pixelWidth:0,pixelHeight:0}).signal.ready,true);
 assert.equal(logistics(c,{...cfg,portCapacity:100}).signal.valid,false);
});
test('Obrót kabinetu i zapas nie zmieniają liczby pikseli kabinetu',()=>{
 const c=calculate({model:'dicolor-p4',width:5,height:3,orientation:'horizontal'});
 const p=logistics(c,{pixelWidth:128,pixelHeight:256,portCapacity:650000,portCount:4,backup:true,spares:3});
 assert.equal(c.total,30);assert.equal(p.signal.ports.length,2);
 assert.equal(p.signal.ports.reduce((sum,p)=>sum+p.pixels,0),30*128*256);
 assert.equal(p.totalCabinets,33);
});

test('Domyślne rozdzielczości modeli zgodnie z kabinetami użytkownika',()=>{
 for(const [model,w,h] of [['dicolor-p4',104,208],['gloshine-p4',104,104],['yes-tech-p39',128,128]]){
  const cfg=globalThis.MM_LED.modelLogistics(model,{pixelWidth:0,pixelHeight:0});assert.equal(cfg.pixelWidth,w);assert.equal(cfg.pixelHeight,h);
  const c=calculate({model,width:5,height:3});const l=logistics(c);assert.equal(l.signal.ports.reduce((sum,p)=>sum+p.pixels,0),c.total*w*h);
 }
 assert.equal(globalThis.MM_LED.modelLogistics('dicolor-p4',{pixelWidth:120}).pixelWidth,120);
});
