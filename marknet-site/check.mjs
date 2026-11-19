import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync('marknet-site/index.html','utf8');
const css=fs.readFileSync('marknet-site/experience.css','utf8');
const brand=fs.readFileSync('marknet-site/marknet-brand.css','utf8');
const js=fs.readFileSync('marknet-site/experience.js','utf8');
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
const known=new Set(ids);
assert.equal(ids.length,known.size,'HTML IDs must be unique');
for(const required of ['entry-intro','entry-canvas','main','kompetencje','branze','utrzymanie','kontakt','technologies-title'])assert(known.has(required),'Missing '+required);
const tabs=[...html.matchAll(/class="expertise-tab"/g)];
const panels=[...html.matchAll(/class="expertise-panel(?:\s|")/g)];
assert.equal(tabs.length,12);
assert.equal(panels.length,tabs.length);
for(const match of html.matchAll(/aria-controls="([^"]+)"/g))assert(known.has(match[1]),'Missing aria target '+match[1]);
for(const match of html.matchAll(/aria-labelledby="([^"]+)"/g))assert(known.has(match[1]),'Missing label target '+match[1]);
for(const match of html.matchAll(/\bhref="#([^"]+)"/g))assert(known.has(match[1]),'Missing hash target '+match[1]);
assert.equal((html.match(/class="tech-item tech-/g)||[]).length,48,'Two 24-brand carousel groups');
assert.equal((html.match(/class="tech-group"/g)||[]).length,2,'Expected two ticker groups');
for(const name of ['CTC Union','DELL','BitStream','Avigilon','Schneider Electric','SAIK']){
 assert.equal((html.match(new RegExp('<strong>'+name+'</strong>','g'))||[]).length,2,'Brand '+name+' must appear in both carousel halves');
}
const groupParts=html.split(/<div class="tech-group" role="(?:list|presentation)"(?: aria-hidden="true")?>/).slice(1,3);
assert.equal(groupParts.length,2,'Expected two full ticker tracks');
const groupBrandOrder=part=>[...part.matchAll(/class="tech-item tech-([\w-]+)(?:\s|")/g)].map(m=>m[1]);
assert.deepEqual(groupBrandOrder(groupParts[0]),groupBrandOrder(groupParts[1]),'Ticker groups must be identical for seamless repeat');
assert.equal(groupBrandOrder(groupParts[0]).length,24,'Each logo group needs all 24 brands');
assert.equal((html.match(/class="sector-card(?:\s|")/g)||[]).length,7,'Seven industry sectors');
assert(html.includes('id="ex-tab-defense"')&&html.includes('id="ex-panel-defense"'),'Dedicated high-security expertise must exist');
assert(html.includes('id="high-security-title"')&&html.includes('data-open-expertise="defense"'),'Security showcase must link to the defense expertise');
assert(js.includes("qsa('[data-open-expertise]')"),'Specialization links must activate the selected tab');
assert(css.includes('prefers-reduced-motion'),'Reduced motion required');
assert(css.includes('.entry-intro'),'Intro styles required');
assert(html.includes('history.scrollRestoration="manual"'),'New homepage entries must disable browser scroll restoration');
assert(html.includes('window.addEventListener("pageshow"'),'BFCache entries must reset page scroll');
assert(html.includes('window.addEventListener("load",resetEntryScroll'),'Page load must reset page scroll');
assert(html.includes('location.hash&&location.hash!=="#top"'),'Intentional in-page anchors must keep working');
assert(js.includes('marknet-intro-seen'),'Intro must not replay repeatedly');
assert(js.includes('setTimeout(finish,3100)'),'Intro must end automatically');
assert(!html.includes('entry-skip'),'Intro skip control must not be present');
assert(!js.includes('keyHandler')&&!js.includes('entry-skip'),'Intro cannot be skipped by Escape or UI controls');
assert(!brand.includes('animation-play-state:paused'),'Ticker must keep moving');
assert(!/<!--|\/\*/.test(html),'No production comments in HTML');
assert(!/\/\*/.test(brand+css),'No production CSS comments');
assert(!/^\s*\/\//m.test(js),'No production JS comments');
for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(match[1].trim())new vm.Script(match[1],{filename:'inline-homepage-script.js'});
const htmlWithoutRaw=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'');
const voids=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const stack=[];
for(const match of htmlWithoutRaw.matchAll(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi)){
 const token=match[0],tag=match[1].toLowerCase();
 if(voids.has(tag)||token.endsWith('/>'))continue;
 if(token.startsWith('</'))assert.equal(stack.pop(),tag,'Invalid closing '+tag);
 else stack.push(tag);
}
assert.equal(stack.length,0,'All HTML tags must be closed');
console.log('MarkNet homepage checks passed:',tabs.length,'expertise areas,',48/2,'technology brands, intro and mobile UX.');
