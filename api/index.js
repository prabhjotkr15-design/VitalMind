import express from 'express';
import axios from 'axios';
import multer from 'multer';
import mammoth from 'mammoth';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const CLIENT_ID = process.env.WHOOP_CLIENT_ID;
const CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SCOPE = 'read:recovery read:sleep read:workout read:body_measurement read:profile offline';

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>VitalMind — Know your body</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,800;1,700&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet"/>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #07090f;
      --surface: #0d1117;
      --surface2: #131a24;
      --border: #1c2535;
      --accent: #e8d5a3;
      --accent2: #c9a96e;
      --text: #f0f4ff;
      --muted: #5a6a85;
      --muted2: #8a9ab8;
      --green: #4ade80;
      --whoop: #e8d5a3;
      --oura: #a78bfa;
    }
    html { scroll-behavior: smooth; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'DM Sans', sans-serif;
      min-height: 100vh;
      overflow-x: hidden;
    }

    /* Noise texture overlay */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E");
      pointer-events: none;
      z-index: 0;
      opacity: 0.4;
    }

    /* Grid lines */
    body::after {
      content: '';
      position: fixed;
      inset: 0;
      background-image: linear-gradient(rgba(232,213,163,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(232,213,163,0.03) 1px, transparent 1px);
      background-size: 60px 60px;
      pointer-events: none;
      z-index: 0;
    }

    /* Glow orbs */
    .orb { position: fixed; border-radius: 50%; pointer-events: none; z-index: 0; }
    .orb1 { width: 700px; height: 700px; background: radial-gradient(circle, rgba(232,213,163,0.06) 0%, transparent 70%); top: -200px; right: -200px; }
    .orb2 { width: 500px; height: 500px; background: radial-gradient(circle, rgba(167,139,250,0.05) 0%, transparent 70%); bottom: -100px; left: -100px; }

    /* Nav */
    nav {
      position: fixed;
      top: 0; left: 0; right: 0;
      padding: 20px 48px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      z-index: 100;
      background: linear-gradient(to bottom, rgba(7,9,15,0.8), transparent);
    }
    .nav-logo {
      font-family: 'Playfair Display', serif;
      font-size: 22px;
      font-weight: 700;
      color: var(--accent);
      letter-spacing: 0.02em;
    }
    .nav-badge {
      font-size: 11px;
      color: var(--muted2);
      letter-spacing: 0.15em;
      text-transform: uppercase;
      border: 1px solid var(--border);
      padding: 6px 14px;
      border-radius: 100px;
    }

    /* Hero */
    .hero {
      position: relative;
      z-index: 1;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 120px 24px 80px;
      text-align: center;
    }
    .hero-eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: var(--accent2);
      margin-bottom: 32px;
      opacity: 0;
      animation: fadeUp 0.8s ease 0.1s forwards;
    }
    .hero-eyebrow::before, .hero-eyebrow::after {
      content: '';
      display: block;
      width: 32px;
      height: 1px;
      background: var(--accent2);
      opacity: 0.5;
    }
    h1 {
      font-family: 'Playfair Display', serif;
      font-size: clamp(48px, 7vw, 88px);
      font-weight: 800;
      line-height: 1.05;
      margin-bottom: 24px;
      opacity: 0;
      animation: fadeUp 0.8s ease 0.2s forwards;
      max-width: 800px;
    }
    h1 em {
      font-style: italic;
      color: var(--accent);
    }
    .hero-sub {
      font-size: 18px;
      color: var(--muted2);
      line-height: 1.7;
      max-width: 480px;
      margin: 0 auto 64px;
      font-weight: 300;
      opacity: 0;
      animation: fadeUp 0.8s ease 0.3s forwards;
    }

    /* Wearable picker */
    .picker-label {
      font-size: 12px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 20px;
      opacity: 0;
      animation: fadeUp 0.8s ease 0.4s forwards;
    }
    .wearable-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      max-width: 620px;
      width: 100%;
      margin: 0 auto 32px;
      opacity: 0;
      animation: fadeUp 0.8s ease 0.5s forwards;
    }
    .wearable-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 24px 16px;
      cursor: pointer;
      transition: all 0.25s ease;
      position: relative;
      overflow: hidden;
      user-select: none;
    }
    .wearable-card::before {
      content: '';
      position: absolute;
      inset: 0;
      opacity: 0;
      transition: opacity 0.25s;
    }
    .wearable-card.whoop::before { background: radial-gradient(circle at 50% 0%, rgba(232,213,163,0.08), transparent 70%); }
    .wearable-card.oura::before { background: radial-gradient(circle at 50% 0%, rgba(167,139,250,0.08), transparent 70%); }
    .wearable-card:hover { border-color: var(--muted); transform: translateY(-2px); }
    .wearable-card:hover::before { opacity: 1; }
    .wearable-card.selected.whoop { border-color: var(--whoop); box-shadow: 0 0 0 1px var(--whoop), 0 0 24px rgba(232,213,163,0.15); }
    .wearable-card.selected.oura { border-color: var(--oura); box-shadow: 0 0 0 1px var(--oura), 0 0 24px rgba(167,139,250,0.15); }
    .wearable-card.selected::before { opacity: 1; }
    .wearable-card.disabled { opacity: 0.35; cursor: not-allowed; }
    .wearable-card.disabled:hover { transform: none; border-color: var(--border); }
    .wearable-icon { font-size: 32px; margin-bottom: 12px; display: block; }
    .wearable-name { font-family: 'Playfair Display', serif; font-size: 16px; font-weight: 700; margin-bottom: 4px; }
    .wearable-desc { font-size: 11px; color: var(--muted); }
    .wearable-check {
      position: absolute;
      top: 12px; right: 12px;
      width: 18px; height: 18px;
      border-radius: 50%;
      border: 1.5px solid var(--border);
      display: flex; align-items: center; justify-content: center;
      font-size: 10px;
      transition: all 0.2s;
    }
    .wearable-card.selected.whoop .wearable-check { background: var(--whoop); border-color: var(--whoop); color: #07090f; }
    .wearable-card.selected.oura .wearable-check { background: var(--oura); border-color: var(--oura); color: #07090f; }
    .coming-soon {
      position: absolute;
      top: 10px; right: 10px;
      font-size: 9px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      background: var(--surface2);
      border: 1px solid var(--border);
      padding: 3px 8px;
      border-radius: 100px;
      color: var(--muted);
    }

    /* CTA */
    .cta-wrap {
      opacity: 0;
      animation: fadeUp 0.8s ease 0.6s forwards;
    }
    .connect-btn {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 18px 40px;
      background: var(--accent);
      color: #07090f;
      font-family: 'DM Sans', sans-serif;
      font-weight: 600;
      font-size: 15px;
      text-decoration: none;
      border-radius: 100px;
      border: none;
      cursor: pointer;
      transition: all 0.25s ease;
      box-shadow: 0 0 40px rgba(232,213,163,0.2);
      letter-spacing: 0.01em;
    }
    .connect-btn:hover { background: var(--accent2); transform: translateY(-2px); box-shadow: 0 0 60px rgba(232,213,163,0.35); }
    .connect-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
    .connect-btn svg { transition: transform 0.2s; }
    .connect-btn:hover svg { transform: translateX(3px); }

    /* Stats bar */
    .stats-bar {
      display: flex;
      gap: 0;
      justify-content: center;
      margin-top: 80px;
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      opacity: 0;
      animation: fadeUp 0.8s ease 0.7s forwards;
    }
    .stat {
      padding: 28px 40px;
      text-align: center;
      border-right: 1px solid var(--border);
      flex: 1;
      max-width: 200px;
    }
    .stat:last-child { border-right: none; }
    .stat-value {
      font-family: 'Playfair Display', serif;
      font-size: 28px;
      font-weight: 700;
      color: var(--accent);
      display: block;
    }
    .stat-label { font-size: 12px; color: var(--muted); margin-top: 4px; letter-spacing: 0.05em; }

    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(24px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @media (max-width: 600px) {
      nav { padding: 16px 20px; }
      .wearable-grid { grid-template-columns: 1fr; max-width: 320px; }
      .stats-bar { flex-wrap: wrap; }
      .stat { border-right: none; border-bottom: 1px solid var(--border); max-width: 100%; width: 100%; }
      .stat:last-child { border-bottom: none; }
    }
  </style>
</head>
<body>
  <div class="orb orb1"></div>
  <div class="orb orb2"></div>

  <nav>
    <div class="nav-logo">VitalMind</div>
    <div class="nav-badge">Early Access</div>
  </nav>

  <div class="hero">
    <div class="hero-eyebrow">AI Health Intelligence</div>
    <h1>Your body is<br/>talking. <em>Listen.</em></h1>
    <p class="hero-sub">Connect your wearable and get AI-powered insights that cross-reference sleep, recovery, and activity — telling you exactly what's going wrong and what to do about it.</p>

    <div class="picker-label">Choose your wearable to get started</div>

    <div class="wearable-grid">
      <div class="wearable-card whoop selected" onclick="selectWearable('whoop', this)">
        <div class="wearable-check">✓</div>
        <span class="wearable-icon">⌚</span>
        <div class="wearable-name">WHOOP</div>
        <div class="wearable-desc">Recovery & strain</div>
      </div>
      <div class="wearable-card oura" onclick="selectWearable('oura', this)">
        <div class="wearable-check"></div>
        <span class="wearable-icon">💍</span>
        <div class="wearable-name">Oura Ring</div>
        <div class="wearable-desc">Sleep & readiness</div>
      </div>
      <div class="wearable-card disabled">
        <div class="coming-soon">Soon</div>
        <span class="wearable-icon">⌚</span>
        <div class="wearable-name">Apple Watch</div>
        <div class="wearable-desc">Coming soon</div>
      </div>
    </div>

    <div class="cta-wrap">
      <button class="connect-btn" id="connectBtn" onclick="handleConnect()">
        Connect your WHOOP
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
      </button>
    </div>

    <div class="stats-bar">
      <div class="stat"><span class="stat-value">7</span><div class="stat-label">Days analyzed</div></div>
      <div class="stat"><span class="stat-value">4</span><div class="stat-label">Data sources</div></div>
      <div class="stat"><span class="stat-value">AI</span><div class="stat-label">Powered insights</div></div>
      <div class="stat"><span class="stat-value">0</span><div class="stat-label">Apps to install</div></div>
    </div>
  </div>

  <script>
    let selected = 'whoop';

    function selectWearable(type, el) {
      document.querySelectorAll('.wearable-card:not(.disabled)').forEach(c => {
        c.classList.remove('selected');
        c.querySelector('.wearable-check').textContent = '';
      });
      el.classList.add('selected');
      el.querySelector('.wearable-check').textContent = '✓';
      selected = type;

      const btn = document.getElementById('connectBtn');
      if (type === 'whoop') btn.textContent = 'Connect your WHOOP →';
      if (type === 'oura') {
        btn.innerHTML = 'Connect Oura Ring <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
        btn.style.background = '#a78bfa';
      } else {
        btn.style.background = '';
      }
    }

    function handleConnect() {
      if (selected === 'whoop') window.location.href = '/login';
      if (selected === 'oura') alert('Oura Ring support coming very soon!');
    }
  </script>
</body>
</html>`);
});

app.get('/login', (req, res) => {
  const state = Math.random().toString(36).substring(2, 12);
  const url = new URL('https://api.prod.whoop.com/oauth/oauth2/auth');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code received from WHOOP');

  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);
    params.append('redirect_uri', REDIRECT_URI);

    const tokenRes = await axios.post(
      'https://api.prod.whoop.com/oauth/oauth2/token',
      params,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token } = tokenRes.data;
    const headers = { Authorization: `Bearer ${access_token}` };

    const [profileRes, recoveryRes, sleepRes] = await Promise.allSettled([
      axios.get('https://api.prod.whoop.com/developer/v1/user/profile/basic', { headers }),
      axios.get('https://api.prod.whoop.com/developer/v2/recovery?limit=7', { headers }),
      axios.get('https://api.prod.whoop.com/developer/v2/activity/sleep?limit=7', { headers }),
    ]);

    const whoopData = {
      profile: profileRes.status === 'fulfilled' ? profileRes.value.data : null,
      recovery: recoveryRes.status === 'fulfilled' ? recoveryRes.value.data.records : [],
      sleep: sleepRes.status === 'fulfilled' ? sleepRes.value.data.records : [],
    };

    const claudeRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-opus-4-5',
        max_tokens: 1200,
        messages: [{
          role: 'user',
          content: `You are a personal health coach. Analyze this WHOOP data from the past 7 days. Format your response in clean HTML using only <h2>, <h3>, <p>, <ul>, <li>, <strong>, and <table> tags. Give specific insights with actual numbers from the data. End with exactly 3 concrete actions in a <ul>.

WHOOP Data:
${JSON.stringify(whoopData, null, 2)}`
        }]
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      }
    );

    const insight = claudeRes.data.content[0].text;
    const firstName = whoopData.profile?.first_name || 'there';
    const latestRecovery = whoopData.recovery?.[0]?.score?.recovery_score;
    const latestHRV = whoopData.recovery?.[0]?.score?.hrv_rmssd_milli?.toFixed(1);
    const latestRHR = whoopData.recovery?.[0]?.score?.resting_heart_rate;
    const whoopEncoded = Buffer.from(JSON.stringify(whoopData)).toString('base64');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>VitalMind — ${firstName}'s Insights</title>
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet"/>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --bg: #080c12; --surface: #0f1520; --border: #1e2a3a; --accent: #00e5ff; --accent2: #7c3aed; --text: #e8f0fe; --muted: #6b7a99; --green: #00c896; --yellow: #f59e0b; --red: #ef4444; }
    body { background: var(--bg); color: var(--text); font-family: 'DM Sans', sans-serif; min-height: 100vh; }
    .bg-orb { position: fixed; border-radius: 50%; filter: blur(100px); opacity: 0.08; pointer-events: none; }
    .orb1 { width: 500px; height: 500px; background: var(--accent); top: -100px; right: -100px; }
    .orb2 { width: 400px; height: 400px; background: var(--accent2); bottom: 0; left: -100px; }
    .header { border-bottom: 1px solid var(--border); padding: 20px 40px; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; background: rgba(8,12,18,0.9); backdrop-filter: blur(12px); z-index: 10; }
    .logo { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 18px; color: var(--accent); }
    .refresh-btn { display: inline-flex; align-items: center; gap: 8px; padding: 10px 20px; background: var(--surface); border: 1px solid var(--border); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 14px; text-decoration: none; border-radius: 100px; transition: border-color 0.2s; }
    .refresh-btn:hover { border-color: var(--accent); color: var(--accent); }
    .main { max-width: 860px; margin: 0 auto; padding: 48px 24px 80px; position: relative; z-index: 1; }
    .greeting { font-family: 'Syne', sans-serif; font-size: 32px; font-weight: 800; margin-bottom: 8px; }
    .greeting span { color: var(--accent); }
    .date { color: var(--muted); font-size: 14px; margin-bottom: 40px; }
    .metrics-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 40px; }
    .metric-card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 24px; transition: border-color 0.2s; }
    .metric-card:hover { border-color: var(--accent); }
    .metric-label { font-size: 12px; color: var(--muted); letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 12px; }
    .metric-value { font-family: 'Syne', sans-serif; font-size: 40px; font-weight: 800; line-height: 1; }
    .metric-unit { font-size: 14px; color: var(--muted); margin-top: 6px; }
    .recovery-high { color: var(--green); }
    .recovery-mid { color: var(--yellow); }
    .recovery-low { color: var(--red); }
    .insight-card { background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 36px; margin-bottom: 32px; }
    .insight-card h2 { font-family: 'Syne', sans-serif; font-size: 22px; font-weight: 700; margin: 24px 0 12px; color: var(--accent); }
    .insight-card h2:first-child { margin-top: 0; }
    .insight-card h3 { font-family: 'Syne', sans-serif; font-size: 16px; font-weight: 600; margin: 20px 0 8px; }
    .insight-card p { color: #b0bdd4; line-height: 1.7; margin-bottom: 12px; font-size: 15px; }
    .insight-card ul { padding-left: 20px; }
    .insight-card li { color: #b0bdd4; line-height: 1.7; margin-bottom: 8px; font-size: 15px; }
    .insight-card strong { color: var(--text); }
    .insight-card table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
    .insight-card th { text-align: left; padding: 10px 12px; color: var(--muted); font-weight: 500; border-bottom: 1px solid var(--border); }
    .insight-card td { padding: 10px 12px; border-bottom: 1px solid var(--border); color: #b0bdd4; }

    /* Workout section */
    .workout-section { background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 36px; }
    .workout-title { font-family: 'Syne', sans-serif; font-size: 20px; font-weight: 700; margin-bottom: 8px; }
    .workout-subtitle { color: var(--muted); font-size: 14px; margin-bottom: 28px; line-height: 1.6; }

    /* Tab switcher */
    .tabs { display: flex; gap: 8px; margin-bottom: 24px; background: var(--bg); border-radius: 12px; padding: 4px; }
    .tab { flex: 1; padding: 12px; text-align: center; border-radius: 9px; cursor: pointer; font-size: 14px; font-weight: 500; color: var(--muted); border: none; background: transparent; transition: all 0.2s; font-family: 'DM Sans', sans-serif; }
    .tab:hover { color: var(--text); }
    .tab.active { background: var(--surface); color: var(--text); border: 1px solid var(--border); }
    .tab-icon { display: block; font-size: 20px; margin-bottom: 4px; }

    /* Tab panels */
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }

    /* Photo upload */
    .upload-zone { border: 2px dashed var(--border); border-radius: 12px; padding: 40px; text-align: center; cursor: pointer; transition: border-color 0.2s, background 0.2s; position: relative; }
    .upload-zone:hover { border-color: var(--accent); background: rgba(0,229,255,0.03); }
    .upload-zone input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
    .upload-zone-icon { font-size: 32px; margin-bottom: 12px; }
    .upload-zone-text { color: var(--muted); font-size: 14px; }
    .upload-zone-text strong { color: var(--accent); }

    /* Text input */
    .text-input { width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 12px; padding: 16px; color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 14px; line-height: 1.6; resize: vertical; min-height: 160px; transition: border-color 0.2s; }
    .text-input:focus { outline: none; border-color: var(--accent); }
    .text-input::placeholder { color: var(--muted); }

    /* File name display */
    .file-name { margin-top: 12px; font-size: 13px; color: var(--muted); min-height: 20px; }

    /* Analyze button */
    .analyze-btn { margin-top: 20px; padding: 14px 28px; background: linear-gradient(135deg, var(--accent), #0099bb); color: #080c12; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 14px; border: none; border-radius: 100px; cursor: pointer; transition: transform 0.2s, opacity 0.2s; width: 100%; }
    .analyze-btn:hover { transform: translateY(-1px); }
    .analyze-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

    /* Result */
    .workout-result { margin-top: 24px; background: var(--bg); border: 1px solid var(--border); border-radius: 12px; padding: 24px; display: none; }
    .workout-result.visible { display: block; }
    .workout-result h2 { font-family: 'Syne', sans-serif; font-size: 18px; font-weight: 700; margin: 16px 0 8px; color: var(--accent); }
    .workout-result h2:first-child { margin-top: 0; }
    .workout-result h3 { font-family: 'Syne', sans-serif; font-size: 15px; font-weight: 600; margin: 14px 0 6px; }
    .workout-result p { color: #b0bdd4; line-height: 1.7; margin-bottom: 10px; font-size: 14px; }
    .workout-result ul { padding-left: 20px; }
    .workout-result li { color: #b0bdd4; line-height: 1.7; margin-bottom: 6px; font-size: 14px; }
    .workout-result strong { color: var(--text); }

    .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid rgba(8,12,18,0.3); border-top-color: #080c12; border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle; margin-right: 8px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 600px) { .metrics-grid { grid-template-columns: 1fr; } .header { padding: 16px 20px; } .main { padding: 32px 16px 60px; } }
  </style>
</head>
<body>
  <div class="bg-orb orb1"></div>
  <div class="bg-orb orb2"></div>
  <div class="header">
    <div class="logo">VitalMind</div>
    <a href="/login" class="refresh-btn">↻ Refresh</a>
  </div>
  <div class="main">
    <div class="greeting">Hey, <span>${firstName}.</span></div>
    <div class="date">Here's your health analysis for the past 7 days</div>
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Today's Recovery</div>
        <div class="metric-value ${latestRecovery >= 67 ? 'recovery-high' : latestRecovery >= 34 ? 'recovery-mid' : 'recovery-low'}">${latestRecovery ?? '--'}%</div>
        <div class="metric-unit">${latestRecovery >= 67 ? 'Ready to perform' : latestRecovery >= 34 ? 'Moderate recovery' : 'Rest recommended'}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">HRV (RMSSD)</div>
        <div class="metric-value" style="color:var(--accent)">${latestHRV ?? '--'}</div>
        <div class="metric-unit">milliseconds</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Resting Heart Rate</div>
        <div class="metric-value" style="color:var(--accent2)">${latestRHR ?? '--'}</div>
        <div class="metric-unit">beats per minute</div>
      </div>
    </div>

    <div class="insight-card">${insight}</div>

    <div class="workout-section">
      <div class="workout-title">🏋️ Cross-reference Your Workout Plan</div>
      <div class="workout-subtitle">Share your workout plan any way you like — Claude will tell you whether to push, modify, or rest today based on your actual biometrics.</div>

      <div class="tabs">
        <button class="tab active" onclick="switchTab('photo')"><span class="tab-icon">📸</span>Photo</button>
        <button class="tab" onclick="switchTab('text')"><span class="tab-icon">💬</span>Type it</button>
        <button class="tab" onclick="switchTab('file')"><span class="tab-icon">📄</span>File</button>
      </div>

      <!-- Photo tab -->
      <div class="tab-panel active" id="tab-photo">
        <div class="upload-zone">
          <input type="file" id="photoInput" accept="image/*" onchange="handlePhoto(this)"/>
          <div class="upload-zone-icon">📸</div>
          <div class="upload-zone-text"><strong>Upload a photo</strong> of your workout plan<br/>Screenshot, handwritten, whiteboard — anything works</div>
        </div>
        <div class="file-name" id="photoName"></div>
        <button class="analyze-btn" id="photoBtn" onclick="analyze('photo')" disabled>Analyze with my WHOOP data →</button>
      </div>

      <!-- Text tab -->
      <div class="tab-panel" id="tab-text">
        <textarea class="text-input" id="textInput" placeholder="e.g. Monday: Lower body — squats, lunges, hip thrusts. Tuesday: Low impact cardio 30 min. Wednesday: Upper body push. Thursday: Rest or yoga. Friday: Full body strength. Saturday: Hike or swim. Sunday: Rest."></textarea>
        <button class="analyze-btn" id="textBtn" onclick="analyze('text')">Analyze with my WHOOP data →</button>
      </div>

      <!-- File tab -->
      <div class="tab-panel" id="tab-file">
        <div class="upload-zone">
          <input type="file" id="fileInput" accept=".pdf,.doc,.docx" onchange="handleFile(this)"/>
          <div class="upload-zone-icon">📄</div>
          <div class="upload-zone-text"><strong>Upload your plan</strong><br/>PDF or Word document (.pdf, .doc, .docx)</div>
        </div>
        <div class="file-name" id="fileName"></div>
        <button class="analyze-btn" id="fileBtn" onclick="analyze('file')" disabled>Analyze with my WHOOP data →</button>
      </div>

      <div class="workout-result" id="workoutResult"></div>
    </div>
  </div>

  <script>
    const WHOOP_DATA = '${whoopEncoded}';
    let photoFile = null;
    let docFile = null;

    function switchTab(tab) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      event.target.closest('.tab').classList.add('active');
      document.getElementById('tab-' + tab).classList.add('active');
      document.getElementById('workoutResult').classList.remove('visible');
    }

    function handlePhoto(input) {
      photoFile = input.files[0];
      if (photoFile) {
        document.getElementById('photoName').textContent = '📎 ' + photoFile.name;
        document.getElementById('photoBtn').disabled = false;
      }
    }

    function handleFile(input) {
      docFile = input.files[0];
      if (docFile) {
        document.getElementById('fileName').textContent = '📎 ' + docFile.name;
        document.getElementById('fileBtn').disabled = false;
      }
    }

    async function analyze(type) {
      const result = document.getElementById('workoutResult');
      const btnId = type === 'photo' ? 'photoBtn' : type === 'text' ? 'textBtn' : 'fileBtn';
      const btn = document.getElementById(btnId);
      btn.innerHTML = '<span class="spinner"></span>Analyzing...';
      btn.disabled = true;
      result.classList.remove('visible');

      try {
        let endpoint = '/analyze-workout';
        let options = {};

        if (type === 'text') {
          const text = document.getElementById('textInput').value.trim();
          if (!text) { btn.innerHTML = 'Analyze with my WHOOP data →'; btn.disabled = false; return; }
          options = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'text', content: text, whoopData: WHOOP_DATA })
          };
        } else {
          const formData = new FormData();
          formData.append('whoopData', WHOOP_DATA);
          formData.append('type', type);
          if (type === 'photo') formData.append('file', photoFile);
          else formData.append('file', docFile);
          options = { method: 'POST', body: formData };
        }

        const res = await fetch(endpoint, options);
        const data = await res.json();
        result.innerHTML = data.insight;
        result.classList.add('visible');
      } catch(e) {
        result.innerHTML = '<p>Something went wrong. Please try again.</p>';
        result.classList.add('visible');
      }

      btn.innerHTML = 'Analyze with my WHOOP data →';
      btn.disabled = false;
    }
  </script>
</body>
</html>`);

  } catch (err) {
    res.status(500).send('Error: ' + JSON.stringify(err.response?.data || err.message));
  }
});

