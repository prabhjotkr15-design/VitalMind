import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { decrypt } from './encrypt.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

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
    const now = new Date();
    const pst = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const today = pst.toISOString().split('T')[0];

    for (const tokenRow of allTokens) {
      try {
        const { data: user } = await supabase.from('users').select('email').eq('id', tokenRow.user_id).single();
        if (!user?.email) continue;

        const { data: foodLogs } = await supabase
          .from('food_logs')
          .select()
          .eq('user_id', tokenRow.user_id)
          .gte('logged_at', today + 'T00:00:00')
          .order('logged_at', { ascending: true });

        if (!foodLogs || foodLogs.length === 0) continue;

        const { data: profile } = await supabase.from('user_profiles').select().eq('user_id', tokenRow.user_id).single();

        let accessToken;
        try { accessToken = decrypt(tokenRow.access_token); }
        catch(e) { accessToken = tokenRow.access_token; }

        let latestRecovery = null;
        let latestHRV = null;
        try {
          const headers = { Authorization: 'Bearer ' + accessToken };
          const recRes = await axios.get('https://api.prod.whoop.com/developer/v2/recovery?limit=1', { headers });
          if (recRes.data?.records?.[0]?.score) {
            latestRecovery = recRes.data.records[0].score.recovery_score;
            latestHRV = recRes.data.records[0].score.hrv_rmssd_milli?.toFixed(1);
          }
        } catch(e) {}

        const totals = foodLogs.reduce((acc, m) => ({
          calories: acc.calories + (m.calories || 0),
          protein: acc.protein + (m.protein || 0),
          carbs: acc.carbs + (m.carbs || 0),
          fat: acc.fat + (m.fat || 0)
        }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

        const allFlags = foodLogs.flatMap(m => m.flags || []);
        const conditionsText = profile?.conditions?.filter(c => c !== 'none').join(', ') || 'none';
        const dietText = profile?.diet?.filter(d => d !== 'none').join(', ') || 'none';
        const goalText = profile?.goal || 'overall health';
        const firstName = user.email.split('@')[0];

        const claudeRes = await axios.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: 'claude-sonnet-4-20250514',
            max_tokens: 600,
            messages: [{
              role: 'user',
              content: `You are a personal health coach writing a brief evening nutrition summary email. Be warm and specific.

User goal: ${goalText}. Conditions: ${conditionsText}. Diet: ${dietText}.
Current recovery: ${latestRecovery || 'unknown'}%. Current HRV: ${latestHRV || 'unknown'} ms.

Today's meals:
${JSON.stringify(foodLogs.map(m => ({ meal: m.meal_type, desc: m.description, cal: m.calories, protein: m.protein, carbs: m.carbs, fat: m.fat, flags: m.flags, time: m.logged_at })), null, 2)}

Write:
1. One-line verdict on today's nutrition (good, okay, needs work)
2. If any dietary flags were triggered, explain specifically what to watch for given their conditions
3. Predict how today's eating might affect tomorrow's recovery and HRV — be specific
4. One thing to do differently tomorrow

Format in clean HTML using p, strong, ul, li tags only. Keep it under 150 words.`
            }]
          },
          { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
        );

        const insight = claudeRes.data.content[0].text;
        const uniqueFlags = [...new Set(allFlags)];
        const flagsHtml = uniqueFlags.length > 0
          ? uniqueFlags.map(f => '<span style="display:inline-block;padding:4px 12px;border-radius:100px;font-size:12px;margin:0 6px 6px 0;background:rgba(224,80,80,0.15);color:#e08080">' + f + '</span>').join('')
          : '';

        await resend.emails.send({
          from: 'VitalMind AI <hello@vitalmindai.community>',
          to: [user.email],
          subject: 'Your nutrition today: ' + totals.calories + ' cal — here\'s what to expect tomorrow',
          html: '<div style="font-family:Helvetica Neue,Arial,sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;background:#0c0a0b;color:#f0ece8"><div style="font-size:22px;color:#e09070;margin-bottom:32px;font-weight:600">VitalMind</div><p style="font-size:16px;color:rgba(240,236,232,0.5);margin-bottom:24px">Evening nutrition wrap-up</p><table style="width:100%;border-collapse:separate;border-spacing:8px 0;margin-bottom:24px"><tr><td style="background:#141112;border:1px solid rgba(255,235,225,0.06);border-radius:12px;padding:14px;text-align:center;width:25%"><div style="font-size:11px;color:rgba(240,236,232,0.3);letter-spacing:0.08em;text-transform:uppercase;margin-bottom:6px">Calories</div><div style="font-size:24px;font-weight:700;color:#e09070">' + totals.calories + '</div></td><td style="background:#141112;border:1px solid rgba(255,235,225,0.06);border-radius:12px;padding:14px;text-align:center;width:25%"><div style="font-size:11px;color:rgba(240,236,232,0.3);letter-spacing:0.08em;text-transform:uppercase;margin-bottom:6px">Protein</div><div style="font-size:24px;font-weight:700;color:#d4a87a">' + totals.protein + 'g</div></td><td style="background:#141112;border:1px solid rgba(255,235,225,0.06);border-radius:12px;padding:14px;text-align:center;width:25%"><div style="font-size:11px;color:rgba(240,236,232,0.3);letter-spacing:0.08em;text-transform:uppercase;margin-bottom:6px">Carbs</div><div style="font-size:24px;font-weight:700;color:#d4849c">' + totals.carbs + 'g</div></td><td style="background:#141112;border:1px solid rgba(255,235,225,0.06);border-radius:12px;padding:14px;text-align:center;width:25%"><div style="font-size:11px;color:rgba(240,236,232,0.3);letter-spacing:0.08em;text-transform:uppercase;margin-bottom:6px">Fat</div><div style="font-size:24px;font-weight:700;color:rgba(240,236,232,0.5)">' + totals.fat + 'g</div></td></tr></table>' + (flagsHtml ? '<div style="margin-bottom:20px">' + flagsHtml + '</div>' : '') + '<div style="background:#141112;border:1px solid rgba(255,235,225,0.06);border-radius:12px;padding:24px;margin-bottom:28px;font-size:15px;line-height:1.7;color:rgba(240,236,232,0.7)">' + insight + '</div><div style="text-align:center;margin-top:32px"><a href="https://vitalmind-sigma.vercel.app/dashboard" style="display:inline-block;padding:14px 32px;background:#e09070;color:#0c0a0b;text-decoration:none;border-radius:100px;font-weight:600;font-size:14px">View dashboard</a></div><p style="font-size:12px;color:rgba(240,236,232,0.15);text-align:center;margin-top:40px">VitalMind AI — evening nutrition summary</p></div>'
        });

        sent++;
      } catch(userErr) {
        console.error('Evening summary failed for user:', tokenRow.user_id, userErr.message);
        failed++;
      }
    }

    res.json({ message: 'Evening summary complete. Sent: ' + sent + ', Failed: ' + failed });
  } catch(err) {
    console.error('Evening summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
