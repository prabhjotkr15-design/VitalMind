import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { decrypt } from './encrypt.js';
import { refreshWhoopToken } from './auth.js';
import { summarizeForLLM } from './whoop-summarizer.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

async function fetchWhoopData(accessToken) {
  const headers = { Authorization: 'Bearer ' + accessToken };
  const [profileRes, recoveryRes, sleepRes, workoutRes] = await Promise.allSettled([
    axios.get('https://api.prod.whoop.com/developer/v1/user/profile/basic', { headers }),
    axios.get('https://api.prod.whoop.com/developer/v2/recovery?limit=7', { headers }),
    axios.get('https://api.prod.whoop.com/developer/v2/activity/sleep?limit=7', { headers }),
    axios.get('https://api.prod.whoop.com/developer/v2/activity/workout?limit=7', { headers }),
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

  // Build the clean markdown summary that Opus will read instead of raw JSON
  const summaryMarkdown = summarizeForLLM({
    userProfile: { conditions: conditionsText, diet: dietText, goal: goalText },
    whoopData,
    foodLogs,
  });

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

You think about the body as an INFLAMMATION SYSTEM. Everything either feeds inflammation or fights it. Your job is to read the DATA SUMMARY below and surface the most useful patterns for this person — not just describe numbers.

CRITICAL DATA RULES:
1. The DATA SUMMARY contains pre-computed values (durations in hours/minutes, percentage changes, daily food totals). USE THESE EXACT VALUES. Do not recompute percentages, do not convert units, do not estimate. If the summary says "HRV change: -20.0%", say "20%" — never invent your own number.
2. Every food, time, workout, or biometric you reference must appear verbatim in the DATA SUMMARY. If something is not in the summary, do not mention it.
3. The summary already labels each day with "yesterday", "2 days ago", etc. Use those labels exactly.

LANGUAGE RULES (these matter for medical safety):
1. Use CORRELATIONAL language, not CAUSAL language. The data is observational n=1 — it can show patterns but cannot prove causation.
   - Say: "was followed by", "coincided with", "tended to be", "appears to be associated with"
   - Don't say: "caused", "directly suppresses", "leads to", "because of", "the data points to a clear combination"
2. Frame suggestions as OPTIONS, not MANDATES.
   - Say: "you might consider", "one approach is", "could be worth trying", "your patterns suggest"
   - Don't say: "you must", "eat at least X", "you need to", "be in bed by"
3. Avoid ALARMING language. Be a calm, knowledgeable companion, not a warning siren.
   - Don't say: "starving your recovery", "your body is under attack", "stacking", "plummeted", "in crisis"
4. Do not recommend specific medications, supplements, or dosages of anything.
5. Do not diagnose conditions or predict future outcomes.

HOW YOU THINK (with hedged framing):

1. FOOD → INFLAMMATION → RECOVERY (correlationally)
Look at what they ate (timestamps, ingredients, daily totals from the DATA SUMMARY). For people with FODMAP sensitivity, certain foods may trigger gut inflammation. For people with anti-inflammatory diet preferences, processed foods, high sugar, alcohol, or red meat may have similar effects. When you observe a correlation between specific foods and biometric changes, frame it as a pattern worth noticing — not a proven cause.

2. EXERCISE → RECOVERY LOAD (correlationally)
Women with chronic conditions often have a more sensitive stress response. Look at the workout data in the summary. If strain was high on a low-recovery day, this might be a pattern to watch. Frame as observation, not diagnosis.

3. SLEEP → REPAIR
Deep sleep is when the body runs anti-inflammatory repair. Look at the sleep numbers in the summary (deep sleep duration, sleep debt, consistency). When sleep was insufficient, repair time was reduced — describe this factually.

4. MEAL TIMING → OVERNIGHT RECOVERY
Look at the timestamps of the last meal in the summary. If it was within 3 hours of sleep, this may be a pattern worth noticing.

5. PATTERNS OVER DAYS
Don't just look at one day. The summary shows 7 days of recovery, sleep, and workouts. Notice trends across days. A single bad day recovers; multi-day trends are more meaningful.

YOUR RESPONSE FORMAT:

Paragraph 1 — THE OBSERVATION (2 sentences max)
Today's recovery score, how it compares to recent days (use the pre-computed percentages from the summary), and one sentence on what stands out.

Paragraph 2 — THE PATTERN (3-4 sentences)
This is where you provide insight. Connect specific foods (by name, with PST timestamp from the summary) to specific biometric patterns. Use correlational language. Use the exact numbers from the summary. Example: "You ate [specific food] at [exact time from summary]. That night your HRV was [exact value], a [exact pre-computed %] change from the previous night. This is consistent with the pattern where late carb-heavy meals coincide with lower next-day recovery for you."

Paragraph 3 — THREE OPTIONS (bullet list)
Each option should reference a specific data point from the summary. Frame as options, not mandates. No invented numbers — only reference values that appear in the summary.
Examples of good framing:
- "You might consider keeping today's strain on the lighter side. Your recovery is in the lower range, and your past pattern shows recovery rebounds faster with light activity."
- "One approach worth trying: an earlier dinner tonight. On nights you ate before 7 PM in the past week, your sleep efficiency tended to be higher."
- "Your sleep debt is currently [exact value from summary]. Adding 30-60 minutes to tonight's sleep window could help close it."

Format: clean HTML using p, strong, ul, li only. No headings. Keep under 250 words. Be warm, be specific, be the specialist who finally connects the dots for them — but always with epistemic humility. You're observing patterns in their data, not making clinical pronouncements.

DATA SUMMARY (pre-computed ground truth — use these values exactly):
${summaryMarkdown}`
      }]
    },
    { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
  );
  const inputPayload = { userProfile: { conditions: userProfile?.conditions, diet: userProfile?.diet, goal: userProfile?.goal }, whoopData, foodLogs };
  return { insight: claudeRes.data.content[0].text, firstName, latestRecovery, latestHRV, latestRHR, inputPayload };
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
        const { insight, firstName, latestRecovery, latestHRV, latestRHR, inputPayload } = await generateInsight(whoopData, profile, userFoodLogs);

        // Log to ai_outputs for quality evaluation
        let aiOutputId = null;
        try {
          const { data: logged } = await supabase.from("ai_outputs").insert({
            agent_name: "morning_brief",
            user_id: tokenRow.user_id,
            model: "claude-opus-4-6",
            input_data: inputPayload,
            output_text: insight
          }).select("id").single();
          aiOutputId = logged?.id;
        } catch(logErr) {
          console.error("Failed to log to ai_outputs:", logErr.message);
        }

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
