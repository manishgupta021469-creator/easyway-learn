(() => {
  'use strict';
  const app = document.getElementById('app');
  const toastRoot = document.getElementById('toast-root');
  const DB_KEY = 'easywayLearnStudentOnlyV17';
  const API_BASE = (location.protocol === 'http:' || location.protocol === 'https:') ? '/api' : null;
  let syncTimer=null, syncing=false, groupPollTimer=null, antiCheatStream=null, antiCheatActive=false;

  const DEFAULT_DB = {
    version: 16,
    settings: { officialEmail: '', officialWhatsApp: '' },
    accounts: [],
    subjects: [],
    progress: {},
    feedback: [],
    history: [],
    shares: { snapshots: {}, incoming: [], outgoing: [] },
    audit: [],
    usage: { activeMinutes: 0, sessions: [] }
  };

  let db = loadDb();
  db.shares ??= {snapshots:{},incoming:[],outgoing:[]}; db.shares.snapshots ??= {}; db.shares.incoming ??= []; db.shares.outgoing ??= [];
  db.shares.incoming = db.shares.incoming.filter(x=>x && x.toStudentId);
  let state = {
    currentId: localStorage.getItem('easywayCurrentStudent') || null,
    page: 'dashboard', subjectId: '', bookId: '', chapterId: '', paragraphId: '',
    pageNumber: 1, speakingListening: false, speakingLang: 'en-IN', recognition: null,
    readerMode: 'qualification', readerTranscript: '', readerAccuracy: 0,
    speakingTranscript: '', speakingScore: 0, speakingRecognized: '',
    chapterIndex: 0, chapterAnswers: {}, qaIndex: 0, qaListening: false, formulaTranscript:'',
    modal: null, filter: 'All', groupSession: null, groupTranscript: '', antiCheatTarget: '', antiCheatMessage: ''
  };

  function loadDb(){
    try {
      const raw = localStorage.getItem(DB_KEY) || localStorage.getItem('easywayLearnStudentOnlyV14') || localStorage.getItem('easywayLearnStudentOnlyV13') || localStorage.getItem('easywayLearnStudentOnlyV12') || localStorage.getItem('easywayLearnStudentOnlyV11') || localStorage.getItem('easywayLearnStudentOnlyV10') || localStorage.getItem('easywayLearnStudentOnlyV9') || localStorage.getItem('easywayLearnStudentOnlyV8');
      const incoming = raw ? JSON.parse(raw) : {};
      const base = structuredClone(DEFAULT_DB);
      const merged = {...base, ...incoming, version: 16};
      // Remove only the known demo records/content from older builds. User-created
      // subjects, books, pages, OCR text, scores and history are preserved.
      merged.accounts = (Array.isArray(merged.accounts) ? merged.accounts : []).filter(a => !(
        (a?.id === 'STU-001' && a?.name === 'Aarav Sharma' && a?.school === 'Demo School') ||
        (a?.id === 'STU-002' && a?.name === 'Riya Verma' && a?.school === 'Demo School')
      ));
      merged.subjects = (Array.isArray(merged.subjects) ? merged.subjects : []).filter(s => !['SCI','ENG','HIN','MAT'].includes(s?.id));
      merged.shares = {...base.shares, ...(merged.shares||{})};
      merged.shares.incoming = (Array.isArray(merged.shares.incoming) ? merged.shares.incoming : []).filter(x => x?.id !== 'SHARE-IN-1');
      merged.shares.outgoing = Array.isArray(merged.shares.outgoing) ? merged.shares.outgoing : [];
      merged.shares.snapshots = (merged.shares.snapshots && typeof merged.shares.snapshots === 'object') ? merged.shares.snapshots : {};
      merged.settings = {...base.settings, ...(incoming.settings||{})};
      merged.accounts.forEach(a=>{a.id=String(a.id||'').toUpperCase();a.history=Array.isArray(a.history)?a.history:[];a.status=a.status||'Active'});
      // Legacy/plaintext passwords are migrated on first successful login; no new account stores plaintext.
      merged.subjects = merged.subjects.map(s=>({
        ...s,
        name:String(s?.name||s?.title||'Untitled Subject'),
        language:String(s?.language||'English'),
        books:Array.isArray(s?.books)?s.books.map(b=>({ ...b, title:String(b?.title||b?.name||'Untitled Book'), chapters:Array.isArray(b?.chapters)?b.chapters:[] })):[]
      }));
      merged.progress = incoming.progress && typeof incoming.progress === 'object' ? incoming.progress : {};
      for (const k of Object.keys(merged.progress)) if (k.startsWith('STU-001:') || k.startsWith('STU-002:')) delete merged.progress[k];
      merged.history = (Array.isArray(incoming.history) ? incoming.history : []).filter(x => x?.studentId !== 'STU-001' && x?.studentId !== 'STU-002');
      merged.audit = (Array.isArray(incoming.audit) ? incoming.audit : []).filter(x => x?.actor !== 'STU-001' && x?.actor !== 'STU-002');
      merged.usage = {...base.usage, ...(incoming.usage||{})};
      merged.usage.sessions = Array.isArray(incoming.usage?.sessions) ? incoming.usage.sessions : [];
      merged.shares.snapshots = (merged.shares.snapshots && typeof merged.shares.snapshots==='object') ? merged.shares.snapshots : {};
      merged.shares.incoming = Array.isArray(merged.shares.incoming) ? merged.shares.incoming : [];
      merged.shares.outgoing = Array.isArray(merged.shares.outgoing) ? merged.shares.outgoing : [];
      return merged;
    } catch { return structuredClone(DEFAULT_DB); }
  }
  let syncDirty=false;
  function saveDb(){
    localStorage.setItem(DB_KEY, JSON.stringify(db));
    syncDirty=true;
    scheduleServerSync();
  }
  function serverToken(){return localStorage.getItem('easywayServerToken')||'';}
  function scheduleServerSync(){
    if(!API_BASE||!state.currentId||!serverToken())return;
    clearTimeout(syncTimer);
    syncTimer=setTimeout(()=>{
      syncToServer().catch(()=>{});
    },700);
  }
  async function apiFetch(path,opts={}){if(!API_BASE)throw Error('API unavailable');const h={'content-type':'application/json',...(opts.headers||{})};const t=serverToken();if(t)h.authorization='Bearer '+t;const r=await fetch(API_BASE+path,{...opts,headers:h});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||('HTTP '+r.status));return d}
  async function ocrFetch(path,payload){if(!API_BASE)throw Error('OCR server is unavailable');const r=await fetch(API_BASE+path,{method:'POST',headers:{'content-type':'application/json','cache-control':'no-store','x-easyway-ocr':'1'},cache:'no-store',body:JSON.stringify(payload)});const d=await r.json().catch(()=>({error:'Invalid OCR server response'}));if(!r.ok)throw Error(d.error||(`OCR HTTP ${r.status}`));return d}
  function remoteState(){return {version:43,settings:db.settings,subjects:db.subjects,progress:db.progress,history:db.history,shares:db.shares,audit:db.audit,usage:db.usage};}
  async function serverAssessment(type,targetId,transcript){if(!API_BASE||!serverToken())throw Error('Backend unavailable');const r=await apiFetch('/assessments',{method:'POST',body:JSON.stringify({type,targetId,transcript})});return r.attempt;}
  async function serverChapterAssessment(targetId,parts){if(!API_BASE||!serverToken())throw Error('Backend unavailable');const r=await apiFetch('/assessments',{method:'POST',body:JSON.stringify({type:'Chapter',targetId,parts})});return r.attempt;}
  async function serverTranscribeAudio(blob,language){
    if(!API_BASE||!serverToken())throw Error('Backend unavailable');
    const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]||'');r.onerror=reject;r.readAsDataURL(blob)});
    const r=await apiFetch('/transcribe',{method:'POST',body:JSON.stringify({mime:blob.type||'audio/webm',data,language})});
    return r;
  }
  async function syncToServer(){
    if(syncing||!API_BASE||!state.currentId||!serverToken())return;
    syncing=true;
    syncDirty=false;
    try{
      const me=current();
      await apiFetch('/me',{method:'PUT',body:JSON.stringify({name:me?.name||'',profile:me?{email:me.email||'',className:me.className||'',section:me.section||'',school:me.school||'',history:me.history||[]}: {}})});
      await apiFetch('/state',{method:'PUT',body:JSON.stringify({state:remoteState()})});
    } finally {
      syncing=false;
      if(syncDirty) scheduleServerSync();
    }
  }
  async function hydrateFromServer(){
    const r=await apiFetch('/me');
    const sr=await apiFetch('/state');
    const st=sr.state||{};
    const hasServerLearning=Array.isArray(st.subjects)||Object.keys(st.progress||{}).length||Array.isArray(st.history)||Array.isArray(st.audit)||Array.isArray(st.feedback)||Object.keys(st.shares||{}).length||Object.keys(st.usage||{}).length;
    if(hasServerLearning){
      db.subjects=Array.isArray(st.subjects)?st.subjects.map(s=>({...s,name:String(s?.name||s?.title||'Untitled Subject'),books:Array.isArray(s?.books)?s.books:[]})):[];
      db.progress=st.progress&&typeof st.progress==='object'?st.progress:{};
      db.history=Array.isArray(st.history)?st.history:[];
      db.shares={...DEFAULT_DB.shares,...(st.shares||{}),snapshots:{...((st.shares||{}).snapshots||{})},incoming:Array.isArray(st.shares?.incoming)?st.shares.incoming:[],outgoing:Array.isArray(st.shares?.outgoing)?st.shares.outgoing:[]};
      db.audit=Array.isArray(st.audit)?st.audit:[];
      db.usage={...DEFAULT_DB.usage,...(st.usage||{}),sessions:Array.isArray(st.usage?.sessions)?st.usage.sessions:[]};
      db.feedback=Array.isArray(st.feedback)?st.feedback:[];
      db.settings=st.settings&&typeof st.settings==='object'?{...DEFAULT_DB.settings,...st.settings}:{...DEFAULT_DB.settings};
    }
    try{const sh=await apiFetch('/shares');if(sh&&typeof sh==='object')db.shares={...db.shares,...sh,snapshots:{...(db.shares.snapshots||{}),...(sh.snapshots||{})}}}catch{}
    const me=current();
    if(me&&r.name)me.name=r.name;
    if(me&&r.profile)Object.assign(me,r.profile);
    localStorage.setItem(DB_KEY,JSON.stringify(db));
    syncDirty=false;
  }
  async function hashPassword(value){
    const data=new TextEncoder().encode(String(value));
    const digest=await crypto.subtle.digest('SHA-256',data);
    return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('');
  }
  async function verifyPassword(acc,value){
    if(acc.passwordHash) return acc.passwordHash === await hashPassword(value);
    if(acc.password===value){acc.passwordHash=await hashPassword(value);delete acc.password;saveDb();return true}
    return false;
  }

  // Binary page assets are stored in IndexedDB so uploaded images/PDFs do not bloat localStorage.
  const ASSET_DB='easywayLearnAssetsV1';
  function assetOpen(){return new Promise((resolve,reject)=>{if(!('indexedDB' in window)){resolve(null);return}const r=indexedDB.open(ASSET_DB,1);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('assets'))r.result.createObjectStore('assets')};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
  async function assetPut(key,blob){const d=await assetOpen();if(!d)return false;return new Promise((resolve,reject)=>{const tx=d.transaction('assets','readwrite');tx.objectStore('assets').put(blob,key);tx.oncomplete=()=>{d.close();resolve(true)};tx.onerror=()=>{d.close();reject(tx.error)}})}
  async function assetGet(key){const d=await assetOpen();if(!d)return null;return new Promise((resolve,reject)=>{const tx=d.transaction('assets','readonly');const q=tx.objectStore('assets').get(key);q.onsuccess=()=>{d.close();resolve(q.result||null)};q.onerror=()=>{d.close();reject(q.error)}})}
  async function assetDelete(key){const d=await assetOpen();if(!d)return;return new Promise((resolve,reject)=>{const tx=d.transaction('assets','readwrite');tx.objectStore('assets').delete(key);tx.oncomplete=()=>{d.close();resolve()};tx.onerror=()=>{d.close();reject(tx.error)}})}
  async function hydratePageAsset(pg){
    const host=document.getElementById('pageAsset'); if(!host||!pg?.assetKey)return;
    try{let blob=await assetGet(pg.assetKey); if(!blob&&API_BASE&&serverToken()){try{const r=await fetch(API_BASE+'/assets/'+encodeURIComponent(pg.assetKey),{headers:{authorization:'Bearer '+serverToken()}});if(r.ok){blob=await r.blob();await assetPut(pg.assetKey,blob)}}catch{}} if(!blob){host.innerHTML='<div class="small muted">No stored binary asset is attached to this page.</div>';return}
      const url=URL.createObjectURL(blob);
      if(blob.type==='application/pdf') host.innerHTML=`<iframe title="${esc(pg.imageName)}" src="${url}" style="width:100%;height:520px;border:0;border-radius:12px;background:#fff"></iframe>`;
      else host.innerHTML=`<img src="${url}" alt="${esc(pg.imageName)}" style="display:block;max-width:100%;max-height:620px;margin:auto;border-radius:12px">`;
    }catch{host.innerHTML='<div class="small muted">The stored page asset could not be opened on this device.</div>'}
  }
  function structuredCloneSafe(x){ return JSON.parse(JSON.stringify(x)); }
  if(typeof structuredClone === 'undefined') window.structuredClone = structuredCloneSafe;

  function esc(v){return String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
  function cls(active){return active?'active':''}
  function toast(msg){const el=document.createElement('div');el.className='toast';el.textContent=msg;toastRoot.className='toast-root';toastRoot.appendChild(el);setTimeout(()=>el.remove(),2300)}
  function today(){return new Date().toISOString().slice(0,10)}
  function fmtDate(d){try{return new Date(d).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}catch{return d}}
  function current(){return db.accounts.find(a=>a.id===state.currentId && a.status==='Active') || null}
  function findSubject(){return db.subjects.find(s=>s.id===state.subjectId) || db.subjects[0]}
  function findBook(){return findSubject().books.find(b=>b.id===state.bookId) || findSubject().books[0]}
  function findChapter(){return findBook().chapters.find(c=>c.id===state.chapterId) || findBook().chapters[0]}
  function findParagraph(){return findChapter()?.paragraphs.find(p=>p.id===state.paragraphId) || findChapter()?.paragraphs[0]}
  function progressKey(contentId){return `${state.currentId}:${contentId}`}
  function getProg(id){return db.progress[progressKey(id)] || {qualified:false,readings:0,speakingAttempts:[],highScore:0,latestScore:0,underline:'',lastType:'',chapterTestAttempts:[],qaQualified:false}}
  function setProg(id,obj){db.progress[progressKey(id)] = obj; saveDb()}
  function addAudit(action,target,extra=''){db.audit.unshift({actor:state.currentId,action,target,time:new Date().toISOString(),extra});db.audit=db.audit.slice(0,300);saveDb()}
  function activeNav(){return ['dashboard','library','history','progress','rankings','group','shares','profile','support']}
  function layout(content){
    const me=current();
    if(!me) return login();
    return `<div class="app-wrap"><header class="topbar"><div class="brand"><div class="logo">E</div><div>Easyway Learn<small>Student-only learning platform</small></div></div><div class="top-actions"><span class="pill" style="background:rgba(255,255,255,.08);color:#e2e8f0;border-color:rgba(255,255,255,.14)">${esc(me.id)}</span><button class="btn ghost" onclick="logout()">Logout</button></div></header><main class="page">${nav()}${content}<div class="footer">Easyway Learn • Student learning platform • <a href="/privacy.html" target="_blank" rel="noopener">Privacy</a> • Source: FINAL MASTER SPECIFICATION v9</div></main></div>`;
  }
  function nav(){
    const labels=[['dashboard','Home'],['library','My Learning'],['history','History'],['progress','Progress'],['rankings','Ranking'],['shares','Shared'],['profile','Profile'],['support','Help & Support']];
    return `<nav class="nav">${labels.map(([id,label])=>`<button class="${cls(state.page===id)}" onclick="go('${id}')">${label}</button>`).join('')}</nav>`;
  }

  function login(){
    app.innerHTML=`<div class="login"><div class="login-box"><section class="hero"><div class="eyebrow">LEARN • SPEAK • SCORE • IMPROVE</div><h1>Easyway Learn</h1><p>Student-only textbook learning with a permanent Student User ID, page/paragraph learning, speaking assessment, Q&A, formula tests, chapter tests, history, progress and content sharing.</p><div class="feature"><b>80% qualification unlock</b><div class="small">Read a paragraph for qualification. Speaking unlocks at 80% or higher.</div></div><div class="feature"><b>Full Chapter Test</b><div class="small">It unlocks automatically after every required paragraph reaches 80% reading qualification.</div></div><div class="feature"><b>Permanent student identity</b><div class="small">The same Student ID carries class/year and learning history forward.</div></div></section><section class="login-card"><div class="eyebrow">STUDENT LOGIN</div><h2 style="margin:6px 0 20px">Sign in</h2><div class="field"><label>STUDENT USER ID</label><input id="loginId" value="${esc(localStorage.getItem('easywayLastId')||'')}" autocomplete="username" /></div><div class="field"><label>PASSWORD</label><input id="loginPwd" type="password" value="" autocomplete="current-password" /></div><button class="btn primary" style="width:100%" onclick="loginSubmit()">Sign In</button><div class="toolbar" style="margin-top:10px"><button class="btn secondary" onclick="openRegister()">Create Permanent ID</button><button class="btn ghost" onclick="openForgot()">Forgot Password</button></div><div class="small muted" style="margin-top:14px">No teacher/admin login is shown in this final Student-only app UI.</div></section></div></div>`;
  }
  async function loginSubmit(){
    const id=(document.getElementById('loginId')?.value||'').trim().toUpperCase(); const pwd=document.getElementById('loginPwd')?.value||'';
    if(API_BASE){try{const r=await apiFetch('/login',{method:'POST',body:JSON.stringify({studentId:id,password:pwd})});localStorage.setItem('easywayServerToken',r.token);if(!db.accounts.some(a=>a.id===id))db.accounts.push({id,status:'Active',history:[]});state.currentId=id;localStorage.setItem('easywayCurrentStudent',id);localStorage.setItem('easywayLastId',id);await hydrateFromServer();state.page='dashboard';addAudit('Login',id);render();toast('Secure sign in successful');return}catch(e){/* fall back to local mode */}}
    const acc=db.accounts.find(a=>a.id===id);if(!acc){toast('Student ID not found');return}if(acc.status!=='Active'){toast('This Student ID is inactive');return}if(!(await verifyPassword(acc,pwd))){toast('Incorrect password');return}state.currentId=id;localStorage.setItem('easywayCurrentStudent',id);localStorage.setItem('easywayLastId',id);state.page='dashboard';addAudit('Login',id);render();
  }
  async function logout(){try{if(API_BASE&&serverToken())await apiFetch('/logout',{method:'POST',body:'{}'})}catch{}localStorage.removeItem('easywayServerToken');state.currentId=null;localStorage.removeItem('easywayCurrentStudent');state.recognition=null;login()}
  function openRegister(){state.modal='register';render()}
  function openForgot(){state.modal='forgot';render()}
  function closeModal(){stopRecognition(false);state.modal=null;document.querySelectorAll('.modal-backdrop').forEach(el=>el.remove());render()}

  function registerModal(){return `<div class="modal-backdrop"><div class="modal"><div class="row between"><div><div class="eyebrow">NEW STUDENT</div><h2 class="section-title" style="font-size:22px">Create permanent Student ID</h2></div><button class="btn ghost" onclick="window.closeModal();return false" type="button">Close</button></div><div class="grid g2"><div class="field"><label>STUDENT ID</label><input id="regId" placeholder="Example: STU-2026-001" /></div><div class="field"><label>NAME</label><input id="regName" placeholder="Student name" /></div><div class="field"><label>PASSWORD</label><input id="regPwd" type="password" placeholder="Create password" /></div><div class="field"><label>EMAIL (OPTIONAL)</label><input id="regEmail" type="email" placeholder="name@example.com" /></div><div class="field"><label>CLASS</label><input id="regClass" value="6" /></div><div class="field"><label>SECTION</label><input id="regSection" value="A" /></div><div class="field"><label>SCHOOL (OPTIONAL)</label><input id="regSchool" placeholder="School name" /></div></div><button class="btn primary" onclick="registerStudent()">Create Student ID</button><p class="small muted" style="margin-bottom:0">The Student ID stays the primary identity across academic years and school changes.</p></div></div>`}
  async function registerStudent(){
    const id=(document.getElementById('regId')?.value||'').trim().toUpperCase();const name=(document.getElementById('regName')?.value||'').trim();const password=document.getElementById('regPwd')?.value||'';
    if(!/^[A-Z0-9][A-Z0-9_-]{3,29}$/.test(id)){toast('Use 4–30 letters, numbers, _ or - for Student ID');return}
    if(!name||password.length<6){toast('Enter name and a 6+ character password');return}
    const className=(document.getElementById('regClass')?.value||'').trim(),section=(document.getElementById('regSection')?.value||'').trim(),school=(document.getElementById('regSchool')?.value||'').trim(),email=(document.getElementById('regEmail')?.value||'').trim();
    const history=[{school,className,section,year:String(new Date().getFullYear())+'-'+String(new Date().getFullYear()+1).slice(-2)}];
    if(API_BASE){try{const created=await apiFetch('/register',{method:'POST',body:JSON.stringify({studentId:id,password,name,profile:{email,className,section,school,history}})});alert('Save this recovery code somewhere safe. It is required if you forget your password:\n\n'+created.recoveryCode);const l=await apiFetch('/login',{method:'POST',body:JSON.stringify({studentId:id,password})});localStorage.setItem('easywayServerToken',l.token);db.accounts.push({id,name,className,section,school,email,status:'Active',createdAt:today(),history});state.currentId=id;localStorage.setItem('easywayCurrentStudent',id);localStorage.setItem('easywayLastId',id);state.modal=null;await syncToServer();addAudit('Create Student ID',id);render();toast('Permanent Student ID created securely');return}catch(e){toast(e.message||'Server registration failed');return}}
    if(db.accounts.some(a=>a.id===id)){toast('That Student ID already exists');return}
    const acc={id,passwordHash:await hashPassword(password),name,className,section,school,email,status:'Active',createdAt:today(),history};
    db.accounts.push(acc);saveDb();state.currentId=id;localStorage.setItem('easywayCurrentStudent',id);localStorage.setItem('easywayLastId',id);state.modal=null;addAudit('Create Student ID',id);render();toast('Permanent Student ID created');
  }
  function forgotModal(){return `<div class="modal-backdrop"><div class="modal"><div class="row between"><div><div class="eyebrow">PASSWORD RESET</div><h2 class="section-title" style="font-size:22px">Forgot Password</h2></div><button class="btn ghost" onclick="window.closeModal();return false" type="button">Close</button></div><p class="muted">Create a new password for the same Student ID. The Student ID does not change.</p><div class="field"><label>STUDENT ID</label><input id="forgotId" value="${esc(localStorage.getItem('easywayLastId')||'')}" /></div><div class="field"><label>RECOVERY CODE</label><input id="forgotRecovery" placeholder="EWL-XXXXXXXX-XXXXXXXX" autocomplete="off" /></div><div class="field"><label>NEW PASSWORD</label><input id="forgotPwd" type="password" /></div><button class="btn primary" onclick="resetPassword()">Save New Password</button><p class="small muted">The recovery code is shown only when a permanent Student ID is created or a password is reset.</p></div></div>`}
  async function resetPassword(){const id=(document.getElementById('forgotId')?.value||'').trim().toUpperCase();const pwd=document.getElementById('forgotPwd')?.value||'';const recovery=(document.getElementById('forgotRecovery')?.value||'').trim();if(pwd.length<6){toast('Password must be at least 6 characters');return}if(API_BASE){try{const r=await apiFetch('/password/reset',{method:'POST',body:JSON.stringify({studentId:id,recoveryCode:recovery,newPassword:pwd})});alert('Save your new recovery code somewhere safe.\n\n'+r.recoveryCode);state.modal=null;toast('Password updated for the same Student ID');login();return}catch(e){toast(e.message||'Password reset failed');return}}const acc=db.accounts.find(a=>a.id===id);if(!acc){toast('Student ID not found');return}acc.passwordHash=await hashPassword(pwd);delete acc.password;saveDb();state.modal=null;toast('Password updated for the same Student ID');login()}

  function dashboard(){
    const me=current(); const subj=findSubject(), book=subj?.books?.[0] || null, ch=book?.chapters?.[0] || null;
    if(!subj || !book || !ch){
      return layout(`<div class="hero"><div class="eyebrow">STUDENT DASHBOARD</div><h1 style="margin:8px 0 4px;font-size:32px">Hello, ${esc(me.name)}</h1><p style="margin:0;color:#cbd5e1">Your learning space is ready. No demo material is installed.</p><div class="toolbar" style="margin-top:18px"><button class="btn" style="background:#fff;color:#312e81" onclick="go('library')">Create Subject</button><button class="btn" style="background:rgba(255,255,255,.08);color:#fff;border-color:rgba(255,255,255,.18)" onclick="go('upload')">Upload Page</button></div></div><div class="card" style="margin-top:16px"><h2 class="section-title">Start your own textbook</h2><p class="muted">Create your Subject and Book, then upload a page photo or PDF. OCR text, corrected text, paragraphs, scores and history are saved to your Student ID.</p></div>`, activeNav());
    }
    state.subjectId=subj.id; state.bookId=book.id; state.chapterId=ch.id;
    const doneCount=ch.paragraphs.filter(p=>getProg(p.id).speakingAttempts.length>0).length; const fullUnlocked=chapterTestUnlocked(ch);
    return layout(`<div class="hero"><div class="eyebrow">STUDENT DASHBOARD</div><div class="row between wrap"><div><h1 style="margin:8px 0 4px;font-size:32px">Hello, ${esc(me.name)}</h1><p style="margin:0;color:#cbd5e1">${esc(me.school||'Independent Student')} • Class ${esc(me.className||'—')} • Section ${esc(me.section||'—')}</p></div><span class="pill green">Permanent ID • ${esc(me.id)}</span></div><div style="margin-top:18px" class="toolbar"><button class="btn" style="background:#fff;color:#312e81" onclick="go('library')">Continue Learning</button><button class="btn" style="background:rgba(255,255,255,.08);color:#fff;border-color:rgba(255,255,255,.18)" onclick="go('upload')">Upload Page</button></div></div>
      <div class="grid g4" style="margin-top:16px"><div class="card stat"><div class="small muted">Chapter Completion</div><div class="num">${doneCount}/${ch.paragraphs.length}</div><div class="progress"><span style="width:${ch.paragraphs.length?doneCount/ch.paragraphs.length*100:0}%"></span></div></div><div class="card stat"><div class="small muted">Latest Score</div><div class="num">${latestPercent()}%</div><div class="small muted">From your last assessment</div></div><div class="card stat"><div class="small muted">High Score</div><div class="num">${highPercent()}%</div><div class="small muted">Best stored score</div></div><div class="card stat"><div class="small muted">Study Time</div><div class="num">${db.usage.activeMinutes}m</div><div class="small muted">Your private active time</div></div></div>
      <div class="grid g2" style="margin-top:16px"><div class="card"><div class="row between wrap"><div><div class="eyebrow">CURRENT CONTENT</div><h2 class="section-title">${esc(subj.name)} → ${esc(book.title)}</h2><div class="muted">${esc(ch.title)}</div></div><span class="pill purple">${ch.paragraphs.length} paragraphs</span></div><div class="list" style="margin-top:12px">${ch.paragraphs.map(p=>{const pg=getProg(p.id);const unlocked=pg.qualified||pg.speakingAttempts.length>0;return `<div class="list-item"><div><b>${esc(p.title)}</b><div class="small muted">${pg.speakingAttempts.length?`High ${Math.round(pg.highScore)}% • ${pg.speakingAttempts.length} attempts`:'Not tested yet'}</div></div><button class="btn ${unlocked?'secondary':'primary'}" onclick="openLesson('${p.id}')">${unlocked?'Practice':'Learn'}</button></div>`}).join('')}</div></div><div class="card"><div class="row between"><div><div class="eyebrow">CHAPTER TEST</div><h2 class="section-title">Full Chapter Test</h2></div><span class="pill ${fullUnlocked?'green':'amber'}">${fullUnlocked?'Unlocked':'Locked'}</span></div><p class="muted">Complete the reading qualification (80%+) for every required paragraph first. The combined chapter test opens automatically after every paragraph reaches 80% reading qualification and keeps its own history.</p><button class="btn ${fullUnlocked?'primary':'ghost'}" ${fullUnlocked?'':'disabled'} onclick="startChapterTest()">${fullUnlocked?'Start Full Chapter Test':'Complete all paragraphs first'}</button></div></div>
      <div class="card" style="margin-top:16px"><div class="row between"><div><div class="eyebrow">RECENT ACTIVITY</div><h2 class="section-title">Your History</h2></div><button class="btn ghost" onclick="go('history')">View All</button></div>${recentHistoryHtml()}</div>`, activeNav());
  }
  function latestPercent(){const h=db.history.find(x=>x.studentId===state.currentId);return h?Math.round(h.score/h.max*100):0}
  function highPercent(){const own=db.history.filter(x=>x.studentId===state.currentId);return own.length?Math.round(Math.max(...own.map(x=>x.score/x.max*100))):0}
  function recentHistoryHtml(){const rows=db.history.filter(x=>x.studentId===state.currentId).slice(0,5);return rows.length?`<div class="table-wrap"><table class="table"><tr><th>Content</th><th>Type</th><th>Score</th><th>Date</th></tr>${rows.map(x=>`<tr><td>${esc(x.content)}</td><td>${esc(x.type)}</td><td><b>${x.score}/${x.max}</b></td><td>${fmtDate(x.date)}</td></tr>`).join('')}</table></div>`:'<div class="empty">No attempts yet. Open a paragraph to begin learning.</div>'}

  function library(){
    const s=findSubject();
    return layout(`<div class="row between wrap"><div><div class="eyebrow">MY LEARNING LIBRARY</div><h1 class="title">Subjects & Books</h1><div class="subtitle">Separate Subject → Book → Chapter → Page → Paragraph structure.</div></div><div class="toolbar"><button class="btn secondary" onclick="openNewSubject()">+ New Subject</button><button class="btn primary" onclick="go('upload')">+ Upload Pages</button></div></div><div class="grid g3" style="margin-top:16px">${db.subjects.map(sub=>`<div class="card"><div class="row between"><span class="pill">${esc(sub.language)}</span><span class="small muted">${sub.books.length} book${sub.books.length===1?'':'s'}</span></div><h2 class="section-title" style="margin-top:10px">${esc(sub.name)}</h2><div class="toolbar" style="margin-bottom:10px"><button class="btn ghost" onclick="shareContent('Subject','${sub.id}','${esc(sub.name)}')">Share Subject</button><button class="btn ghost" onclick="openNewBook('${sub.id}')">+ Book</button><button class="btn ghost" onclick="deleteSubject('${sub.id}')">Delete Subject</button></div><div class="list">${sub.books.map(b=>`<div class="list-item"><div><b>${esc(b.title)}</b><div class="small muted">${b.chapters.length} chapter${b.chapters.length===1?'':'s'}</div></div><button class="btn secondary" onclick="openBook('${sub.id}','${b.id}')">Open</button><button class="btn ghost" onclick="deleteBook('${b.id}')">Delete</button></div>`).join('')}</div></div>`).join('')}</div>`, activeNav());
  }
  function openBook(subjectId,bookId){state.subjectId=subjectId;state.bookId=bookId;state.chapterId=findSubjectBy(subjectId).books.find(b=>b.id===bookId)?.chapters[0]?.id||'';state.page='book';render()}
  function findSubjectBy(id){return db.subjects.find(s=>s.id===id)||db.subjects[0]}
  function bookView(){
    const s=findSubject(), b=findBook();
    if(!b)return layout('<div class="empty">Book unavailable.</div>',activeNav());
    const chapterCards = b.chapters.length ? b.chapters.map(ch=>{
      const pages = ch.pages.map(pg=>`<button class="page-dot" onclick="viewPage(${pg.number})">${pg.number}</button>`).join('');
      return `<div class="card chapter-card"><div class="row between"><div><span class="pill">Chapter ${ch.order}</span><h2 class="section-title" style="margin-top:9px">${esc(ch.title)}</h2><div class="small muted">${ch.pages.length} page${ch.pages.length===1?'':'s'} • ${ch.paragraphs.length} paragraph${ch.paragraphs.length===1?'':'s'}</div></div><span class="pill ${ch.complete?'green':'amber'}">${ch.complete?'Complete':'In progress'}</span></div><div class="page-strip" style="margin-top:12px">${pages}</div><div class="toolbar" style="margin-top:12px"><button class="btn secondary" onclick="openChapter('${ch.id}')">Open Chapter</button><button class="btn ghost" onclick="editChapter('${ch.id}')">Edit</button><button class="btn ghost" onclick="shareContent('Chapter','${ch.id}','${esc(ch.title)}')">Share</button></div></div>`;
    }).join('') : '<div class="empty">No chapters yet. Upload a page to start building this book.</div>';
    return layout(`<div class="breadcrumb">${esc(s.name)} → ${esc(b.title)}</div><div class="row between wrap"><div><div class="eyebrow">BOOK VIEW</div><h1 class="title">${esc(b.title)}</h1><div class="subtitle">Pages already uploaded are available immediately in serial order.</div></div><button class="btn primary" onclick="go('upload')">Upload Next Page</button></div><div class="grid g2" style="margin-top:16px">${chapterCards}</div>`, [['dashboard','Home'],['library','My Learning'],['history','History'],['progress','Progress'],['rankings','Ranking'],['shares','Shared'],['profile','Profile'],['support','Help & Support']]);
  }
  function openChapter(chapterId){state.chapterId=chapterId;state.paragraphId=findBook().chapters.find(c=>c.id===chapterId)?.paragraphs[0]?.id||'';state.page='bookDetail';render()}
  function chapterView(){
    const ch=findChapter(); const done=ch.paragraphs.filter(p=>getProg(p.id).speakingAttempts.length>0).length; const unlocked=chapterTestUnlocked(ch);
    return layout(`<div class="breadcrumb">${esc(findSubject().name)} → ${esc(findBook().title)} → ${esc(ch.title)}</div><div class="row between wrap"><div><div class="eyebrow">CHAPTER</div><h1 class="title">${esc(ch.title)}</h1><div class="subtitle">${ch.pages.length} uploaded pages • ${done}/${ch.paragraphs.length} paragraph speaking tests completed</div></div><span class="pill ${unlocked?'green':'amber'}">${unlocked?'Full Chapter Test Unlocked':'Full Test Locked'}</span></div><div class="card" style="margin-top:16px"><div class="page-strip">${ch.pages.map(pg=>`<button class="page-dot ${state.pageNumber===pg.number?'active':''}" onclick="viewPage(${pg.number})">${pg.number}</button>`).join('')}</div><div class="grid g2"><div><h2 class="section-title">Paragraph View</h2>${ch.paragraphs.map(p=>{const pr=getProg(p.id);return `<div class="list-item"><div><b>${esc(p.title)}</b><div class="small muted">Max ${p.maxScore} marks • ${pr.speakingAttempts.length?`High ${Math.round(pr.highScore)}%`:'Not tested'}</div></div><div class="toolbar"><button class="btn secondary" onclick="openLesson('${p.id}')">Learn/Test</button><button class="btn ghost" onclick="shareContent('Paragraph','${p.id}','${esc(p.title)}')">Share</button></div></div>`}).join('')}</div><div><h2 class="section-title">Assessment Sections</h2><div class="list-item"><div><b>Q&A</b><div class="small muted">${ch.qa.length} questions • sequential speaking exam</div></div><button class="btn secondary" onclick="openQA()">Open</button></div><div class="list-item"><div><b>Formula / Sample</b><div class="small muted">${ch.formulas.length} formula cards</div></div><button class="btn secondary" onclick="openFormula()">Open</button></div><div class="list-item"><div><b>Full Chapter Test</b><div class="small muted">Separate chapter-level history</div></div><button class="btn ${unlocked?'primary':'ghost'}" ${unlocked?'':'disabled'} onclick="startChapterTest()">${unlocked?'Start':'Locked'}</button></div></div></div></div><div class="toolbar" style="margin-top:14px"><button class="btn ghost" onclick="editChapter('${ch.id}')">Edit Chapter</button><button class="btn ghost" onclick="deleteChapter('${ch.id}')">Delete Chapter</button></div>`, [['dashboard','Home'],['library','My Learning'],['history','History'],['progress','Progress'],['rankings','Ranking'],['shares','Shared'],['profile','Profile'],['support','Help & Support']]);
  }
  function viewPage(num){state.pageNumber=num;state.page='pageView';render()}
  function pageView(){
    const ch=findChapter();const pg=ch?.pages.find(p=>p.number===state.pageNumber);if(!pg)return chapterView();
    const idx=ch.pages.findIndex(p=>p.id===pg.id);const para=ch.paragraphs.find(p=>p.pageId===pg.id);
    return layout(`<div class="breadcrumb">${esc(findBook().title)} → ${esc(ch.title)} → Page ${pg.number}</div><div class="row between wrap"><div><div class="eyebrow">ORIGINAL PAGE VIEW</div><h1 class="title">Page ${pg.number}</h1><div class="subtitle">${esc(pg.imageName)} • Review: ${esc(pg.review)}</div></div><div class="toolbar"><button class="btn ghost" onclick="viewPage(${Math.max(1,ch.pages[Math.max(0,idx-1)]?.number||1)})">← Prev</button><button class="btn ghost" onclick="viewPage(${ch.pages[Math.min(ch.pages.length-1,idx+1)]?.number||pg.number})">Next →</button></div></div><div class="grid g2" style="margin-top:16px"><div class="card"><div class="hero" style="padding:18px"><div class="eyebrow">TEXTBOOK PAGE</div><div id="pageAsset" style="margin-top:12px;min-height:120px;display:flex;align-items:center;justify-content:center"><div class="small muted">Loading stored page asset…</div></div><div class="small muted" style="margin-top:10px">${esc(pg.imageName)} • ${pg.assetKey?'Stored locally in this browser':'Stored page metadata'}</div></div><div class="field" style="margin-top:14px"><label>EXTRACTED TEXT</label><textarea id="pageText">${esc(pg.extractedText)}</textarea></div><div class="toolbar"><button class="btn primary" onclick="savePageText('${pg.id}')">Save Extracted Text</button><button class="btn ghost" onclick="shareContent('Page','${pg.id}','Page ${pg.number} • ${esc(ch.title)}')">Share Page</button><button class="btn ghost" onclick="deletePage('${pg.id}')">Delete Page</button></div></div><div class="card"><div class="row between"><h2 class="section-title">Detected Paragraph</h2><span class="pill green">AI/OCR detected</span></div>${para?`<div class="paragraph">${esc(para.text)}</div><div class="toolbar" style="margin-top:12px"><button class="btn secondary" onclick="openLesson('${para.id}')">Open Paragraph Learning</button><button class="btn ghost" onclick="editParagraph('${para.id}')">Edit</button><button class="btn ghost" onclick="shareContent('Paragraph','${para.id}','${esc(para.title)}')">Share</button><button class="btn ghost" onclick="deleteParagraph('${para.id}')">Delete</button></div>`:'<div class="empty">No paragraph linked to this page yet.</div>'}</div></div>`, [['dashboard','Home'],['library','My Learning'],['history','History'],['progress','Progress'],['rankings','Ranking'],['shares','Shared'],['profile','Profile'],['support','Help & Support']]);
  }
  function savePageText(pageId){const pg=findChapter().pages.find(p=>p.id===pageId);const v=document.getElementById('pageText')?.value.trim();if(!pg||!v)return;pg.extractedText=v;const para=findChapter().paragraphs.find(p=>p.pageId===pageId);if(para)para.text=v;saveDb();addAudit('Edit Page Text',pageId);toast('Page text saved');render()}
  async function deletePage(pageId){if(!confirm('Delete this page from your own content? Shared recipients keep their accepted access unless you choose otherwise in the sharing manager.'))return;const ch=findChapter();const old=ch.pages.find(p=>p.id===pageId);ch.pages=ch.pages.filter(p=>p.id!==pageId);ch.paragraphs=ch.paragraphs.filter(p=>p.pageId!==pageId);if(old?.assetKey){await assetDelete(old.assetKey);if(API_BASE&&serverToken()){try{await apiFetch('/assets/'+encodeURIComponent(old.assetKey),{method:'DELETE'})}catch{}}}saveDb();addAudit('Delete Page',pageId);state.page='bookDetail';render();}
  async function deleteChapter(id){
    const b=findBook();const ch=b.chapters.find(c=>c.id===id);if(!ch)return;
    if(!confirm('Delete this chapter from your own content?'))return;
    for(const pg of (ch.pages||[])){if(pg.assetKey){try{await assetDelete(pg.assetKey)}catch{}}}
    const paragraphIds=new Set((ch.paragraphs||[]).map(p=>p.id));for(const key of Object.keys(db.progress)){const id=key.slice(key.indexOf(':')+1);if(paragraphIds.has(id))delete db.progress[key]}
    b.chapters=b.chapters.filter(c=>c.id!==id);saveDb();addAudit('Delete Chapter',id);state.chapterId=b.chapters[0]?.id||'';state.page='book';render();
  }
  function editChapter(id){const ch=findBook().chapters.find(c=>c.id===id);state.modal={type:'chapterEdit',id,title:ch?.title||''};render()}
  function editParagraph(id){const p=findChapter().paragraphs.find(x=>x.id===id);state.modal={type:'paragraphEdit',id,text:p?.text||'',title:p?.title||''};render()}
  async function deleteParagraph(id){
    const ch=findChapter(); const p=(ch?.paragraphs||[]).find(x=>x.id===id); if(!p)return;
    if(!confirm(`Delete paragraph "${p.title}" from your own content? Its page will remain, and accepted shared snapshots remain preserved.`))return;
    ch.paragraphs=ch.paragraphs.filter(x=>x.id!==id);
    for(const key of Object.keys(db.progress||{})){if(key.endsWith(':'+id)||key===id)delete db.progress[key]}
    saveDb(); addAudit('Delete Paragraph',id,`chapter=${ch.id}`); toast('Paragraph deleted from your own content'); state.page='bookDetail'; render();
  }

  async function startAntiCheat(targetId){
    if(!navigator.mediaDevices?.getUserMedia)return toast('Camera is not supported on this device');
    try{if(antiCheatStream)antiCheatStream.getTracks().forEach(t=>t.stop());antiCheatStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:640},height:{ideal:480}},audio:false});antiCheatActive=true;state.antiCheatTarget=targetId||'';state.antiCheatMessage='Camera enabled. No continuous video is stored; evidence is captured only when a trigger occurs.';render()}catch(e){toast('Camera permission was not granted')}}
  function stopAntiCheat(){if(antiCheatStream){antiCheatStream.getTracks().forEach(t=>t.stop());antiCheatStream=null}antiCheatActive=false}
  async function captureAntiCheat(trigger='Manual trigger'){
    if(!antiCheatStream||!antiCheatActive)return toast('Enable the camera first');
    const video=document.createElement('video');video.srcObject=antiCheatStream;video.muted=true;video.playsInline=true;
    try{await video.play();await new Promise(r=>setTimeout(r,100));const c=document.createElement('canvas');c.width=640;c.height=480;c.getContext('2d').drawImage(video,0,0,c.width,c.height);const imageData=c.toDataURL('image/jpeg',0.72);if(API_BASE&&serverToken()){const r=await apiFetch('/anti-cheat',{method:'POST',body:JSON.stringify({imageData,targetId:state.antiCheatTarget,trigger})});state.antiCheatMessage=`Evidence captured: ${r.evidence.id}`;addAudit('Anti-Cheating Evidence',state.antiCheatTarget,trigger);saveDb();toast('Anti-cheating evidence captured');render()}else toast('Server is required to save anti-cheating evidence')}catch(e){toast(e.message||'Evidence capture failed')}}
  function antiCheatPanel(targetId){return `<div class="card" style="margin-top:14px;box-shadow:none"><div class="row between wrap"><div><div class="eyebrow">ANTI-CHEATING EVIDENCE</div><b>Camera evidence is trigger-based</b><div class="small muted">No continuous video is stored. A JPEG snapshot is saved only after a trigger.</div></div><div class="toolbar"><button class="btn secondary" onclick="startAntiCheat('${targetId}')">${antiCheatActive?'Camera Enabled':'Enable Camera'}</button>${antiCheatActive?`<button class="btn ghost" onclick="captureAntiCheat('Manual evidence trigger')">Capture Evidence</button><button class="btn ghost" onclick="stopAntiCheat();render()">Stop Camera</button>`:''}</div></div>${antiCheatActive?'<video id="antiCheatPreview" autoplay muted playsinline style="width:100%;max-width:320px;border-radius:12px;margin-top:10px;background:#111"></video>':''}<div class="small muted" style="margin-top:8px">${esc(state.antiCheatMessage||'A trigger can occur manually or when the assessment tab is hidden.')}</div></div>`}
  function attachAntiCheatPreview(){const v=document.getElementById('antiCheatPreview');if(v&&antiCheatStream){v.srcObject=antiCheatStream;v.play().catch(()=>{})}}
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&antiCheatActive&&(state.page==='lesson'||state.page==='chapterTest'))captureAntiCheat('Assessment tab hidden')});

  function lesson(id){
    const p=findChapter().paragraphs.find(x=>x.id===id); if(!p)return chapterView(); state.paragraphId=id;const pr=getProg(id);
    if(state.readerMode==='qualification' || !pr.qualified){return qualificationView(p,pr)}
    return speakingView(p,pr);
  }
  function qualificationView(p,pr){
    return layout(`<div class="breadcrumb">${esc(findChapter().title)} → ${esc(p.title)}</div><div class="row between wrap"><div><div class="eyebrow">STEP 1 • QUALIFICATION READING</div><h1 class="title">${esc(p.title)}</h1><div class="subtitle">One qualification reading. Speaking unlocks when accuracy reaches 80% or higher.</div></div><span class="pill amber">${pr.readings} previous qualification attempt${pr.readings===1?'':'s'}</span></div><div class="card" style="margin-top:16px"><div class="paragraph">${esc(p.text)}</div><div class="grid g2" style="margin-top:16px"><div class="card" style="box-shadow:none"><div class="eyebrow">READ ALOUD</div><div class="meter" style="--val:${state.readerAccuracy}%"><strong>${Math.round(state.readerAccuracy)}%</strong></div><div class="center small muted">Speech accuracy</div><div class="toolbar" style="justify-content:center;margin-top:10px"><button class="btn primary" onclick="toggleQualificationMic()">${state.speakingListening?'Stop Listening':'Start Reading Mic'}</button><button class="btn ghost" onclick="useTypedForQualification()">Use Typed Transcript</button></div></div><div class="card" style="box-shadow:none"><div class="field"><label>RECOGNIZED / TYPED SPEECH</label><textarea id="qualText" placeholder="Speak with the microphone, or paste/type your reading here.">${esc(state.readerTranscript)}</textarea></div><button class="btn secondary" onclick="calculateQualification()">Check Reading Accuracy</button><p class="small muted" style="margin-bottom:0">Normal accents and pauses can be tolerated; finger tracking is not required.</p></div></div>${antiCheatPanel(p.id)}${state.readerAccuracy>=80?'<div class="demo" style="margin-top:14px"><b>Qualified.</b> Your Speaking Test can now unlock.</div>':'<div class="demo" style="margin-top:14px">Below 80% keeps the Speaking Test locked. Practice and retry the qualification reading.</div>'}</div>`, [['dashboard','Home'],['library','My Learning'],['history','History'],['progress','Progress'],['rankings','Ranking'],['shares','Shared'],['profile','Profile'],['support','Help & Support']]);
  }
  async function calculateQualification(){const p=findParagraph();const t=(document.getElementById('qualText')?.value||'').trim();if(!t){toast('Enter or speak the paragraph first');return}state.readerTranscript=t;let score=wordAccuracy(p.text,t);try{const a=await serverAssessment('Qualification',p.id,t);score=a.score}catch{}state.readerAccuracy=score;if(state.readerAccuracy>=80){const pr=getProg(p.id);pr.readings+=1;pr.qualified=true;setProg(p.id,pr);addAudit('Qualification Unlocked',p.id,`${Math.round(state.readerAccuracy)}%`);state.readerMode='speaking';toast('80% reached — Speaking Test unlocked');}else{const pr=getProg(p.id);pr.readings+=1;setProg(p.id,pr);toast(`Reading accuracy ${Math.round(state.readerAccuracy)}% — retry`)}render()}
  function useTypedForQualification(){calculateQualification()}
  function toggleQualificationMic(){state.speakingListening?stopRecognition():startRecognition('qualification')}

  function speakingView(p,pr){
    return layout(`<div class="breadcrumb">${esc(findChapter().title)} → ${esc(p.title)}</div><div class="row between wrap"><div><div class="eyebrow">STEP 2 • SPEAKING TEST</div><h1 class="title">${esc(p.title)}</h1><div class="subtitle">Qualified at ${Math.round(pr.qualified?Math.max(state.readerAccuracy,80):state.readerAccuracy)}%+. Retests are available without rereading unless reset.</div></div><span class="pill green">Unlocked</span></div><div class="card" style="margin-top:16px"><div class="grid g2"><div><div class="eyebrow">TEST WITHOUT LOOKING</div><div class="demo">The test uses speech-to-text + word matching. Extra words earn no extra marks; missing/wrong/order differences reduce the score.</div><div class="toolbar" style="margin-top:12px"><button class="btn primary" onclick="toggleSpeakingMic()">${state.speakingListening?'Stop Mic':'Start Speaking Mic'}</button><button class="btn ghost" onclick="resetSpeakingText()">Clear</button><button class="btn secondary" onclick="rereadParagraph()">Read This Paragraph Again</button></div><div class="field" style="margin-top:12px"><label>RECOGNIZED SPEECH</label><textarea id="speechText" placeholder="Your speech transcript appears here, or type/paste it for the demo scorer.">${esc(state.speakingTranscript)}</textarea></div><button class="btn secondary" onclick="submitSpeakingTest()">Finish Test & Score</button></div><div><h2 class="section-title">Maximum Score</h2><div class="big-score" style="font-size:56px">${p.maxScore}</div><div class="muted center">Current High Score: ${Math.round(pr.highScore)}%</div><div class="list" style="margin-top:16px">${pr.speakingAttempts.map((a,i)=>`<div class="list-item"><span>Attempt ${i+1}<div class="small muted">${fmtDate(a.date)}</div></span><b>${Math.round(a.score)}%</b></div>`).join('') || '<div class="small muted">No speaking attempts yet.</div>'}</div></div></div>${antiCheatPanel(p.id)}</div>`, [['dashboard','Home'],['library','My Learning'],['history','History'],['progress','Progress'],['rankings','Ranking'],['shares','Shared'],['profile','Profile'],['support','Help & Support']]);
  }
  function resetSpeakingText(){state.speakingTranscript='';render()}
  function toggleSpeakingMic(){state.speakingListening?stopRecognition():startRecognition('speaking')}
  async function submitSpeakingTest(){const p=findParagraph();const text=(document.getElementById('speechText')?.value||'').trim();if(!text){toast('Speak or enter an answer first');return}state.speakingTranscript=text;let score=wordAccuracy(p.text,text);let metrics=null;try{const a=await serverAssessment('Speaking',p.id,text);score=a.score;metrics=a.metrics||null}catch{}state.speakingScore=score;stopAntiCheat();const pr=getProg(p.id);pr.speakingAttempts.push({score,date:new Date().toISOString(),recognizedText:text,metrics,underline:buildUnderline(p.text,text)});pr.latestScore=score;pr.highScore=Math.max(pr.highScore,score);pr.underline=buildUnderline(p.text,text);pr.lastType='Speaking Test';setProg(p.id,pr);db.history.unshift({id:'H-'+Date.now(),studentId:state.currentId,content:p.title,type:'Speaking Test',score:Math.round(p.maxScore*score/100),max:p.maxScore,date:new Date().toISOString(),paragraphId:p.id});saveDb();addAudit('Speaking Test',p.id,`${Math.round(score)}%`);state.page='result';render()}
  function result(){const p=findParagraph();const pr=getProg(p.id);const latest=pr.speakingAttempts[pr.speakingAttempts.length-1];return layout(`<div class="center"><div class="eyebrow">RESULT</div><h1 class="title">${esc(p.title)}</h1><div class="big-score">${Math.round((p.maxScore*(latest?.score||0)/100))}/${p.maxScore}</div><div class="muted">${Math.round(latest?.score||0)}% • Attempt ${pr.speakingAttempts.length}</div>${latest?.metrics?`<div class="small muted" style="margin-top:8px">Correct words: ${latest.metrics.correctWords}/${latest.metrics.expectedWords} • Missing: ${latest.metrics.missingWords} • Extra: ${latest.metrics.extraWords} • Sequence: ${latest.metrics.sequenceAccuracy}%</div>`:''}</div><div class="grid g3" style="margin-top:16px"><div class="card stat"><div class="small muted">Latest Score</div><div class="num">${Math.round(latest?.score||0)}%</div></div><div class="card stat"><div class="small muted">High Score</div><div class="num">${Math.round(pr.highScore)}%</div></div><div class="card stat"><div class="small muted">Max Marks</div><div class="num">${p.maxScore}</div></div></div><div class="card" style="margin-top:16px"><h2 class="section-title">Latest Underline Snapshot</h2><div class="paragraph">${pr.underline||buildUnderline(p.text,state.speakingTranscript)}</div><div class="toolbar" style="margin-top:14px"><button class="btn primary" onclick="openLesson('${p.id}')">Retest</button><button class="btn secondary" onclick="openChapter('${findChapter().id}')">Back to Chapter</button><button class="btn ghost" onclick="go('history')">History</button></div></div>`, activeNav());}
  function buildUnderline(expected,got){const gt=normalizeTokens(got);const counts={};gt.forEach(w=>counts[w]=(counts[w]||0)+1);return normalizeTokens(expected).map(w=>{if(counts[w]){counts[w]--;return `<span class="word correct">${esc(w)}</span>`}return `<span class="word miss">${esc(w)}</span>`}).join(' ')}
  function normalizeTokens(t){return String(t||'').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu,' ').trim().split(/\s+/).filter(Boolean)}
  function wordAccuracy(expected,got){const e=normalizeTokens(expected),g=normalizeTokens(got);if(!e.length)return 0;const counts={};g.forEach(w=>counts[w]=(counts[w]||0)+1);let hit=0;e.forEach(w=>{if(counts[w]){counts[w]--;hit++}});return Math.round(hit/e.length*100)}

  function history(){const rows=db.history.filter(h=>h.studentId===state.currentId);return layout(`<div class="row between wrap"><div><div class="eyebrow">HISTORY</div><h1 class="title">Scores, attempts & High Scores</h1><div class="subtitle">Old records stay intact even when your content changes.</div></div><span class="pill">${rows.length} records</span></div><div class="toolbar" style="margin-top:14px"><button class="btn ${state.filter==='All'?'secondary':'ghost'}" onclick="setFilter('All')">All</button><button class="btn ${state.filter==='Speaking Test'?'secondary':'ghost'}" onclick="setFilter('Speaking Test')">Speaking</button><button class="btn ${state.filter==='Chapter Test'?'secondary':'ghost'}" onclick="setFilter('Chapter Test')">Chapter Test</button><button class="btn ${state.filter==='Q&A'?'secondary':'ghost'}" onclick="setFilter('Q&A')">Q&A</button><button class="btn ${state.filter==='Formula'?'secondary':'ghost'}" onclick="setFilter('Formula')">Formula</button></div><div class="card" style="margin-top:12px"><div class="table-wrap"><table class="table"><tr><th>Content</th><th>Type</th><th>Score</th><th>Attempt</th><th>Date</th></tr>${rows.filter(h=>state.filter==='All'||h.type===state.filter).map((h,i)=>`<tr><td>${esc(h.content)}</td><td>${esc(h.type)}</td><td><b>${h.score}/${h.max}</b></td><td>${h.attempt||i+1}</td><td>${fmtDate(h.date)}</td></tr>`).join('')||'<tr><td colspan="5">No matching records.</td></tr>'}</table></div></div>`, activeNav())}
  function setFilter(f){state.filter=f;render()}
  function periodAverage(rows,days){const cutoff=Date.now()-days*86400000;const vals=rows.filter(h=>new Date(h.date||h.createdAt||0).getTime()>=cutoff&&Number(h.max)>0).map(h=>Math.round(Number(h.score)/Number(h.max)*100));return vals.length?Math.round(vals.reduce((a,b)=>a+b,0)/vals.length):0;}
  function progress(){const own=db.history.filter(h=>h.studentId===state.currentId);const latest=own.slice(0,8).reverse();const chapter=findChapter();return layout(`<div class="eyebrow">PROGRESS</div><h1 class="title">Improvement & learning status</h1><div class="grid g3" style="margin-top:16px"><div class="card stat"><div class="small muted">Overall Attempt Average</div><div class="num">${own.length?Math.round(own.reduce((a,h)=>a+h.score/h.max*100,0)/own.length):0}%</div></div><div class="card stat"><div class="small muted">Learned Paragraphs</div><div class="num">${chapter.paragraphs.filter(p=>getProg(p.id).speakingAttempts.length>0).length}/${chapter.paragraphs.length}</div></div><div class="card stat"><div class="small muted">Active Study Minutes</div><div class="num">${db.usage.activeMinutes}</div></div></div><div class="card" style="margin-top:16px"><h2 class="section-title">Attempt Trend</h2>${latest.length?`<div class="list">${latest.map((h,i)=>`<div><div class="row between small"><span>${i+1}. ${esc(h.content)} • ${esc(h.type)}</span><b>${Math.round(h.score/h.max*100)}%</b></div><div class="progress"><span style="width:${Math.round(h.score/h.max*100)}%"></span></div></div>`).join('')}</div>`:'<div class="empty">Complete your first test to see the trend.</div>'}</div><div class="card" style="margin-top:16px"><h2 class="section-title">Weekly / Monthly Progress</h2><div class="grid g2"><div><div class="small muted">Last 7 days</div><div class="num">${periodAverage(own,7)}%</div><div class="small muted">Average completed assessment score</div></div><div><div class="small muted">Last 30 days</div><div class="num">${periodAverage(own,30)}%</div><div class="small muted">Average completed assessment score</div></div></div><div class="small muted" style="margin-top:10px">Progress summaries are calculated from stored assessment attempts and do not overwrite official scores.</div></div><div class="card" style="margin-top:16px"><h2 class="section-title">Year / Class Continuity</h2><div class="list">${(current().history||[]).map(x=>`<div class="list-item"><div><b>${esc(x.year||'')}</b><div class="small muted">${esc(x.school||'No school')} • Class ${esc(x.className||'—')} • Section ${esc(x.section||'—')}</div></div><span class="pill">History preserved</span></div>`).join('')}</div></div>`, activeNav())}

  function chapterTestUnlocked(ch){return !!ch && ch.paragraphs.length>0 && ch.paragraphs.every(p=>getProg(p.id).qualified===true);}
  function startChapterTest(){const ch=findChapter();const unlocked=chapterTestUnlocked(ch);if(!unlocked){toast('Complete 80% reading qualification for every paragraph first');return}state.chapterIndex=0;state.chapterAnswers={};state.page='chapterTest';render()}
  function chapterTest(){const ch=findChapter();if(ch.paragraphs.length===0)return chapterView();const p=ch.paragraphs[state.chapterIndex];const saved=state.chapterAnswers[p.id]||'';const allDone=state.chapterIndex>=ch.paragraphs.length; if(allDone)return chapterResult();return layout(`<div class="eyebrow">FULL CHAPTER TEST</div><div class="row between wrap"><div><h1 class="title">${esc(ch.title)}</h1><div class="subtitle">Paragraph ${state.chapterIndex+1} of ${ch.paragraphs.length} • Max ${ch.paragraphs.reduce((a,x)=>a+x.maxScore,0)} marks</div></div><span class="pill purple">Sequential</span></div><div class="card" style="margin-top:16px"><div class="demo"><b>Speak without looking.</b> This combined test creates a separate Chapter Test record; paragraph records remain unchanged.</div><h2 class="section-title" style="margin-top:16px">${esc(p.title)}</h2><div class="field"><label>RECOGNIZED SPEECH</label><textarea id="chapterSpeech" placeholder="Speak or type this paragraph">${esc(saved)}</textarea></div><div class="toolbar"><button class="btn primary" onclick="checkChapterParagraph()">Check & Continue</button><button class="btn ghost" onclick="toggleChapterMic()">Mic</button></div>${antiCheatPanel(ch.id)}</div>`, activeNav())}
  function toggleChapterMic(){state.speakingListening?stopRecognition():startRecognition('chapter')}
  function checkChapterParagraph(){const p=findChapter().paragraphs[state.chapterIndex];const text=(document.getElementById('chapterSpeech')?.value||'').trim();if(!text){toast('Enter speech first');return}state.chapterAnswers[p.id]=text;state.chapterIndex+=1;saveDb();render()}
  async function chapterResult(){const ch=findChapter();const parts=ch.paragraphs.map(p=>{const t=state.chapterAnswers[p.id]||'';const pct=wordAccuracy(p.text,t);return {paragraphId:p.id,title:p.title,score:Math.round(p.maxScore*pct/100),max:p.maxScore,pct,transcript:t}});let serverAttempt=null;try{serverAttempt=await serverChapterAssessment(ch.id,parts.map(x=>({paragraphId:x.paragraphId,transcript:x.transcript})));}catch(e){}const score=serverAttempt?Math.round(serverAttempt.score/100*ch.paragraphs.reduce((a,x)=>a+x.maxScore,0)):parts.reduce((a,x)=>a+x.score,0),max=parts.reduce((a,x)=>a+x.max,0),pct=serverAttempt?serverAttempt.score:Math.round(score/max*100);const old=db.history.filter(h=>h.studentId===state.currentId&&h.type==='Chapter Test'&&h.content===ch.title);const attempt=serverAttempt?.attempt||old.length+1;const high=serverAttempt?.highScore||Math.max(pct,...old.map(h=>Math.round(h.score/h.max*100)));db.history.unshift({id:'CH-'+Date.now(),studentId:state.currentId,content:ch.title,type:'Chapter Test',score,max,date:new Date().toISOString(),attempt,highScore:high,parts});saveDb();addAudit('Full Chapter Test',ch.id,`${score}/${max}`);state.chapterIndex=0;return layout(`<div class="center"><div class="eyebrow">CHAPTER RESULT</div><h1 class="title">${esc(ch.title)}</h1><div class="big-score">${score}/${max}</div><div class="muted">Attempt ${attempt} • ${pct}% • Chapter High Score ${high}%</div></div><div class="card" style="margin-top:16px"><h2 class="section-title">Paragraph-wise breakdown</h2><div class="list">${parts.map(x=>`<div class="list-item"><div><b>${esc(x.title)}</b><div class="small muted">${x.pct}% match</div></div><b>${x.score}/${x.max}</b></div>`).join('')}</div></div><div class="toolbar" style="margin-top:14px"><button class="btn primary" onclick="openChapter('${ch.id}')">Back to Chapter</button><button class="btn ghost" onclick="go('history')">History</button></div>`, activeNav())}

  function openQA(){state.qaIndex=0;state.page='qa';render()}
  function qaView(){const ch=findChapter();if(!ch.qa.length)return layout('<div class="empty">No Q&A uploaded for this chapter yet.</div>',activeNav());const q=ch.qa[state.qaIndex];const key=progressKey(q.id);const pr=db.progress[key]||{qaQualified:false,qaAttempts:[],qaDone:false,highScore:0};return pr.qaQualified?qaExam(q,pr):qaQualification(q,pr)}
  function qaQualification(q,pr){return layout(`<div class="eyebrow">Q&A • READ TO UNLOCK</div><h1 class="title">Question ${q.number}</h1><div class="card" style="margin-top:16px"><div class="demo"><b>Question:</b> ${esc(q.question)}<br><br><b>Correct Answer:</b> ${esc(q.answer)}</div><div class="field" style="margin-top:14px"><label>READING TRANSCRIPT</label><textarea id="qaRead">${esc(pr?.lastRead||'')}</textarea></div><div class="toolbar"><button class="btn primary" onclick="qualifyQA('${q.id}')">Check 80% Reading</button><button class="btn ghost" onclick="toggleQAMic('qualification')">Mic</button></div><div class="small muted" style="margin-top:10px">Speaking answer stays locked until the question's reading qualification reaches 80%.</div></div>`, activeNav())}
  async function qualifyQA(qid){const q=findChapter().qa.find(x=>x.id===qid);const text=(document.getElementById('qaRead')?.value||'').trim();if(!text){toast('Read the question and answer first');return}let pct=wordAccuracy(`${q.question} ${q.answer}`,text);try{const a=await serverAssessment('QAQualification',qid,text);pct=a.score}catch{}const pr=db.progress[progressKey(q.id)]||{qaQualified:false,qaAttempts:[],qaDone:false,highScore:0};pr.readings=(pr.readings||0)+1;pr.lastRead=text;if(pct>=80){pr.qaQualified=true;toast('80% reached — Q&A speaking unlocked')}else toast(`Reading accuracy ${pct}% — retry`);db.progress[progressKey(q.id)]=pr;saveDb();render()}
  function qaExam(q,pr){return layout(`<div class="eyebrow">Q&A SPEAKING EXAM</div><div class="row between wrap"><div><h1 class="title">Question ${q.number}</h1><div class="subtitle">One question at a time • Max ${q.maxScore} marks</div></div><span class="pill green">Unlocked</span></div><div class="card" style="margin-top:16px"><div class="demo"><b>Question:</b> ${esc(q.question)}</div><div class="field" style="margin-top:14px"><label>SPOKEN ANSWER</label><textarea id="qaAnswer" placeholder="Speak or type the answer">${esc(pr.lastAnswer||'')}</textarea></div><div class="toolbar"><button class="btn primary" onclick="submitQA('${q.id}')">Check Answer</button><button class="btn ghost" onclick="toggleQAMic('answer')">Mic</button></div></div><div class="card" style="margin-top:16px"><div class="row between"><span>Total Q&A Marks</span><b>${findChapter().qa.reduce((a,x)=>a+x.maxScore,0)}</b></div><div class="small muted" style="margin-top:5px">Question ${state.qaIndex+1} of ${findChapter().qa.length}</div></div>`, activeNav())}
  async function submitQA(qid){const q=findChapter().qa.find(x=>x.id===qid);const text=(document.getElementById('qaAnswer')?.value||'').trim();if(!text){toast('Answer first');return}let pct=wordAccuracy(q.answer,text);try{const a=await serverAssessment('QA',qid,text);pct=a.score}catch{}const pr=db.progress[progressKey(q.id)]||{};pr.lastAnswer=text;pr.qaAttempts=pr.qaAttempts||[];pr.qaAttempts.push({score:pct,date:new Date().toISOString(),underline:buildUnderline(q.answer,text)});pr.highScore=Math.max(pr.highScore||0,pct);pr.qaDone=true;db.progress[progressKey(q.id)]=pr;db.history.unshift({id:'QA-'+Date.now(),studentId:state.currentId,content:`Q${q.number}: ${q.question}`,type:'Q&A',score:Math.round(q.maxScore*pct/100),max:q.maxScore,date:new Date().toISOString(),attempt:pr.qaAttempts.length});saveDb();addAudit('Q&A Test',q.id,`${Math.round(pct)}%`);if(state.qaIndex<findChapter().qa.length-1){state.qaIndex+=1;toast(`Score ${Math.round(pct)}% — Next question`);render()}else{state.qaIndex=0;go('history')}}
  function toggleQAMic(mode){state.speakingListening?stopRecognition():startRecognition(mode==='answer'?'qa-answer':'qa-qualification')}

  function openFormula(){state.page='formula';render()}
  function formulaView(){const ch=findChapter();if(!ch.formulas.length)return layout('<div class="empty">No Formula/Sample cards uploaded for this chapter yet.</div>',activeNav());const f=ch.formulas[0];return layout(`<div class="eyebrow">FORMULA / SAMPLE SPEAKING</div><div class="row between wrap"><div><h1 class="title">${esc(f.sampleName)}</h1><div class="subtitle">Formula structure checking with spoken aliases.</div></div><span class="pill purple">Max ${f.maxScore}</span></div><div class="card" style="margin-top:16px"><div class="hero" style="padding:18px"><div class="eyebrow">FORMULA</div><div style="font-size:30px;margin-top:8px;color:#fff;font-weight:800">${esc(f.formula)}</div></div><div class="demo" style="margin-top:14px"><b>How to say:</b> “E equals P multiply t” or another approved equivalent.</div><div class="field" style="margin-top:14px"><label>SPOKEN FORMULA</label><textarea id="formulaSpeech" placeholder="Example: E equals P multiply t">${esc(state.formulaTranscript)}</textarea></div><div class="toolbar"><button class="btn primary" onclick="submitFormula('${f.id}')">Check Formula</button><button class="btn ghost" onclick="toggleFormulaMic()">Mic</button></div></div>`, activeNav())}
  function toggleFormulaMic(){state.speakingListening?stopRecognition():startRecognition('formula')}
  function normalizeFormulaSpeech(s){return String(s||'').toLowerCase().replace(/multiply|into|times/g,'*').replace(/equals|equal to|is equal to/g,'=').replace(/plus/g,'+').replace(/minus/g,'-').replace(/divide|divided by|slash/g,'/').replace(/square root/g,'sqrt').replace(/[^a-z0-9*=+\-/.\s]/g,' ').replace(/\s+/g,' ').trim()}
  async function submitFormula(id){const f=findChapter().formulas.find(x=>x.id===id);const text=(document.getElementById('formulaSpeech')?.value||'').trim();if(!text){toast('Speak or type the formula');return}state.formulaTranscript=text;let serverScore=null;try{const a=await serverAssessment('Formula',id,text);serverScore=a.score}catch{}const got=normalizeFormulaSpeech(text),exp=normalizeFormulaSpeech(f.formula);const ok=got.replace(/\s/g,'')===exp.replace(/\s/g,'') || f.spokenAliases.some(a=>normalizeFormulaSpeech(a).replace(/\s/g,'')===got.replace(/\s/g,''));const pct=serverScore===null?(ok?100:(wordAccuracy(f.spokenAliases.join(' '),text)>=60?60:0)):serverScore;db.history.unshift({id:'F-'+Date.now(),studentId:state.currentId,content:f.sampleName,type:'Formula',score:Math.round(f.maxScore*pct/100),max:f.maxScore,date:new Date().toISOString(),attempt:db.history.filter(h=>h.studentId===state.currentId&&h.type==='Formula'&&h.content===f.sampleName).length+1});saveDb();addAudit('Formula Test',f.id,`${pct}%`);toast(`Formula result: ${pct}%`);go('history')}

  function uploadView(){return layout(`<div class="eyebrow">CONTENT UPLOAD</div><h1 class="title">Build your own Subject / Book / Chapter</h1><div class="subtitle">Student has full authority over their own Subject, Book, Chapter, Page and Paragraph content in this final model.</div><div class="card" style="margin-top:16px"><div class="grid g2"><div class="field"><label>SUBJECT</label><select id="upSubject">${db.subjects.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}<option value="NEW">+ New Subject</option></select></div><div class="field"><label>BOOK</label><select id="upBook"></select></div><div class="field"><label>CHAPTER</label><select id="upChapter"></select></div><div class="field"><label>NEW CHAPTER NAME (optional)</label><input id="newChapter" placeholder="Detected automatically from heading when possible" /></div></div><div class="field"><label>PAGE PHOTOS / PDFS</label><input id="pageFiles" type="file" accept="image/*,.pdf" multiple /></div><div class="field"><label>EXTRACTED TEXT (OCR REVIEW)</label><textarea id="upText" placeholder="You can review and correct OCR text before saving. Multi-page uploads are supported."></textarea></div><div class="demo"><b>Automatic chapter detection:</b> file names containing “chapter 2”, “ch2”, etc. are grouped into that chapter. Otherwise the selected chapter is used. Low-confidence cases stay editable for confirmation.</div><div class="toolbar" style="margin-top:12px"><button class="btn primary" onclick="processUpload()">Detect & Save Pages</button><button class="btn ghost" onclick="go('library')">Cancel</button></div></div>`, activeNav())}
  function refreshUploadOptions(){const sid=document.getElementById('upSubject')?.value;const s=findSubjectBy(sid);if(!s)return;const bs=document.getElementById('upBook');bs.innerHTML=s.books.map(b=>`<option value="${b.id}">${esc(b.title)}</option>`).join('');const b=s.books[0];document.getElementById('upChapter').innerHTML=b?.chapters.map(c=>`<option value="${c.id}">${esc(c.title)}</option>`).join('')||'<option value="">No chapter yet</option>';}
  function detectChapterFromFilename(name, fallback){
    const m=String(name||'').match(/chapter\s*[-_]?\s*(\d+)|\bch\s*[-_]?\s*(\d+)\b/i);
    if(!m)return {title:fallback.title, confidence:'Selected chapter'};
    const n=Number(m[1]||m[2]);
    const existing=findBook().chapters.find(c=>c.order===n);
    return {title:existing?.title||`Chapter ${n}`, order:n, confidence:existing?'Detected from chapter number':'Detected chapter number — review name'};
  }
  function ocrMime(file){
    const type=String(file?.type||'').toLowerCase().split(';')[0].trim();
    if(type==='image/jpeg'||type==='image/png'||type==='image/webp'||type==='application/pdf')return type;
    const name=String(file?.name||'').toLowerCase();
    if(name.endsWith('.pdf'))return 'application/pdf';
    if(name.endsWith('.png'))return 'image/png';
    if(name.endsWith('.webp'))return 'image/webp';
    if(name.endsWith('.jpg')||name.endsWith('.jpeg'))return 'image/jpeg';
    return type || 'application/octet-stream';
  }
  async function processUpload(){
    const sid=document.getElementById('upSubject')?.value; const bookId=document.getElementById('upBook')?.value; const chId=document.getElementById('upChapter')?.value; const text=(document.getElementById('upText')?.value||'').trim(); const files=[...(document.getElementById('pageFiles')?.files||[])];
    if(sid==='NEW'){toast('Use + New Subject from the library first');return}
    const s=findSubjectBy(sid), b=s.books.find(x=>x.id===bookId); if(!b){toast('Select a book');return}
    let fallback=b.chapters.find(x=>x.id===chId); const newCh=(document.getElementById('newChapter')?.value||'').trim();
    if(!fallback && !newCh){toast('Select or name a chapter');return}
    if(newCh)fallback={id:'NEW',title:newCh,order:b.chapters.length+1,complete:false,pages:[],paragraphs:[],qa:[],formulas:[]};
    if(!files.length && !text){toast('Choose a file or enter extracted text');return}
    const items=[];
    if(files.length){
      for(let i=0;i<files.length;i++){
        const file=files[i]; let rawText=''; let det=detectChapterFromFilename(file?.name,fallback); let ocr='manual review'; let ocrError='';
        if(API_BASE){
          try{
            // OCR is intentionally session-independent. The server exposes /api/ocr before
            // the authenticated student routes, so an expired/stale student token must not
            // prevent document text extraction. Saving the page still requires the normal
            // authenticated flow below.
            const data=await blobToDataUrl(file);
            const r=await ocrFetch('/ocr',{mime:ocrMime(file),data:String(data).split(',')[1]||'',lang:'eng+hin'});
            rawText=String(r.text||'').trim();
            const detectedParagraphs=Array.isArray(r.paragraphs)?r.paragraphs:[];
            if(r.chapterDetection?.title&&r.chapterDetection?.confidence==='Detected from OCR heading') det={title:r.chapterDetection.title,order:r.chapterDetection.number,confidence:r.chapterDetection.confidence};
            items.push({name:file.name,text:rawText||'No text detected. You can correct the text below before saving.',paragraphs:detectedParagraphs,detected:det,file,ocr:'server OCR',ocrError:'',ocrLanguage:r.ocrLanguage||'',pageCount:r.pageCount||1});
            toast(`OCR ${i+1}/${files.length}: ${detectedParagraphs.length} paragraph(s)`);
            continue;
          }catch(e){
            ocrError=e?.message||'processing failed';
            if(/authentication required|unauthorized|401/i.test(ocrError)) ocrError='Deployed OCR endpoint is still protected by login. Replace the repo-root server.js with V67 and redeploy Render.';
            // Retry once through the same stateless OCR endpoint. This deliberately never uses
            // the student's session token, so an expired login cannot turn OCR into a 401.
            try{
              if(API_BASE && /authentication required|unauthorized|401/i.test(ocrError)){
                const data=await blobToDataUrl(file);
                const r=await ocrFetch('/ocr',{mime:ocrMime(file),data:String(data).split(',')[1]||'',lang:'eng+hin'});
                rawText=String(r.text||'').trim();
                const detectedParagraphs=Array.isArray(r.paragraphs)?r.paragraphs:[];
                if(r.chapterDetection?.title)det={title:r.chapterDetection.title,order:r.chapterDetection.number,confidence:r.chapterDetection.confidence||'Detected from OCR heading'};
                items.push({name:file.name,text:rawText||'No text detected. You can correct the text below before saving.',paragraphs:detectedParagraphs,detected:det,file,ocr:'server OCR',ocrError:'',ocrLanguage:r.ocrLanguage||'',pageCount:r.pageCount||1});
                toast(`OCR ${i+1}/${files.length}: ${detectedParagraphs.length} paragraph(s)`);
                continue;
              }
            }catch(retryErr){ocrError=retryErr?.message||ocrError}
          }
        }else ocrError='OCR server is unavailable. Open the deployed app over HTTPS and try again.';
        items.push({name:file.name,text:`OCR failed: ${ocrError||'processing failed'}. You can correct the text below before saving.`,paragraphs:[],detected:det,file,ocr,ocrError});
      }
    }
    if(!files.length&&text){items.push({name:'manual-page.txt',text,paragraphs:[{id:'MANUAL-1',title:'Detected Paragraph 1',text}],detected:detectChapterFromFilename('',fallback),file:null,ocr:'manual'});}
    state.modal={type:'uploadPreview',subjectId:s.id,bookId:b.id,selectedChapterId:chId,newChapter:newCh,items};render();
  }
  async function uploadAssetToServer(key,blob){if(!API_BASE||!serverToken()||!blob)return false;const data=await blobToDataUrl(blob);await apiFetch('/assets/'+encodeURIComponent(key),{method:'PUT',body:JSON.stringify({mime:blob.type||'application/octet-stream',data:String(data).split(',')[1]||''})});return true}
  async function confirmUpload(){
    const m=state.modal;if(!m||m.type!=='uploadPreview')return; const s=findSubjectBy(m.subjectId); const b=s.books.find(x=>x.id===m.bookId);if(!b)return;
    const groups={};
    m.items.forEach(x=>{const key=x.detected.title;groups[key]??={title:key,order:x.detected.order||b.chapters.length+1,confidence:x.detected.confidence,items:[]};groups[key].items.push(x)});
    for (const g of Object.values(groups)) {
      let ch=b.chapters.find(c=>c.title===g.title);if(!ch){ch={id:'CH-'+Date.now()+'-'+Math.random().toString(36).slice(2,7),title:g.title,order:g.order||b.chapters.length+1,complete:false,pages:[],paragraphs:[],qa:[],formulas:[]};b.chapters.push(ch)}
      const base=ch.pages.length?Math.max(...ch.pages.map(p=>p.number)):0;
      for(let i=0;i<g.items.length;i++){const item=g.items[i];const n=base+i+1;const pageId='PG-'+Date.now()+'-'+i+'-'+Math.random().toString(36).slice(2,6);const assetKey=item.file?`asset:${state.currentId}:${pageId}`:'';if(item.file&&assetKey){try{await assetPut(assetKey,item.file);try{await uploadAssetToServer(assetKey,item.file)}catch{toast('Page saved locally; server asset upload will retry on next sync')}}catch{toast('Page saved, but one binary asset could not be stored')}}const pg={id:pageId,number:n,imageName:item.name,extractedText:item.text,review:'Pending Review',assetKey,chapterDetection:{confidence:g.confidence,status:'Confirmed'}};ch.pages.push(pg);const paraList=Array.isArray(item.paragraphs)&&item.paragraphs.length?item.paragraphs:[{text:item.text,title:`Detected Paragraph ${ch.paragraphs.length+1}`}];for(const detected of paraList){ch.paragraphs.push({id:'P-'+Date.now()+'-'+Math.random().toString(36).slice(2,7),pageId:pg.id,title:detected.title||`Detected Paragraph ${ch.paragraphs.length+1}`,text:detected.text||item.text,maxScore:10,weights:{}});}} 
    }
    saveDb();addAudit('Upload Page(s)',b.id,`${m.items.length} page(s); AI chapter grouping reviewed and confirmed`);state.modal=null;state.subjectId=s.id;state.bookId=b.id;state.chapterId=(Object.values(groups)[0] && b.chapters.find(c=>c.title===Object.values(groups)[0].title)?.id) || b.chapters[0]?.id || '';state.page='book';toast(`${m.items.length} page(s) added with chapter grouping`);render();
  }
  function editPageNotUsed(){ }

  async function rankings(){
    let data=null;
    if(API_BASE&&serverToken()){try{data=await apiFetch('/rankings')}catch{} }
    const rows=data?.rankings||[];
    const me=rows.find(x=>x.isCurrent);
    return layout(`<div class="row between wrap"><div><div class="eyebrow">ACADEMIC RANKING</div><h1 class="title">Class & Section Ranking</h1><div class="subtitle">Student visibility is limited to the same school + class + section.</div></div></div><div class="card" style="margin-top:16px"><div class="small muted">${data?.available?`${esc(data.scope.school)} • Class ${esc(data.scope.className)} • Section ${esc(data.scope.section)}`:'Ranking is not available until school, class and section are configured.'}</div>${rows.length?`<div class="list" style="margin-top:12px">${rows.map(x=>`<div class="list-item"><div><b>#${x.rank} ${esc(x.displayName)}${x.isCurrent?' (You)':''}</b><div class="small muted">${x.attempted} assessment item(s)</div></div><b>${x.score}%</b></div>`).join('')}</div>`:'<div class="empty" style="margin-top:12px">No comparable assessment records are available yet.</div>'}</div>`, activeNav());
  }
  function sharesView(){const meId=state.currentId;const inc=db.shares.incoming.filter(x=>(x.toStudentId||meId)===meId&&x.status!=='Rejected');const out=db.shares.outgoing.filter(x=>x.fromStudentId===meId);const accepted=inc.filter(x=>x.status==='Accepted');return layout(`<div class="row between wrap"><div><div class="eyebrow">SHARED CONTENT</div><h1 class="title">Sharing & Requests</h1><div class="subtitle">Share Subject, Book, Chapter, Page or Paragraph. Receiver must accept before learning features become active.</div></div><button class="btn primary" onclick="shareContent('Book',findBook().id,findBook().title)">Share Current Book</button></div><div class="grid g2" style="margin-top:16px"><div class="card"><h2 class="section-title">Incoming Requests</h2>${inc.length?inc.map(x=>`<div class="list-item"><div><b>${esc(x.targetLabel)}</b><div class="small muted">From ${esc(x.fromName)} (${esc(x.fromStudentId)})</div></div>${x.status==='Pending'?`<div class="toolbar"><button class="btn success" onclick="acceptShare('${x.id}')">Accept</button><button class="btn danger" onclick="rejectShare('${x.id}')">Reject</button></div>`:`<span class="pill green">${esc(x.status)}</span>`}</div>`).join(''):'<div class="empty">No incoming share requests.</div>'}</div><div class="card"><h2 class="section-title">Outgoing Requests</h2>${out.length?out.map(x=>`<div class="list-item"><div><b>${esc(x.targetLabel)}</b><div class="small muted">To ${esc(x.toStudentId)}</div></div><span class="pill ${x.status==='Accepted'?'green':'amber'}">${esc(x.status)}</span></div>`).join(''):'<div class="empty">No outgoing requests.</div>'}</div></div><div class="card" style="margin-top:16px"><h2 class="section-title">Accepted Shared Learning</h2>${accepted.length?`<div class="list">${accepted.map(x=>`<div class="list-item"><div><b>${esc(x.targetLabel)}</b><div class="small muted">Shared by ${esc(x.fromName)} (${esc(x.fromStudentId)})</div></div><button class="btn secondary" onclick="openShared('${x.id}')">Open</button></div>`).join('')}</div>`:'<div class="empty">No accepted shared content yet.</div>'}<div class="demo" style="margin-top:12px">Shared content stays canonical while your scores, attempts, history and progress remain your own.</div></div>`, activeNav())}
  function shareContent(type,id,label){state.modal={type:'share',shareType:type,shareId:id,shareLabel:label};render()}
  function shareModal(){return `<div class="modal-backdrop"><div class="modal"><div class="row between"><div><div class="eyebrow">SHARE CONTENT</div><h2 class="section-title" style="font-size:22px">${esc(state.modal.shareLabel)}</h2><div class="small muted">${esc(state.modal.shareType)}</div></div><button class="btn ghost" onclick="window.closeModal();return false" type="button">Close</button></div><div class="field"><label>RECEIVING STUDENT ID</label><input id="shareTarget" placeholder="Example: STU-002" /></div><button class="btn primary" onclick="sendShare()">Send Share Request</button><p class="small muted">The receiving Student must accept the request before using all learning features.</p></div></div>`}
  function cloneSharedTarget(type,id){
    for(const s of db.subjects||[]) for(const b of s.books||[]) for(const ch of b.chapters||[]){
      if(type==='Subject' && s.id===id) return {type,sourceId:id,subject:structuredCloneSafe(s)};
      if(type==='Book' && b.id===id) return {type,sourceId:id,subjectId:s.id,book:structuredCloneSafe(b)};
      if(type==='Chapter' && ch.id===id) return {type,sourceId:id,subjectId:s.id,bookId:b.id,chapter:structuredCloneSafe(ch)};
      if(type==='Page') { const pg=(ch.pages||[]).find(x=>x.id===id); if(pg) return {type,sourceId:id,subjectId:s.id,bookId:b.id,chapterId:ch.id,page:structuredCloneSafe(pg),paragraph:structuredCloneSafe((ch.paragraphs||[]).find(x=>x.pageId===id)||null)}; }
      if(type==='Paragraph') { const para=(ch.paragraphs||[]).find(x=>x.id===id); if(para) return {type,sourceId:id,subjectId:s.id,bookId:b.id,chapterId:ch.id,paragraph:structuredCloneSafe(para)}; }
    }
    return null;
  }
  function openSharedSnapshot(x){
    const snap=db.shares.snapshots?.[x.id]; if(!snap)return false;
    state.sharedSnapshot=snap; state.page='sharedSnapshot'; render(); return true;
  }
  function sharedSnapshotView(){
    const snap=state.sharedSnapshot; if(!snap)return sharesView();
    let title=x=>x||'Shared Content'; let body='';
    if(snap.type==='Paragraph') body=`<div class="paragraph">${esc(snap.paragraph?.text||'')}</div>`;
    else if(snap.type==='Page') body=`<div class="paragraph"><b>Extracted Text</b><br>${esc(snap.page?.extractedText||'')}</div>${snap.paragraph?`<div class="paragraph" style="margin-top:12px"><b>${esc(snap.paragraph.title)}</b><br>${esc(snap.paragraph.text)}</div>`:''}`;
    else if(snap.type==='Chapter') body=(snap.chapter?.paragraphs||[]).map(p=>`<div class="list-item"><div><b>${esc(p.title)}</b><div class="small muted">${esc(p.text)}</div></div></div>`).join('')||'<div class="empty">No paragraphs in this shared chapter.</div>';
    else if(snap.type==='Book') body=(snap.book?.chapters||[]).map(c=>`<div class="list-item"><b>${esc(c.title)}</b><span class="pill">${(c.paragraphs||[]).length} paragraphs</span></div>`).join('')||'<div class="empty">No chapters in this shared book.</div>';
    else if(snap.type==='Subject') body=(snap.subject?.books||[]).map(b=>`<div class="list-item"><b>${esc(b.title)}</b><span class="pill">${(b.chapters||[]).length} chapters</span></div>`).join('')||'<div class="empty">No books in this shared subject.</div>';
    return layout(`<div class="eyebrow">ACCEPTED SHARED CONTENT</div><h1 class="title">${esc(title(snap.type))}</h1><div class="subtitle">This accepted snapshot is preserved independently from the owner's later edits or deletion. Your assessment history remains separate.</div><div class="card" style="margin-top:16px"><div class="list">${body}</div></div><div class="toolbar" style="margin-top:14px"><button class="btn primary" onclick="go('shares')">Back to Shared</button></div>`,activeNav());
  }
  async function sendShare(){const target=(document.getElementById('shareTarget')?.value||'').trim().toUpperCase();if(!target){toast('Enter a receiving Student ID');return}if(target===state.currentId){toast('Choose another Student ID');return}if(API_BASE&&serverToken()){try{const r=await apiFetch('/shares',{method:'POST',body:JSON.stringify({toStudentId:target,targetType:state.modal.shareType,targetId:state.modal.shareId,targetLabel:state.modal.shareLabel})});db.shares.outgoing.unshift(r.share);saveDb();addAudit('Share Content',state.modal.shareId,`to ${target}; ${state.modal.shareType}`);state.modal=null;toast(`Share request sent to ${target}`);render();return}catch(e){toast(e.message||'Share request failed');return}}const receiver=db.accounts.find(a=>a.id===target&&a.status==='Active');if(!receiver){toast('Receiving Student ID was not found');return}const duplicate=db.shares.outgoing.some(s=>s.fromStudentId===state.currentId&&s.toStudentId===target&&s.targetType===state.modal.shareType&&s.targetId===state.modal.shareId&&s.status==='Pending');if(duplicate){toast('A pending share request already exists');return}const x={id:'SHARE-'+Date.now(),fromStudentId:state.currentId,fromName:current().name,toStudentId:target,targetType:state.modal.shareType,targetId:state.modal.shareId,targetLabel:state.modal.shareLabel,status:'Pending'};db.shares.outgoing.unshift(x);saveDb();addAudit('Share Content',state.modal.shareId,`to ${target}; ${state.modal.shareType}`);state.modal=null;toast(`Share request saved locally for ${target}`);render()}
  function syncShareStatus(id,status){
    const outgoingId=id.endsWith('-IN')?id.slice(0,-3):id;
    const out=db.shares.outgoing.find(s=>s.id===outgoingId);
    if(out) out.status=status;
  }
  function openShared(id){
    const x=db.shares.incoming.find(s=>s.id===id && s.status==='Accepted');
    if(!x){toast('This shared item is not accepted yet');return}
    if(db.shares.snapshots?.[id]) return openSharedSnapshot(x);
    toast('Accepted shared snapshot is missing');
  }
  async function acceptShare(id){const x=db.shares.incoming.find(s=>s.id===id);if(!x)return;if(API_BASE&&serverToken()){try{const r=await apiFetch('/shares/'+encodeURIComponent(id)+'/accept',{method:'POST'});x.status='Accepted';db.shares.snapshots[id]=r.snapshot;syncShareStatus(id,'Accepted');saveDb();addAudit('Accept Share',x.targetId,`from ${x.fromStudentId}`);toast('Shared content accepted and preserved on server');render();return}catch(e){toast(e.message||'Accept failed');return}}const snap=cloneSharedTarget(x.targetType,x.targetId);if(!snap){toast('The shared content is no longer available');x.status='Rejected';syncShareStatus(id,'Rejected');saveDb();return}x.status='Accepted';db.shares.snapshots[id]=snap;syncShareStatus(id,'Accepted');saveDb();addAudit('Accept Share',x.targetId,`from ${x.fromStudentId}`);toast('Shared content accepted and preserved');render()}
  async function rejectShare(id){const x=db.shares.incoming.find(s=>s.id===id);if(!x)return;if(API_BASE&&serverToken()){try{await apiFetch('/shares/'+encodeURIComponent(id)+'/reject',{method:'POST'});x.status='Rejected';syncShareStatus(id,'Rejected');saveDb();addAudit('Reject Share',x.targetId,`from ${x.fromStudentId}`);toast('Share request rejected');render();return}catch(e){toast(e.message||'Reject failed');return}}x.status='Rejected';syncShareStatus(id,'Rejected');saveDb();addAudit('Reject Share',x.targetId,`from ${x.fromStudentId}`);toast('Share request rejected');render()}

  function profile(){const me=current();return layout(`<div class="eyebrow">PROFILE</div><h1 class="title">Student Profile</h1><div class="grid g2" style="margin-top:16px"><div class="card"><div class="field"><label>PERMANENT STUDENT ID</label><input value="${esc(me.id)}" disabled /></div><div class="grid g2"><div class="field"><label>NAME</label><input id="profName" value="${esc(me.name)}" /></div><div class="field"><label>EMAIL</label><input id="profEmail" value="${esc(me.email)}" /></div><div class="field"><label>CLASS</label><input id="profClass" value="${esc(me.className)}" /></div><div class="field"><label>SECTION</label><input id="profSection" value="${esc(me.section)}" /></div><div class="field"><label>SCHOOL</label><input id="profSchool" value="${esc(me.school)}" /></div></div><button class="btn primary" onclick="saveProfile()">Save Profile</button></div><div class="card"><h2 class="section-title">Password</h2><div class="field"><label>CURRENT PASSWORD</label><input id="oldPwd" type="password" /></div><div class="field"><label>NEW PASSWORD</label><input id="newPwd" type="password" /></div><button class="btn secondary" onclick="changePassword()">Change Password</button><h2 class="section-title" style="margin-top:24px">Data Backup</h2><p class="small muted">Full backup includes your learning database and locally stored image/PDF page assets when the browser permits access. Large uploads can make the backup file large.</p><div class="toolbar"><button class="btn secondary" onclick="downloadBackup()">Download Full Backup</button><button class="btn ghost" onclick="importBackupFile()">Restore Backup</button><input id="backupFile" type="file" accept="application/json,.json" hidden onchange="restoreBackup(this)"></div><h2 class="section-title" style="margin-top:24px">Continuity</h2><p class="muted">Your Student ID remains permanent while class, section, academic year and school history can change.</p></div></div>`, activeNav())}
  function saveProfile(){const me=current();const next={name:document.getElementById('profName')?.value.trim()||me.name,email:document.getElementById('profEmail')?.value.trim()||'',className:document.getElementById('profClass')?.value.trim()||'',section:document.getElementById('profSection')?.value.trim()||'',school:document.getElementById('profSchool')?.value.trim()||''};if(next.school!==me.school||next.className!==me.className||next.section!==me.section){me.history=me.history||[];me.history.push({school:next.school,className:next.className,section:next.section,year:String(new Date().getFullYear())+'-'+String(new Date().getFullYear()+1).slice(-2),changedAt:new Date().toISOString()});}Object.assign(me,next);saveDb();addAudit('Edit Profile',me.id);toast('Profile saved; continuity history preserved');render()}
  async function blobToDataUrl(blob){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(blob)})}
  async function downloadBackup(){
    try{
      const assets=[];
      for(const s of db.subjects||[]) for(const b of s.books||[]) for(const ch of b.chapters||[]) for(const pg of ch.pages||[]) if(pg.assetKey){
        const blob=await assetGet(pg.assetKey);
        if(blob) assets.push({key:pg.assetKey,type:blob.type||'application/octet-stream',data:await blobToDataUrl(blob)});
      }
      const payload={format:'Easyway Learn Student Full Backup',version:16,exportedAt:new Date().toISOString(),database:db,assets};
      const blob=new Blob([JSON.stringify(payload)],{type:'application/json'});
      const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`easyway-learn-full-backup-${today()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      addAudit('Export Full Backup',state.currentId,`${assets.length} asset(s)`);
      toast(`Full backup downloaded with ${assets.length} page asset(s)`);
    }catch{toast('Backup could not be created on this browser.')}
  }
  function importBackupFile(){document.getElementById('backupFile')?.click()}
  async function restoreBackup(input){
    const file=input?.files?.[0];if(!file)return;
    try{
      const raw=await file.text();const payload=JSON.parse(raw);const incoming=payload?.database||payload;
      if(!incoming||!Array.isArray(incoming.accounts)||!Array.isArray(incoming.subjects)||!incoming.progress){throw new Error('Invalid backup')}
      if(!confirm('Restore this Easyway Learn data backup? Current local database will be replaced.')){input.value='';return}
      db=Object.assign(structuredClone(DEFAULT_DB),incoming,{version:16});saveDb();
      for(const a of (payload?.assets||[])){
        try{const res=await fetch(a.data);const blob=await res.blob();await assetPut(a.key,blob)}catch{}
      }
      state.currentId=null;localStorage.removeItem('easywayCurrentStudent');localStorage.removeItem('easywayLastId');input.value='';toast(`Backup restored with ${(payload?.assets||[]).length} page asset(s). Please sign in again.`);render();
    }catch{input.value='';toast('Backup file is invalid or unreadable.')}
  }

  async function changePassword(){const me=current();const old=document.getElementById('oldPwd')?.value||'';const nw=document.getElementById('newPwd')?.value||'';if(!(await verifyPassword(me,old))){toast('Current password is incorrect');return}if(nw.length<4){toast('New password must be at least 4 characters');return}me.passwordHash=await hashPassword(nw);delete me.password;saveDb();addAudit('Change Password',me.id);toast('Password changed');render()}

  async function groupView(){
    if(!groupPollTimer && state.groupSession?.id && API_BASE&&serverToken()){ groupPollTimer=setInterval(()=>{ if(state.page==='group') refreshGroupSession(); else {clearInterval(groupPollTimer);groupPollTimer=null;} },3000); }
    let session=state.groupSession;
    if(session?.id && API_BASE&&serverToken()){try{const r=await apiFetch('/group-sessions/'+encodeURIComponent(session.id));session=r.session;state.groupSession=session}catch{} }
    return layout(`<div class="row between wrap"><div><div class="eyebrow">LIVE GROUP LEARNING</div><h1 class="title">Practice together</h1><div class="subtitle">2–5 students • one speaker at a time • separate scores and history</div></div></div>
      <div class="grid g2" style="margin-top:16px"><div class="card"><h2 class="section-title">Create a session</h2><div class="field"><label>SESSION TITLE</label><input id="groupTitle" value="${esc(findChapter()?.title||'Chapter Practice')}" /></div><div class="field"><label>CONTENT / TOPIC</label><textarea id="groupContent" placeholder="Paste the paragraph, question or formula to practice">${esc(findParagraph()?.text||'')}</textarea></div><button class="btn primary" onclick="createGroupSession()">Create & Host</button></div>
      <div class="card"><h2 class="section-title">Join a session</h2><div class="field"><label>SESSION ID</label><input id="joinGroupId" placeholder="GS-XXXXXXXX" /></div><button class="btn secondary" onclick="joinGroupSession()">Join Session</button><div class="small muted" style="margin-top:12px">The host shares the Session ID with other students.</div></div></div>
      ${session?groupSessionCard(session):''}`, activeNav())
  }
  function groupSessionCard(s){const mine=s.participants.find(x=>x.studentId===state.currentId);const myTurn=s.currentStudentId===state.currentId;return `<div class="card" style="margin-top:16px"><div class="row between wrap"><div><div class="eyebrow">SESSION ${esc(s.id)}</div><h2 class="section-title">${esc(s.title)}</h2><div class="small muted">${s.participants.length}/${s.maxParticipants} participants • ${esc(s.status)}</div></div><div class="toolbar">${s.isHost&&s.status!=='Ended'?`<button class="btn danger" onclick="endGroupSession()">End Session</button>`:''}<button class="btn ghost" onclick="refreshGroupSession()">Refresh</button></div></div><div class="grid g2" style="margin-top:14px"><div><h3>Participants</h3>${s.participants.map((p,i)=>`<div class="list-item"><div><b>${esc(p.name)}</b><div class="small muted">${p.turns} turn(s) • Avg ${Math.round(p.score)}%</div></div><span class="pill ${s.turnIndex===i&&s.status!=='Ended'?'green':''}">${s.turnIndex===i&&s.status!=='Ended'?'Speaking next':''}</span></div>`).join('')}</div><div><h3>Current turn</h3><div class="card" style="box-shadow:none"><div class="small muted">${s.status==='Ended'?'Session ended':s.participants.length<2?'Waiting for another student':myTurn?'Your turn':`${esc(s.participants[s.turnIndex]?.name||'Next student')}'s turn`}</div><p>${esc(s.content)}</p>${myTurn&&s.status!=='Ended'?`<div class="field"><label>YOUR SPOKEN ANSWER / TRANSCRIPT</label><textarea id="groupTranscript" placeholder="Use the microphone on your device or type your answer">${esc(state.groupTranscript||'')}</textarea></div><div class="toolbar"><button class="btn secondary" onclick="groupMic()">🎤 Speak</button><button class="btn primary" onclick="submitGroupTurn()">Submit Turn</button></div>`:''}</div></div></div><div class="small muted" style="margin-top:12px">Scores are stored per student. Group activity does not overwrite individual paragraph/chapter history.</div></div>`}
  async function createGroupSession(){try{const r=await apiFetch('/group-sessions',{method:'POST',body:JSON.stringify({title:document.getElementById('groupTitle')?.value,content:document.getElementById('groupContent')?.value})});state.groupSession=r.session;state.page='group';render();toast('Group session created')}catch(e){toast(e.message)}}
  async function joinGroupSession(){const id=document.getElementById('joinGroupId')?.value.trim().toUpperCase();if(!id)return toast('Enter a Session ID');try{const r=await apiFetch('/group-sessions/'+encodeURIComponent(id)+'/join',{method:'POST'});state.groupSession=r.session;state.page='group';render();toast('Joined group session')}catch(e){toast(e.message)}}
  async function refreshGroupSession(){if(!state.groupSession?.id)return;try{const r=await apiFetch('/group-sessions/'+encodeURIComponent(state.groupSession.id));state.groupSession=r.session;render()}catch(e){toast(e.message)}}
  async function submitGroupTurn(){const transcript=document.getElementById('groupTranscript')?.value.trim();if(!transcript)return toast('Enter your spoken answer first');try{const target=findParagraph()?.id||findChapter()?.id||'GROUP';let score=wordAccuracy(state.groupSession?.content||'',transcript);const r=await apiFetch('/group-sessions/'+encodeURIComponent(state.groupSession.id)+'/turn',{method:'POST',body:JSON.stringify({transcript,score})});state.groupTranscript='';state.groupSession=r.session;render();toast(`Turn submitted • ${Math.round(score)}%`)}catch(e){toast(e.message)}}
  function groupMic(){const SR=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SR)return toast('Speech recognition is not supported; type your answer instead');const r=new SR();r.lang=findSubject().language==='Hindi'?'hi-IN':'en-IN';r.interimResults=false;r.maxAlternatives=1;r.onresult=e=>{state.groupTranscript=e.results[0][0].transcript||'';render()};r.onerror=()=>toast('Microphone error');try{r.start()}catch{}}
  async function endGroupSession(){if(!state.groupSession?.id)return;try{const r=await apiFetch('/group-sessions/'+encodeURIComponent(state.groupSession.id)+'/end',{method:'POST'});state.groupSession=r.session;render();toast('Session ended')}catch(e){toast(e.message)}}
  function support(){const email=db.settings.officialEmail, wa=db.settings.officialWhatsApp;const reports=Array.isArray(db.feedback)?db.feedback:[];return layout(`<div class="eyebrow">HELP & SUPPORT</div><h1 class="title">Contact Support</h1><p class="subtitle">Use the official support contact configured for Easyway Learn. No automatic monthly emails are sent by this app.</p><div class="grid g2" style="margin-top:16px"><div class="card"><h2 class="section-title">Official WhatsApp</h2>${wa?`<p class="muted">${esc(wa)}</p><a class="btn success" href="https://wa.me/${encodeURIComponent(wa.replace(/\D/g,''))}" target="_blank" rel="noopener">Open WhatsApp</a>`:'<div class="empty">Not configured yet.</div>'}</div><div class="card"><h2 class="section-title">Official Email</h2>${email?`<p class="muted">${esc(email)}</p><a class="btn secondary" href="mailto:${encodeURIComponent(email)}">Open Email</a>`:'<div class="empty">Not configured yet.</div>'}</div></div><div class="card" style="margin-top:16px"><h2 class="section-title">Report a Learning / Content Problem</h2><div class="field"><label>PROBLEM TYPE</label><select id="fbType"><option>Wrong word</option><option>Missing line</option><option>Formula error</option><option>Wrong sample name</option><option>Wrong underline</option><option>Speech detection error</option><option>Wrong answer</option><option>OCR error</option></select></div><div class="field"><label>DETAILS</label><textarea id="fbText" placeholder="Describe the problem"></textarea></div><button class="btn primary" onclick="submitFeedback()">Submit for Review</button><button class="btn ghost" style="margin-left:8px" onclick="loadFeedback()">Refresh My Reports</button></div><div class="card" style="margin-top:16px"><div class="row between"><h2 class="section-title">My Reports</h2><span class="pill">${reports.length}</span></div>${reports.length?`<div class="list">${reports.map(x=>`<div class="list-item"><div><b>${esc(x.issue)}</b><div class="small muted">${esc(x.comment)}</div><div class="small muted">${fmtDate(x.createdAt||x.date)}</div></div><span class="pill ${x.status==='Resolved'?'green':'amber'}">${esc(x.status||'Pending Review')}</span></div>`).join('')}</div>`:'<div class="empty">No reports submitted yet.</div>'}</div>`, activeNav())}
  async function loadFeedback(){if(API_BASE&&serverToken()){try{const r=await apiFetch('/feedback');db.feedback=r.feedback||[];saveDb();toast('Feedback status refreshed');render();return}catch(e){toast(e.message||'Could not refresh reports');return}}toast('Feedback is currently stored locally');}
  async function submitFeedback(){const issue=document.getElementById('fbType')?.value||'';const comment=document.getElementById('fbText')?.value.trim()||'';if(!comment){toast('Please describe the problem');return}if(API_BASE&&serverToken()){try{const r=await apiFetch('/feedback',{method:'POST',body:JSON.stringify({issue,comment,targetId:state.paragraphId||state.chapterId||''})});db.audit.unshift({actor:state.currentId,action:'Feedback',target:state.chapterId,time:new Date().toISOString(),extra:`${issue}: ${comment}`});saveDb();db.feedback ||= []; db.feedback.unshift(r.feedback); db.feedback=db.feedback.slice(0,1000); saveDb(); toast(`Feedback submitted — ${r.feedback.status}`); document.getElementById('fbText').value=''; render(); return}catch(e){toast(e.message||'Feedback could not be submitted');return}}db.audit.unshift({actor:state.currentId,action:'Feedback',target:state.chapterId,time:new Date().toISOString(),extra:`${issue}: ${comment}`});saveDb();toast('Feedback saved locally; it will be submitted when server sync is available');document.getElementById('fbText').value='';}

  function openNewSubject(){
    stopRecognition(false);
    const name=(window.prompt('Create Subject\n\nEnter subject name:', '')||'').trim();
    if(!name)return;
    if(db.subjects.some(x=>String(x.name||'').trim().toLowerCase()===name.toLowerCase())){toast('Subject already exists');return}
    const languageRaw=(window.prompt('Language\n\nType English or Hindi:', 'English')||'English').trim().toLowerCase();
    const language=languageRaw.startsWith('h')?'Hindi':'English';
    const id='SUB-'+Date.now();
    db.subjects.push({id,name,language,books:[]});
    saveDb();addAudit('Create Subject',id);
    toast('Subject created');
    state.subjectId=id;state.bookId='';state.chapterId='';state.page='library';
    render();
  }
  function openNewBook(subjectId){
    stopRecognition(false);
    const s=findSubjectBy(subjectId);
    if(!s){toast('Select a subject first');return}
    const title=(window.prompt('Create Book\n\nEnter book name:', '')||'').trim();
    if(!title)return;
    const cls=(window.prompt('Class\n\nEnter class (optional):', '')||'').trim();
    const id='BOOK-'+Date.now();
    s.books.push({id,title,className:cls,chapters:[]});
    saveDb();addAudit('Create Book',id,`subject=${subjectId}`);
    toast('Book created');
    state.subjectId=s.id;state.bookId=id;state.chapterId='';state.page='book';
    render();
  }
  async function deleteSubject(id){
    const s=findSubjectBy(id); if(!s)return;
    if(!confirm(`Delete subject "${s.name}" and all of its books, chapters, pages and local page files from your own content? Accepted shared snapshots remain with recipients.`))return;
    for(const b of (s.books||[])) for(const ch of (b.chapters||[])) for(const pg of (ch.pages||[])){ if(pg.assetKey){try{await assetDelete(pg.assetKey)}catch{}} }
    db.subjects=db.subjects.filter(x=>x.id!==id);
    if(state.subjectId===id){state.subjectId=db.subjects[0]?.id||'';state.bookId=db.subjects[0]?.books?.[0]?.id||'';state.chapterId=db.subjects[0]?.books?.[0]?.chapters?.[0]?.id||'';state.page='library';}
    saveDb();addAudit('Delete Subject',id);toast('Subject deleted from your own content');render();
  }
  async function deleteBook(id){
    const s=findSubject(); const b=s?.books?.find(x=>x.id===id); if(!b)return;
    if(!confirm(`Delete book "${b.title}" and all of its chapters, pages and local page files from your own content? Accepted shared snapshots remain with recipients.`))return;
    for(const ch of (b.chapters||[])) for(const pg of (ch.pages||[])){ if(pg.assetKey){try{await assetDelete(pg.assetKey)}catch{}} }
    s.books=s.books.filter(x=>x.id!==id);
    if(state.bookId===id){state.bookId=s.books[0]?.id||'';state.chapterId=s.books[0]?.chapters?.[0]?.id||'';state.page='library';}
    saveDb();addAudit('Delete Book',id,`subject=${s.id}`);toast('Book deleted from your own content');render();
  }
  function createSubject(){const name=(document.getElementById('newSubName')?.value||'').trim();const lang=document.getElementById('newSubLang')?.value||'English';if(!name){toast('Enter a subject name');return}if(db.subjects.some(x=>String(x.name||'').toLowerCase()===name.toLowerCase())){toast('Subject already exists');return}const id='SUB-'+Date.now();db.subjects.push({id,name,language:lang,books:[]});saveDb();addAudit('Create Subject',id);state.modal=null;toast('Subject created');render()}
  function createBook(){const sid=state.modal?.subjectId;const s=findSubjectBy(sid);const title=(document.getElementById('newBookTitle')?.value||'').trim();const cls=(document.getElementById('newBookClass')?.value||'').trim();if(!s){toast('Select a subject first');return}if(!title){toast('Enter a book title');return}const id='BOOK-'+Date.now();s.books.push({id,title,className:cls,chapters:[]});saveDb();addAudit('Create Book',id,`subject=${sid}`);state.modal=null;toast('Book created');render()}
  function editModal(){
    if(state.modal.type==='share')return shareModal();
    if(state.modal.type==='newSubject')return `<div class="modal-backdrop"><div class="modal"><div class="row between"><h2 class="section-title">Create Subject</h2><button class="btn ghost" onclick="window.closeModal();return false" type="button">Close</button></div><div class="field"><label>SUBJECT NAME</label><input id="newSubName" type="text" inputmode="text" autocomplete="off" placeholder="Example: Physics" /></div><div class="field"><label>LANGUAGE</label><select id="newSubLang"><option>English</option><option>Hindi</option></select></div><button class="btn primary" onclick="createSubject()">Create Subject</button></div></div>`;
    if(state.modal.type==='newBook')return `<div class="modal-backdrop"><div class="modal"><div class="row between"><h2 class="section-title">Create Book</h2><button class="btn ghost" onclick="window.closeModal();return false" type="button">Close</button></div><div class="field"><label>BOOK TITLE</label><input id="newBookTitle" type="text" inputmode="text" autocomplete="off" placeholder="Example: Physics — Class 11" /></div><div class="field"><label>CLASS</label><input id="newBookClass" type="text" inputmode="numeric" autocomplete="off" placeholder="11" /></div><button class="btn primary" onclick="createBook()">Create Book</button></div></div>`;
    if(state.modal.type==='uploadPreview'){
      const groups={};state.modal.items.forEach(x=>{groups[x.detected.title]??={confidence:x.detected.confidence,count:0};groups[x.detected.title].count++});
      return `<div class="modal-backdrop"><div class="modal"><div class="row between"><div><div class="eyebrow">OCR / AI REVIEW</div><h2 class="section-title" style="font-size:22px">Confirm page grouping</h2></div><button class="btn ghost" onclick="window.closeModal();return false" type="button">Cancel</button></div><p class="muted">OCR text is shown below. Pages are grouped by detected chapter heading/number when available; otherwise the selected chapter is used.</p><div class="list">${Object.entries(groups).map(([title,g])=>`<div class="list-item"><div><b>${esc(title)}</b><div class="small muted">${g.count} page(s) • ${esc(g.confidence)}</div></div><span class="pill ${g.confidence.startsWith('Detected from')?'green':'amber'}">${g.confidence.startsWith('Detected from')?'Detected':'Review'}</span></div>`).join('')}</div><div class="card" style="margin-top:12px;box-shadow:none"><div class="small muted">OCR results</div>${state.modal.items.map((x,i)=>`<div style="padding:12px 0;border-top:1px solid var(--line)"><div class="row between wrap"><b>${i+1}. ${esc(x.name)}</b><span class="pill ${x.ocr==='server OCR'?'green':'red'}">${x.ocr==='server OCR'?'OCR OK':'OCR ERROR'}</span></div><div class="small muted" style="margin-top:5px">${esc(x.detected.title)} • ${x.paragraphs?.length||0} paragraph(s)${x.ocrLanguage?` • ${esc(x.ocrLanguage)}`:''}</div>${x.ocrError?`<div class="small" style="margin-top:6px;color:#b91c1c">${esc(x.ocrError)}</div>`:''}<div class="demo" style="margin-top:8px;white-space:pre-wrap;max-height:180px;overflow:auto">${esc(x.text||'No OCR text returned')}</div></div>`).join('')}</div><div class="toolbar" style="margin-top:14px"><button class="btn primary" onclick="confirmUpload()">Confirm & Save</button><button class="btn ghost" onclick="window.closeModal();return false" type="button">Go Back</button></div></div></div>`;
    }
    if(state.modal.type==='chapterEdit')return `<div class="modal-backdrop"><div class="modal"><div class="row between"><h2 class="section-title">Edit Chapter</h2><button class="btn ghost" onclick="window.closeModal();return false" type="button">Close</button></div><div class="field"><label>CHAPTER NAME</label><input id="editChapterTitle" value="${esc(state.modal.title)}" /></div><button class="btn primary" onclick="saveChapterEdit('${state.modal.id}')">Save Changes</button></div></div>`;
    if(state.modal.type==='paragraphEdit')return `<div class="modal-backdrop"><div class="modal"><div class="row between"><h2 class="section-title">Edit Paragraph</h2><button class="btn ghost" onclick="window.closeModal();return false" type="button">Close</button></div><div class="field"><label>TITLE</label><input id="editPTitle" value="${esc(state.modal.title)}" /></div><div class="field"><label>TEXT</label><textarea id="editPText">${esc(state.modal.text)}</textarea></div><button class="btn primary" onclick="saveParagraphEdit('${state.modal.id}')">Save Changes</button></div></div>`;
    return '';
  }
  function saveChapterEdit(id){const ch=findBook().chapters.find(c=>c.id===id);if(!ch)return;const v=document.getElementById('editChapterTitle')?.value.trim();if(!v){toast('Chapter name cannot be empty');return}ch.title=v;saveDb();addAudit('Edit Chapter',id);state.modal=null;toast('Chapter updated');render()}
  function saveParagraphEdit(id){const p=findChapter().paragraphs.find(x=>x.id===id);if(!p)return;const t=document.getElementById('editPTitle')?.value.trim();const v=document.getElementById('editPText')?.value.trim();if(!t||!v){toast('Title and text are required');return}p.title=t;p.text=v;const pg=findChapter().pages.find(x=>x.id===p.pageId);if(pg)pg.extractedText=v;saveDb();addAudit('Edit Paragraph',id);state.modal=null;toast('Paragraph updated');render()}

  function transcriptForMode(mode){
    if(mode==='qualification')return state.readerTranscript||'';
    if(mode==='speaking')return state.speakingTranscript||'';
    if(mode==='chapter')return state.chapterAnswers?.[findChapter().paragraphs[state.chapterIndex]?.id]||'';
    if(mode==='formula')return state.formulaTranscript||'';
    if(mode==='qa-qualification')return document.getElementById('qaRead')?.value||'';
    if(mode==='qa-answer')return document.getElementById('qaAnswer')?.value||'';
    return '';
  }
  function putTranscriptForMode(mode,text){
    const clean=String(text||'').trim();
    if(mode==='qualification'){state.readerTranscript=clean;state.readerAccuracy=wordAccuracy(findParagraph().text,clean);const el=document.getElementById('qualText');if(el)el.value=clean;}
    else if(mode==='speaking'){state.speakingTranscript=clean;const el=document.getElementById('speechText');if(el)el.value=clean;}
    else if(mode==='chapter'){const id=findChapter().paragraphs[state.chapterIndex]?.id;if(id)state.chapterAnswers[id]=clean;const el=document.getElementById('chapterSpeech');if(el)el.value=clean;}
    else if(mode==='formula'){state.formulaTranscript=clean;const el=document.getElementById('formulaSpeech');if(el)el.value=clean;}
    else if(mode==='qa-qualification'){const el=document.getElementById('qaRead');if(el)el.value=clean;}
    else if(mode==='qa-answer'){const el=document.getElementById('qaAnswer');if(el)el.value=clean;}
  }
  function normalizeSpeechText(v){return String(v||'').toLowerCase().normalize('NFKC').replace(/[.,!?;:।॥]+/g,' ').replace(/\s+/g,' ').trim();}
  function appendSpeechUnique(existing,incoming){
    const a=String(existing||'').trim(), b=String(incoming||'').trim();
    if(!b)return a;
    const na=normalizeSpeechText(a), nb=normalizeSpeechText(b);
    if(!na)return b;
    if(na===nb||na.endsWith(nb)||nb.startsWith(na))return nb.startsWith(na) && nb.length>na.length ? b : a;
    const aw=na.split(' '), bw=nb.split(' ');
    const max=Math.min(aw.length,bw.length,40);
    for(let n=max;n>=2;n--){
      if(aw.slice(-n).join(' ')===bw.slice(0,n).join(' ')){
        const origWords=b.split(/\s+/);
        return `${a} ${origWords.slice(n).join(' ')}`.trim();
      }
    }
    if(nb.includes(na)&&nb.length>na.length)return b;
    return `${a} ${b}`.trim();
  }
  let recognitionRunId=0;
  function startRecognition(mode){
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR){toast('Speech recognition is not supported in this browser. Use the text box fallback.');return}
    stopRecognition(false);
    state.speechWanted=true;
    const runId=++recognitionRunId;
    const launch=()=>{
      if(!state.speechWanted||runId!==recognitionRunId)return;
      const r=new SR();
      const subj=findSubject();
      state.speakingLang=(subj?.language==='Hindi'?'hi-IN':'en-IN');
      r.lang=state.speakingLang;
      r.interimResults=true;
      r.continuous=true;
      r.maxAlternatives=1;
      r._easywayManualStop=false;
      r._easywayMode=mode;
      r._easywayRestartTimer=null;
      r._easywayLastResultKey='';
      r._easywayLastResultAt=0;
      state.speakingListening=true;
      state.recognition=r;
      let sessionBase=transcriptForMode(mode);
      let restartCount=0;
      const scheduleRestart=()=>{
        if(!state.speechWanted||state.recognition!==r||r._easywayManualStop)return;
        clearTimeout(r._easywayRestartTimer);
        const delay=Math.min(1200,180+restartCount*120); restartCount+=1;
        r._easywayRestartTimer=setTimeout(()=>{if(state.speechWanted&&state.recognition===r&&!r._easywayManualStop)launchReplacement()},delay);
      };
      const launchReplacement=()=>{
        if(!state.speechWanted||state.recognition!==r||r._easywayManualStop)return;
        // Build a fresh SpeechRecognition object after silence/end. This avoids Chrome mobile
        // replaying earlier final results when the same object is restarted.
        try{r.onresult=r.onerror=r.onend=null;r.stop()}catch{}
        state.recognition=null;
        launch();
      };
      r.onresult=e=>{
        let changed=false;
        for(let i=e.resultIndex;i<e.results.length;i++){
          const res=e.results[i];
          const part=String(res?.[0]?.transcript||'').trim();
          if(!part)continue;
          if(!res.isFinal)continue;
          const key=normalizeSpeechText(part);
          const now=Date.now();
          if(key && key===r._easywayLastResultKey && now-r._easywayLastResultAt<10000)continue;
          r._easywayLastResultKey=key;r._easywayLastResultAt=now;
          const next=appendSpeechUnique(sessionBase,part);
          changed = changed || next!==sessionBase;
          sessionBase=next;
        }
        if(changed)putTranscriptForMode(mode,sessionBase);
      };
      r.onerror=e=>{
        if(!state.speechWanted||state.recognition!==r||r._easywayManualStop)return;
        const fatal=['not-allowed','service-not-allowed','language-not-supported'].includes(e.error);
        if(fatal){state.speechWanted=false;state.speakingListening=false;state.recognition=null;toast(`Mic error: ${e.error||'unknown'}`);render();return;}
        scheduleRestart();
      };
      r.onend=()=>{
        if(!state.speechWanted||state.recognition!==r||r._easywayManualStop)return;
        scheduleRestart();
      };
      try{r.start()}catch(e){
        if(state.speechWanted&&state.recognition===r)scheduleRestart();
      }
    };
    launch();
  }
  function stopRecognition(shouldRender=true){
    state.speechWanted=false;
    ++recognitionRunId;
    const r=state.recognition;
    if(r){r._easywayManualStop=true;clearTimeout(r._easywayRestartTimer);try{r.onend=null;r.onerror=null;r.stop()}catch{}try{r.abort()}catch{}}
    state.speakingListening=false;state.recognition=null;
    if(shouldRender)render();
  }

  // Modal inputs are deliberately isolated from speech recognition. Opening a modal
  // always stops recognition; the modal is mounted directly under <body> so normal
  // page renders cannot replace the focused input while the user is typing.
  async function usageTick(){if(!current()||document.visibilityState!=='visible'||!['dashboard','library','book','bookDetail','pageView','lesson','speaking','history','progress','rankings','shares','profile','support'].includes(state.page))return; db.usage.activeMinutes+=1; db.usage.sessions.unshift({studentId:state.currentId,start:new Date().toISOString(),minutes:1,context:state.page}); db.usage.sessions=db.usage.sessions.slice(0,1000); saveDb(); if(API_BASE&&serverToken()){try{const r=await apiFetch('/usage',{method:'POST',body:JSON.stringify({minutes:1,context:state.page})}); if(r.usage)db.usage=r.usage; saveDb()}catch{}}}
  setInterval(usageTick,60000);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')usageTick()});

  async function render(){
    if(!current()){login();return}
    let body='';
    if(state.page==='dashboard')body=dashboard();
    else if(state.page==='library')body=library();
    else if(state.page==='book')body=bookView();
    else if(state.page==='bookDetail')body=chapterView();
    else if(state.page==='pageView')body=pageView();
    else if(state.page==='lesson')body=lesson(state.paragraphId);
    else if(state.page==='result')body=result();
    else if(state.page==='history')body=history();
    else if(state.page==='progress')body=progress();
    else if(state.page==='rankings')body=await rankings();
    else if(state.page==='group')body=await groupView();
    else if(state.page==='chapterTest')body=chapterTest();
    else if(state.page==='chapterResult')body=chapterResult();
    else if(state.page==='qa')body=qaView();
    else if(state.page==='formula')body=formulaView();
    else if(state.page==='upload')body=uploadView();
    else if(state.page==='shares')body=sharesView();
    else if(state.page==='profile')body=profile();
    else if(state.page==='support')body=support();
    else if(state.page==='sharedSnapshot')body=sharedSnapshotView();
    else body=dashboard();
    app.innerHTML=body;
    if(state.page==='pageView'){const ch=findChapter();const pg=ch?.pages.find(p=>p.number===state.pageNumber);if(pg)hydratePageAsset(pg)}
    if(state.page==='upload')refreshUploadOptions();
    let root=document.getElementById('easyway-modal-root');
    if(state.modal){
      if(!root){root=document.createElement('div');root.id='easyway-modal-root';document.body.appendChild(root);}
      root.innerHTML=editModal();
      root.hidden=false;
      document.body.classList.add('easyway-modal-open');
      const first=root.querySelector('input, textarea, select');
      if(first && (state.modal.type==='newBook'||state.modal.type==='newSubject')){
        requestAnimationFrame(()=>{try{first.focus({preventScroll:true})}catch{first.focus()}});
      }
    }else{
      if(root)root.remove();
      document.body.classList.remove('easyway-modal-open');
    }
  }
  function go(p){stopRecognition();if(p!=='lesson'&&p!=='chapterTest')stopAntiCheat();state.sharedSnapshot=null;state.page=p;if(p!=='group'&&groupPollTimer){clearInterval(groupPollTimer);groupPollTimer=null}render()}
  function rereadParagraph(){stopRecognition();state.readerMode='qualification';state.readerAccuracy=getProg(state.paragraphId).qualified?80:0;state.readerTranscript='';state.page='lesson';render()}
  function openLesson(id){stopRecognition();state.paragraphId=id;state.readerMode=getProg(id).qualified?'speaking':'qualification';state.readerAccuracy=getProg(id).qualified?80:0;state.readerTranscript='';state.speakingTranscript='';state.page='lesson';render()}

  window.go=go;window.sharedSnapshotView=sharedSnapshotView;window.loginSubmit=loginSubmit;window.logout=logout;window.openNewSubject=openNewSubject;window.openNewBook=openNewBook;window.createSubject=createSubject;window.createBook=createBook;window.deleteSubject=deleteSubject;window.deleteBook=deleteBook;window.openRegister=openRegister;window.openForgot=openForgot;window.closeModal=closeModal;window.stopRecognition=stopRecognition;window.registerStudent=registerStudent;window.resetPassword=resetPassword;window.openBook=openBook;window.openChapter=openChapter;window.viewPage=viewPage;window.savePageText=savePageText;window.deletePage=deletePage;window.deleteParagraph=deleteParagraph;window.deleteChapter=deleteChapter;window.editChapter=editChapter;window.editParagraph=editParagraph;window.saveChapterEdit=saveChapterEdit;window.saveParagraphEdit=saveParagraphEdit;window.openLesson=openLesson;window.rereadParagraph=rereadParagraph;window.calculateQualification=calculateQualification;window.useTypedForQualification=useTypedForQualification;window.toggleQualificationMic=toggleQualificationMic;window.toggleSpeakingMic=toggleSpeakingMic;window.submitSpeakingTest=submitSpeakingTest;window.resetSpeakingText=resetSpeakingText;window.startChapterTest=startChapterTest;window.toggleChapterMic=toggleChapterMic;window.checkChapterParagraph=checkChapterParagraph;window.openQA=openQA;window.qualifyQA=qualifyQA;window.submitQA=submitQA;window.toggleQAMic=toggleQAMic;window.openFormula=openFormula;window.submitFormula=submitFormula;window.toggleFormulaMic=toggleFormulaMic;window.processUpload=processUpload;window.confirmUpload=confirmUpload;window.shareContent=shareContent;window.sendShare=sendShare;window.acceptShare=acceptShare;window.rejectShare=rejectShare;window.openShared=openShared;window.saveProfile=saveProfile;window.downloadBackup=downloadBackup;window.importBackupFile=importBackupFile;window.restoreBackup=restoreBackup;window.changePassword=changePassword;window.submitFeedback=submitFeedback;window.loadFeedback=loadFeedback;window.rankings=rankings;window.setFilter=setFilter;window.createGroupSession=createGroupSession;window.joinGroupSession=joinGroupSession;window.refreshGroupSession=refreshGroupSession;window.submitGroupTurn=submitGroupTurn;window.groupMic=groupMic;window.endGroupSession=endGroupSession;window.startAntiCheat=startAntiCheat;window.stopAntiCheat=stopAntiCheat;window.captureAntiCheat=captureAntiCheat;

  // Keep the app shell fresh. Unregistering older workers once prevents stale cached JS/CSS from surviving a release.
  if('serviceWorker' in navigator){
    navigator.serviceWorker.getRegistrations().then(rs=>Promise.all(rs.map(r=>r.unregister()))).catch(()=>{});
    if('caches' in window) caches.keys().then(keys=>Promise.all(keys.map(k=>caches.delete(k)))).catch(()=>{});
  }
  render();
})();
