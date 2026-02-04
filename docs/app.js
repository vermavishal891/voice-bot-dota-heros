console.log('[voice-app] build v5', window.__VOICE_APP_BUILD__);
const chatEl = document.getElementById('chat');
const form = document.getElementById('form');
const input = document.getElementById('input');
const btnClear = document.getElementById('btnClear');
const btnStop = document.getElementById('btnStop');
const btnEnableAudio = document.getElementById('btnEnableAudio');

const DATA_URL = './data/voice_index.json';

let DB = null;

// Single global audio player (attach to DOM for better iOS/in-app support)
let audio = document.createElement('audio');
audio.preload = 'auto';
audio.controls = false;
audio.style.display = 'none';
// Avoid hotlink/referrer blocks on some CDNs
audio.referrerPolicy = 'no-referrer';
document.body.appendChild(audio);

const RECENT_KEY = 'dota2_voice_recent_v1';
const RECENT_MAX = 120; // avoid repeats

const AUDIO_ENABLED_KEY = 'dota2_voice_audio_enabled_v1';

let audioCtx = null;
let audioEnabled = false;

function loadRecent(){
  try {
    const x = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(x) ? x : [];
  } catch { return []; }
}
function saveRecent(arr){
  localStorage.setItem(RECENT_KEY, JSON.stringify(arr.slice(-RECENT_MAX)));
}

function loadAudioEnabled(){
  return localStorage.getItem(AUDIO_ENABLED_KEY) === '1';
}
function setAudioEnabled(v){
  audioEnabled = !!v;
  localStorage.setItem(AUDIO_ENABLED_KEY, audioEnabled ? '1' : '0');
  btnEnableAudio.textContent = audioEnabled ? 'Audio Enabled' : 'Enable Audio';
  btnEnableAudio.classList.toggle('primary', audioEnabled);
}

async function unlockAudio(){
  // Creates/resumes an AudioContext on a user gesture. This "unlocks" autoplay.
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = new Ctx();
  }
  if (audioCtx.state !== 'running') {
    await audioCtx.resume();
  }

  // Play a near-silent blip to fully unlock output
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  gain.gain.value = 0.0001;
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.02);

  // also try to "prime" the <audio> element
  try {
    audio.muted = true;
    await audio.play();
  } catch {}
  audio.pause();
  audio.muted = false;
}

function esc(s){
  return String(s).replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
}

function addMsg({ role, text, hero=null, tags=[], audioSrc=null, lineId=null }){
  const div = document.createElement('div');
  div.className = `msg ${role}`;

  const meta = document.createElement('div');
  meta.className = 'meta';

  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.textContent = role === 'user' ? 'You' : (hero || 'Bot');

  const right = document.createElement('div');
  right.style.display = 'flex';
  right.style.gap = '10px';
  right.style.alignItems = 'center';

  const tagsEl = document.createElement('div');
  tagsEl.className = 'tags';
  for (const t of (tags||[]).slice(0, 8)) {
    const span = document.createElement('span');
    span.className = 'tag';
    span.textContent = t;
    tagsEl.appendChild(span);
  }
  right.appendChild(tagsEl);

  if (role === 'bot' && audioSrc) {
    const btn = document.createElement('button');
    btn.className = 'btn ghost';
    btn.textContent = 'Play';
    btn.title = 'Play this voice line';
    btn.dataset.audioSrc = audioSrc;
    if (lineId) btn.dataset.lineId = lineId;
    btn.addEventListener('click', async ()=>{
      await playUrl(audioSrc);
    });
    right.appendChild(btn);
  }

  meta.appendChild(badge);
  meta.appendChild(right);

  const body = document.createElement('div');
  body.className = 'text';
  body.innerHTML = esc(text);

  div.appendChild(meta);
  div.appendChild(body);
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function tokenize(s){
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g,' ')
    .split(/\s+/)
    .map(w=>w.replace(/^'+|'+$/g,''))
    .filter(Boolean);
}

const stop = new Set([
  'i','me','my','myself','we','our','ours','ourselves','you','your','yours','yourself','yourselves',
  'he','him','his','himself','she','her','hers','herself','it','its','itself','they','them','their','theirs','themselves',
  'a','an','the','and','but','or','nor','so','yet','for','of','to','in','on','at','by','from','with','about','as','into','like','through','after','over','between','out','against','during','without','before','under','around','among',
  'is','am','are','was','were','be','been','being','do','does','did','doing','have','has','had','having',
  'will','would','shall','should','can','could','may','might','must',
  'this','that','these','those','there','here','then','than','now','not','no','yes',
  'what','which','who','whom','when','where','why','how',
  'just','very','too','also','still','again','some','want','wants'
]);

function queryKeywords(q){
  const w = tokenize(q).filter(x=>!stop.has(x));
  return w.slice(0,10);
}

function buildDb(raw){
  const items = raw.items || [];
  const prepared = items.map(it => ({
    ...it,
    _text: String(it.text).toLowerCase(),
    _tags: new Set((it.tags||[]).map(t=>String(t).toLowerCase()))
  }));
  return { items: prepared };
}

