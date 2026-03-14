import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

const CLIENT_ID = process.env.WHOOP_CLIENT_ID;
const CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const SCOPE = 'read:recovery read:sleep read:workout read:body_measurement read:profile';

// Home page
app.get('/', (req, res) => {
  res.send(`
    <h1>WHOOP AI Health Insights</h1>
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

// WHOOP sends user back here after login
app.get('/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('No code received from WHOOP');
  }

  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);
    params.append('redirect_uri', REDIRECT_URI);

    const response = await axios.post(
      'https://api.prod.whoop.com/oauth/oauth2/token',
      params,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = response.data;

    res.send(`
      <h2>✅ Connected Successfully!</h2>
      <p><strong>Access Token:</strong><br/><code>${access_token}</code></p>
      <p><strong>Refresh Token:</strong><br/><code>${refresh_token}</code></p>
      <p><strong>Expires in:</strong> ${expires_in} seconds</p>
      <p>⚠️ Copy and save both tokens somewhere safe.</p>
    `);

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('Auth failed: ' + JSON.stringify(err.response?.data));
  }
});

export default app;