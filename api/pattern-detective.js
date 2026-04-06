import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { decrypt } from './encrypt.js';
import { refreshWhoopToken } from './auth.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

async function fetchWeekData(accessToken) {
  const headers = { Authorization: 'Bearer ' + accessToken };
  const [recoveryRes, sleepRes, workoutRes] = await Promise.allSettled([
    axios.get('https://api.prod.whoop.com/developer/v2/recovery?limit=7', { headers }),
    axios.get('https://api.prod.whoop.com/developer/v2/activity/sleep?limit=7', { headers }),
    axios.get('https://api.prod.whoop.com/developer/v2/workout?limit=7', { headers }),
  ]);
  return {
    recovery: recoveryRes.status === 'fulfilled' ? recoveryRes.value.data.records : [],
    sleep: sleepRes.status === 'fulfilled' ? sleepRes.value.data.records : [],
    workout: workoutRes.status === 'fulfilled' ? workoutRes.value.data.records : [],
  };
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

    const weekAgo = new Date(Date.now() - 7 * 86400000 - 7 * 60 * 60 * 1000).toISOString().split('T')[0];

    for (const tokenRow of allTokens) {
      try {
        const { data: user } = await supabase.from('users').select('email').eq('id', tokenRow.user_id).single();
        if (!user?.email) continue;

        const { data: profile } = await supabase.from('user_profiles').select().eq('user_id', tokenRow.user_id).single();

        let accessToken;
        try { accessToken = decrypt(tokenRow.access_token); }
        catch(e) { accessToken = tokenRow.access_token; }

        let whoopData = await fetchWeekData(accessToken);
        if (!whoopData.recovery?.length) {
          try {
            const newToken = await refreshWhoopToken(tokenRow.user_id);
            if (newToken) whoopData = await fetchWeekData(newToken);
          } catch(e) {}
        }
        if (!whoopData.recovery?.length) continue;

        const { data: foodLogs } = await supabase
          .from('food_logs')
          .select()
          .eq('user_id', tokenRow.user_id)
          .gte('logged_at', weekAgo + 'T00:00:00')
          .order('logged_at', { ascending: true });

        const conditionsText = profile?.conditions?.filter(c => c !== 'none').join(', ') || 'none';
        const dietText = profile?.diet?.filter(d => d !== 'none').join(', ') || 'none';
        const goalText = profile?.goal || 'overall health';
        const firstName = user.email.split('@')[0];

        const claudeRes = await axios.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: 'claude-opus-4-6',
            max_tokens: 1500,
            temperature: 0,
            messages: [{
              role: 'user',
              content: `You are a pattern detection specialist for a patient with: ${conditionsText}. Goal: ${goalText}. Diet: ${dietText}.

You have 7 days of biometric data and food logs. Your job is to find CORRELATIONS that the patient would never notice on their own.

HOW TO FIND PATTERNS:

1. FOOD → NEXT DAY RECOVERY
For each day, look at what they ate and when. Then look at the NEXT morning's recovery and HRV.
- Did late meals (after 8pm) consistently lead to lower recovery?
- Did specific foods (dairy, gluten, high-FODMAP, sugar) correlate with HRV drops?
- Did high-protein days correlate with better recovery?
Calculate: "You ate [food] on [days]. On those days, your next-morning HRV averaged [X]. On days without [food], it averaged [Y]. That's a [Z]% difference."

2. EXERCISE → RECOVERY RELATIONSHIP
- On days with high strain (15+), what happened to recovery the next day?
- Is the patient overtraining? (high strain + consistently dropping recovery)
- Did rest days actually produce better recovery, or did they not help?

3. SLEEP PATTERNS
- Is bedtime consistent or erratic?
- Is deep sleep trending up or down?
- Does weekend sleep differ from weekday?

4. COMPOUNDING EFFECTS
- Look for combinations: late meal + high strain + poor sleep = recovery crash?
- Do bad days cluster? (3+ low recovery days in a row)

5. CONDITION-SPECIFIC PATTERNS
For endometriosis: inflammation markers in food correlating with recovery dips
For PCOS: high-carb meals correlating with energy crashes (elevated RHR)
For thyroid: sleep quality patterns affecting metabolism markers

YOUR OUTPUT:

Write exactly 3 PATTERNS you found, ranked by confidence. For each pattern:
- State the pattern as a clear rule: "When X happens, Y follows"
- Show the specific data points that prove it: dates, numbers, foods
- Give the confidence: how many times did this pattern hold vs not hold? (e.g. "4 out of 5 times")
- Give ONE specific action to test next week

If you don't have enough food data, say so honestly and tell them what to log to find better patterns next week.

Format in clean HTML using p, strong, ul, li only. No headings. Keep it under 400 words. Be warm but data-driven.

FOOD LOGS (past 7 days):
${foodLogs && foodLogs.length > 0 ? JSON.stringify(foodLogs.map(f => ({ date: f.logged_at, meal: f.meal_type, food: f.description, cal: f.calories, protein: f.protein, carbs: f.carbs, fat: f.fat, flags: f.flags })), null, 2) : 'No food logged this week'}

WHOOP DATA (past 7 days):
${JSON.stringify(whoopData, null, 2)}`
            }]
          },
          { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
        );

        const insight = claudeRes.data.content[0].text;

        await resend.emails.send({
          from: 'VitalMind <onboarding@resend.dev>',
          to: [user.email],
          subject: firstName + ', your weekly patterns are in — 3 things your body is telling you',
          html: '<div style="font-family:Helvetica Neue,Arial,sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;background:#0c0a0b;color:#f0ece8"><div style="font-size:22px;color:#e09070;margin-bottom:8px;font-weight:600">VitalMind</div><div style="font-size:13px;color:rgba(240,236,232,0.3);margin-bottom:32px">Weekly Pattern Detective</div><div style="background:#141112;border:1px solid rgba(255,235,225,0.06);border-radius:12px;padding:28px;margin-bottom:28px;font-size:15px;line-height:1.8;color:rgba(240,236,232,0.7)">' + insight + '</div><div style="text-align:center;margin-top:32px"><a href="https://vitalmindai.community/dashboard" style="display:inline-block;padding:14px 32px;background:#e09070;color:#0c0a0b;text-decoration:none;border-radius:100px;font-weight:600;font-size:14px">View your dashboard</a></div><p style="font-size:12px;color:rgba(240,236,232,0.15);text-align:center;margin-top:40px">VitalMind AI — weekly pattern intelligence</p></div>'
        });

        sent++;
      } catch(userErr) {
        console.error('Pattern detective failed for user:', tokenRow.user_id, userErr.message);
        failed++;
      }
    }

    res.json({ message: 'Pattern detective complete. Sent: ' + sent + ', Failed: ' + failed });
  } catch(err) {
    console.error('Pattern detective error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