function scoreItem(item, qWords){
  let s = 0;
  for (const w of qWords) {
    if (item._tags.has(w)) s += 8;
  }
  for (const w of qWords) {
    if (w.length >= 4 && item._text.includes(w)) s += 3;
  }
  s += Math.random() * 1.25;
  return s;
}

function weightedPick(cands){
  const total = cands.reduce((a,c)=>a+Math.max(0,c.score),0);
  if (total <= 0) return cands[Math.floor(Math.random()*cands.length)]?.item;
  let r = Math.random() * total;
  for (const c of cands) {
    r -= Math.max(0, c.score);
    if (r <= 0) return c.item;
  }
  return cands[cands.length-1]?.item;
}

function chooseReply(q){
  const qWords = queryKeywords(q);
  const recent = loadRecent();
  const recentSet = new Set(recent);

  const scored = [];
  for (const it of DB.items) {
    let s = scoreItem(it, qWords);
    if (recentSet.has(it.id)) s *= 0.15;
    scored.push({ item: it, score: s });
  }
  scored.sort((a,b)=>b.score-a.score);

  const K = 220;
  const top = scored.slice(0, K);
  const pick = weightedPick(top) || DB.items[Math.floor(Math.random()*DB.items.length)];

  if (pick?.id) {
    const next = recent.filter(x=>x!==pick.id);
    next.push(pick.id);
    saveRecent(next);
  }
  return pick;
}

async function playUrl(url){
  if (!url) return;

  // If user enabled audio, prefer WebAudio playback (more reliable than <audio> in some setups)
  if (audioEnabled && audioCtx) {
    try {
      if (audioCtx.state !== 'running') await audioCtx.resume();
      const res = await fetch(url, { referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const buf = await res.arrayBuffer();
      const decoded = await audioCtx.decodeAudioData(buf.slice(0));

      const src = audioCtx.createBufferSource();
      src.buffer = decoded;
      src.connect(audioCtx.destination);
      src.start(0);
      return;
    } catch (e) {
      // fall back to <audio>
    }
  }

  const tryPlay = async (player) => {
    player.pause?.();
    try { player.currentTime = 0; } catch {}
    player.src = url;
    player.load?.();
    return await player.play();
  };

  try {
    await tryPlay(audio);
    return;
  } catch (e1) {
    try {
      const a2 = new Audio();
      a2.preload = 'auto';
      a2.referrerPolicy = 'no-referrer';
      await tryPlay(a2);
      audio.pause();
      audio = a2;
      document.body.appendChild(audio);
      return;
    } catch (e2) {
      const msg = (err) => {
        if (!err) return 'Unknown error';
        const name = err.name || 'Error';
        const m = err.message || String(err);
        return `${name}: ${m}`;
      };
      addMsg({
        role: 'bot',
        text:
          'Audio failed to play in this browser.\n' +
          `Error 1: ${msg(e1)}\n` +
          `Error 2: ${msg(e2)}\n` +
          'Click Enable Audio once, then try again. Also try the direct link below:',
      });
      addMsg({ role:'bot', text: url });
    }
  }
}

async function init(){
  setAudioEnabled(loadAudioEnabled());

  addMsg({ role:'bot', text:'Loading voice lines…' });
  const res = await fetch(DATA_URL, { cache: 'force-cache' });
  const raw = await res.json();
  DB = buildDb(raw);
  chatEl.innerHTML = '';
  addMsg({ role:'bot', text:`Loaded ${raw.count.toLocaleString()} voice lines. Say something.` });
  if (!audioEnabled) {
    addMsg({ role:'bot', text:'Tip: click “Enable Audio” once. After that, replies should auto-play.' });
  }
  input.focus();
}

form.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const q = input.value.trim();
  if (!q || !DB) return;
  input.value = '';

  addMsg({ role:'user', text:q });

  const item = chooseReply(q);
  addMsg({ role:'bot', hero: item.hero, text: item.text, tags: item.tags, audioSrc: item.audioSrc, lineId: item.id });

  // Autoplay only after user explicitly enabled audio.
  if (audioEnabled) {
    await playUrl(item.audioSrc);
  }
});

btnClear.addEventListener('click', ()=>{
  chatEl.innerHTML='';
  localStorage.removeItem(RECENT_KEY);
  addMsg({ role:'bot', text:'Cleared. Say something.' });
  input.focus();
});

btnEnableAudio.addEventListener('click', async ()=>{
  try {
    await unlockAudio();
    setAudioEnabled(true);
    addMsg({ role:'bot', text:'Audio enabled. Replies should auto-play now.' });
  } catch {
    addMsg({ role:'bot', text:'Could not enable audio in this browser. Try again or use a different browser.' });
  }
});

btnStop.addEventListener('click', ()=>{
  audio.pause();
  try { audio.currentTime = 0; } catch {}
});

init();
