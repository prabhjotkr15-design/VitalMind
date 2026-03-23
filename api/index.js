import express from 'express';
import axios from 'axios';
import multer from 'multer';
import mammoth from 'mammoth';
import cookieParser from 'cookie-parser';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { signup, login, saveWhoopTokens, getWhoopTokens, saveProfile, getProfile, verifyToken } from './auth.js';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(cookieParser());
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const CLIENT_ID = process.env.WHOOP_CLIENT_ID;
const CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SCOPE = 'read:recovery read:sleep read:workout read:body_measurement read:profile offline';

const getPage = (name) => readFileSync(join(__dirname, 'pages', name), 'utf-8');

// Auth middleware
function getUser(req) {
  try {
    const token = req.cookies?.vm_token;
    if (!token) return null;
    return verifyToken(token);
  } catch(e) {
    return null;
  }
}

// Home
app.get('/', (req, res) => {
  const user = getUser(req);
  if (user) return res.redirect('/dashboard');
  res.send(getPage('home.html'));
});

// Auth page
app.get('/auth', (req, res) => res.send(getPage('auth.html')));

// Auth API routes
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) throw new Error('Email and password required');
    if (password.length < 8) throw new Error('Password must be at least 8 characters');
    const { token, userId } = await signup(email, password);

    // Save profile if provided
    const profile = req.body.profile;
    if (profile) {
      try {
        const p = JSON.parse(Buffer.from(profile, 'base64').toString('utf-8'));
        await saveProfile(userId, p);
      } catch(e) {}
    }

    res.json({ token, userId });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) throw new Error('Email and password required');
    const { token, userId } = await login(email, password);
    res.json({ token, userId });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// Dashboard — requires login
app.get('/dashboard', async (req, res) => {
  const user = getUser(req);
  if (!user) return res.redirect('/auth?redirect=/dashboard');

  // Check if WHOOP is connected
  const tokens = await getWhoopTokens(user.userId);
  if (!tokens) {
    return res.redirect('/connect-whoop');
  }

  // Redirect to insights with stored token
  res.redirect('/insights-stored');
});

// Connect WHOOP page
app.get('/connect-whoop', (req, res) => {
  const user = getUser(req);
  if (!user) return res.redirect('/auth?redirect=/connect-whoop');
  res.send(getPage('connect.html'));
});

// Login with WHOOP OAuth
app.get('/login', (req, res) => {
  const state = Math.random().toString(36).substring(2, 12);
  const profile = req.query.profile || '';
  if (profile) res.cookie('vm_profile', profile, { maxAge: 600000, httpOnly: false });
  const url = new URL('https://api.prod.whoop.com/oauth/oauth2/auth');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

// WHOOP callback
app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code received from WHOOP');
  const profile = req.cookies?.vm_profile || '';
  const user = getUser(req);

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

    const { access_token, refresh_token } = tokenRes.data;

    // If user is logged in, save tokens to database
    if (user) {
      await saveWhoopTokens(user.userId, access_token, refresh_token);
      return res.redirect('/insights-stored');
    }

    // Otherwise pass tokens through URL (old flow for non-logged-in users)
    const headers = { Authorization: 'Bearer ' + access_token };
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

    const whoopEncoded = Buffer.from(JSON.stringify(whoopData)).toString('base64');
    res.redirect('/insights?data=' + whoopEncoded + '&profile=' + profile);

  } catch (err) {
    res.status(500).send('Error: ' + JSON.stringify(err.response?.data || err.message));
  }
});

