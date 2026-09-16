/* ============================================================================
 * AuraDetector — app.js
 * Router, UI, usage limits, history, share cards, battle, admin, paywall.
 * ==========================================================================*/
(() => {
"use strict";
const E = window.AuraEngine;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const nf = new Intl.NumberFormat();

/* ------------------------------- Storage ---------------------------------- */
const K = {
  usage: "auradetector.usage",
  history: "auradetector.history",
  premium: "auradetector.premium",
  account: "auradetector.account",
  metrics: "auradetector.metrics",
  plan: "auradetector.plan",
};
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));

function todayKey() { return new Date().toISOString().slice(0, 10); }
function getUsage() {
  const u = read(K.usage, null);
  if (!u || u.date !== todayKey()) { const fresh = { date: todayKey(), count: 0, bonus: 0, adWatched: 0 }; write(K.usage, fresh); return fresh; }
  return u;
}
function saveUsage(u) { write(K.usage, u); }
/* Premium is server truth (Stripe webhook → database). The client never decides. */
function isPremium() { return Boolean(state.me && state.me.premium); }
const AUTH_ERROR_MESSAGES = {
  google_not_configured: "Google sign-in isn't configured on the server. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
  google_access_denied: "Google denied access. If the OAuth consent screen is in Testing, add your Google account as a test user.",
  google_redirect_uri_mismatch: "Google redirect URI mismatch: add the exact redirect URI shown on this page to Google Cloud Console.",
  google_invalid_client: "Google rejected the client ID/secret. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
  google_invalid_grant: "The Google sign-in expired or was already used. Please try again.",
  google_verify_failed: "Google sign-in could not be verified. Please try again.",
  google_token_failed: "Google token exchange failed. Please try again.",
  google_error: "Google sign-in failed. Please try again.",
  apple_not_configured: "Apple sign-in isn't configured on the server.",
  apple_token_failed: "Apple sign-in failed. Please try again.",
  invalid_state: "The sign-in session expired. Please try again.",
  no_code: "No authorization code was returned. Please try again.",
};
function authErrorText(code) {
  if (!code) return "Sign-in failed. Please try again.";
  for (const k of Object.keys(AUTH_ERROR_MESSAGES)) if (code.startsWith(k)) return AUTH_ERROR_MESSAGES[k];
  return "Sign-in failed (" + code + "). Please try again.";
}
async function refreshProviders() {
  try {
    const r = await fetch(E.getApiBase() + "/api/auth/providers", { credentials: "include" });
    if (r.ok) state.providers = await r.json();
  } catch {}
}
async function refreshMe() {
  try {
    const r = await fetch(E.getApiBase() + "/api/me", { credentials: "include" });
    if (!r.ok) return;
    const j = await r.json();
    state.me = { user: j.user || null, premium: !!j.premium, plan: j.plan || null, subscription: j.subscription || null };
    if (j.user && Array.isArray(j.scans)) state.serverScans = j.scans;
  } catch {}
}
function scansRemaining() {
  if (isPremium()) return Infinity;
  const u = getUsage();
  const limit = E.getConfig().freeScansPerDay + (u.bonus || 0);
  return Math.max(0, limit - u.count);
}
function consumeScan() {
  if (isPremium()) { bumpMetric("premiumScans"); return true; }
  const u = getUsage();
  const limit = E.getConfig().freeScansPerDay + (u.bonus || 0);
  if (u.count >= limit) return false;
  u.count++; saveUsage(u); return true;
}

/* --------------------------- Lightweight metrics -------------------------- */
function getMetrics() {
  return read(K.metrics, { totalScans: 0, premiumScans: 0, errors: 0, apiCalls: 0, adImpressions: 0, revenueCents: 0, adRevenueCents: 0, signups: 0 });
}
function bumpMetric(key, by = 1) { const m = getMetrics(); m[key] = (m[key] || 0) + by; write(K.metrics, m); }

/* ------------------------------- History ---------------------------------- */
function getHistory() { return read(K.history, []); }
function addHistory(result, mode) {
  const h = getHistory();
  h.unshift({ id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), ts: Date.now(), mode, score: result.score, tier: result.tier, archetype: result.archetype, categories: result.categories, summary: result.summary });
  write(K.history, h.slice(0, 200));
}

/* --------------------------------- State ---------------------------------- */
const state = { result: null, plan: read(K.plan, "yearly"), lastFile: null, battleA: null, battleB: null, currentScreen: "home", me: { user: null, premium: false, plan: null, subscription: null }, providers: null, serverScans: null, scanning: false, lastScan: null };

/* ------------------------------- Router ----------------------------------- */
function navigate(name) {
  const el = document.getElementById("screen-" + name);
  if (!el) return;
  $$(".screen").forEach(s => s.classList.remove("active"));
  el.classList.add("active", "viewfade");
  setTimeout(() => el.classList.remove("viewfade"), 400);
  state.currentScreen = name;
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  $$(".bottomnav button").forEach(b => b.classList.toggle("active", b.dataset.nav === name));
  if (name === "history") renderHistory();
  if (name === "account") renderAccount();
  if (name === "admin") renderAdmin();
  if (name === "result" && state.result) renderResult();
}

/* --------------------------------- Toast ---------------------------------- */
let toastT;
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms);
}

/* --------------------------- Static home content -------------------------- */
function renderArchetypes() {
  const g = $("#archGridHome");
  g.innerHTML = E.AURA_ARCHETYPES.map(a => `<div class="arch-cell"><span class="a-ico">${a.ico}</span>${a.name.replace("THE ", "")}</div>`).join("");
}
const FAQ = [
  ["What is Aura Score?", "It's a playful 0–1000 score generated by AI from visible or described elements of a photo or scenario — outfit, styling, composition, light, pose and context. It is entertainment, not a measurement."],
  ["Is Aura Score real?", "No. There is no physical property called “aura” that the app measures. It is a fun, AI-generated entertainment score and should be treated as a game."],
  ["Does Aura Score judge my personality?", "No. The analysis looks only at visible presentation and described context. It does not infer or judge who you are, and it deliberately avoids sensitive traits."],
  ["Are my photos stored?", "Your photo is processed to produce your result and is not kept by the app afterwards. Free history keeps only the result data, not the original image."],
  ["How does Aura Pro work?", "Aura Pro unlocks deeper analysis, a personalised improvement plan, outfit analysis, the photo optimizer, Aura Battle and Aura History. You can cancel anytime."],
  ["Can I delete my data?", "Yes. The Privacy & Data page has “Delete my data” and “Delete my account”, and EU users can email privacy@auradetector.app for any request."],
  ["Can I cancel Premium?", "Yes, anytime. Cancelling stops the renewal and keeps access until the end of the paid period."],
];
function renderFAQ() { $("#faqList").innerHTML = FAQ.map(([q, a]) => `<div class="faq-item"><button class="faq-q">${q}<span>＋</span></button><div class="faq-a"><p>${a}</p></div></div>`).join(""); }
function renderExamples() {
  const ex = ["I walk into a party wearing a black leather jacket and say nothing.", "I'm at the gym, headphones on, black tank top.", "I post this photo on Instagram.", "I arrive late to class.", "I cross the street in a long coat at midnight."];
  $("#scenarioExamples").innerHTML = ex.map(e => `<button class="chip" data-ex="${e.replace(/"/g, "&quot;")}">${e}</button>`).join("");
}

