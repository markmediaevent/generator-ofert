'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
require('../public/led-utils.js');
const {calculate,logistics}=globalThis.MM_LED;

test('Yes Tech 50×50: 5.5×2.5 m',()=>{
 const c=calculate({model:'yes-tech-p39',width:5.5,height:2.5});
 assert.equal(c.columns,11);assert.equal(c.rows,5);assert.equal(c.total,55);assert.equal(c.exact,true);
 const l=logistics(c);
 assert.equal(l.cases,7);assert.equal(l.dataRuns,6);assert.equal(l.dataJumpers,49);
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
 assert.equal(l.cases,11);assert.equal(l.dataRuns,5);assert.equal(l.dataJumpers,55);
 assert.equal(l.powerRuns,12);assert.equal(l.powerJumpers,48);
});
test('Nieprawidłowe wymiary nie generują checklisty',()=>{
 assert.equal(calculate({model:'dicolor-p4',width:0,height:3}),null);
 assert.equal(calculate({model:'inny',width:5,height:3}),null);
 assert.equal(logistics(null),null);
});