// Insights from stored tokens (logged in users)
app.get('/insights-stored', async (req, res) => {
  const user = getUser(req);
  if (!user) return res.redirect('/auth');

  try {
    const tokens = await getWhoopTokens(user.userId);
    if (!tokens) return res.redirect('/connect-whoop');

    const userProfile = await getProfile(user.userId) || {};
    const headers = { Authorization: 'Bearer ' + tokens.access_token };

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

    const goalLabels = { better_sleep: 'better sleep', more_energy: 'more energy', lose_weight: 'weight loss', peak_performance: 'peak performance' };
    const goalText = goalLabels[userProfile.goal] || 'overall health';
    const conditionsText = userProfile.conditions?.filter(c => c !== 'none').join(', ') || 'none';
    const dietText = userProfile.diet?.filter(d => d !== 'none').join(', ') || 'none';

    const claudeRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-opus-4-5',
        max_tokens: 1200,
        messages: [{
          role: 'user',
          content: `You are a personal health coach. Analyze this WHOOP data from the past 7 days for a user whose primary goal is ${goalText}. Health conditions: ${conditionsText}. Dietary approach: ${dietText}. Tailor EVERY recommendation to their goal and conditions. Format in clean HTML using only h2, h3, p, ul, li, strong, table tags. Be specific with actual numbers. End with exactly 3 concrete actions.\n\nWHOOP Data:\n${JSON.stringify(whoopData, null, 2)}`
        }]
      },
      { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );

    const insight = claudeRes.data.content[0].text;
    const firstName = whoopData.profile?.first_name || 'there';
    const latestRecovery = whoopData.recovery?.[0]?.score?.recovery_score;
    const latestHRV = whoopData.recovery?.[0]?.score?.hrv_rmssd_milli?.toFixed(1);
    const latestRHR = whoopData.recovery?.[0]?.score?.resting_heart_rate;
    const whoopEncoded = Buffer.from(JSON.stringify(whoopData)).toString('base64');
    const profileEncoded = Buffer.from(JSON.stringify(userProfile)).toString('base64');

    let html = getPage('insights.html');
    html = html
      .replace(/__FIRST_NAME__/g, firstName)
      .replace(/__RECOVERY__/g, latestRecovery ?? '--')
      .replace(/__HRV__/g, latestHRV ?? '--')
      .replace(/__RHR__/g, latestRHR ?? '--')
      .replace(/__RECOVERY_CLASS__/g, latestRecovery >= 67 ? 'high' : latestRecovery >= 34 ? 'mid' : 'low')
      .replace(/__RECOVERY_LABEL__/g, latestRecovery >= 67 ? 'Ready to perform' : latestRecovery >= 34 ? 'Moderate recovery' : 'Rest recommended')
      .replace(/__GOAL_TEXT__/g, goalText)
      .replace(/__INSIGHT__/g, insight)
      .replace(/__WHOOP_DATA__/g, whoopEncoded)
      .replace(/__PROFILE_DATA__/g, profileEncoded);

    res.send(html);
  } catch (err) {
    res.status(500).send('Error: ' + JSON.stringify(err.message));
  }
});

