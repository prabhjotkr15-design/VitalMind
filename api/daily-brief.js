import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { decrypt } from './encrypt.js';
import { refreshWhoopToken } from './auth.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

async function fetchWhoopData(accessToken) {
  const headers = { Authorization: 'Bearer ' + accessToken };
  const [profileRes, recoveryRes, sleepRes] = await Promise.allSettled([
    axios.get('https://api.prod.whoop.com/developer/v1/user/profile/basic', { headers }),
    axios.get('https://api.prod.whoop.com/developer/v2/recovery?limit=7', { headers }),
    axios.get('https://api.prod.whoop.com/developer/v2/activity/sleep?limit=7', { headers }),
  ]);
  return {
    profile: profileRes.status === 'fulfilled' ? profileRes.value.data : null,
    recovery: recoveryRes.status === 'fulfilled' ? recoveryRes.value.data.records : [],
    sleep: sleepRes.status === 'fulfilled' ? sleepRes.value.data.records : [],
  };
}

async function generateInsight(whoopData, userProfile) {
  const goalLabels = { better_sleep: 'better sleep', more_energy: 'more energy', lose_weight: 'weight loss', peak_performance: 'peak performance' };
  const goalText = goalLabels[userProfile?.goal] || 'overall health';
  const conditionsText = userProfile?.conditions?.filter(c => c !== 'none').join(', ') || 'none';
  const dietText = userProfile?.diet?.filter(d => d !== 'none').join(', ') || 'none';
  const firstName = whoopData.profile?.first_name || 'there';
  const latestRecovery = whoopData.recovery?.[0]?.score?.recovery_score;
  const latestHRV = whoopData.recovery?.[0]?.score?.hrv_rmssd_milli?.toFixed(1);
  const latestRHR = whoopData.recovery?.[0]?.score?.resting_heart_rate;

  const claudeRes = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `You are a personal health coach writing a morning brief email. Be warm, direct, and specific. Use actual numbers from the data. Keep it concise — this is an email someone reads before getting out of bed.

User goal: ${goalText}. Conditions: ${conditionsText}. Diet: ${dietText}.

Structure:
1. One-line summary of how their body is doing today (use recovery score)
2. The most important insight from the past 24 hours
3. Three specific things to do today based on their biometrics and conditions

Format in clean HTML using p, strong, ul, li tags only. No h1 or h2. Keep it under 200 words.

WHOOP Data (past 7 days):
${JSON.stringify(whoopData, null, 2)}`
      }]
    },
    { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
  );

  return { insight: claudeRes.data.content[0].text, firstName, latestRecovery, latestHRV, latestRHR };
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { data: allTokens } = await supabase.from('whoop_tokens').select('user_id, access_token');
    if (!allTokens || allTokens.length === 0) {
      return res.json({ message: 'No users to process' });
    }

    let sent = 0;
    let failed = 0;

    for (const tokenRow of allTokens) {
      try {
        console.log('Processing user:', tokenRow.user_id);
        let accessToken;
        try { accessToken = decrypt(tokenRow.access_token); }
        catch(e) { accessToken = tokenRow.access_token; }

        const { data: user } = await supabase.from('users').select('email').eq('id', tokenRow.user_id).single();
        if (!user?.email) continue;

        const { data: profile } = await supabase.from('user_profiles').select().eq('user_id', tokenRow.user_id).single();

        let whoopData = await fetchWhoopData(accessToken);

        if (!whoopData.recovery?.length) {
          console.log('Token may be expired, attempting refresh for user:', tokenRow.user_id);
          try {
            const newToken = await refreshWhoopToken(tokenRow.user_id);
            if (newToken) {
              whoopData = await fetchWhoopData(newToken);
            }
          } catch(refreshErr) {
            console.log('Refresh failed:', refreshErr.message);
          }
        }

        if (!whoopData.recovery?.length) { console.log('SKIP: still no recovery data after refresh'); continue; }

        const { insight, firstName, latestRecovery, latestHRV, latestRHR } = await generateInsight(whoopData, profile);

        const recoveryColor = latestRecovery >= 67 ? '#4ade80' : latestRecovery >= 34 ? '#f59e0b' : '#ef4444';
        const recoveryLabel = latestRecovery >= 67 ? 'Ready to perform' : latestRecovery >= 34 ? 'Moderate recovery' : 'Rest recommended';

        await resend.emails.send({
          from: 'VitalMind <onboarding@resend.dev>',
          to: [user.email],
          subject: firstName + ', your recovery is ' + (latestRecovery || '--') + '% today',
          html: '<div style="font-family:Helvetica Neue,Arial,sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;background:#0c0a0b;color:#f0ece8"><div style="font-size:22px;color:#e09070;margin-bottom:32px;font-weight:600">VitalMind</div><p style="font-size:16px;color:rgba(240,236,232,0.5);margin-bottom:24px">Good morning, ' + firstName + '. Here is your daily brief.</p><table style="width:100%;border-collapse:separate;border-spacing:8px 0;margin-bottom:28px"><tr><td style="background:#141112;border:1px solid rgba(255,235,225,0.06);border-radius:12px;padding:16px;text-align:center;width:33%"><div style="font-size:11px;color:rgba(240,236,232,0.3);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px">Recovery</div><div style="font-size:28px;font-weight:700;color:' + recoveryColor + '">' + (latestRecovery || '--') + '%</div><div style="font-size:11px;color:rgba(240,236,232,0.4);margin-top:4px">' + recoveryLabel + '</div></td><td style="background:#141112;border:1px solid rgba(255,235,225,0.06);border-radius:12px;padding:16px;text-align:center;width:33%"><div style="font-size:11px;color:rgba(240,236,232,0.3);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px">HRV</div><div style="font-size:28px;font-weight:700;color:#e09070">' + (latestHRV || '--') + '</div><div style="font-size:11px;color:rgba(240,236,232,0.4);margin-top:4px">ms</div></td><td style="background:#141112;border:1px solid rgba(255,235,225,0.06);border-radius:12px;padding:16px;text-align:center;width:33%"><div style="font-size:11px;color:rgba(240,236,232,0.3);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px">RHR</div><div style="font-size:28px;font-weight:700;color:#d4a87a">' + (latestRHR || '--') + '</div><div style="font-size:11px;color:rgba(240,236,232,0.4);margin-top:4px">bpm</div></td></tr></table><div style="background:#141112;border:1px solid rgba(255,235,225,0.06);border-radius:12px;padding:24px;margin-bottom:28px;font-size:15px;line-height:1.7;color:rgba(240,236,232,0.7)">' + insight + '</div><div style="text-align:center;margin-top:32px"><a href="https://vitalmind-sigma.vercel.app/dashboard" style="display:inline-block;padding:14px 32px;background:#e09070;color:#0c0a0b;text-decoration:none;border-radius:100px;font-weight:600;font-size:14px">View full dashboard</a></div><p style="font-size:12px;color:rgba(240,236,232,0.2);text-align:center;margin-top:40px">VitalMind AI — your daily health intelligence</p></div>'
        });

        sent++;
      } catch(userErr) {
        console.error('Failed for user:', tokenRow.user_id, userErr.message);
        failed++;
      }
    }

    res.json({ message: 'Daily brief complete. Sent: ' + sent + ', Failed: ' + failed });
  } catch(err) {
    console.error('Daily brief error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