/* ----------------------------- Config -> UI ------------------------------- */
function applyConfigToUI() {
  const c = E.getConfig();
  $$("[data-price]").forEach(el => { el.textContent = c.currency + (el.dataset.price === "monthly" ? Number(c.priceMonthly).toFixed(2) : Number(c.priceYearly).toFixed(2)); });
  $("#homeBestValue").style.display = c.premiumFeatures ? "" : "none";
  renderAIStatus();
}
async function refreshPublicConfig() {
  try {
    const r = await fetch(E.getApiBase() + "/api/config", { credentials: "include" });
    if (!r.ok) return;
    const j = await r.json();
    if (j && j.config) E.setConfig(j.config);
    applyConfigToUI();
  } catch {}
}
function renderAIStatus() {
  renderConnectionBanner();
  const pill = $("#aiStatusPill"), txt = $("#aiStatusText");
  const st = E.getBackendStatus();
  if (!st.checked) { txt.textContent = "Connecting to server…"; pill.classList.remove("off"); return; }
  if (!st.ok) { txt.textContent = "Server not connected"; pill.classList.add("off"); return; }
  if (st.ai && st.ai.configured) {
    const p = st.ai.provider === "openai" ? "OpenAI" : st.ai.provider === "gemini" ? "Gemini" : st.ai.provider === "openrouter" ? "OpenRouter" : st.ai.provider;
    txt.textContent = "AI ready · " + p + (st.ai.model ? " · " + st.ai.model : "");
    pill.classList.remove("off");
  } else {
    txt.textContent = "AI not configured on the server";
    pill.classList.add("off");
  }
}

/* ------------------------------- Photo flow ------------------------------- */
function validateImage(file) {
  if (!file) return "Choose a photo first.";
  const type = (file.type || "").toLowerCase();
  // Empty type happens on some mobile browsers — the server sniffs the real bytes.
  if (type && !["image/jpeg", "image/png", "image/webp"].includes(type)) return "That format isn't supported. Please use JPG, PNG or WEBP.";
  if (file.size > 10 * 1024 * 1024) return "Your photo is larger than 10 MB. Please choose a smaller file.";
  return null;
}
function setPreview(file) {
  const err = validateImage(file);
  const errEl = $("#photoError");
  if (err) { errEl.textContent = err; errEl.hidden = false; state.lastFile = null; $("#btnAnalyzePhoto").disabled = true; return; }
  errEl.hidden = true;
  state.lastFile = file;
  const url = URL.createObjectURL(file);
  const img = $("#previewImg"); img.src = url; img.hidden = false;
  $(".dz-inner").style.display = "none";
  $("#btnAnalyzePhoto").disabled = false;
}

/* ---------------------------- Result rendering ---------------------------- */
function scoreRingSVG(score) {
  const R = 100, C = 2 * Math.PI * R;
  const offset = C * (1 - score / 1000);
  return `<div class="score-ring">
    <svg viewBox="0 0 230 230">
      <defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#a855f7"/><stop offset="55%" stop-color="#7c3aed"/><stop offset="100%" stop-color="#22d3ee"/>
      </linearGradient></defs>
      <circle class="track" cx="115" cy="115" r="${R}" fill="none" stroke-width="14"/>
      <circle class="bar" cx="115" cy="115" r="${R}" fill="none" stroke-width="14"
        stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${C.toFixed(2)}" data-target="${offset.toFixed(2)}"/>
    </svg>
    <div class="ring-center">
      <div class="ring-score" data-count="${score}">0</div>
      <div class="ring-max">/ 1000</div>
      <div class="ring-label">AURA SCORE</div>
    </div>
  </div>`;
}
function catsHTML(cats) {
  return `<div class="cat-list">${E.AURA_CATEGORY_KEYS.map(([k, label]) =>
    `<div class="cat"><span class="cat-name">${label}</span><span class="cat-val">${cats[k]}/100</span>
      <div class="cat-bar"><div class="cat-fill" data-w="${cats[k]}"></div></div></div>`).join("")}</div>`;
}
function archetypeObj(name) { return E.AURA_ARCHETYPES.find(a => a.name === name) || E.AURA_ARCHETYPES[0]; }

