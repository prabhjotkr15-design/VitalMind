import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const mealType = req.body?.meal || 'meal';

  const mealConfig = {
    breakfast: { label: 'breakfast', start: 0, end: 11, emoji: '&#9749;', greeting: 'Good morning' },
    lunch: { label: 'lunch', start: 11, end: 15, emoji: '&#127860;', greeting: 'Hey' },
    dinner: { label: 'dinner', start: 17, end: 24, emoji: '&#127869;', greeting: 'Evening' },
  };

  const config = mealConfig[mealType] || mealConfig.lunch;

  try {
    const { data: allTokens } = await supabase.from('whoop_tokens').select('user_id');
    if (!allTokens || allTokens.length === 0) {
      return res.json({ message: 'No users' });
    }

    const now = new Date();
    const utcHour = now.getUTCHours();
    const pstHour = (utcHour - 7 + 24) % 24;
    const today = new Date(now.getTime() - 7 * 60 * 60 * 1000).toISOString().split('T')[0];

    let sent = 0;
    let skipped = 0;

    for (const tokenRow of allTokens) {
      try {
        const { data: user } = await supabase.from('users').select('email').eq('id', tokenRow.user_id).single();
        if (!user?.email) continue;

        const { data: meals } = await supabase
          .from('food_logs')
          .select('meal_type, logged_at')
          .eq('user_id', tokenRow.user_id)
          .gte('logged_at', today + 'T00:00:00')
          .order('logged_at', { ascending: true });

        const alreadyLogged = (meals || []).some(function(m) {
          return m.meal_type === mealType;
        });

        if (alreadyLogged) {
          skipped++;
          continue;
        }

        const firstName = user.email.split('@')[0];

        await resend.emails.send({
          from: 'VitalMind <onboarding@resend.dev>',
          to: [user.email],
          subject: config.greeting + ' ' + firstName + ' — time to log ' + config.label,
          html: '<div style="font-family:Helvetica Neue,Arial,sans-serif;max-width:480px;margin:0 auto;padding:40px 24px;background:#0c0a0b;color:#f0ece8">' +
            '<div style="font-size:22px;color:#e09070;margin-bottom:28px;font-weight:600">VitalMind</div>' +
            '<p style="font-size:24px;margin-bottom:8px">' + config.emoji + '</p>' +
            '<p style="font-size:18px;font-weight:500;margin-bottom:12px">' + config.greeting + ', ' + firstName + '.</p>' +
            '<p style="font-size:15px;color:rgba(240,236,232,0.6);line-height:1.6;margin-bottom:28px">Quick reminder to log your ' + config.label + '. It takes 10 seconds — snap a photo, use voice, or just type it. The more VitalMind knows about what you eat, the smarter your morning briefs get.</p>' +
            '<div style="text-align:center"><a href="https://vitalmind-sigma.vercel.app/dashboard" style="display:inline-block;padding:14px 32px;background:#e09070;color:#0c0a0b;text-decoration:none;border-radius:100px;font-weight:600;font-size:14px">Log your ' + config.label + '</a></div>' +
            '<p style="font-size:12px;color:rgba(240,236,232,0.15);text-align:center;margin-top:40px">VitalMind AI — meal reminder</p>' +
          '</div>'
        });

        sent++;
      } catch(userErr) {
        console.error('Reminder failed for user:', tokenRow.user_id, userErr.message);
      }
    }

    res.json({ message: 'Meal reminder (' + mealType + '). Sent: ' + sent + ', Skipped (already logged): ' + skipped });
  } catch(err) {
    console.error('Reminder error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