// Unified analyze endpoint
app.post('/analyze-workout', upload.single('file'), async (req, res) => {
  try {
    const whoopData = Buffer.from(req.body.whoopData, 'base64').toString('utf-8');
    const type = req.body.type;
    let messages = [];

    if (type === 'text') {
      const workoutText = req.body.content;
      messages = [{
        role: 'user',
        content: `You are a personal health coach. Cross-reference this workout plan with the user's WHOOP biometric data. Tell them specifically: (1) whether to push hard, modify, or rest today based on their recovery score, (2) any modifications needed given their HRV and sleep trends this week, (3) what to watch for. Format in clean HTML using only <h2>, <h3>, <p>, <ul>, <li>, <strong> tags. Be specific with actual numbers.

WHOOP Data:
${whoopData}

Workout Plan:
${workoutText}`
      }];
    } else if (type === 'photo') {
      const file = req.file;
      const base64 = file.buffer.toString('base64');
      const mediaType = file.mimetype;
      messages = [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 }
          },
          {
            type: 'text',
            text: `You are a personal health coach. First read the workout plan in this image. Then cross-reference it with the user's WHOOP biometric data below. Tell them specifically: (1) whether to push hard, modify, or rest today based on their recovery score, (2) any modifications needed given their HRV and sleep trends this week, (3) what to watch for. Format in clean HTML using only <h2>, <h3>, <p>, <ul>, <li>, <strong> tags. Be specific with actual numbers.

WHOOP Data:
${whoopData}`
          }
        ]
      }];
    } else {
      const file = req.file;
      let workoutText = '';
      if (file.mimetype === 'application/pdf') {
        const parsed = await pdfParse(file.buffer);
        workoutText = parsed.text;
      } else {
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        workoutText = result.value;
      }
      messages = [{
        role: 'user',
        content: `You are a personal health coach. Cross-reference this workout plan with the user's WHOOP biometric data. Tell them specifically: (1) whether to push hard, modify, or rest today based on their recovery score, (2) any modifications needed given their HRV and sleep trends this week, (3) what to watch for. Format in clean HTML using only <h2>, <h3>, <p>, <ul>, <li>, <strong> tags. Be specific with actual numbers.

WHOOP Data:
${whoopData}

Workout Plan:
${workoutText.slice(0, 3000)}`
      }];
    }

    const claudeRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-opus-4-5', max_tokens: 1000, messages },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      }
    );

    res.json({ insight: claudeRes.data.content[0].text });

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ insight: '<p>Error analyzing. Please try again.</p>' });
  }
});

export default app;
