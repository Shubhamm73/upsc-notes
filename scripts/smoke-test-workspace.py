"""Stable workspace: panel controls, section search, read-only reference and planned review. Disposable fixtures only."""
from pathlib import Path
import json,os,tempfile
from playwright.sync_api import sync_playwright,expect
from PIL import Image,ImageDraw
OUT=Path(os.environ.get('UPSC_WORKSPACE_QA_DIR',tempfile.mkdtemp(prefix='upsc-workspace-')))
checks=[];errors=[];shots=[]
def check(v,n):
 print(('PASS ' if v else 'FAIL ')+n,flush=True);checks.append({'name':n,'pass':bool(v)})
def record(page,id):
 return page.evaluate('''id=>new Promise(ok=>{const q=indexedDB.open('upsc-notes');q.onsuccess=()=>{const d=q.result,r=d.transaction('notes').objectStore('notes').get(id);r.onsuccess=()=>{ok(r.result);d.close()}}})''',id)
def axe(page,label):
 if not page.evaluate("typeof axe !== 'undefined'"): page.add_script_tag(path=str(Path.cwd()/'node_modules/axe-core/axe.min.js'))
 violations=page.evaluate("axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']}}).then(r=>r.violations.map(v=>v.id+': '+v.nodes.map(n=>n.target.join(' ')).join('; ')))")
 check(not violations,'Accessibility '+label+': '+str(violations))
