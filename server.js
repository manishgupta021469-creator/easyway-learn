'use strict';

// Easyway Learn production-backend foundation.
// Node 18+; uses only built-in modules so it can be deployed without a framework.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch {}

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.EASYWAY_DATA_DIR || path.join(__dirname, 'server-data');
const DATA_FILE = path.join(DATA_DIR, 'students.json');
const SQLITE_FILE = path.join(DATA_DIR, 'easyway.sqlite');
const USE_SQLITE = process.env.EASYWAY_DB !== 'json' && !!DatabaseSync;
const ASSET_DIR = path.join(DATA_DIR, 'assets');
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const sessions = new Map();
const MAX_JSON_BYTES = 48_000_000;
const MAX_ASSET_BYTES = 30_000_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 120;
const MAX_REQUEST_BYTES = 32_000_000;
const MAX_AUDIO_BYTES = 15_000_000;
const MAX_ANTICHEAT_BYTES = 1_500_000;
const APP_VERSION = '0.66.0';
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const rateBuckets = new Map();

let db = null;
function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  if (USE_SQLITE) {
    if (!db) {
      db = new DatabaseSync(SQLITE_FILE);
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, student_id TEXT NOT NULL, expires_at INTEGER NOT NULL);`);
      const row = db.prepare('SELECT value FROM app_state WHERE key=?').get('students');
      if (!row) {
        let initial = { students: {}, groupSessions: {} };
        if (fs.existsSync(DATA_FILE)) {
          try { initial = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
          try { fs.renameSync(DATA_FILE, DATA_FILE + '.migrated'); } catch {}
        }
        db.prepare('INSERT INTO app_state(key,value) VALUES(?,?)').run('students', JSON.stringify(initial));
      }
    }
    return;
  }
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ students: {}, groupSessions: {} }, null, 2));
}
function readStore() {
  ensureStore();
  const store = USE_SQLITE ? JSON.parse(db.prepare('SELECT value FROM app_state WHERE key=?').get('students').value) : JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!store.students) store.students={};
  if (!store.groupSessions) store.groupSessions={};
  if (!store.students['STU-001']) {
    const p=hashPassword('demo123');
    store.students['STU-001']={studentId:'STU-001',name:'Aarav Sharma',password:p,recoveryHash:null,profile:{className:'6',section:'A',school:'Demo School',email:'',history:[{school:'Demo School',className:'6',section:'A',year:'2026-27'}]},state:{},audit:[]};
    writeStore(store);
  }
  return store;
}
function writeStore(store) {
  ensureStore();
  if (USE_SQLITE) { db.prepare('INSERT INTO app_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('students', JSON.stringify(store)); return; }
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
function hashToken(t) { return crypto.createHash('sha256').update(t).digest('hex'); }
function saveSession(t, studentId, expiresAt) {
  if (USE_SQLITE) db.prepare('INSERT INTO sessions(token_hash,student_id,expires_at) VALUES(?,?,?)').run(hashToken(t), studentId, expiresAt);
  sessions.set(t,{studentId,expiresAt});
}
function deleteSession(t) {
  if (USE_SQLITE) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(t));
  sessions.delete(t);
}
function deleteStudentSessions(studentId) {
  if (USE_SQLITE) db.prepare('DELETE FROM sessions WHERE student_id=?').run(studentId);
  for (const [t,s] of sessions) if (s.studentId===studentId) sessions.delete(t);
}
function auth(req) {
  const value = req.headers.authorization || '';
  if (!value.startsWith('Bearer ')) return null;
  const t = value.slice(7);
  if (USE_SQLITE) {
    const s = db.prepare('SELECT student_id, expires_at FROM sessions WHERE token_hash=?').get(hashToken(t));
    if (!s || s.expires_at < Date.now()) { if (s) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(t)); return null; }
    return { token:t, studentId:s.student_id, expiresAt:s.expires_at };
  }
  const s = sessions.get(t);
  if (!s || s.expiresAt < Date.now()) { sessions.delete(t); return null; }
  return { token: t, ...s };
}
function securityHeaders(res) {
  res.setHeader('x-content-type-options','nosniff');
  res.setHeader('x-frame-options','DENY');
  res.setHeader('referrer-policy','no-referrer');
  res.setHeader('x-dns-prefetch-control','off');
  res.setHeader('cross-origin-opener-policy','same-origin');
  res.setHeader('cross-origin-resource-policy','same-origin');
  res.setHeader('permissions-policy','camera=(self), microphone=(self), geolocation=()');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'self' blob:; frame-ancestors 'none'");
  if (process.env.NODE_ENV === 'production') res.setHeader('strict-transport-security','max-age=31536000; includeSubDomains');
}
function json(res, status, body) {
  securityHeaders(res);
  res.writeHead(status, {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store'});
  res.end(JSON.stringify(body));
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, record) {
  if (!record || typeof record.salt !== 'string' || typeof record.hash !== 'string') return false;
  try {
    const hash = crypto.scryptSync(String(password), record.salt, 64).toString('hex');
    const expected = Buffer.from(record.hash, 'hex');
    const actual = Buffer.from(hash, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}
function token() { return crypto.randomBytes(32).toString('hex'); }
function recoveryCode() { return 'EWL-' + crypto.randomBytes(4).toString('hex').toUpperCase() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase(); }
function hashRecoveryCode(code) { return crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex'); }
function verifyRecoveryCode(code, storedHash) { try { const a=Buffer.from(String(storedHash||''),'hex'); const b=Buffer.from(hashRecoveryCode(code),'hex'); return a.length===b.length && crypto.timingSafeEqual(a,b); } catch { return false; } }
function audit(student, action, detail='') {
  student.audit ||= [];
  student.audit.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), action, detail });
  student.audit = student.audit.slice(0, 1000);
}
function allowedRate(req) {
  const key = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (rateBuckets.size > 5000) for (const [k,v] of rateBuckets) if (now - v.start >= RATE_WINDOW_MS) rateBuckets.delete(k);
  const current = rateBuckets.get(key);
  if (!current || now - current.start >= RATE_WINDOW_MS) { rateBuckets.set(key,{start:now,count:1}); return true; }
  current.count += 1; return current.count <= RATE_LIMIT;
}
function body(req) {
  return new Promise((resolve, reject) => {
    let raw='';
    req.on('data', c => { raw += c; if (raw.length > MAX_JSON_BYTES) { reject(new Error('Payload too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}
function serveStatic(req,res) {
  let p = new URL(req.url, 'http://localhost').pathname;
  if (p === '/') p='/index.html';
  const publicFiles = new Set(['/index.html','/privacy.html','/app.js','/styles.css','/manifest.webmanifest','/sw.js','/icon.svg','/icon-maskable.svg']);
  if (!publicFiles.has(p)) return json(res,404,{error:'Not found'});
  const root=__dirname;
  const file=path.normalize(path.join(root,p));
  if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res,404,{error:'Not found'});
  const ext=path.extname(file).toLowerCase();
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml'};
  securityHeaders(res);
  res.writeHead(200,{'content-type':types[ext]||'application/octet-stream','cache-control':ext==='.'?'no-store':'no-cache'}); fs.createReadStream(file).pipe(res);
}


function splitParagraphs(text){
  const cleaned=String(text||'').replace(/\r/g,'').trim();
  if(!cleaned)return [];
  const lines=cleaned.split(/\n+/).map(x=>x.replace(/[\t ]+/g,' ').trim()).filter(Boolean);
  const heading=/^(?:(?:chapter|unit|lesson|topic|exercise|chapter\s*(?:no\.?|number)?|lesson\s*(?:no\.?|number)?)[\s.:#-]*\d{0,3}\b|(?:अध्याय|पाठ|इकाई|विषय|अभ्यास)[\s.:#-]*(?:क्रमांक|नंबर)?\s*\d{0,3}\b)/iu;
  const numbered=/^(?:\d{1,3}[.)]|[A-Za-z][.)]|[-•▪◦])\s+/;
  const out=[];let cur=[];
  const flush=()=>{const joined=cur.join(' ').replace(/\s+/g,' ').trim();cur=[];if(!joined)return;if(heading.test(joined)&&joined.length<220)return;out.push(joined)};
  for(const line of lines){
    if(heading.test(line)){flush();continue;}
    if(numbered.test(line)&&cur.length)flush();
    cur.push(line);
    if(/[.!?।॥]$/.test(line)&&cur.join(' ').length>=110)flush();
  }
  flush();
  if(out.length===1&&out[0].length>280){
    const parts=out[0].split(/(?<=[.!?।॥])\s+(?=[A-ZА-Яअ-ह0-9])/u).map(x=>x.trim()).filter(Boolean);
    if(parts.length>1)return parts;
  }
  return out;
}
function chapterFromOCR(text, fallback=''){
  const lines=String(text||'').split(/\r?\n/).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
  const re=/(?:(?:chapter|unit|lesson|topic)(?:\s*(?:no\.?|number|क्रमांक))?|(?:अध्याय|पाठ|इकाई|विषय)(?:\s*(?:क्रमांक|नंबर))?)[\s.:#-]*?(\d{1,3})?\b/iu;
  const line=lines.find(x=>re.test(x));
  if(line){const m=line.match(re);const num=m&&m[1]?Number(m[1]):undefined;return {number:num,title:line.slice(0,120),confidence:'Detected from OCR heading'};}
  return {title:fallback||'Selected chapter',confidence:'No chapter heading detected — selected chapter retained'};
}
function normalizeOCRLanguage(lang){
  const raw=String(lang||'eng').toLowerCase().trim().replace(/\s+/g,'');
  if(raw==='devanagari'||raw==='hindi'||raw==='hi'||raw==='hi-in')return 'hin';
  if(raw==='english'||raw==='en'||raw==='en-in')return 'eng';
  const parts=raw.split(/[+,]/).map(x=>x==='devanagari'||x==='hindi'||x==='hi'||x==='hi-in'?'hin':(x==='english'||x==='en'||x==='en-in'?'eng':x)).filter(x=>/^[a-z0-9_]+$/.test(x));
  return parts.length?Array.from(new Set(parts)).join('+'):'eng';
}
function installedTesseractLanguages(){
  try{return execFileSync('tesseract',['--list-langs'],{timeout:5000}).toString('utf8').split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&/^[A-Za-z0-9_]+$/.test(x));}catch{return []}
}
function ocrQuality(text){
  const s=String(text||'');
  if(!s)return 0;
  const chars=[...s].filter(ch=>/\p{L}|\p{N}/u.test(ch)).length;
  const replacement=(s.match(/[�]/g)||[]).length;
  return chars - replacement*20 + Math.min(s.length,500)*0.01;
}
async function runOCR(raw,mime,lang){
  let safeLang=normalizeOCRLanguage(lang);
  const available=installedTesseractLanguages();
  const requested=safeLang.split('+').filter(Boolean);
  const usable=requested.filter(x=>available.includes(x));
  safeLang=usable.length?usable.join('+'):(available.includes('eng')?'eng':(available[0]||'eng'));
  if(!available.length) throw new Error('Tesseract is not installed on the server');
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'easyway-ocr-'));
  const input=path.join(work,mime==='application/pdf'?'input.pdf':'input');
  try{
    fs.writeFileSync(input,raw);
    let images=[];
    if(mime==='application/pdf'){
      const prefix=path.join(work,'page');
      execFileSync('pdftoppm',['-png','-r','180',input,prefix],{timeout:90000});
      images=fs.readdirSync(work).filter(x=>/^page-\d+\.png$/.test(x)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0])).map(x=>path.join(work,x));
      if(!images.length)throw new Error('PDF could not be converted to images');
    }else images=[input];
    const textParts=[];
    for(const image of images){
      const candidates=[];
      for(const psm of ['6','3','11']){
        try{
          const out=execFileSync('tesseract',[image,'stdout','-l',safeLang,'--oem','1','--psm',psm],{timeout:60000,maxBuffer:6_000_000}).toString('utf8').trim();
          if(out)candidates.push(out);
        }catch(e){ if(psm==='6'&&!candidates.length)throw e; }
      }
      const best=candidates.sort((a,b)=>ocrQuality(b)-ocrQuality(a))[0]||'';
      if(best)textParts.push(best);
    }
    const text=textParts.join('\n\n').trim();
    if(!text)throw new Error(`OCR returned no readable text (languages: ${safeLang}; pages: ${images.length})`);
    const paragraphs=splitParagraphs(text);
    return {text,paragraphs,chapterDetection:chapterFromOCR(text),ocrLanguage:safeLang,pageCount:images.length};
  } finally {try{fs.rmSync(work,{recursive:true,force:true})}catch{}}
}

function normalizeTokens(text){
  return String(text||'').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').split(/\s+/).filter(Boolean);
}
function assessmentMetrics(expected, got){
  const e=normalizeTokens(expected), g=normalizeTokens(got);
  if(!e.length) return {score:0,correctWords:0,expectedWords:0,recognizedWords:g.length,missingWords:0,extraWords:g.length,sequenceAccuracy:0,wer:1};
  const rows=Array.from({length:e.length+1},()=>Array(g.length+1).fill(0));
  for(let i=0;i<=e.length;i++) rows[i][0]=i;
  for(let j=0;j<=g.length;j++) rows[0][j]=j;
  for(let i=1;i<=e.length;i++) for(let j=1;j<=g.length;j++) rows[i][j]=e[i-1]===g[j-1]?rows[i-1][j-1]:Math.min(rows[i-1][j]+1,rows[i][j-1]+1,rows[i-1][j-1]+1);
  const distance=rows[e.length][g.length];
  let i=e.length,j=g.length,correct=0,sub=0,ins=0,del=0;
  while(i>0||j>0){
    if(i>0&&j>0&&e[i-1]===g[j-1]){correct++;i--;j--;continue;}
    const diag=i>0&&j>0?rows[i-1][j-1]:Infinity, up=i>0?rows[i-1][j]:Infinity, left=j>0?rows[i][j-1]:Infinity;
    if(diag<=up&&diag<=left){sub++;i--;j--;} else if(up<=left){del++;i--;} else {ins++;j--;}
  }
  const multiset={}; g.forEach(w=>multiset[w]=(multiset[w]||0)+1); let bagHits=0; for(const w of e){if(multiset[w]){multiset[w]--;bagHits++;}}
  const score=Math.max(0,Math.min(100,Math.round(bagHits/e.length*100)));
  return {score,correctWords:correct,expectedWords:e.length,recognizedWords:g.length,missingWords:del,extraWords:ins,substitutedWords:sub,sequenceAccuracy:Math.max(0,Math.round((1-distance/Math.max(e.length,g.length,1))*100)),wer:Number((distance/Math.max(e.length,1)).toFixed(3))};
}
function wordAccuracy(expected, got){ return assessmentMetrics(expected,got).score; }
function normalizeFormula(text){
  return String(text||'').toLowerCase().replace(/equals|equal to|is equal to/g,'=').replace(/multiply|multiplied by|times/g,'*').replace(/divide by/g,'/').replace(/plus/g,'+').replace(/minus/g,'-').replace(/[^a-z0-9=+*/.\s]/g,' ').replace(/\s+/g,' ').trim();
}

async function transcribeAudio(raw, mime, language){
  if(!process.env.OPENAI_API_KEY) throw new Error('Speech provider is not configured');
  const form=new FormData();
  const safeMime=String(mime||'audio/webm').split(';')[0] || 'audio/webm';
  const ext=safeMime.includes('mp4')?'m4a':safeMime.includes('ogg')?'ogg':safeMime.includes('wav')?'wav':safeMime.includes('mpeg')?'mp3':'webm';
  form.append('file',new Blob([raw],{type:safeMime}),`easyway-${Date.now()}.${ext}`);
  form.append('model',TRANSCRIBE_MODEL);
  if(language && /^[a-z]{2}(-[A-Z]{2})?$/.test(language)) form.append('language',language.slice(0,2));
  const r=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{authorization:`Bearer ${process.env.OPENAI_API_KEY}`},body:form});
  const d=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(d.error?.message||`Speech provider HTTP ${r.status}`);
  return {text:String(d.text||'').trim(),model:TRANSCRIBE_MODEL};
}

function findAssessmentItem(state,type,id){
  const subjects=Array.isArray(state?.subjects)?state.subjects:[];
  for(const s of subjects) for(const b of (s.books||[])) for(const c of (b.chapters||[])){
    if(type==='QA') for(const q of (c.qa||[])) if(q.id===id) return {item:structuredClone(q), chapter:c};
    if(type==='Formula') for(const f of (c.formulas||[])) if(f.id===id) return {item:structuredClone(f), chapter:c};
  }
  return null;
}

function findTarget(state,type,id){
  const subjects=Array.isArray(state?.subjects)?state.subjects:[];
  for(const s of subjects){
    if(type==='Subject'&&s.id===id)return {subject:structuredClone(s)};
    for(const b of (s.books||[])){
      if(type==='Book'&&b.id===id)return {book:structuredClone(b)};
      for(const c of (b.chapters||[])){
        if(type==='Chapter'&&c.id===id)return {chapter:structuredClone(c)};
        for(const p of (c.pages||[])){ if(type==='Page'&&p.id===id)return {page:structuredClone(p)}; }
        for(const p of (c.paragraphs||[])){ if(type==='Paragraph'&&p.id===id)return {paragraph:structuredClone(p)}; }
      }
    }
  } return null;
}

function safeGroup(session,viewerId){
  return {id:session.id,title:session.title,content:session.content,status:session.status,hostStudentId:session.hostStudentId,maxParticipants:session.maxParticipants,participants:session.participants.map(x=>({studentId:x.studentId,name:x.name,score:x.score,turns:x.turns,joinedAt:x.joinedAt})),turnIndex:session.turnIndex,currentStudentId:session.participants[session.turnIndex]?.studentId||null,isHost:session.hostStudentId===viewerId,turns:session.turns.map(x=>({id:x.id,studentId:x.studentId,score:x.score,at:x.at})),createdAt:session.createdAt,updatedAt:session.updatedAt};
}

async function handle(req,res) {
  if (!allowedRate(req)) return json(res,429,{error:'Too many requests; try again shortly'});
  const declaredLength=Number(req.headers['content-length']||0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) return json(res,413,{error:'Request body is too large'});
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/api/health')) return json(res,200,{ok:true,service:'easyway-learn-backend',version:APP_VERSION,node:process.version,database:USE_SQLITE?'sqlite':'json',uptimeSeconds:Math.floor(process.uptime()),time:new Date().toISOString()});
  if (!url.pathname.startsWith('/api/')) return serveStatic(req,res);

  if (req.method==='OPTIONS') { securityHeaders(res); res.writeHead(204, {'cache-control':'no-store'}); return res.end(); }

  try {
    const store=readStore();
    store.groupSessions ||= {};
    if (req.method==='POST' && url.pathname==='/api/register') {
      if (req.headers['content-type'] && !req.headers['content-type'].toLowerCase().startsWith('application/json')) return json(res,415,{error:'JSON content required'});
      const b=await body(req); const id=String(b.studentId||'').trim().toUpperCase(); const password=String(b.password||'');
      if (!/^STU-[A-Z0-9-]{2,40}$/.test(id) || password.length < 6) return json(res,400,{error:'Student ID or password does not meet requirements'});
      if (store.students[id]) return json(res,409,{error:'Student ID already exists'});
      const p=hashPassword(password);
      const recovery=recoveryCode();
      store.students[id]={studentId:id,name:String(b.name||''),password:p,recoveryHash:hashRecoveryCode(recovery),profile:b.profile&&typeof b.profile==='object'?b.profile:{},state:{},audit:[]}; audit(store.students[id],'Register','Student account created'); writeStore(store);
      return json(res,201,{studentId:id,recoveryCode:recovery});
    }
    if (req.method==='POST' && url.pathname==='/api/password/reset') {
      if (req.headers['content-type'] && !req.headers['content-type'].toLowerCase().startsWith('application/json')) return json(res,415,{error:'JSON content required'});
      const b=await body(req); const id=String(b.studentId||'').trim().toUpperCase(); const s=store.students[id];
      if (!s || !s.recoveryHash || !verifyRecoveryCode(String(b.recoveryCode||''),s.recoveryHash)) return json(res,401,{error:'Student ID or recovery code is incorrect'});
      const pwd=String(b.newPassword||''); if(pwd.length<6) return json(res,400,{error:'New password must be at least 6 characters'});
      const nextRecovery=recoveryCode(); s.password=hashPassword(pwd); s.recoveryHash=hashRecoveryCode(nextRecovery); deleteStudentSessions(id); audit(s,'Reset Password','Password reset with recovery code; active sessions revoked'); writeStore(store);
      return json(res,200,{ok:true,studentId:id,recoveryCode:nextRecovery});
    }
    if (req.method==='POST' && url.pathname==='/api/login') {
      if (req.headers['content-type'] && !req.headers['content-type'].toLowerCase().startsWith('application/json')) return json(res,415,{error:'JSON content required'});
      const b=await body(req); const id=String(b.studentId||'').trim().toUpperCase(); const s=store.students[id];
      if (!s || !verifyPassword(String(b.password||''),s.password)) return json(res,401,{error:'Invalid Student ID or password'});
      const t=token(); saveSession(t,id,Date.now()+SESSION_TTL_MS); audit(s,'Login'); writeStore(store);
      return json(res,200,{token:t,studentId:id,expiresAt:Date.now()+SESSION_TTL_MS});
    }

    // OCR is a stateless document-processing operation. It must remain usable when a
    // browser has a stale/expired learning-session token. Content saving and all
    // student data APIs below still require authentication. A per-IP rate limit is
    // already applied at the top of this handler.
    if (req.method==='GET' && url.pathname==='/api/ocr-status') {
      const languages=installedTesseractLanguages();
      return json(res,200,{ok:true,ocr:true,languages,eng:languages.includes('eng'),hin:languages.includes('hin'),version:APP_VERSION});
    }

    if (req.method==='POST' && (url.pathname==='/api/ocr' || url.pathname==='/api/ocr-batch')) {
      if (req.headers['content-type'] && !req.headers['content-type'].toLowerCase().startsWith('application/json')) return json(res,415,{error:'JSON content required'});
      const b=await body(req);
      const processOne=async (it, index, lang)=>{
        const mime=String(it?.mime||''); const data=String(it?.data||'');
        if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(mime)) throw new Error('OCR supports JPEG, PNG, WebP and PDF');
        if(!data) throw new Error('Image/PDF data required');
        const raw=Buffer.from(data,'base64'); if(!raw.length) throw new Error('Image/PDF data is invalid');
        if(raw.length>MAX_ASSET_BYTES) throw new Error('OCR input exceeds 30MB');
        return runOCR(raw,mime,lang);
      };
      if(url.pathname==='/api/ocr') {
        try {
          const r=await processOne(b,0,String(b.lang||'eng'));
          return json(res,200,{ok:true,...r,paragraphs:r.paragraphs.map((text,i)=>({id:`OCR-${i+1}`,title:`Detected Paragraph ${i+1}`,text}))});
        } catch(e) {
          return json(res,422,{error:`OCR processing failed: ${e.message||'unknown OCR error'}`});
        }
      }
      const items=Array.isArray(b.items)?b.items:[]; const lang=String(b.lang||'eng');
      if(!items.length) return json(res,400,{error:'At least one OCR item is required'});
      if(items.length>20) return json(res,413,{error:'OCR batch is limited to 20 pages'});
      const results=[];
      for(let i=0;i<items.length;i++) {
        const it=items[i]||{};
        try {
          const r=await processOne(it,i,lang);
          results.push({index:i,name:String(it.name||`page-${i+1}`),ok:true,text:r.text,paragraphs:r.paragraphs.map((text,n)=>({id:`OCR-${i+1}-${n+1}`,title:`Detected Paragraph ${n+1}`,text})),chapterDetection:r.chapterDetection,ocrLanguage:r.ocrLanguage,pageCount:r.pageCount});
        } catch(e) {
          results.push({index:i,name:String(it.name||`page-${i+1}`),ok:false,error:`OCR processing failed: ${e.message||'unknown OCR error'}`});
        }
      }
      const chapterMap=new Map();
      for(const r of results.filter(x=>x.ok)){const key=r.chapterDetection.number?`chapter-${r.chapterDetection.number}`:`fallback-${r.index}`;const g=chapterMap.get(key)||{key,title:r.chapterDetection.title,order:r.chapterDetection.number||null,confidence:r.chapterDetection.confidence,pages:[]};g.pages.push(r.index);chapterMap.set(key,g);}
      return json(res,200,{ok:true,results,groups:[...chapterMap.values()]});
    }

    const me=auth(req);
    if (!me) return json(res,401,{error:'Authentication required'});
    const student=store.students[me.studentId]; if (!student) return json(res,401,{error:'Student account not found'});

    if (req.method==='POST' && url.pathname==='/api/logout') { deleteSession(me.token); audit(student,'Logout'); writeStore(store); return json(res,200,{ok:true}); }
    if (req.method==='GET' && url.pathname==='/api/me') return json(res,200,{studentId:student.studentId,name:student.name,profile:student.profile,state:student.state});
    if (req.method==='PUT' && url.pathname==='/api/me') {
      const b=await body(req); if (typeof b.name==='string') student.name=b.name; if (b.profile && typeof b.profile==='object') student.profile=b.profile; audit(student,'Update Profile'); writeStore(store); return json(res,200,{ok:true});
    }
    if (req.method==='GET' && url.pathname==='/api/backup') {
      const backup={format:'easyway-learn-student-backup',version:50,exportedAt:new Date().toISOString(),studentId:student.studentId,name:student.name,profile:student.profile,state:student.state,assessments:student.assessments||[],shares:student.shares||{incoming:[],outgoing:[],snapshots:{}},audit:student.audit||[]};
      audit(student,'Export Backup','Student data backup exported'); writeStore(store);
      return json(res,200,backup);
    }
    if (req.method==='POST' && url.pathname==='/api/usage') {
      const b=await body(req); const minutes=Math.max(0,Math.min(5,Number(b.minutes||0)));
      if(!Number.isFinite(minutes)||minutes<=0) return json(res,400,{error:'Usage minutes must be positive'});
      student.state ||= {}; student.state.usage ||= {activeMinutes:0,sessions:[]};
      const now=new Date(); const day=now.toISOString().slice(0,10);
      student.state.usage.activeMinutes=(Number(student.state.usage.activeMinutes)||0)+minutes;
      student.state.usage.sessions=Array.isArray(student.state.usage.sessions)?student.state.usage.sessions:[];
      student.state.usage.sessions.unshift({studentId:student.studentId,start:now.toISOString(),minutes,context:String(b.context||'unknown'),day});
      student.state.usage.sessions=student.state.usage.sessions.slice(0,1000);
      audit(student,'Usage Heartbeat',`${minutes} minute(s) • ${String(b.context||'unknown')}`); writeStore(store);
      return json(res,200,{ok:true,usage:student.state.usage});
    }
    if (req.method==='GET' && url.pathname==='/api/usage') {
      student.state ||= {}; student.state.usage ||= {activeMinutes:0,sessions:[]};
      const sessions=Array.isArray(student.state.usage.sessions)?student.state.usage.sessions:[];
      const now=Date.now(); const total=(days)=>sessions.filter(x=>now-Date.parse(x.start)<=days*86400000).reduce((a,x)=>a+Number(x.minutes||0),0);
      return json(res,200,{activeMinutes:Number(student.state.usage.activeMinutes)||0,last7Days:total(7),last30Days:total(30),activeDays7:new Set(sessions.filter(x=>now-Date.parse(x.start)<=7*86400000).map(x=>x.day||String(x.start).slice(0,10))).size});
    }
    if (req.method==='GET' && url.pathname==='/api/rankings') {
      const profile=student.profile||{};
      const school=String(profile.school||'').trim(), className=String(profile.className||'').trim(), section=String(profile.section||'').trim();
      if(!school || !className || !section) return json(res,200,{available:false,reason:'School, class and section are required for student ranking visibility',scope:{school,className,section},rankings:[]});
      const peers=Object.values(store.students).filter(x=>{const q=x.profile||{};return String(q.school||'').trim()===school&&String(q.className||'').trim()===className&&String(q.section||'').trim()===section;});
      const all=[];
      for(const peer of peers){
        const best=new Map();
        for(const a of (peer.assessments||[])){ const k=String(a.targetId||''); if(!k) continue; const score=Number(a.score||0); if(!best.has(k)||score>best.get(k).score) best.set(k,{score,max:Number(a.maxScore||100),type:String(a.type||'')}); }
        const vals=[...best.values()]; const total=vals.reduce((x,a)=>x+a.score/(a.max||100)*100,0); const avg=vals.length?Math.round(total/vals.length):0;
        all.push({studentId:peer.studentId,displayName:peer.name||peer.studentId,score:avg,attempted:vals.length,isCurrent:peer.studentId===student.studentId});
      }
      all.sort((a,b)=>b.score-a.score||a.displayName.localeCompare(b.displayName));
      const ranked=all.map((x,i)=>({...x,rank:i+1}));
      return json(res,200,{available:true,scope:{school,className,section},rankings:ranked});
    }
    if (req.method==='POST' && url.pathname==='/api/group-sessions') {
      const b=await body(req);
      const title=String(b.title||'').trim().slice(0,120);
      const content=String(b.content||'').trim().slice(0,500);
      if(!title||!content) return json(res,400,{error:'title and content are required'});
      const id='GS-'+crypto.randomBytes(4).toString('hex').toUpperCase();
      const session={id,title,content,hostStudentId:me.studentId,status:'Waiting',maxParticipants:5,participants:[{studentId:me.studentId,name:student.name||me.studentId,joinedAt:new Date().toISOString(),score:0,turns:0}],turnIndex:0,turns:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
      store.groupSessions[id]=session; audit(student,'Create Group Session',id); writeStore(store);
      return json(res,201,{ok:true,session:safeGroup(session,me.studentId)});
    }
    if (req.method==='POST' && url.pathname.startsWith('/api/group-sessions/') && url.pathname.endsWith('/join')) {
      const id=url.pathname.split('/')[3]; const session=store.groupSessions[id];
      if(!session) return json(res,404,{error:'Group session not found'});
      if(session.status==='Ended') return json(res,409,{error:'Session ended'});
      if(session.participants.some(x=>x.studentId===me.studentId)) return json(res,200,{ok:true,session:safeGroup(session,me.studentId)});
      if(session.participants.length>=session.maxParticipants) return json(res,409,{error:'Session is full'});
      session.participants.push({studentId:me.studentId,name:student.name||me.studentId,joinedAt:new Date().toISOString(),score:0,turns:0});
      if(session.participants.length>=2) session.status='Live';
      session.updatedAt=new Date().toISOString(); audit(student,'Join Group Session',id); writeStore(store);
      return json(res,200,{ok:true,session:safeGroup(session,me.studentId)});
    }
    if (req.method==='GET' && url.pathname.startsWith('/api/group-sessions/')) {
      const id=url.pathname.split('/')[3]; const session=store.groupSessions[id];
      if(!session) return json(res,404,{error:'Group session not found'});
      if(!session.participants.some(x=>x.studentId===me.studentId)) return json(res,403,{error:'Join the session first'});
      return json(res,200,{ok:true,session:safeGroup(session,me.studentId)});
    }
    if (req.method==='POST' && url.pathname.startsWith('/api/group-sessions/') && url.pathname.endsWith('/turn')) {
      const id=url.pathname.split('/')[3]; const session=store.groupSessions[id]; const b=await body(req);
      if(!session) return json(res,404,{error:'Group session not found'});
      const idx=session.participants.findIndex(x=>x.studentId===me.studentId);
      if(idx<0) return json(res,403,{error:'Join the session first'});
      if(session.status==='Ended') return json(res,409,{error:'Session ended'});
      if(session.participants.length<2) return json(res,409,{error:'At least 2 participants are required'});
      if(session.turnIndex!==idx) return json(res,409,{error:'It is not your turn'});
      const score=Math.max(0,Math.min(100,Number(b.score)||0));
      const transcript=String(b.transcript||'').slice(0,3000);
      session.turns.push({id:crypto.randomUUID(),studentId:me.studentId,participantIndex:idx,score,transcript,at:new Date().toISOString()});
      session.participants[idx].score=Math.round((session.participants[idx].score*(session.participants[idx].turns||0)+score)/((session.participants[idx].turns||0)+1));
      session.participants[idx].turns=(session.participants[idx].turns||0)+1;
      session.turnIndex=(session.turnIndex+1)%session.participants.length; session.updatedAt=new Date().toISOString();
      audit(student,'Group Session Turn',`${id}:${score}`); writeStore(store);
      return json(res,200,{ok:true,session:safeGroup(session,me.studentId)});
    }
    if (req.method==='POST' && url.pathname.startsWith('/api/group-sessions/') && url.pathname.endsWith('/end')) {
      const id=url.pathname.split('/')[3]; const session=store.groupSessions[id];
      if(!session) return json(res,404,{error:'Group session not found'});
      if(session.hostStudentId!==me.studentId) return json(res,403,{error:'Only the session host can end it'});
      session.status='Ended'; session.updatedAt=new Date().toISOString(); audit(student,'End Group Session',id); writeStore(store);
      return json(res,200,{ok:true,session:safeGroup(session,me.studentId)});
    }
    if (req.method==='GET' && url.pathname==='/api/metrics') {
      const assessments=student.assessments||[]; const state=student.state||{};
      const subjects=Array.isArray(state.subjects)?state.subjects:[]; let books=0,chapters=0,pages=0,paragraphs=0;
      for(const s of subjects){books+=(s.books||[]).length; for(const b of (s.books||[])){chapters+=(b.chapters||[]).length; for(const c of (b.chapters||[])){pages+=(c.pages||[]).length; paragraphs+=(c.paragraphs||[]).length;}}}
      return json(res,200,{studentId:student.studentId,counts:{subjects:subjects.length,books,chapters,pages,paragraphs,assessments:assessments.length},latestAssessment:assessments[0]||null,serverTime:new Date().toISOString()});
    }
    if (req.method==='GET' && url.pathname==='/api/state') return json(res,200,{version:50,state:student.state});
    if (req.method==='PUT' && url.pathname==='/api/state') {
      const b=await body(req); if (!b.state || typeof b.state!=='object') return json(res,400,{error:'state object required'});
      student.state=b.state; audit(student,'Sync Learning State'); writeStore(store); return json(res,200,{ok:true,version:1});
    }
    if (req.method==='POST' && url.pathname==='/api/transcribe') {
      const b=await body(req); const mime=String(b.mime||'audio/webm'); const data=String(b.data||''); const language=String(b.language||'');
      if(!data) return json(res,400,{error:'Audio data is required'});
      const raw=Buffer.from(data,'base64'); if(!raw.length) return json(res,400,{error:'Audio data is invalid'});
      if(raw.length>MAX_AUDIO_BYTES) return json(res,413,{error:'Audio exceeds 15MB'});
      if(!/^audio\//.test(mime)) return json(res,415,{error:'Audio MIME type required'});
      try { const result=await transcribeAudio(raw,mime,language); audit(student,'Speech Transcription',`${mime}; ${result.text.length} chars; model=${result.model}`); writeStore(store); return json(res,200,{ok:true,...result}); }
      catch(e){ return json(res,503,{error:e.message.includes('not configured')?'Speech provider is not configured on this server':'Speech transcription temporarily unavailable'}); }
    }
    if (req.method==='POST' && url.pathname==='/api/assessments') {
      const b=await body(req);
      const type=String(b.type||'').trim(); const targetId=String(b.targetId||'').trim(); const transcript=String(b.transcript||'').trim();
      if(type==='Chapter') {
        const parts=Array.isArray(b.parts)?b.parts:[];
        if(!targetId || !parts.length) return json(res,400,{error:'Chapter targetId and paragraph parts are required'});
        const x=findTarget(student.state,'Chapter',targetId);
        if(!x) return json(res,404,{error:'Chapter not found'});
        const required=Array.isArray(x.chapter.paragraphs)?x.chapter.paragraphs:[];
        if(!required.length || parts.length!==required.length || parts.some((part,i)=>String(part.paragraphId||'')!==String(required[i].id||''))) return json(res,409,{error:'Chapter test must include every required paragraph in sequential order'});
        const qualificationBest = new Map();
        for (const a of (student.assessments||[])) {
          if (a.type === 'Qualification' && a.targetId && !qualificationBest.has(a.targetId)) qualificationBest.set(a.targetId, Number(a.score||0));
        }
        const unqualified = required.filter(p => Number(qualificationBest.get(p.id) || 0) < 80).map(p => p.id);
        if (unqualified.length) return json(res,409,{error:'Chapter test is locked until every paragraph reaches 80% reading qualification',unqualifiedParagraphIds:unqualified});
        const scored=required.map((p,i)=>{const text=String(parts[i].transcript||'').trim();if(!text) throw new Error('Every chapter paragraph requires a transcript');const m=assessmentMetrics(p.text||'',text);return {paragraphId:p.id,title:p.title||'',score:m.score,maxScore:Number(p.maxScore||10),transcript:text,metrics:m};});
        const total=scored.reduce((a,x)=>a+x.score*x.maxScore/100,0), max=scored.reduce((a,x)=>a+x.maxScore,0), pct=max?Math.round(total/max*100):0;
        const prior=(student.assessments||[]).filter(a=>a.type==='Chapter'&&a.targetId===targetId);
        const high=Math.max(pct,...prior.map(a=>Number(a.score||0)));
        const attempt={id:crypto.randomUUID(),studentId:student.studentId,type:'Chapter',targetId,score:pct,maxScore:100,attempt:prior.length+1,highScore:high,createdAt:new Date().toISOString(),parts:scored};
        student.assessments ||= []; student.assessments.unshift(attempt); student.assessments=student.assessments.slice(0,5000);
        audit(student,'Chapter Assessment',`${targetId}=${pct}% attempt=${attempt.attempt}`); writeStore(store);
        return json(res,201,{ok:true,attempt});
      }
      if(!['Qualification','Speaking','QAQualification','QA','Formula'].includes(type) || !targetId || !transcript) return json(res,400,{error:'Assessment type, targetId and transcript are required'});
      let expected='', maxScore=10, score=0, extra={};
      if(type==='Qualification' || type==='Speaking'){
        const x=findTarget(student.state,'Paragraph',targetId); if(!x) return json(res,404,{error:'Paragraph not found'});
        expected=x.paragraph.text||''; maxScore=Number(x.paragraph.maxScore||10); const m=assessmentMetrics(expected,transcript); score=m.score;
        extra={paragraphTitle:x.paragraph.title||'', underline:[], metrics:m};
      } else if(type==='QAQualification' || type==='QA'){
        const x=findAssessmentItem(student.state,'QA',targetId); if(!x) return json(res,404,{error:'Question not found'});
        expected=type==='QAQualification' ? `${x.item.question||''} ${x.item.answer||''}` : (x.item.answer||''); maxScore=Number(x.item.maxScore||5); const m=assessmentMetrics(expected,transcript); score=m.score;
        extra={question:x.item.question||'', metrics:m};
      } else {
        const x=findAssessmentItem(student.state,'Formula',targetId); if(!x) return json(res,404,{error:'Formula not found'});
        maxScore=Number(x.item.maxScore||10);
        const got=normalizeFormula(transcript), exp=normalizeFormula(x.item.formula||'');
        const aliases=(x.item.spokenAliases||[]).map(normalizeFormula);
        const ok=got.replace(/\s/g,'')===exp.replace(/\s/g,'') || aliases.some(a=>a.replace(/\s/g,'')===got.replace(/\s/g,''));
        score=ok?100:(wordAccuracy((x.item.spokenAliases||[]).join(' '),transcript)>=60?60:0);
        extra={formula:x.item.formula||''};
      }
      const attempt={id:crypto.randomUUID(),studentId:student.studentId,type,targetId,score,maxScore,transcript,createdAt:new Date().toISOString(),...extra};
      student.assessments ||= []; student.assessments.unshift(attempt); student.assessments=student.assessments.slice(0,5000);
      audit(student,'Assessment',`${type}:${targetId}=${score}%`); writeStore(store);
      return json(res,201,{ok:true,attempt});
    }
    if (req.method==='POST' && url.pathname==='/api/anti-cheat') {
      const b=await body(req);
      const data=String(b.imageData||'');
      const targetId=String(b.targetId||'').slice(0,200);
      const trigger=String(b.trigger||'Manual trigger').slice(0,120);
      if(!data.startsWith('data:image/jpeg;base64,')) return json(res,400,{error:'JPEG evidence image required'});
      const raw=Buffer.from(data.split(',')[1]||'','base64');
      if(!raw.length||raw.length>MAX_ANTICHEAT_BYTES) return json(res,413,{error:'Evidence image exceeds 1.5MB'});
      const id='ACE-'+crypto.randomUUID();
      const rel=path.join('anticheat',student.studentId,id+'.jpg');
      const abs=path.join(ASSET_DIR,rel); fs.mkdirSync(path.dirname(abs),{recursive:true}); fs.writeFileSync(abs,raw);
      student.antiCheatEvidence ||= [];
      const item={id,studentId:student.studentId,targetId,trigger,createdAt:new Date().toISOString(),mime:'image/jpeg',size:raw.length,path:rel,reviewStatus:'Pending Review'};
      student.antiCheatEvidence.unshift(item); student.antiCheatEvidence=student.antiCheatEvidence.slice(0,100);
      audit(student,'Anti-Cheating Evidence',`${trigger}${targetId?`:${targetId}`:''}`); writeStore(store);
      return json(res,201,{ok:true,evidence:{...item,path:undefined}});
    }
    if (req.method==='GET' && url.pathname==='/api/anti-cheat') {
      return json(res,200,{evidence:(student.antiCheatEvidence||[]).map(x=>({...x,path:undefined}))});
    }
    if (req.method==='POST' && url.pathname==='/api/feedback') {
      const b=await body(req);
      const issue=String(b.issue||'').trim(); const comment=String(b.comment||'').trim(); const targetId=String(b.targetId||'').trim();
      if(!issue || !comment) return json(res,400,{error:'Feedback type and details are required'});
      student.feedback ||= [];
      const item={id:crypto.randomUUID(),studentId:student.studentId,issue,comment,targetId,createdAt:new Date().toISOString(),status:'Pending Review'};
      student.feedback.unshift(item); student.feedback=student.feedback.slice(0,1000);
      audit(student,'Content Feedback',`${issue}${targetId?`:${targetId}`:''}`); writeStore(store);
      return json(res,201,{ok:true,feedback:item});
    }
    if (req.method==='GET' && url.pathname==='/api/feedback') {
      return json(res,200,{feedback:student.feedback||[]});
    }
    if (req.method==='POST' && url.pathname==='/api/password') {
      const b=await body(req); if (!verifyPassword(String(b.currentPassword||''),student.password)) return json(res,401,{error:'Current password is incorrect'});
      if (String(b.newPassword||'').length<6) return json(res,400,{error:'New password must be at least 6 characters'});
      student.password=hashPassword(String(b.newPassword));
      deleteStudentSessions(student.studentId);
      audit(student,'Change Password','All active sessions revoked'); writeStore(store); return json(res,200,{ok:true});
    }
    if (req.method==='POST' && url.pathname==='/api/shares') {
      const b=await body(req); const to=String(b.toStudentId||'').trim().toUpperCase();
      if(!/^STU-[A-Z0-9-]{2,40}$/.test(to) || to===student.studentId) return json(res,400,{error:'Invalid receiving Student ID'});
      const receiver=store.students[to]; if(!receiver) return json(res,404,{error:'Receiving Student ID was not found'});
      student.shares ||= {incoming:[],outgoing:[],snapshots:{}}; receiver.shares ||= {incoming:[],outgoing:[],snapshots:{}};
      const share={id:crypto.randomUUID(),fromStudentId:student.studentId,fromName:student.name||'',toStudentId:to,targetType:String(b.targetType||''),targetId:String(b.targetId||''),targetLabel:String(b.targetLabel||''),status:'Pending',createdAt:new Date().toISOString()};
      student.shares.outgoing.unshift(share); receiver.shares.incoming.unshift(share); audit(student,'Share Content',`${share.targetType}:${share.targetId} to ${to}`); audit(receiver,'Incoming Share',`${share.targetType}:${share.targetId} from ${student.studentId}`); writeStore(store); return json(res,201,{share});
    }
    if (req.method==='GET' && url.pathname==='/api/shares') {
      student.shares ||= {incoming:[],outgoing:[],snapshots:{}}; return json(res,200,student.shares);
    }
    if (req.method==='POST' && url.pathname.startsWith('/api/shares/') && url.pathname.endsWith('/accept')) {
      const id=url.pathname.split('/')[3]; student.shares ||= {incoming:[],outgoing:[],snapshots:{}}; const x=student.shares.incoming.find(v=>v.id===id);
      if(!x) return json(res,404,{error:'Share request not found'}); if(x.status!=='Pending') return json(res,409,{error:'Share request is not pending'});
      const owner=store.students[x.fromStudentId]; if(!owner) return json(res,404,{error:'Sharing student not found'}); const source=findTarget(owner.state,x.targetType,x.targetId);
      if(!source) return json(res,409,{error:'Shared content is no longer available'});
      x.status='Accepted'; student.shares.snapshots[id]={...source,type:x.targetType,sourceId:x.targetId};
      owner.shares ||= {incoming:[],outgoing:[],snapshots:{}}; const out=owner.shares.outgoing.find(v=>v.id===id); if(out) out.status='Accepted'; audit(student,'Accept Share',`${x.targetType}:${x.targetId} from ${x.fromStudentId}`); audit(owner,'Share Accepted',`${x.targetType}:${x.targetId} by ${student.studentId}`); writeStore(store); return json(res,200,{ok:true,share:x,snapshot:student.shares.snapshots[id]});
    }
    if (req.method==='POST' && url.pathname.startsWith('/api/shares/') && url.pathname.endsWith('/reject')) {
      const id=url.pathname.split('/')[3]; student.shares ||= {incoming:[],outgoing:[],snapshots:{}}; const x=student.shares.incoming.find(v=>v.id===id);
      if(!x) return json(res,404,{error:'Share request not found'}); x.status='Rejected'; const owner=store.students[x.fromStudentId]; if(owner){owner.shares ||= {incoming:[],outgoing:[],snapshots:{}}; const out=owner.shares.outgoing.find(v=>v.id===id); if(out) out.status='Rejected'; audit(owner,'Share Rejected',`${x.targetType}:${x.targetId} by ${student.studentId}`);} audit(student,'Reject Share',`${x.targetType}:${x.targetId} from ${x.fromStudentId}`); writeStore(store); return json(res,200,{ok:true,share:x});
    }
    if (req.method==='PUT' && url.pathname.startsWith('/api/assets/')) {
      const key=decodeURIComponent(url.pathname.slice('/api/assets/'.length)); if(!/^[A-Za-z0-9:_-]{1,180}$/.test(key)) return json(res,400,{error:'Invalid asset key'});
      const b=await body(req); const data=String(b.data||''); const mime=String(b.mime||'application/octet-stream'); if(!data) return json(res,400,{error:'Asset data required'});
      if (!/^([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+)$/.test(mime) || !['image/jpeg','image/png','image/webp','application/pdf'].includes(mime)) return json(res,415,{error:'Unsupported asset type'});
      const raw=Buffer.from(data,'base64'); if(raw.length>MAX_ASSET_BYTES) return json(res,413,{error:'Asset exceeds 10MB'}); const meta=path.join(ASSET_DIR,`${student.studentId}__${key.replace(/[^A-Za-z0-9_-]/g,'_')}.json`); const tmp=meta+'.tmp'; fs.writeFileSync(tmp,JSON.stringify({mime,data:raw.toString('base64'),updatedAt:new Date().toISOString()})); fs.renameSync(tmp,meta); audit(student,'Upload Page Asset',key); writeStore(store); return json(res,200,{ok:true,key,size:raw.length});
    }
    if (req.method==='GET' && url.pathname.startsWith('/api/assets/')) {
      const key=decodeURIComponent(url.pathname.slice('/api/assets/'.length)); const meta=path.join(ASSET_DIR,`${student.studentId}__${key.replace(/[^A-Za-z0-9_-]/g,'_')}.json`); if(!fs.existsSync(meta)) return json(res,404,{error:'Asset not found'}); const a=JSON.parse(fs.readFileSync(meta,'utf8')); res.writeHead(200,{'content-type':a.mime||'application/octet-stream','cache-control':'private, max-age=300'}); return res.end(Buffer.from(a.data,'base64'));
    }
    if (req.method==='DELETE' && url.pathname.startsWith('/api/assets/')) {
      const key=decodeURIComponent(url.pathname.slice('/api/assets/'.length)); const meta=path.join(ASSET_DIR,`${student.studentId}__${key.replace(/[^A-Za-z0-9_-]/g,'_')}.json`); if(fs.existsSync(meta)) fs.unlinkSync(meta); audit(student,'Delete Page Asset',key); writeStore(store); return json(res,200,{ok:true});
    }
    return json(res,404,{error:'API route not found'});
  } catch (e) {
    if (e instanceof SyntaxError) return json(res,400,{error:'Invalid JSON body'});
    if (e && e.message === 'Payload too large') return json(res,413,{error:'Request body is too large'});
    return json(res,500,{error:'Server error'});
  }
}

ensureStore();
if (process.env.NODE_ENV === 'production' && !USE_SQLITE) { console.error('Production mode requires SQLite support (Node 22+)'); process.exit(1); }
let server;
const cleanupTimer=setInterval(()=>{ if(USE_SQLITE && db){ try{ db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); }catch{} } }, 15*60*1000);
cleanupTimer.unref();
function shutdown(){ try{ if(server) server.close(()=>{}); }catch{} try{ if(db) db.close(); }catch{} process.exit(0); }
process.on('SIGTERM',shutdown); process.on('SIGINT',shutdown);
server=http.createServer((req,res)=>handle(req,res)).listen(PORT,()=>console.log(`Easyway Learn backend listening on :${PORT}`));
