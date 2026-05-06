import express from 'express';
import axios from 'axios';
import multer from 'multer';
import mammoth from 'mammoth';
import cookieParser from 'cookie-parser';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { signup, login, saveWhoopTokens, getWhoopTokens, saveProfile, getProfile, verifyToken, refreshWhoopToken } from './auth.js';
import { signupLimiter, loginLimiter, resetLimiter, foodAnalysisLimiter, checkRateLimit, getClientId } from './rate-limit.js';
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

function getUser(req) {
  try {
    const token = req.cookies?.vm_token;
    if (!token) return null;
    return verifyToken(token);
  } catch(e) { return null; }
}



app.get('/', (req, res) => {
  const user = getUser(req);
  if (user) return res.redirect('/dashboard');
  res.send(getPage('home.html'));
});

app.get('/auth', (req, res) => res.send(getPage('auth.html')));
app.get('/privacy', (req, res) => res.send(getPage('privacy.html')));
app.get('/terms', (req, res) => res.send(getPage('terms.html')));

app.post('/api/auth/signup', async (req, res) => {
  const rlId = getClientId(req);
  const rl = await checkRateLimit(signupLimiter, rlId);
  if (!rl.success) {
    return res.status(429).json({ error: 'Too many signup attempts. Try again in an hour.' });
  }
  try {
    const { email, password } = req.body;
    if (!email || !password) throw new Error('Email and password required');
    if (password.length < 8) throw new Error('Password must be at least 8 characters');
    const { token, userId } = await signup(email, password);
    const phone = req.body.phone;
    const { createClient: cc } = await import('@supabase/supabase-js');
    const sb = cc(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    if (phone) {
      let cleanPhone = phone.replace(/[\s\-\(\)]/g, '');
      if (!cleanPhone.startsWith('+')) {
        if (cleanPhone.length === 10) cleanPhone = '+1' + cleanPhone;
        else cleanPhone = '+' + cleanPhone;
      }
      await sb.from('users').update({ phone: cleanPhone }).eq('id', userId);
    }
    await sb.from('user_profiles').upsert({ user_id: userId, brief_hour: 7 }, { onConflict: 'user_id' });
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
  const rlId = getClientId(req);
  const rl = await checkRateLimit(loginLimiter, rlId);
  if (!rl.success) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in a minute.' });
  }
  try {
    const { email, password } = req.body;
    if (!email || !password) throw new Error('Email and password required');
    const { token, userId } = await login(email, password);
    res.json({ token, userId });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/dashboard', async (req, res) => {
  const user = getUser(req);
  if (!user) return res.redirect('/auth?redirect=/dashboard');
  res.redirect('/insights-stored');
});

app.get('/connect-whoop', (req, res) => {
  const user = getUser(req);
  if (!user) return res.redirect('/auth?redirect=/connect-whoop');
  res.send(getPage('connect.html'));
});

// Pass JWT token through state so it survives the WHOOP redirect
app.get('/login', (req, res) => {
  const user = getUser(req);
  const profile = req.query.profile || '';
  if (profile) res.cookie('vm_profile', profile, { maxAge: 600000, httpOnly: false });

  // Encode user token in state so we can identify user after WHOOP redirect
  const stateData = {
    r: Math.random().toString(36).substring(2, 8),
    t: user ? req.cookies.vm_token : null
  };
  const state = Buffer.from(JSON.stringify(stateData)).toString('base64');

  const url = new URL('https://api.prod.whoop.com/oauth/oauth2/auth');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('No code received from WHOOP');

  // Extract user token from state
  let user = null;
  try {
    const stateData = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
    if (stateData.t) user = verifyToken(stateData.t);
  } catch(e) {}

  const profile = req.cookies?.vm_profile || '';

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

    if (user) {
      await saveWhoopTokens(user.userId, access_token, refresh_token);
      return res.redirect('/insights-stored');
    }

    // Non-logged-in flow
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

app.get('/insights-stored', async (req, res) => {
  const user = getUser(req);
  if (!user) return res.redirect('/auth');

  try {
    let tokens = await getWhoopTokens(user.userId);
    if (!tokens) {
      let html = getPage('insights.html');
      html = html
        .replace(/__FIRST_NAME__/g, 'there')
        .replace(/__RECOVERY__/g, '--')
        .replace(/__HRV__/g, '--')
        .replace(/__RHR__/g, '--')
        .replace(/__RECOVERY_CLASS__/g, 'low')
        .replace(/__RECOVERY_LABEL__/g, 'Connect a wearable')
        .replace(/__GOAL_TEXT__/g, 'overall health')
        .replace(/__INSIGHT__/g, '<p>Connect your WHOOP, Oura, or Apple Health to get personalized health insights. In the meantime, start logging your meals — VitalMind can already analyze your nutrition and flag triggers based on your conditions.</p>')
        .replace(/__WHOOP_DATA__/g, '')
        .replace(/__PROFILE_DATA__/g, '');
      return res.send(html);
    }

    const userProfile = await getProfile(user.userId) || {};
    let headers = { Authorization: 'Bearer ' + tokens.access_token };

    const testRes = await axios.get('https://api.prod.whoop.com/developer/v1/user/profile/basic', { headers }).catch(e => e.response);
    if (testRes?.status === 401) {
      try {
        const newToken = await refreshWhoopToken(user.userId);
        if (newToken) {
          headers = { Authorization: 'Bearer ' + newToken };
        }
      } catch(e) { return res.redirect('/login'); }
    }

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
        model: 'claude-sonnet-4-20250514',
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


app.get('/reset-password', (req, res) => res.send(getPage('reset.html')));

app.post('/api/auth/request-reset', async (req, res) => {
  const rlId = getClientId(req);
  const rl = await checkRateLimit(resetLimiter, rlId);
  if (!rl.success) {
    return res.status(429).json({ error: 'Too many password reset requests. Try again in an hour.' });
  }
  try {
    const { email } = req.body;
    if (!email) throw new Error('Email required');
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: user } = await supabase.from('users').select().eq('email', email).single();
    if (!user) { res.json({ ok: true }); return; }
    const crypto = await import('crypto');
    const token = crypto.default.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    await supabase.from('reset_tokens').insert({ user_id: user.id, token, expires_at: expiresAt });
    const resetUrl = (process.env.REDIRECT_URI || '').replace('/callback', '') + '/reset-password?token=' + token;
    const { Resend } = await import('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'VitalMind AI <hello@vitalmindai.community>',
      to: [email],
      subject: 'Reset your VitalMind password',
      html: '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 20px"><h2 style="color:#e09070">Reset your password</h2><p style="color:#666;line-height:1.6;margin-bottom:24px">Click below to reset your VitalMind password. Link expires in 1 hour.</p><a href="' + resetUrl + '" style="display:inline-block;padding:14px 32px;background:#e09070;color:#fff;text-decoration:none;border-radius:8px;font-weight:500">Reset password</a><p style="color:#999;font-size:13px;margin-top:32px">If you did not request this, ignore this email.</p></div>'
    });
    console.log('RESET: email sent successfully to', email);
    res.json({ ok: true });
  } catch(e) {
    console.error('Reset error:', e.message, e.response?.data || '');
    res.json({ ok: true });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) throw new Error('Token and password required');
    if (password.length < 8) throw new Error('Password must be at least 8 characters');
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: resetToken } = await supabase.from('reset_tokens').select().eq('token', token).eq('used', false).single();
    if (!resetToken) throw new Error('Invalid or expired reset link');
    if (new Date(resetToken.expires_at) < new Date()) throw new Error('Reset link has expired');
    const bcrypt = await import('bcryptjs');
    const password_hash = await bcrypt.default.hash(password, 10);
    await supabase.from('users').update({ password_hash }).eq('id', resetToken.user_id);
    await supabase.from('reset_tokens').update({ used: true }).eq('id', resetToken.id);
    res.json({ ok: true });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/daily-brief', async (req, res) => {
  const handler = (await import('./daily-brief.js')).default;
  return handler(req, res);
});


app.post('/api/analyze-food', upload.single('photo'), async (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });

  const rlId = getClientId(req, user.userId);
  const rl = await checkRateLimit(foodAnalysisLimiter, rlId);
  if (!rl.success) {
    return res.status(429).json({ error: "You've logged a lot of meals recently! Please wait a bit before logging more." });
  }

  try {
    const { getProfile: gp } = await import('./auth.js');
    const profile = await gp(user.userId);
    const { analyzeFood } = await import('./food-analyzer.js');

    const type = req.body.type;
    let result;

    if (type === 'photo' && req.file) {
      const base64 = req.file.buffer.toString('base64');
      result = await analyzeFood(user.userId, 'photo', null, base64, req.file.mimetype, profile);
    } else {
      result = await analyzeFood(user.userId, 'text', req.body.content, null, null, profile);
    }

    res.json(result);
  } catch(err) {
    if (err.code === 'NOT_FOOD') {
      return res.status(400).json({ error: "I couldn't recognize any food in that. Try describing it differently or send a photo." });
    }
    console.error('Food analysis error:', err.message);
    res.status(500).json({ error: 'Failed to analyze food' });
  }
});


app.get('/api/meals/today', async (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const now = new Date();
    const pst = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const today = pst.toISOString().split('T')[0];
    const { data } = await sb
      .from('food_logs')
      .select()
      .eq('user_id', user.userId)
      .gte('logged_at', today + 'T00:00:00')
      .order('logged_at', { ascending: true });
    const totals = (data || []).reduce((acc, m) => ({
      calories: acc.calories + (m.calories || 0),
      protein: acc.protein + (m.protein || 0),
      carbs: acc.carbs + (m.carbs || 0),
      fat: acc.fat + (m.fat || 0)
    }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
    res.json({ meals: data || [], totals });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


app.post('/api/evening-summary', async (req, res) => {
  const handler = (await import('./evening-summary.js')).default;
  return handler(req, res);
});


app.post('/api/meal-reminder', async (req, res) => {
  const handler = (await import('./meal-reminder.js')).default;
  return handler(req, res);
});


app.post('/api/whatsapp/incoming', async (req, res) => {
  const { handleIncoming } = await import('./whatsapp-handler.js');
  return handleIncoming(req, res);
});


app.post('/api/brief-time', async (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  const hour = parseInt(req.body.hour);
  if (isNaN(hour) || hour < 6 || hour > 10) return res.status(400).json({ error: 'Hour must be 6-10' });
  const { createClient: cc } = await import('@supabase/supabase-js');
  const sb = cc(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  await sb.from('user_profiles').update({ brief_hour: hour }).eq('user_id', user.userId);
  res.json({ ok: true, hour });
});


app.get('/api/brief-time-current', async (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  const { createClient: cc } = await import('@supabase/supabase-js');
  const sb = cc(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data } = await sb.from('user_profiles').select('brief_hour').eq('user_id', user.userId).single();
  res.json({ hour: data?.brief_hour ?? 7 });
});

app.get('/api/timezone', async (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  const { createClient: cc } = await import('@supabase/supabase-js');
  const sb = cc(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data } = await sb.from('user_profiles').select('timezone').eq('user_id', user.userId).single();
  res.json({ timezone: data?.timezone || 'America/Los_Angeles' });
});

app.post('/api/timezone', async (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  const tz = req.body?.timezone;
  if (!tz || typeof tz !== 'string') return res.status(400).json({ error: 'Invalid timezone' });
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date()); } catch(e) { return res.status(400).json({ error: 'Invalid IANA timezone' }); }
  const { createClient: cc } = await import('@supabase/supabase-js');
  const sb = cc(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  await sb.from('user_profiles').update({ timezone: tz }).eq('user_id', user.userId);
  try { const tzUtils = await import('./timezone-utils.js'); tzUtils.clearTimezoneCache(user.userId); } catch(e) {}
  res.json({ ok: true });
});


app.get('/onboarding', (req, res) => {
  const user = getUser(req);
  if (!user) return res.redirect('/auth');
  res.send(getPage('onboarding.html'));
});

app.post('/api/onboarding', async (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  try {
    const { createClient: cc } = await import('@supabase/supabase-js');
    const sb = cc(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const data = {
      user_id: user.userId,
      conditions: req.body.conditions,
      diet: req.body.diet,
      goal: req.body.goal,
      age: req.body.age,
      weight_kg: req.body.weight_kg,
      height_cm: req.body.height_cm,
      wearable: req.body.wearable || 'none',
      brief_hour: req.body.brief_hour || 7,
      symptom_method: req.body.symptom_method || 'off',
      timezone: req.body.timezone || 'America/Los_Angeles',
      onboarding_complete: true
    };
    await sb.from('user_profiles').upsert(data, { onConflict: 'user_id' });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


app.get('/api/onboarding-state', async (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  try {
    const { createClient: cc } = await import('@supabase/supabase-js');
    const sb = cc(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await sb.from('user_profiles').select().eq('user_id', user.userId).single();
    const { data: tokens } = await sb.from('whoop_tokens').select('user_id').eq('user_id', user.userId).single();
    const today = new Date(Date.now() - 7*60*60*1000).toISOString().split('T')[0];
    const { data: meals } = await sb.from('food_logs').select('id').eq('user_id', user.userId).limit(1);
    const hasProfile = profile?.onboarding_complete === true;
    const hasWearable = !!tokens;
    const hasMeals = meals && meals.length > 0;
    const needsSetup = !hasProfile || !hasWearable || !hasMeals;
    res.json({ needsSetup, hasProfile, hasWearable, hasMeals });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/pattern-detective', async (req, res) => {
  const handler = (await import('./pattern-detective.js')).default;
  return handler(req, res);
});


app.get('/api/symptom-prefs', async (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  try {
    const { createClient: cc } = await import('@supabase/supabase-js');
    const sb = cc(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data } = await sb.from('user_profiles').select('symptom_method, symptom_time').eq('user_id', user.userId).single();
    res.json({ method: data?.symptom_method, time: data?.symptom_time || 21 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/symptom-prefs', async (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  const method = req.body.method;
  if (!['whatsapp', 'dashboard', 'off'].includes(method)) return res.status(400).json({ error: 'Invalid method' });
  try {
    const { createClient: cc } = await import('@supabase/supabase-js');
    const sb = cc(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    await sb.from('user_profiles').update({ symptom_method: method }).eq('user_id', user.userId);
    res.json({ ok: true, method });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});




app.get('/api/weekly-review-users', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { createClient: cc } = await import('@supabase/supabase-js');
    const sb = cc(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: tokens } = await sb.from('whoop_tokens').select('user_id');
    res.json({ users: (tokens || []).map(t => t.user_id) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/weekly-review', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { createClient: cc } = await import('@supabase/supabase-js');
    const sb = cc(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: allTokens } = await sb.from('whoop_tokens').select('user_id');
    if (!allTokens || allTokens.length === 0) {
      return res.json({ message: 'No users to process' });
    }
    let triggered = 0;
    let skipped = 0;
    for (let i = 0; i < allTokens.length; i++) {
      const tokenRow = allTokens[i];
      try {
        // Stagger calls by 30 seconds to avoid rate limiting
        const delay = i * 30000;
        setTimeout(() => {
          fetch('https://vitalmindai.community/api/investigate', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + process.env.CRON_SECRET,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            user_id: tokenRow.user_id,
            event_type: 'weekly_review',
            event_data: {
              description: 'Weekly health review — analyze 7-day patterns across recovery, sleep, food, symptoms, and workouts. Provide a comprehensive summary via email and store any new patterns discovered.',
              review_type: 'weekly',
            },
            severity: 'low',
          }),
          keepalive: true,
          }).catch(err => {
            console.error('[WEEKLY-REVIEW] Failed for user:', tokenRow.user_id, err.message);
          });
        }, delay);
        triggered++;
      } catch (e) {
        skipped++;
      }
    }
    // Wait for fetch calls to be dispatched before responding
    await new Promise(r => setTimeout(r, 3000));
    res.json({ message: 'Weekly review triggered', triggered, skipped, total_users: allTokens.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/investigate', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { detectAnomalies } = await import('./event-detector.js');
    const { investigate } = await import('./health-investigator.js');
    const userId = req.body?.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id required' });

    // Option 1: Auto-detect anomalies from current WHOOP data
    if (!req.body.event_type) {
      const { decrypt } = await import('./encrypt.js');
      const { refreshWhoopToken } = await import('./auth.js');
      const { createClient: cc } = await import('@supabase/supabase-js');
      const sb = cc(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const { data: tokenRow } = await sb.from('whoop_tokens').select('access_token').eq('user_id', userId).single();
      if (!tokenRow) return res.status(400).json({ error: 'No WHOOP token for user' });
      let accessToken;
      try { accessToken = decrypt(tokenRow.access_token); } catch(e) { accessToken = tokenRow.access_token; }
      const axios = (await import('axios')).default;
      const headers = { Authorization: 'Bearer ' + accessToken };
      const [recRes, slpRes] = await Promise.allSettled([
        axios.get('https://api.prod.whoop.com/developer/v2/recovery?limit=7', { headers }),
        axios.get('https://api.prod.whoop.com/developer/v2/activity/sleep?limit=7', { headers }),
      ]);
      const whoopData = {
        recovery: recRes.status === 'fulfilled' ? recRes.value.data.records : [],
        sleep: slpRes.status === 'fulfilled' ? slpRes.value.data.records : [],
      };
      const result = await detectAnomalies(userId, whoopData);
      return res.json(result);
    }

    // Option 2: Manual event — force an investigation with specified event
    const result = await investigate({
      userId,
      eventId: null,
      eventType: req.body.event_type,
      eventData: req.body.event_data || { description: 'Manual investigation triggered' },
      severity: req.body.severity || 'medium',
    });
    return res.json(result);
  } catch(e) {
    console.error('[INVESTIGATE] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/quality-check/brief', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { judgeBrief } = await import('./quality-check.js');
    const { ai_output_id, user_id } = req.body || {};
    if (!ai_output_id && !user_id) {
      return res.status(400).json({ error: 'Provide ai_output_id or user_id' });
    }
    const result = await judgeBrief({ aiOutputId: ai_output_id, userId: user_id });
    return res.json(result);
  } catch(err) {
    console.error('Quality check error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/symptom-checkin', async (req, res) => {
  const handler = (await import('./symptom-checkin.js')).default;
  return handler(req, res);
});


app.post('/api/symptoms', async (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  try {
    const { createClient: cc } = await import('@supabase/supabase-js');
    const sb = cc(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    await sb.from('symptom_logs').insert({
      user_id: user.userId,
      pain: req.body.pain,
      bloating: req.body.bloating,
      energy: req.body.energy,
      mood: req.body.mood
    });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/symptoms/today', async (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  try {
    const { createClient: cc } = await import('@supabase/supabase-js');
    const sb = cc(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const now = new Date();
    const pst = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const today = pst.toISOString().split('T')[0];
    const { data } = await sb.from('symptom_logs').select('id').eq('user_id', user.userId).gte('logged_at', today + 'T00:00:00').limit(1);
    res.json({ logged: data && data.length > 0 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/logout', (req, res) => {
  res.clearCookie('vm_token');
  res.redirect('/');
});

export default app;