// Insights from URL params (non-logged-in users)
app.get('/insights', async (req, res) => {
  try {
    const whoopData = JSON.parse(Buffer.from(req.query.data, 'base64').toString('utf-8'));
    const userProfile = req.query.profile ? JSON.parse(Buffer.from(req.query.profile, 'base64').toString('utf-8')) : {};

    const firstName = whoopData.profile?.first_name || 'there';
    const latestRecovery = whoopData.recovery?.[0]?.score?.recovery_score;
    const latestHRV = whoopData.recovery?.[0]?.score?.hrv_rmssd_milli?.toFixed(1);
    const latestRHR = whoopData.recovery?.[0]?.score?.resting_heart_rate;

    const goalLabels = { better_sleep: 'better sleep', more_energy: 'more energy', lose_weight: 'weight loss', peak_performance: 'peak performance' };
    const goalText = goalLabels[userProfile.goal] || 'overall health';
    const conditionsText = userProfile.conditions?.filter(c => c !== 'none').join(', ') || 'none';
    const dietText = userProfile.diet?.filter(d => d !== 'none').join(', ') || 'none';

    const claudeRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-opus-4-5',
        max_tokens: 1200,
        messages: [{
          role: 'user',
          content: `You are a personal health coach. Analyze this WHOOP data from the past 7 days for a user whose primary goal is ${goalText}. Health conditions: ${conditionsText}. Dietary approach: ${dietText}. Tailor EVERY recommendation to their goal and conditions. Format in clean HTML using only h2, h3, p, ul, li, strong, table tags. Be specific with actual numbers. End with exactly 3 concrete actions.\n\nWHOOP Data:\n${JSON.stringify(whoopData, null, 2)}`
        }]
      },
      { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );

    const insight = claudeRes.data.content[0].text;
    const whoopEncoded = Buffer.from(JSON.stringify(whoopData)).toString('base64');
    const profileEncoded = Buffer.from(JSON.stringify(userProfile)).toString('base64');

    let html = getPage('insights.html');
    html = html
      .replace(/__FIRST_NAME__/g, firstName)
      .replace(/__RECOVERY__/g, latestRecovery ?? '--')
      .replace(/__HRV__/g, latestHRV ?? '--')
      .replace(/__RHR__/g, latestRHR ?? '--')
      .replace(/__RECOVERY_CLASS__/g, latestRecovery >= 67 ? 'high' : latestRecovery >= 34 ? 'mid' : 'low')
      .replace(/__RECOVERY_LABEL__/g, latestRecovery >= 67 ? 'Ready to perform' : latestRecovery >= 34 ? 'Moderate recovery' : 'Rest recommended')
      .replace(/__GOAL_TEXT__/g, goalText)
      .replace(/__INSIGHT__/g, insight)
      .replace(/__WHOOP_DATA__/g, whoopEncoded)
      .replace(/__PROFILE_DATA__/g, profileEncoded);

    res.send(html);
  } catch (err) {
    res.status(500).send('Error: ' + JSON.stringify(err.message));
  }
});

// Analyze workout
app.post('/analyze-workout', upload.single('file'), async (req, res) => {
  try {
    const whoopData = Buffer.from(req.body.whoopData, 'base64').toString('utf-8');
    const type = req.body.type;
    let messages = [];

    if (type === 'text') {
      messages = [{ role: 'user', content: `You are a personal health coach. Cross-reference this workout plan with the WHOOP data. Tell them: (1) push, modify, or rest today based on recovery score, (2) modifications needed given HRV and sleep trends, (3) what to watch for. Format in clean HTML using h2, h3, p, ul, li, strong tags. Use actual numbers.\n\nWHOOP Data:\n${whoopData}\n\nWorkout Plan:\n${req.body.content}` }];
    } else if (type === 'photo') {
      const base64 = req.file.buffer.toString('base64');
      messages = [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: req.file.mimetype, data: base64 } }, { type: 'text', text: `You are a personal health coach. Read the workout plan in this image. Cross-reference with WHOOP data below. Format in clean HTML.\n\nWHOOP Data:\n${whoopData}` }] }];
    } else {
      let workoutText = '';
      if (req.file.mimetype === 'application/pdf') { const parsed = await pdfParse(req.file.buffer); workoutText = parsed.text; }
      else { const result = await mammoth.extractRawText({ buffer: req.file.buffer }); workoutText = result.value; }
      messages = [{ role: 'user', content: `You are a personal health coach. Cross-reference this workout plan with the WHOOP data. Format in clean HTML.\n\nWHOOP Data:\n${whoopData}\n\nWorkout Plan:\n${workoutText.slice(0, 3000)}` }];
    }

    const claudeRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-opus-4-5', max_tokens: 1000, messages },
      { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );

    res.json({ insight: claudeRes.data.content[0].text });
  } catch (err) {
    res.status(500).json({ insight: '<p>Error analyzing. Please try again.</p>' });
  }
});

// Logout
app.get('/logout', (req, res) => {
  res.clearCookie('vm_token');
  res.redirect('/');
});

export default app;