function renderResult() {
  const r = state.result; if (!r) return;
  const body = $("#resultBody");
  const arch = archetypeObj(r.archetype);
  const premium = isPremium();
  const pf = E.getConfig().premiumFeatures;

  const proLock = (title, inner) => premium ? inner
    : `<div class="pro-gate"><h4>🔒 ${title}</h4><p class="muted small">This is part of Aura Pro.</p><button class="btn btn-primary btn-block" data-open-paywall>UNLOCK AURA PRO</button></div>`;

  body.innerHTML = `
  <div class="block">
    <div class="result-hero">
      ${scoreRingSVG(r.score)}
      <div class="tier-big">${r.tier.toUpperCase()} AURA</div>
      <div class="delta">${r.score >= 715 ? "+" : ""}${r.score - 715} compared to average</div>
    </div>

    <div class="glass panel" style="margin-top:16px">
      <h3 class="panel-title">CATEGORIES</h3>
      ${catsHTML(r.categories)}
    </div>

    <div class="archetype-card">
      <div class="archetype-eyebrow">YOUR AURA ARCHETYPE</div>
      <div class="archetype-name">${arch.ico} ${r.archetype}</div>
      <p class="archetype-desc">${r.summary || arch.desc}</p>
    </div>

    ${proLock("FULL AURA ANALYSIS", `
      <div class="two-col">
        <div class="list-card up"><h4>WHAT RAISES YOUR AURA</h4><ul>${(r.strengths.length ? r.strengths : ["A clear, deliberate presentation."]).map(s => `<li>${s}</li>`).join("")}</ul></div>
        <div class="list-card down"><h4>WHAT LOWERS IT</h4><ul>${(r.improvements.length ? r.improvements : ["Nothing major — keep the current direction."]).map(s => `<li>${s}</li>`).join("")}</ul></div>
      </div>`)}

    ${proLock("HOW TO INCREASE YOUR AURA", `
      <div class="glass panel" style="margin-top:0">
        <h3 class="panel-title">3 THINGS TO INCREASE YOUR AURA</h3>
        <ol class="pro-list" style="padding-left:20px">${buildImprovePlan(r).map(x => `<li>${x}</li>`).join("")}</ol>
        <p class="small muted" style="margin-top:12px">Estimated potential Aura: <b style="color:#4ade80">${Math.min(1000, r.score + 72)}</b> · playful in-app estimate, not a guaranteed result.</p>
      </div>`)}

    ${r._outfit || r.mode === "image" ? proLock("OUTFIT & PHOTO ANALYSIS", `
      <div class="glass panel" style="margin-top:0" id="outfitPanel"><h3 class="panel-title">OUTFIT ANALYSIS</h3>${outfitHTML(r)}</div>`) : ""}

    ${proLock("PHOTO OPTIMIZER", `
      <div class="glass panel" style="margin-top:0"><h3 class="panel-title">HOW CAN I MAKE THIS BETTER?</h3><ul class="pro-list" style="padding-left:20px">${optimizerPlan(r).map(x => `<li>${x}</li>`).join("")}</ul></div>`)}

    <div class="glass panel" style="margin-top:16px">
      <h3 class="panel-title">REMEMBER</h3>
      <p class="small muted">AuraDetector is an entertainment product. This score is AI-generated and is not a scientific measurement of you. It never assesses sensitive traits.</p>
    </div>

    <div class="share-wrap">
      <h3 class="sec-title" style="align-self:flex-start">Share your Aura</h3>
      <img class="share-card-img" id="shareCardImg" alt="AuraDetector share card" />
      <div class="btn-row" style="width:100%">
        <button class="btn btn-primary" style="flex:1" id="btnShare">SHARE MY AURA</button>
        <button class="btn btn-ghost" id="btnDownload">Download</button>
        <button class="btn btn-ghost" id="btnCopyLink">Copy link</button>
      </div>
    </div>

    <div class="viral-card">
      <h4>Challenge your friend</h4>
      <p class="muted small">Send a link and let them try to beat you.</p>
      <button class="btn btn-outline btn-block" id="btnChallenge">SEND “Can you beat my ${r.score} Aura?”</button>
    </div>

    <div class="pro-gate" style="text-align:center">
      <h4>${premium ? "Aura Pro is active ✦" : "Want to know how to reach " + (Math.floor(r.score / 100) * 100 + 100) + "+?"}</h4>
      <p class="muted small">Full analysis, personalised plan, outfit breakdown, photo optimizer, Aura Battle and History.</p>
      ${premium ? `<button class="btn btn-ghost btn-block" data-nav="history">VIEW MY HISTORY</button>`
                : `<button class="btn btn-primary btn-block" data-open-paywall>UNLOCK AURA PRO</button>`}
      <p class="tiny muted" style="margin-top:10px">Cancel anytime. No dark patterns.</p>
    </div>

    <div class="btn-col">
      ${scansRemaining() === 0 && !premium ? `<button class="btn btn-outline btn-block" id="btnAd">WATCH AN AD TO GET 1 EXTRA SCAN</button>` : ""}
      <button class="btn btn-ghost btn-block" data-nav="battle">AURA BATTLE ⚔</button>
      <button class="btn btn-ghost btn-block" data-nav="home">SCAN ANOTHER LOOK</button>
    </div>
  </div>`;

  // share card
  drawShareCard(r).then(url => { const i = $("#shareCardImg"); if (i) i.src = url; });
  // animations
  requestAnimationFrame(() => {
    const bar = $(".score-ring .bar");
    if (bar) bar.style.strokeDashoffset = bar.dataset.target;
    $$(".cat-fill").forEach(f => requestAnimationFrame(() => (f.style.width = f.dataset.w + "%")));
    countUp($(".ring-score"));
  });
}
function countUp(el) {
  if (!el) return; const target = Number(el.dataset.count), dur = 1400, t0 = performance.now();
  const step = (t) => { const p = Math.min(1, (t - t0) / dur); const eased = 1 - Math.pow(1 - p, 3); el.textContent = nf.format(Math.round(target * eased)); if (p < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
function labelOf(k) { return (E.AURA_CATEGORY_KEYS.find(([key]) => key === k) || [k, k])[1]; }
function buildImprovePlan(r) {
  const c = r.categories;
  const sorted = E.AURA_CATEGORY_KEYS.map(([k]) => [k, c[k]]).sort((a, b) => a[1] - b[1]);
  const tips = {
    presence: "Frame yourself more deliberately — step into the centre of the shot and give the camera a clear subject.",
    style: "Simplify and commit: fewer elements, one strong colour story and a clear silhouette.",
    confidence_vibe: "Use a more confident pose — shoulders back, chin level, hands doing something intentional.",
    photo_energy: "Improve lighting: face a soft light source and add contrast between subject and background.",
    originality: "Add one unexpected element that doesn't follow the obvious formula.",
    mystery: "Leave more out. Negative space, a darker mood and less explanation read as power.",
  };
  return sorted.slice(0, 3).map(([k]) => tips[k]);
}
function outfitHTML(r) {
  const c = r.categories;
  const rows = [["STYLE SCORE", c.style], ["COLOR MATCH", Math.round((c.style + c.originality) / 2)], ["SILHOUETTE", Math.round((c.presence + c.style) / 2)], ["ACCESSORIES", Math.round((c.style + c.photo_energy) / 2)], ["PHOTO COMPATIBILITY", Math.round((c.style + c.photo_energy + c.presence) / 3)]];
  return `<div class="cat-list">${rows.map(([k, v]) => `<div class="cat"><span class="cat-name">${k}</span><span class="cat-val">${v}/100</span><div class="cat-bar"><div class="cat-fill" style="width:${v}%"></div></div></div>`).join("")}</div>`;
}
function optimizerPlan(r) {
  const c = r.categories;
  const tips = [];
  tips.push(c.photo_energy < 80 ? "Crop tighter and lead with the light on your face." : "Your light is strong — keep the crop generous to preserve atmosphere.");
  tips.push(c.presence < 80 ? "Lower the angle slightly so you read taller and more dominant in frame." : "Angle is good — try a half-step turn for a more dynamic line.");
  tips.push(c.mystery < 80 ? "Simplify the background so the eye lands on you, not the room." : "Keep the moody background — it's doing work for you.");
  tips.push("Match outfit contrast to the setting so you separate from the background.");
  return tips;
}

/* --------------------------- Share card (9:16) ---------------------------- */
async function drawShareCard(r) {
  const W = 1080, H = 1920;
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const x = cv.getContext("2d");
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#0a0616"); g.addColorStop(.5, "#05050a"); g.addColorStop(1, "#0b0620");
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  // orbs
  const orb = (cx, cy, rad, col) => { const rg = x.createRadialGradient(cx, cy, 0, cx, cy, rad); rg.addColorStop(0, col); rg.addColorStop(1, "transparent"); x.fillStyle = rg; x.fillRect(0, 0, W, H); };
  orb(220, 300, 520, "rgba(168,85,247,.55)");
  orb(900, 1600, 620, "rgba(34,211,238,.35)");
  // frame
  x.strokeStyle = "rgba(255,255,255,.10)"; x.lineWidth = 3; x.strokeRect(40, 40, W - 80, H - 80);
  x.textAlign = "center";
  x.fillStyle = "#9aa0b8"; x.font = "600 40px 'Space Grotesk', sans-serif";
  x.fillText("AuraDetector", W / 2, 150);
  x.fillStyle = "#a855f7"; x.font = "600 30px 'Space Grotesk', sans-serif";
  x.fillText("✦ AURA SCANNER ✦", W / 2, 200);

  x.fillStyle = "#ffffff"; x.font = "700 120px 'Space Grotesk', sans-serif";
  x.fillText("MY AURA", W / 2, 760);

  const sg = x.createLinearGradient(200, 0, 880, 0); sg.addColorStop(0, "#a855f7"); sg.addColorStop(.55, "#7c3aed"); sg.addColorStop(1, "#22d3ee");
  x.fillStyle = sg; x.font = "700 320px 'Space Grotesk', sans-serif";
  x.fillText(String(r.score), W / 2, 1120);
  x.fillStyle = "#6b6f8a"; x.font = "600 44px 'Space Grotesk', sans-serif";
  x.fillText("/ 1000", W / 2, 1190);

  x.fillStyle = "#ffffff"; x.font = "700 90px 'Space Grotesk', sans-serif";
  x.fillText(r.tier.toUpperCase(), W / 2, 1330);
  x.fillStyle = "#8b8ba7"; x.font = "500 44px 'Inter', sans-serif";
  x.fillText(String(r.archetype), W / 2, 1410);

  x.fillStyle = "rgba(255,255,255,.75)"; x.font = "600 48px 'Inter', sans-serif";
  x.fillText("Scan yours at AuraDetector", W / 2, 1660);
  x.fillStyle = "rgba(255,255,255,.4)"; x.font = "400 30px 'Inter', sans-serif";
  x.fillText("auradetector.app · entertainment only", W / 2, 1720);
  return cv.toDataURL("image/png");
}

/* --------------------------------- Battle --------------------------------- */
async function runBattle() {
  const wrap = $("#battleOut"); const err = $("#battleError");
  if (!state.battleA || !state.battleB) { err.textContent = "Choose both photos."; err.hidden = false; return; }
  err.hidden = true;
  wrap.innerHTML = `<div class="glass panel center"><p class="muted">Reading both auras…</p></div>`;
  try {
    const [a, b] = await Promise.all([
      E.runAuraScan({ kind: "image", file: state.battleA }),
      E.runAuraScan({ kind: "image", file: state.battleB }),
    ]);
    const winner = a.score >= b.score ? "A" : "B";
    wrap.innerHTML = `<div class="glass panel">
      <h3 class="panel-title">RESULT</h3>
      <div class="battle-out">
        <div class="battle-side ${winner === "A" ? "win" : ""}"><div class="tiny muted">PHOTO A</div><div class="bs-score">${a.score}</div><div class="tiny">${a.archetype}</div>${winner === "A" ? '<div class="tiny" style="color:#4ade80">WINNER</div>' : ""}</div>
        <div class="battle-side ${winner === "B" ? "win" : ""}"><div class="tiny muted">PHOTO B</div><div class="bs-score">${b.score}</div><div class="tiny">${b.archetype}</div>${winner === "B" ? '<div class="tiny" style="color:#4ade80">WINNER</div>' : ""}</div>
      </div>
      <p class="small muted" style="margin-top:14px">Photo ${winner} reads stronger overall. The differences come from composition, light and presentation — both are valid looks, not a judgement of the person.</p>
      <button class="btn btn-ghost btn-block" style="margin-top:14px" data-nav="home">BACK HOME</button>
    </div>`;
  } catch (e) {
    wrap.innerHTML = `<div class="glass panel"><p class="muted">Sorry, these images can't be analyzed.</p></div>`;
  }
}

/* -------------------------------- History --------------------------------- */
function renderHistory() {
  const body = $("#historyBody");
  const server = state.me && state.me.user && state.serverScans;
  const h = server
    ? state.serverScans.map(s => ({ score: s.score, tier: s.tier, archetype: s.archetype, ts: s.created_at, categories: s.categories }))
    : getHistory();
  if (!h.length) { body.innerHTML = `<div class="block"><div class="glass panel center"><h3 class="panel-title">NO SCANS YET</h3><p class="muted small">Your history appears here after your first scan.</p><button class="btn btn-primary btn-block" data-nav="photo">SCAN MY AURA</button></div></div>`; return; }
  const best = Math.max(...h.map(x => x.score));
  const avg = Math.round(h.reduce((a, x) => a + x.score, 0) / h.length);
  const days = new Set(h.map(x => new Date(x.ts).toISOString().slice(0, 10))).size;
  body.innerHTML = `<div class="block">
    <div class="stat-grid">
      <div class="stat"><div class="k">Scans</div><div class="v">${h.length}</div></div>
      <div class="stat"><div class="k">Best</div><div class="v">${best}</div></div>
      <div class="stat"><div class="k">Average</div><div class="v">${avg}</div></div>
      <div class="stat"><div class="k">Active days</div><div class="v">${days}</div></div>
    </div>
    <div class="chart-box"><h3 class="sec-title" style="font-size:18px;margin-bottom:10px">MY AURA EVOLUTION</h3><canvas id="histChart" width="640" height="220" style="width:100%;height:auto"></canvas></div>
    <h3 class="sec-title" style="font-size:18px;margin:22px 0 10px">RECENT SCANS</h3>
    ${h.slice(0, 20).map(x => `<div class="hist-item"><div class="hist-score">${x.score}</div><div class="hist-meta"><b>${x.archetype}</b><span>${x.tier} · ${new Date(x.ts).toLocaleString()}</span></div></div>`).join("")}
  </div>`;
  drawHistoryChart(h);
}
function drawHistoryChart(h) {
  const cv = $("#histChart"); if (!cv) return; const x = cv.getContext("2d");
  const W = cv.width, H = cv.height, pad = 30;
  const pts = h.slice(0, 20).reverse();
  const min = Math.min(...pts.map(p => p.score), 700) - 20, max = Math.max(...pts.map(p => p.score), 800) + 20;
  x.clearRect(0, 0, W, H);
  x.strokeStyle = "rgba(255,255,255,.08)"; x.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const y = pad + (H - 2 * pad) * i / 4; x.beginPath(); x.moveTo(pad, y); x.lineTo(W - pad, y); x.stroke(); }
  const px = i => pad + (W - 2 * pad) * (pts.length === 1 ? 0.5 : i / (pts.length - 1));
  const py = v => H - pad - (H - 2 * pad) * ((v - min) / (max - min));
  const grd = x.createLinearGradient(pad, 0, W - pad, 0); grd.addColorStop(0, "#a855f7"); grd.addColorStop(1, "#22d3ee");
  x.strokeStyle = grd; x.lineWidth = 3; x.beginPath();
  pts.forEach((p, i) => { i ? x.lineTo(px(i), py(p.score)) : x.moveTo(px(i), py(p.score)); }); x.stroke();
  x.fillStyle = grd;
  pts.forEach((p, i) => { x.beginPath(); x.arc(px(i), py(p.score), 4, 0, 7); x.fill(); });
}

/* Admin rendering is server-driven — see renderAdmin() above. */

/* -------------------------------- Paywall --------------------------------- */
function openPaywall(score) {
  const c = E.getConfig();
  $("#paywallHero").textContent = c.paywallHeadline.replace("{score}", score ?? 842);
  $("#paywallQuestion").textContent = c.paywallQuestion;
  $("#paywallPerks").innerHTML = ["Full aura analysis — what raises and lowers it", "How to increase your aura (personalised plan)", "Outfit analysis & photo optimizer", "Aura Battle — two photos, one winner", "Aura History with evolution chart"].map(p => `<li>${p}</li>`).join("");
  selectPlan(state.plan);
  $("#paywallModal").hidden = false;
}
function selectPlan(plan) {
  state.plan = plan; write(K.plan, plan);
  $$("#planToggle .plan").forEach(p => p.classList.toggle("active", p.dataset.plan === plan));
}
function closePaywall() { $("#paywallModal").hidden = true; }

/* ------------------------------- Settings --------------------------------- */
async function openSettings() {
  $("#setApiBase").value = E.getApiBase();
  $("#setOffline").checked = E.getOfflinePreview();
  $("#settingsModal").hidden = false;
  $("#setStatus").textContent = "Checking server…";
  const st = await E.checkHealth();
  $("#setStatus").textContent = !st.ok
    ? "Not connected (" + (E.getApiBase() || "same origin") + "). " + (E.backendProblemHint ? E.backendProblemHint() : "")
    : (st.ai && st.ai.configured
      ? `Server online · AI: ${st.ai.provider} · ${st.ai.model}`
      : "Server online, but no AI provider key is configured server-side.");
  renderAIStatus();
}
function saveSettings() {
  E.setApiBase($("#setApiBase").value.trim());
  E.setOfflinePreview($("#setOffline").checked);
  $("#settingsModal").hidden = true;
  E.checkHealth().then(() => { renderAIStatus(); refreshPublicConfig(); });
  toast("Settings saved.");
}

/* --------------------------------- Account -------------------------------- */
async function renderAccount() {
  const body = $("#accountBody");
  if (!body) return;
  if (!state.providers) await refreshProviders();
  const prov = state.providers || {};
  const gReady = !!(prov.google && prov.google.configured);
  const aReady = !!(prov.apple && prov.apple.configured);
  const u = state.me && state.me.user;
  if (!u) {
    body.innerHTML = `<div class="block">
      <div class="glass panel">
        <h3 class="panel-title">SIGN IN</h3>
        <p class="muted small">You can scan once a day without an account. Sign in to save your history and activate Aura Pro.</p>
        <label class="label">Email</label><input class="input" id="accEmail" type="email" autocomplete="email" placeholder="you@example.com" />
        <label class="label">Password</label><input class="input" id="accPassword" type="password" autocomplete="current-password" placeholder="At least 8 characters" />
        <p class="field-error" id="accError" hidden></p>
        <div class="btn-col">
          <button class="btn btn-primary btn-block" id="btnAccLogin">SIGN IN</button>
          <button class="btn btn-outline btn-block" id="btnAccRegister">CREATE ACCOUNT</button>
        </div>
        <div class="oauth-row">
          ${gReady ? `<a class="btn btn-ghost btn-block" href="${E.getApiBase()}/api/auth/google">Continue with Google</a>`
                   : `<button class="btn btn-ghost btn-block" disabled>Continue with Google (not configured)</button>`}
          ${aReady ? `<a class="btn btn-ghost btn-block" href="${E.getApiBase()}/api/auth/apple">Continue with Apple</a>`
                   : `<button class="btn btn-ghost btn-block" disabled>Continue with Apple (not configured)</button>`}
        </div>
        ${!gReady && prov.google && prov.google.redirectUri ? `<div class="glass" style="padding:12px 14px;margin-top:12px;border-radius:12px">
          <p class="tiny muted" style="margin:0 0 6px">To enable Google sign-in, in Google Cloud Console → Credentials → OAuth client (Web):</p>
          <p class="tiny" style="margin:0 0 4px">Authorized JavaScript origin:<br><b style="word-break:break-all">${prov.origin || location.origin}</b></p>
          <p class="tiny" style="margin:0">Authorized redirect URI:<br><b style="word-break:break-all">${prov.google.redirectUri}</b></p>
        </div>` : ""}
        <p class="tiny muted">Social sign-in works when the corresponding provider credentials are configured on the server.</p>
      </div>
    </div>`;
    return;
  }
  const sub = (state.me && state.me.subscription) || {};
  body.innerHTML = `<div class="block">
    <div class="glass panel">
      <h3 class="panel-title">SIGNED IN</h3>
      <p><b>${u.email || "(no email)"}</b>${u.name ? " · " + u.name : ""}</p>
      <p class="small muted">Plan: <b>${state.me.premium ? (state.me.plan || "Aura Pro").toUpperCase() : "FREE"}</b>${sub.currentPeriodEnd ? " · renews " + new Date(sub.currentPeriodEnd).toLocaleDateString() : ""}${sub.cancelAtPeriodEnd ? " · cancels at period end" : ""}</p>
      ${state.me.premium ? "" : `<button class="btn btn-primary btn-block" id="btnAccUpgrade">UNLOCK AURA PRO</button>`}
      ${sub.manageable ? `<button class="btn btn-outline btn-block" id="btnAccPortal" style="margin-top:10px">MANAGE SUBSCRIPTION</button>` : ""}
      <div class="btn-col"><button class="btn btn-ghost btn-block" id="btnAccLogout">SIGN OUT</button></div>
    </div>
    <p class="tiny muted center">Payments are processed by Stripe. AuraDetector never sees your card details.</p>
  </div>`;
}
async function accountAuth(kind) {
  const email = $("#accEmail").value.trim();
  const password = $("#accPassword").value;
  const err = $("#accError");
  if (err) err.hidden = true;
  try {
    const r = await fetch(E.getApiBase() + "/api/auth/" + kind, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { await refreshMe(); renderAccount(); toast(kind === "register" ? "Welcome to AuraDetector." : "Signed in."); return; }
    if (err) { err.textContent = j.message || (r.status === 429 ? "Too many attempts. Please wait and try again." : "Something went wrong. Please try again."); err.hidden = false; }
  } catch { if (err) { err.textContent = "Could not reach the server."; err.hidden = false; } }
}

/* ------------------------------- Admin UI --------------------------------- */
function renderAdminLogin(message) {
  const lock = $("#adminLock");
  lock.hidden = false; $("#adminBody").hidden = true;
  lock.innerHTML = `<h3 class="panel-title">PROTECTED AREA</h3>
    <p class="muted small">Admin access is verified on the server. Enter the admin passphrase.</p>
    <input type="password" id="adminPass" class="input" placeholder="Passphrase" autocomplete="current-password" />
    <p class="field-error" id="adminError" ${message ? "" : "hidden"}>${message || ""}</p>
    <button class="btn btn-primary btn-block" id="btnAdminLogin">UNLOCK</button>
    <p class="tiny muted">The credential is never stored in the frontend or localStorage.</p>`;
}
function adminKpi(k, v) { return `<div class="admin-kpi"><div class="k">${k}</div><div class="v">${v}</div></div>`; }

async function renderAdmin() {
  const lock = $("#adminLock"), body = $("#adminBody");
  body.hidden = true; lock.hidden = false; lock.innerHTML = `<p class="muted small center">Checking session…</p>`;
  if (!E.getBackendStatus().checked) await E.checkHealth();
  const st = E.getBackendStatus();
  if (!st.ok) { lock.innerHTML = `<h3 class="panel-title">SERVER NOT CONNECTED</h3><p class="muted small">The admin area needs the AuraDetector backend. Set the API base in ⚙ or run the server.</p>`; return; }
  if (!st.adminEnabled) { lock.innerHTML = `<h3 class="panel-title">ADMIN DISABLED</h3><p class="muted small">Admin credentials are not configured in the server environment. Set them server-side to enable this area.</p>`; return; }

  const me = await fetch(E.getApiBase() + "/api/admin/me", { credentials: "include" });
  if (me.status !== 200) { renderAdminLogin(); return; }

  const [mres, cres] = await Promise.all([
    fetch(E.getApiBase() + "/api/admin/metrics", { credentials: "include" }),
    fetch(E.getApiBase() + "/api/admin/config", { credentials: "include" }),
  ]);
  if (mres.status !== 200 || cres.status !== 200) { renderAdminLogin("Your session expired. Please sign in again."); return; }
  const m = await mres.json();
  const cfg = ((await cres.json()).config) || {};
  const conv = m.totalScans ? Math.round((m.aiScans / m.totalScans) * 100) + "%" : "—";
  const scansByDay = Object.entries(m.scansByDay || {}).slice(-7);
  const topList = m.topArchetypes || [];
  const maxTop = topList.length ? topList[0][1] : 1;

  lock.hidden = true; body.hidden = false;
  body.innerHTML = `<div class="block">
    <div class="btn-row" style="justify-content:flex-end;margin-bottom:12px">
      <button class="btn btn-ghost" id="btnAdminRefresh">REFRESH</button>
      <button class="btn btn-outline" id="btnAdminLogout">LOGOUT</button>
    </div>
    <div class="admin-grid">
      ${adminKpi("Total scans", m.totalScans)}${adminKpi("AI scans", m.aiScans)}${adminKpi("AI share", conv)}
      ${adminKpi("Image scans", m.imageScans)}${adminKpi("Text scans", m.textScans)}${adminKpi("Errors", m.errors)}
      ${adminKpi("Blocked", m.blocked || 0)}${adminKpi("Avg latency", (m.avgLatencyMs || 0) + " ms")}${adminKpi("Uptime", Math.round((m.uptimeSeconds || 0) / 60) + " min")}
    </div>
    <div class="admin-section">
      <h3>AI PROVIDER</h3>
      <div class="glass panel" style="margin:0"><p class="small" style="margin:0">Provider: <b>${(m.ai && m.ai.provider) || "—"}</b> · Model: <b>${(m.ai && m.ai.model) || "—"}</b> · Key configured: <b style="color:${m.ai && m.ai.configured ? "#4ade80" : "#f87171"}">${m.ai && m.ai.configured ? "yes" : "no"}</b></p></div>
    </div>
    <div class="admin-section">
      <h3>TOP ARCHETYPES</h3>
      <div class="glass panel" style="margin:0">${topList.length ? topList.map(([a, n]) => `<div class="cat"><span class="cat-name">${a}</span><span class="cat-val">${n}</span><div class="cat-bar"><div class="cat-fill" style="width:${Math.round((n / maxTop) * 100)}%"></div></div></div>`).join("") : '<p class="muted small">No data yet.</p>'}</div>
    </div>
    <div class="admin-section">
      <h3>SCANS BY DAY</h3>
      <div class="glass panel" style="margin:0">${scansByDay.length ? scansByDay.map(([d, n]) => `<div class="cat"><span class="cat-name">${d}</span><span class="cat-val">${n}</span></div>`).join("") : '<p class="muted small">No data yet.</p>'}</div>
    </div>
    <div class="admin-section">
      <h3>ERRORS</h3>
      <div class="glass panel" style="margin:0">${m.errorCodes && Object.keys(m.errorCodes).length ? Object.entries(m.errorCodes).map(([c, n]) => `<div class="cat"><span class="cat-name">${c}</span><span class="cat-val">${n}</span></div>`).join("") : '<p class="muted small">No errors logged.</p>'}</div>
    </div>
    <div class="admin-section">
      <h3>SETTINGS</h3>
      <div class="glass panel" style="margin:0">
        <label class="label">Product name</label><input class="input" id="cfgName" value="${(cfg.productName || "").replace(/"/g, "&quot;")}" />
        <label class="label">Free scans per day</label><input class="input" type="number" min="0" id="cfgFree" value="${cfg.freeScansPerDay}" />
        <label class="label">Monthly price (${cfg.currency || "€"})</label><input class="input" type="number" step="0.01" id="cfgMonthly" value="${cfg.priceMonthly}" />
        <label class="label">Yearly price (${cfg.currency || "€"})</label><input class="input" type="number" step="0.01" id="cfgYearly" value="${cfg.priceYearly}" />
        <label class="label">Paywall headline ({score} = placeholder)</label><input class="input" id="cfgPayHead" value="${(cfg.paywallHeadline || "").replace(/"/g, "&quot;")}" />
        <label class="label">Paywall question</label><input class="input" id="cfgPayQ" value="${(cfg.paywallQuestion || "").replace(/"/g, "&quot;")}" />
        <label class="label">Premium features</label>
        <div class="btn-row" style="gap:14px;flex-wrap:wrap">${Object.keys(cfg.premiumFeatures || {}).map(k => `<label class="tiny" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-feat="${k}" ${cfg.premiumFeatures[k] ? "checked" : ""} /> ${k}</label>`).join("")}</div>
        <div class="btn-col"><button class="btn btn-primary btn-block" id="btnSaveConfig">SAVE SETTINGS</button></div>
      </div>
    </div>
    <p class="tiny muted">Metrics come from the server and are protected by a server-side admin session. Images are never stored.</p>
  </div>`;
}

/* --------------------------------- Ad ------------------------------------- */
function openAd() {
  if (isPremium()) { toast("Aura Pro already includes unlimited scans."); return; }
  const u = getUsage();
  if (u.adWatched >= 3) { toast("You've reached the ad limit for today."); return; }
  $("#adModal").hidden = false;
  let n = 5; const cd = $("#adCountdown"); cd.textContent = n; $("#btnClaimAd").disabled = true;
  const t = setInterval(() => { n--; cd.textContent = n; if (n <= 0) { clearInterval(t); $("#btnClaimAd").disabled = false; } }, 1000);
}

/* --------------------------- Scan orchestration --------------------------- */
const PHASES = ["Uploading photo…", "Analyzing style…", "Reading the vibe…", "Calculating Aura Score…"];

/* Every backend failure maps to a simple, non-technical message. */
const ERROR_MESSAGES = {
  INVALID_IMAGE: "That photo couldn't be read. Please choose another one.",
  UNSUPPORTED_FORMAT: "That format isn't supported. Please use JPG, PNG or WEBP.",
  FILE_TOO_LARGE: "Your photo is larger than 10 MB. Please choose a smaller one.",
  UPLOAD_FAILED: "The upload failed. Please try again.",
  AI_CONFIGURATION_ERROR: "The AI service isn't configured yet. Please try again later.",
  AI_TIMEOUT: "The analysis took too long. Please try again.",
  AI_RATE_LIMIT: "The AI service is busy right now. Please try again in a moment.",
  AI_RESPONSE_ERROR: "The AI returned an unexpected response. Please try again.",
  RATE_LIMITED: "You've reached today's scan limit. Try again later or unlock Aura Pro.",
  FREE_QUOTA_EXCEEDED: "Our free AI capacity is full right now. Please try again in a few minutes.",
  MODEL_UNAVAILABLE: "The AI model is busy right now. Please try again in a moment.",
  CONTENT_REJECTED: "This content can't be analysed. Please try something else.",
  NETWORK_ERROR: "We couldn't reach the AuraDetector server.",
  API_NOT_FOUND: "The AuraDetector API was not found at the configured address.",
  SERVER_ERROR: "Something went wrong while analysing your photo. Please try again.",
};

function setScanning(on) {
  state.scanning = on;
  const btn = $("#btnAnalyzePhoto"), bs = $("#btnAnalyzeScenario"), bb = $("#btnBattle");
  if (btn) { btn.disabled = on || !state.lastFile; btn.textContent = on ? "SCANNING…" : "SCAN MY AURA"; }
  if (bs) { bs.disabled = on; bs.textContent = on ? "SCANNING…" : "CALCULATE MY AURA"; }
  if (bb) bb.disabled = on || !(state.battleA && state.battleB);
}

function renderError(code) {
  const msg = ERROR_MESSAGES[code] || ERROR_MESSAGES.SERVER_ERROR;
  const connectionIssue = ["NETWORK_ERROR", "API_NOT_FOUND"].includes(code) || !E.getBackendStatus().ok;
  const hint = connectionIssue && E.backendProblemHint
    ? `<p class="tiny warn" style="max-width:46ch;margin:0 auto 20px">${E.backendProblemHint()}</p>` : "";
  const body = $("#errorBody");
  body.innerHTML = `<div class="block">
    <div class="glass panel center">
      <div class="error-ico">⚠︎</div>
      <h3 class="panel-title">WE COULDN'T READ YOUR AURA</h3>
      <p class="muted" style="max-width:38ch;margin:0 auto ${hint ? "10px" : "20px"}">${msg}</p>
      ${hint}
      <div class="btn-col">
        <button class="btn btn-primary btn-block" id="btnRetry">TRY AGAIN</button>
        <button class="btn btn-ghost btn-block" data-nav="home">BACK HOME</button>
        <button class="btn btn-ghost btn-block" id="btnConnSettings">CONNECTION SETTINGS</button>
      </div>
    </div>
  </div>`;
  navigate("error");
}

function renderConnectionBanner() {
  const el = $("#connBanner");
  if (!el) return;
  const st = E.getBackendStatus();
  if (!st.checked || st.ok) { el.hidden = true; return; }
  const base = E.getApiBase() || "(same origin)";
  el.hidden = false;
  $("#connBannerText").textContent = "AI backend not connected (" + base + "). " + (E.backendProblemHint ? E.backendProblemHint() : "");
}

async function performScan(kind, payload) {
  if (state.scanning) return; // prevent duplicate requests
  if (!isPremium() && scansRemaining() <= 0) { openPaywall(state.result ? state.result.score : 842); return; }
  state.lastScan = { kind, payload };
  setScanning(true);
  navigate("loading");
  const fill = $("#loadProgress");
  $$("#phaseList li").forEach(li => li.className = "");
  let phase = 0; if (fill) fill.style.width = "6%";
  const adv = setInterval(() => {
    $$("#phaseList li").forEach((li, i) => { li.className = i < phase ? "done" : i === phase ? "active" : ""; });
    if (fill) fill.style.width = Math.round(8 + phase * 26) + "%";
    phase = Math.min(PHASES.length - 1, phase + 1);
  }, 900);
  const t0 = Date.now();
  try {
    const result = await E.runAuraScan({ kind, file: payload.file, text: payload.text });
    const elapsed = Date.now() - t0;
    if (elapsed < 1200) await new Promise(r => setTimeout(r, 1200 - elapsed));
    clearInterval(adv);
    if (fill) fill.style.width = "100%";
    $$("#phaseList li").forEach(li => li.className = "done");
    await new Promise(r => setTimeout(r, 200));
    result.mode = kind;
    state.result = result;
    addHistory(result, kind);
    bumpMetric("totalScans");
    bumpMetric(kind === "image" ? "imageScans" : "textScans");
    navigate("result");
    if (!isPremium()) setTimeout(() => openPaywall(result.score), 2800);
  } catch (err) {
    clearInterval(adv);
    bumpMetric("errors");
    renderError((err && err.code) || "SERVER_ERROR");
  } finally {
    setScanning(false);
  }
}

/* ---------------------------- Referral / viral ---------------------------- */
function handleReferral() {
  const p = new URLSearchParams(location.search);
  const ref = p.get("ref");
  if (!ref || !/^\d{1,4}$/.test(ref)) return;
  const banner = document.createElement("div");
  banner.className = "glass panel";
  banner.style.cssText = "max-width:760px;margin:14px auto;text-align:center";
  banner.innerHTML = `<h3 class="panel-title">YOUR FRIEND GOT ${ref}. WHAT'S YOUR AURA?</h3>
    <p class="muted small">You were challenged. Scan your aura and try to beat ${ref}.</p>
    <button class="btn btn-primary btn-block" data-nav="photo">SCAN YOUR AURA</button>`;
  $("#screen-home").insertBefore(banner, $("#screen-home").children[1] || null);
}

/* ------------------------------- Init ------------------------------------- */
function bindEvents() {
  document.addEventListener("click", (ev) => {
    const nav = ev.target.closest("[data-nav]");
    if (nav) { navigate(nav.dataset.nav); return; }
    if (ev.target.closest("[data-open-paywall]")) { openPaywall(state.result ? state.result.score : 842); return; }
    const ex = ev.target.closest("[data-ex]");
    if (ex) { $("#scenarioInput").value = ex.dataset.ex; return; }
    const faq = ev.target.closest(".faq-q");
    if (faq) { faq.parentElement.classList.toggle("open"); return; }
    const plan = ev.target.closest("#planToggle .plan");
    if (plan) { selectPlan(plan.dataset.plan); return; }
    const close = ev.target.closest("[data-close]");
    if (close) { const id = close.dataset.close; if (id === "payload") closePaywall(); else if (id === "settings") $("#settingsModal").hidden = true; else if (id === "ad") $("#adModal").hidden = true; return; }
  });

  // photo
  $("#fileInput").addEventListener("change", e => { if (e.target.files[0]) setPreview(e.target.files[0]); });
  const dz = $("#dropzone");
  ["dragenter", "dragover"].forEach(t => dz.addEventListener(t, e => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach(t => dz.addEventListener(t, e => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) setPreview(f); });
  $("#btnAnalyzePhoto").addEventListener("click", () => { if (state.lastFile) performScan("image", { file: state.lastFile }); });

  // scenario
  $("#btnAnalyzeScenario").addEventListener("click", () => {
    const t = $("#scenarioInput").value.trim();
    const err = $("#scenarioError");
    if (t.length < 3) { err.textContent = "Describe the scenario first."; err.hidden = false; return; }
    err.hidden = true; performScan("text", { text: t });
  });

  // battle
  $("#battleA").addEventListener("change", e => previewBattle(e.target.files[0], "A"));
  $("#battleB").addEventListener("change", e => previewBattle(e.target.files[0], "B"));
  $("#btnBattle").addEventListener("click", runBattle);

  // result actions
  document.addEventListener("click", async (ev) => {
    if (ev.target.id === "btnShare") {
      const url = await drawShareCard(state.result);
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], "auradetector.png", { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: "My Aura", text: `I got ${state.result.score} Aura on AuraDetector. Can you beat it?` }); } catch {}
      } else { window.open(url, "_blank"); toast("Long-press the card to save or share."); }
    }
    if (ev.target.id === "btnDownload") { const url = await drawShareCard(state.result); const a = document.createElement("a"); a.href = url; a.download = "auradetector.png"; a.click(); }
    if (ev.target.id === "btnCopyLink") { const link = challengeLink(state.result.score); navigator.clipboard?.writeText(link).then(() => toast("Challenge link copied!"), () => toast(link)); }
    if (ev.target.id === "btnChallenge") { const txt = `Can you beat my ${state.result.score} Aura? ${challengeLink(state.result.score)}`; if (navigator.share) { try { await navigator.share({ title: "AuraDetector", text: txt }); } catch {} } else { navigator.clipboard?.writeText(txt).then(() => toast("Copied — send it to a friend!")); } }
    if (ev.target.id === "btnAd") openAd();
  });

  // settings & admin
  $("#btnSettings").addEventListener("click", openSettings);
  $("#settingsClose").addEventListener("click", () => ($("#settingsModal").hidden = true));
  $("#btnSaveSettings").addEventListener("click", saveSettings);
  $("#paywallClose").addEventListener("click", closePaywall);
  $("#adClose").addEventListener("click", () => ($("#adModal").hidden = true));

  // Real Stripe Checkout: the server creates the session and verifies the
  // webhook. The client only redirects; it can never grant Premium itself.
  $("#btnUnlockPro").addEventListener("click", async () => {
    if (!state.me.user) { closePaywall(); navigate("account"); toast("Sign in or create an account to subscribe.", 3200); return; }
    try {
      const r = await fetch(E.getApiBase() + "/api/billing/checkout", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: state.plan }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.url) { location.href = j.url; return; }
      toast(j.error === "STRIPE_NOT_CONFIGURED" ? "Subscriptions are not configured yet." : "Could not start checkout. Please try again.", 3400);
    } catch { toast("Could not reach the server.", 3000); }
  });
  $("#btnHomePro").addEventListener("click", () => openPaywall(842));

  $("#btnClaimAd").addEventListener("click", () => {
    const u = getUsage(); u.bonus = (u.bonus || 0) + 1; u.adWatched = (u.adWatched || 0) + 1; saveUsage(u);
    bumpMetric("adImpressions"); bumpMetric("adRevenueCents", 12);
    $("#adModal").hidden = true; toast("+1 scan added for today.");
  });

  // admin + shared actions (all admin state is verified server-side)
  document.addEventListener("click", async (ev) => {
    if (ev.target.id === "btnAdminLogin") {
      const passcode = $("#adminPass") ? $("#adminPass").value : "";
      const err = $("#adminError");
      try {
        const r = await fetch(E.getApiBase() + "/api/admin/login", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ passcode }),
        });
        if (r.ok) { renderAdmin(); }
        else if (err) { err.textContent = r.status === 429 ? "Too many attempts. Please wait." : "Invalid credentials."; err.hidden = false; }
      } catch { if (err) { err.textContent = "Server unreachable."; err.hidden = false; } }
    }
    if (ev.target.id === "btnAdminLogout") {
      await fetch(E.getApiBase() + "/api/admin/logout", { method: "POST", credentials: "include" }).catch(() => {});
      renderAdminLogin("Signed out.");
    }
    if (ev.target.id === "btnAdminRefresh") renderAdmin();
    if (ev.target.id === "btnSaveConfig") {
      const feats = {}; $$("[data-feat]").forEach(cb => (feats[cb.dataset.feat] = cb.checked));
      const payload = {
        productName: $("#cfgName").value, freeScansPerDay: Number($("#cfgFree").value) || 0,
        priceMonthly: Number($("#cfgMonthly").value) || 0, priceYearly: Number($("#cfgYearly").value) || 0,
        paywallHeadline: $("#cfgPayHead").value, paywallQuestion: $("#cfgPayQ").value, premiumFeatures: feats,
      };
      try {
        const r = await fetch(E.getApiBase() + "/api/admin/config", {
          method: "PUT", credentials: "include",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        });
        if (r.ok) { toast("Settings saved."); refreshPublicConfig(); renderAdmin(); }
        else if (r.status === 401) renderAdminLogin("Your session expired. Please sign in again.");
        else toast("Could not save settings.");
      } catch { toast("Server unreachable."); }
    }
    if (ev.target.id === "btnRetry") {
      const last = state.lastScan;
      if (last) performScan(last.kind, last.payload); else navigate("home");
    }
    if (ev.target.id === "btnConnSettings") openSettings();
    if (ev.target.id === "connRetry") {
      $("#connRetry").disabled = true;
      await E.checkHealth();
      await refreshPublicConfig();
      await refreshMe();
      renderAIStatus();
      $("#connRetry").disabled = false;
      toast(E.getBackendStatus().ok ? "Backend connected." : "Still not reachable.", 2600);
    }
    if (ev.target.id === "btnDeleteData") {
      localStorage.removeItem(K.history); localStorage.removeItem(K.metrics); localStorage.removeItem(K.usage);
      toast("Local data deleted."); renderHistory();
    }
    if (ev.target.id === "btnDeleteAccount") {
      try { if (state.me.user) await fetch(E.getApiBase() + "/api/auth/account", { method: "DELETE", credentials: "include" }); } catch {}
      [K.history, K.metrics, K.usage, K.premium, K.account, K.plan, "auradetector.offlinePreview"].forEach(k => localStorage.removeItem(k));
      state.me = { user: null, premium: false, plan: null, subscription: null };
      state.serverScans = null;
      toast("Account and local data deleted."); navigate("home");
    }
    // account actions
    if (ev.target.id === "btnAccLogin") accountAuth("login");
    if (ev.target.id === "btnAccRegister") accountAuth("register");
    if (ev.target.id === "btnAccUpgrade") openPaywall(state.result ? state.result.score : 842);
    if (ev.target.id === "btnAccLogout") {
      await fetch(E.getApiBase() + "/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
      state.me = { user: null, premium: false, plan: null, subscription: null };
      state.serverScans = null;
      await refreshMe(); renderAccount(); toast("Signed out.");
    }
    if (ev.target.id === "btnAccPortal") {
      try {
        const r = await fetch(E.getApiBase() + "/api/billing/portal", { method: "POST", credentials: "include" });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.url) { location.href = j.url; return; }
        toast("Could not open the subscription portal.", 3000);
      } catch { toast("Could not reach the server.", 3000); }
    }
  });
}
function previewBattle(file, which) {
  if (!file) return; const err = $("#battleError");
  const bad = validateImage(file); if (bad) { err.textContent = bad; err.hidden = false; return; }
  err.hidden = true;
  if (which === "A") state.battleA = file; else state.battleB = file;
  const img = $("#battleImg" + which); img.src = URL.createObjectURL(file); img.hidden = false;
  $("#btnBattle").disabled = !(state.battleA && state.battleB);
}

function init() {
  renderArchetypes(); renderFAQ(); renderExamples(); applyConfigToUI(); handleReferral();
  $("#year").textContent = new Date().getFullYear();
  bindEvents();
  E.checkHealth().then(() => { renderAIStatus(); refreshPublicConfig(); });
  refreshMe().then(() => {
    const q = new URLSearchParams(location.search);
    if (q.get("auth") === "ok") { toast("Signed in."); navigate("account"); }
    else if (q.get("auth_error")) { toast(authErrorText(q.get("auth_error")), 5200); navigate("account"); }
    else if (q.get("checkout") === "success") { toast("Aura Pro activated. Welcome ✦", 3600); navigate("account"); }
    else if (q.get("checkout") === "cancel") toast("Checkout cancelled.");
    if (q.get("auth") || q.get("auth_error") || q.get("checkout") || q.get("portal")) history.replaceState(null, "", location.pathname);
    if (isPremium()) document.body.dataset.premium = "1";
  });
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
document.addEventListener("DOMContentLoaded", init);
})();