def go(page,hash,sel):
 page.evaluate('(hash)=>location.hash=hash',hash);page.wait_for_selector(sel);page.wait_for_timeout(250)
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 ctx=browser.new_context(viewport={'width':1280,'height':900},reduced_motion='reduce')
 page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('http://localhost:4173/upsc-notes/');page.wait_for_selector('.today-title');page.evaluate("async () => { const q=indexedDB.open('upsc-notes');const d=await new Promise(ok=>q.onsuccess=()=>ok(q.result));const get=(s,k)=>new Promise(ok=>{const r=d.transaction(s).objectStore(s).get(k);r.onsuccess=()=>ok(r.result)});const put=(s,v)=>new Promise(ok=>{const t=d.transaction(s,'readwrite');t.objectStore(s).put(v);t.oncomplete=()=>ok()});const ymd=()=>new Date().toISOString().slice(0,10),date={id:'wd:'+ymd()},textToDoc=text=>({type:'doc',content:[{type:'paragraph',content:[{type:'text',text}]}]});  const now = Date.now();\n  const shared = { nextReview: ymd(), reviewCount: 0, lastReviewed: null, createdAt: now, updatedAt: now, deletedAt: null };\n  const notes = [\n    { ...shared, id: 'pilot-sample-parliament', subject: 'GS2', folderId: 'gen:GS2', topic: 'Parliament', template: 'topic-sheet', title: 'Parliamentary sovereignty',\n      sections: [\n        { id: 'pilot-overview', heading: 'Overview', doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Parliament can make and unmake laws within the framework of the Constitution.' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'India follows constitutional supremacy, with judicial review as a check on legislative power.', marks: [{ type: 'highlight' }] }] }] } },\n        { id: 'pilot-arguments', heading: 'Arguments', doc: textToDoc('Compare the constitutional position in India and the United Kingdom. Link the answer to separation of powers and fundamental rights.') },\n        { id: 'pilot-forward', heading: 'Way forward', doc: textToDoc('Balance institutional autonomy with accountability and constitutional limits.') }\n      ], explain: 'The Constitution sets the boundaries within which Parliament exercises its power.', connect: 'Connect to the basic structure doctrine and judicial review.' },\n    { ...shared, id: 'pilot-sample-rights', subject: 'GS2', folderId: 'gen:GS2', topic: 'Constitution', title: 'Fundamental rights', template: 'topic-sheet',\n      sections: [{ id: 'pilot-rights-overview', heading: 'Overview', doc: textToDoc('Fundamental rights protect liberty and equality. Consider both the guarantee and the reasonable restrictions in a balanced answer.') }, { id: 'pilot-rights-example', heading: 'Examples', doc: textToDoc('Connect the right to equality with substantive equality and access to opportunity.') }], explain: '', connect: '' }\n  ];\n  const word = { ...shared, id: 'pilot-sample-resilience', folderId: date.id, word: 'Resilience', meaning: 'The capacity to recover, adapt and continue after difficulty.', uses: [{ sentence: 'Institutional resilience depends on public trust.', context: 'Essay' }], synonyms: ['Adaptability', 'Endurance'], antonyms: ['Fragility'] };\n  await (async () => {\n    for (const note of notes) if (!(await get('notes',note.id))) await put('notes',note);\n    if (!(await get('vocab',word.id))) await put('vocab',word);\n  })();\nd.close();}")
 go(page,'#/n/pilot-sample-parliament','#f-title')
 check(page.locator('.workspace-strip').count()==1,'Working set mounted with one editable note')
 check(not page.locator('.topline').is_visible(),'Desktop top strip removed');check(page.locator('.rail #pilot-guide-open').is_visible(),'Writing guide lives in side panel');page.click('#pilot-guide-open');page.wait_for_selector('#writing-guide');page.get_by_role('button',name='Back to the desk',exact=True).click()
 initial=page.locator('.canvas-col').bounding_box()['width'];page.click('#navigation-toggle');check(not page.locator('.rail').is_visible(),'Navigation hides independently');check(page.locator('.canvas-col').bounding_box()['width']>initial+50,'Hiding navigation gives its width to the page')
 check(page.locator('#navigation-toggle').get_attribute('aria-expanded')=='false','Navigation toggle announces collapsed state')
 page.click('#outline-toggle');check(not page.locator('.outline').is_visible(),'Outline hides independently');expanded=page.locator('.canvas-col').bounding_box()['width'];check(expanded>1000,'Combined collapsed panels give a full-width desktop page')
 page.click('#focus-toggle');check(not page.locator('.topline').is_visible() and not page.locator('.workspace-strip').is_visible(),'Focus recedes all app controls');check(page.locator('.canvas-col').bounding_box()['width']>1100,'Focus uses the available screen width');page.click('#focus-exit');check(not page.locator('.rail').is_visible(),'Leaving Focus preserves navigation choice')
 page.click('#navigation-toggle');page.click('#outline-toggle')
 before=record(page,'pilot-sample-rights')
 page.click('#reference-open');page.locator('.reference-choices button').filter(has_text='Fundamental rights').click();page.wait_for_selector('#reference-pane')
 axe(page,'reference')
 check(page.locator('#reference-pane [contenteditable=true]').count()==0,'Every reference section is read only')
 check(page.locator('#reference-pane .rich').count()==2,'Reference renders both original rich-text sections')
 page.locator('.canvas-col .rich').first.click();page.keyboard.press('End');page.keyboard.type(' Pilot workspace autosave.');expect(page.locator('.save-status')).to_have_text('Saved on this tablet',timeout=6000)
 check(record(page,'pilot-sample-rights')==before,'Writing beside a reference leaves its complete saved record unchanged')
 check('Pilot workspace autosave.' in json.dumps(record(page,'pilot-sample-parliament')),'Primary note still autosaves while reference is open')
 path=OUT/'workspace-reference-1280.png';page.screenshot(path=str(path));shots.append(path)
 page.click('#reference-close');check(page.locator('.outline').is_visible(),'Closing reference restores the outline preference')
 # Slash inventory and insertion are exercised by the unchanged smoke-test-ui2 suite.
 go(page,'#/n/pilot-sample-rights','#f-title');go(page,'#/n/pilot-sample-parliament','#f-title');check(page.locator('.working-tab').count()==2,'Switching notes retains an open working set')
 page.evaluate('scrollTo(0,500)');page.wait_for_timeout(100);position=page.evaluate('scrollY');go(page,'#/n/pilot-sample-rights','#f-title');page.locator('.working-tab a').filter(has_text='Parliamentary sovereignty').click();page.wait_for_timeout(450)
 check(abs(page.evaluate('scrollY')-position)<5,'Returning through open notes restores the reading position')
 page.evaluate('scrollTo(0,0)');page.click('.rail-search');page.fill('#global-search','separation');page.wait_for_selector('.search-section')
 check(page.locator('.search-selected').bounding_box()['y']-page.locator('.search-row').bounding_box()['y']<140,'Search result stays directly below its heading beside the preview')
 axe(page,'section search')
 check('Arguments' in page.locator('.search-section').first.inner_text(),'Search identifies the matching section');check('separation' in page.locator('.search-snippet').first.inner_text().lower(),'Search includes contextual text snippets');check(page.locator('.search-preview').is_visible(),'Desktop search supplies a read-only note preview')
 path=OUT/'workspace-search-1280.png';page.screenshot(path=str(path));shots.append(path)
 page.press('#global-search','Enter');page.wait_for_url('**/section/pilot-arguments');page.wait_for_timeout(400)
 target=page.locator('.note-section[data-section-id="pilot-arguments"]').bounding_box();check(target and 0<=target['y']<400,'Search opens directly at the matching section')
 page.evaluate('scrollTo(0,0)');page.click('.rail-search');page.fill('#global-search','rights');page.wait_for_selector('a.search-hit');page.press('#global-search','ArrowDown');check(page.locator('.search-selected').count()==1,'Keyboard search selects exactly one result');page.press('#global-search','Escape');check(page.locator('.search-overlay').count()==0,'Escape dismisses search and returns to writing')
 go(page,'#/','.today-title');page.click('#plan-session');page.wait_for_selector('#session-planner');page.select_option('#plan-subject','main:GS2');page.select_option('#plan-time','300');count=page.locator('.plan-preview li').count();check(count==2,'Five-minute GS2 preview includes the two due notes and excludes words');check(record(page,'pilot-sample-rights')==before,'Planning a session does not alter the review schedule')
 axe(page,'session planner');path=OUT/'workspace-plan-1280.png';page.screenshot(path=str(path));shots.append(path)
 page.click('#plan-start');page.wait_for_selector('#rv-count');check('2' in page.locator('#rv-count').inner_text(),'Review queue matches the planner preview');page.click('#rv-close');page.wait_for_timeout(250)
 # Screenshots show every existing surface at both tablet and phone sizes.
 for theme in ['light','dark']:
  page.emulate_media(color_scheme=theme)
  for width in [390,800,1280]:
   page.set_viewport_size({'width':width,'height':1000 if width<1000 else 900})
   for name,hash,selector in [('today','#/','.today-title'),('library','#/notes','.pilot-resume'),('editor','#/n/pilot-sample-parliament','#f-title'),('word','#/v/pilot-sample-resilience','#v-word'),('more','#/more','.more-list')]:
    go(page,hash,selector);check(page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),f'{theme} {width} {name}: no overflow')
    if width==390 and name=='library':
     check(not page.locator('.topline').is_visible(),'Main screen has no top strip');check(page.locator('.rail-search').is_visible(),'Phone search remains directly reachable')
    if width==390 and name=='more':
     page.click('#more-writing-guide');page.wait_for_selector('#writing-guide');check(page.locator('#writing-guide').is_visible(),'Phone More opens writing guide');page.get_by_role('button',name='Back to the desk',exact=True).click();page.click('#more-navigation');check(not page.locator('.rail').is_visible(),'Phone More hides navigation');check(page.locator('#navigation-toggle').is_visible(),'Hidden phone navigation has a reachable reopen control');page.click('#navigation-toggle');check(page.locator('.rail').is_visible(),'Phone navigation reopens');check(page.locator('#more-navigation').inner_text()=='Hide navigation','More reflects navigation reopened from floating control')
    path=OUT/f'workspace-{theme}-{width}-{name}.png';page.screenshot(path=str(path));shots.append(path)
 go(page,'#/n/pilot-sample-parliament','#f-title');page.set_viewport_size({'width':390,'height':844});page.click('#reference-open');page.locator('.reference-choices button').filter(has_text='Fundamental rights').click();page.wait_for_selector('#reference-pane');check(page.locator('#reference-close').is_visible(),'Phone reference has a reachable dismissal control');page.click('#reference-close')
 page.set_viewport_size({'width':800,'height':1000});check(not page.locator('.outline').is_visible(),'Portrait outline defaults to a clear writing space');page.click('#outline-toggle');check(page.locator('.outline').is_visible(),'Portrait outline can be opened on demand');page.click('#outline-toggle');check(not page.locator('.outline').is_visible(),'Portrait outline closes again')
 check(not errors,'No JavaScript runtime errors: '+str(errors));browser.close()
(OUT/'workspace-results.json').write_text(json.dumps(checks,indent=2))
for name in ['today','library','editor','word','more']:
 subset=[s for s in shots if s.stem.endswith('-'+name)];sheet=Image.new('RGB',(1500,2200),'#dddddd');draw=ImageDraw.Draw(sheet)
 for i,path in enumerate(subset):
  im=Image.open(path).convert('RGB');im.thumbnail((480,1035));x=(i%3)*500;y=(i//3)*1100;sheet.paste(im,(x+(500-im.width)//2,y+30));draw.text((x+10,y+7),path.stem,fill='black')
 sheet.save(OUT/f'{name}-contact.png')
assert all(c['pass'] for c in checks)
print('TOTAL',len(checks),flush=True)
