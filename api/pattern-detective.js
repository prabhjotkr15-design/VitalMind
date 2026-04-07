import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { decrypt } from './encrypt.js';
import { refreshWhoopToken } from './auth.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
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

        const prompt = `You are a health detective writing a weekly report for a patient with: ${conditionsText}. Goal: ${goalText}. Diet: ${dietText}.

You have 7 days of biometric + food + workout data.

CRITICAL LANGUAGE RULES:
- NEVER use technical terms. The user is not a doctor.
- Instead of "HRV" say "your body's recovery signal" or "how calm your nervous system was overnight"
- Instead of "recovery score" say "how ready your body was to take on the day"
- Instead of "strain" say "how hard you pushed your body"
- Instead of "resting heart rate" say "how hard your heart was working at rest"
- Instead of "sleep consistency" say "how regular your sleep schedule was"
- Instead of "deep sleep" say "the deep repair phase of your sleep"
- Use real numbers but explain what they mean: "Your body's readiness jumped from 46% to 97%" not "Recovery score increased"

WHAT TO ANALYZE — connect ALL three:
1. FOOD: What they ate, when they ate it, any flags. Meal timing especially.
2. EXERCISE: Workout intensity, type, how it affected next-day readiness. Did they push too hard on a low-readiness day?
3. SLEEP: Duration, consistency, deep repair phase. Did exercise or food timing affect sleep quality?

YOUR OUTPUT:

Paragraph 1 — THE VERDICT (1-2 sentences):
Did their body get stronger or weaker this week? Be specific with numbers.

Paragraph 2 — THE CONNECTED STORY (3-4 sentences):
Connect food + exercise + sleep into ONE narrative. Show cause and effect across days.

Paragraph 3 — THE ONE THING (1-2 sentences):
The single most impactful change for this week. Include a specific number or time.

If food data is sparse: acknowledge it and ask them to log every meal this week so you can find the food-exercise-sleep connection next time.

TONE: Smart friend who happens to be a doctor. Warm, direct, zero jargon.

LENGTH: Under 150 words total. Three short paragraphs only. No bullet points, no lists, no headings.

Format: clean HTML. Three <p> tags. Bold the action with <strong>.

FOOD LOGS (past 7 days):
${foodLogs && foodLogs.length > 0 ? JSON.stringify(foodLogs.map(f => ({ date: f.logged_at, meal: f.meal_type, food: f.description, cal: f.calories, protein: f.protein, carbs: f.carbs, fat: f.fat, flags: f.flags })), null, 2) : 'No food logged this week'}

WHOOP DATA (past 7 days — includes recovery scores, sleep data, and workout strain):
${JSON.stringify(whoopData, null, 2)}`;

        const claudeRes = await axios.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: 'claude-opus-4-6',
            max_tokens: 1000,
            temperature: 0,
            messages: [{ role: 'user', content: prompt }]
          },
          { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
        );

        const insight = claudeRes.data.content[0].text;

        await resend.emails.send({
          from: 'VitalMind <onboarding@resend.dev>',
          to: [user.email],
          subject: firstName + ', your week in one story',
          html: '<div style="font-family:Helvetica Neue,Arial,sans-serif;max-width:520px;margin:0 auto;padding:40px 24px;background:#0c0a0b;color:#f0ece8"><div style="font-size:22px;color:#e09070;margin-bottom:8px;font-weight:600">VitalMind</div><div style="font-size:13px;color:rgba(240,236,232,0.3);margin-bottom:32px">Your weekly story</div><div style="background:#141112;border:1px solid rgba(255,235,225,0.06);border-radius:12px;padding:28px;margin-bottom:28px;font-size:15px;line-height:1.8;color:rgba(240,236,232,0.75)">' + insight + '</div><div style="text-align:center;margin-top:32px"><a href="https://vitalmindai.community/dashboard" style="display:inline-block;padding:14px 32px;background:#e09070;color:#0c0a0b;text-decoration:none;border-radius:100px;font-weight:600;font-size:14px">View your dashboard</a></div><p style="font-size:12px;color:rgba(240,236,232,0.15);text-align:center;margin-top:40px">VitalMind AI — weekly intelligence</p></div>'
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
