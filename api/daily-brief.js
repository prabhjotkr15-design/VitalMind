import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { decrypt } from './encrypt.js';
import { refreshWhoopToken } from './auth.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

async function fetchWhoopData(accessToken) {
  const headers = { Authorization: 'Bearer ' + accessToken };
  const [profileRes, recoveryRes, sleepRes, workoutRes] = await Promise.allSettled([
    axios.get('https://api.prod.whoop.com/developer/v1/user/profile/basic', { headers }),
    axios.get('https://api.prod.whoop.com/developer/v2/recovery?limit=7', { headers }),
    axios.get('https://api.prod.whoop.com/developer/v2/activity/sleep?limit=7', { headers }),
    axios.get('https://api.prod.whoop.com/developer/v2/workout?limit=7', { headers }),
  ]);
  return {
    profile: profileRes.status === 'fulfilled' ? profileRes.value.data : null,
    recovery: recoveryRes.status === 'fulfilled' ? recoveryRes.value.data.records : [],
    sleep: sleepRes.status === 'fulfilled' ? sleepRes.value.data.records : [],
    workout: workoutRes.status === 'fulfilled' ? workoutRes.value.data.records : [],
  };
}

async function generateInsight(whoopData, userProfile, foodLogs) {
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
      model: 'claude-opus-4-6',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `You are a specialist in endometriosis, PCOS, and chronic conditions who also has deep expertise in nutrition and exercise physiology. You are writing a morning brief email for a patient.

Patient profile:
- Conditions: ${conditionsText}
- Goal: ${goalText}
- Dietary approach: ${dietText}

You think about the body as an INFLAMMATION SYSTEM. Everything either feeds inflammation or fights it. Your job is to read ALL the data below and find the causal chain — not just describe numbers.

HOW YOU THINK:

1. FOOD → GUT → SYSTEMIC INFLAMMATION → RECOVERY
Look at what they ate yesterday (timestamps, ingredients, flags). If they have FODMAP sensitivity, foods with garlic, onion, wheat, or lactose trigger gut inflammation within 4-6 hours. This becomes systemic inflammation overnight, which suppresses HRV and tanks recovery. If they ate inflammatory foods (processed, high sugar, alcohol, red meat), same pathway. Connect the specific food to this morning's specific HRV and recovery numbers.

2. EXERCISE → CORTISOL → HORMONAL LOAD
Women with endo have a dysregulated stress response. Look at yesterday's strain score. If strain was high (15+) on a low recovery day (below 50%), that workout spiked cortisol instead of building fitness. Elevated cortisol suppresses progesterone, which worsens endo symptoms. Look for: elevated resting heart rate today vs their baseline as confirmation.

3. SLEEP → REPAIR CYCLE
Deep sleep is when the body runs anti-inflammatory repair. Look at total sleep, deep sleep duration, sleep disturbances, and sleep consistency score. If deep sleep was low, the body didn't get enough repair time. Combined with inflammatory food or high strain, recovery compounds downward.

4. MEAL TIMING → OVERNIGHT RECOVERY
Look at the timestamps of their last meal. If they ate within 3 hours of sleep, digestion competes with recovery. For endo patients this is amplified — the body is already working harder to manage inflammation.

5. PATTERNS OVER DAYS
Don't just look at yesterday. Look at the 7-day trend. Is HRV trending down over 3+ days? Is resting heart rate creeping up? Are they accumulating sleep debt? These compound. A single bad night recovers. Three bad nights create a cascade.

YOUR RESPONSE FORMAT:

Paragraph 1 — THE VERDICT (2 sentences max)
Today's recovery score, how it compares to their trend, and one sentence on why.

Paragraph 2 — THE CONNECTION (3-4 sentences)
This is where you earn your value. Connect specific foods (by name, with timestamp) to specific biometric changes. Connect yesterday's workout strain to today's RHR. Connect sleep quality to recovery. Use actual numbers. Example: "You ate [specific food] at [time]. That contains [trigger]. Your HRV dropped from [X] to [Y] overnight — that's the gut inflammation pathway showing up in your data."

Paragraph 3 — THREE ACTIONS (bullet list)
Each action must include a specific number or time. No generic advice. Each must be achievable today.
Examples:
- "Keep strain below 10 today. Your body is in recovery deficit — light walking or yoga only."
- "Eat dinner before 7pm. Your last 3 late meals correlate with 15% lower next-day recovery."
- "Aim for bed by 10pm. You need 8.2 hours to clear your 1.8 hour sleep debt."

Format: clean HTML using p, strong, ul, li only. No headings. Keep under 250 words. Be warm, be specific, be the specialist who finally connects the dots for them.

YESTERDAY'S FOOD LOG:
${foodLogs && foodLogs.length > 0 ? JSON.stringify(foodLogs.map(f => ({ meal: f.meal_type, food: f.description, calories: f.calories, protein: f.protein, carbs: f.carbs, fat: f.fat, flags: f.flags, time: f.logged_at })), null, 2) : 'No meals logged yesterday. Note this gap — encourage them to log today so you can provide better analysis tomorrow.'}

WHOOP BIOMETRIC DATA (past 7 days):
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

        const briefHour = profile?.brief_hour ?? 7;
        const now = new Date();
        const pstHour = (now.getUTCHours() - 7 + 24) % 24;
        if (pstHour !== briefHour) { continue; }

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

        
        let userFoodLogs = [];
        try {
          const yday = new Date(Date.now() - 86400000 - 7*60*60*1000).toISOString().split('T')[0];
          const { data: fl } = await supabase.from('food_logs').select().eq('user_id', tokenRow.user_id).gte('logged_at', yday + 'T00:00:00').order('logged_at', { ascending: true });
          userFoodLogs = fl || [];
        } catch(e) {}
        const { insight, firstName, latestRecovery, latestHRV, latestRHR } = await generateInsight(whoopData, profile, userFoodLogs);

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
