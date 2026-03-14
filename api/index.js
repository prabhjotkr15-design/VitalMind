import express from 'express';
import axios from 'axios';

const app = express();
app.use(express.json());

const CLIENT_ID = process.env.WHOOP_CLIENT_ID;
const CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SCOPE = 'read:recovery read:sleep read:workout read:body_measurement read:profile offline';

app.get('/', (req, res) => {
  res.send(`
    <h1>VitalMind - WHOOP AI Health Insights</h1>
    <a href="/login">Connect your WHOOP</a>
  `);
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
    // Step 1: Get access token
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

    // Step 2: Fetch all health data
    const [profileRes, recoveryRes, sleepRes] = await Promise.allSettled([
      axios.get('https://api.prod.whoop.com/developer/v1/user/profile/basic', { headers }),
      axios.get('https://api.prod.whoop.com/developer/v1/recovery?limit=7', { headers }),
      axios.get('https://api.prod.whoop.com/developer/v1/sleep?limit=7', { headers }),
    ]);

    const whoopData = {
      profile: profileRes.status === 'fulfilled' ? profileRes.value.data : null,
      recovery: recoveryRes.status === 'fulfilled' ? recoveryRes.value.data.records : [],
      sleep: sleepRes.status === 'fulfilled' ? sleepRes.value.data.records : [],
    };
// Temporary: show raw data
    return res.send('<pre>' + JSON.stringify(whoopData, null, 2) + '</pre>');
    // Step 3: Send to Claude
    const claudeRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-opus-4-5',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `You are a personal health coach. Analyze this WHOOP data from the past 7 days and give clear, specific insights. Tell the user what patterns you see, what is going wrong, and 3 concrete actions they should take. Be direct and specific, not generic.

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

    // Step 4: Show results
    const insight = claudeRes.data.content[0].text;

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>VitalMind Insights</title>
        <style>
          body { font-family: sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; }
          h1 { color: #1a1a1a; }
          .insight { background: #f5f5f5; padding: 20px; border-radius: 10px; line-height: 1.6; white-space: pre-wrap; }
          .refresh { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #000; color: #fff; text-decoration: none; border-radius: 5px; }
        </style>
      </head>
      <body>
        <h1>Your WHOOP AI Insights</h1>
        <div class="insight">${insight}</div>
        <a class="refresh" href="/login">Refresh Analysis</a>
      </body>
      </html>
    `);

  } catch (err) {
    res.status(500).send('Error: ' + JSON.stringify(err.response?.data || err.message));
  }
});

export default app;