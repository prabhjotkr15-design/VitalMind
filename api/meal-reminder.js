import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';
import { getUserTimezone, startOfTodayUTC } from './timezone-utils.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM = process.env.TWILIO_WHATSAPP_NUMBER;

const templates = {
  breakfast: 'HXa3abb6f2976a3ad9aab76940fb68544e',
  lunch: 'HXd148e7e54aefbfc80d63a1c668fa9c1e',
  dinner: 'HX39d81c7ea8d02a6cd07fb2bf6524d6bb'
};

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const mealType = (req.body?.meal || 'meal').toLowerCase();
  const templateSid = templates[mealType];
  if (!templateSid) return res.status(400).json({ error: 'Invalid meal type' });



  try {
    const { data: users } = await supabase.from('users').select('id, phone');
    if (!users || users.length === 0) return res.json({ message: 'No users' });

    let sent = 0;
    let skipped = 0;

    for (const user of users) {
      if (!user.phone) { skipped++; continue; }

      try {
        const userTZ = await getUserTimezone(user.id);
        const todayStartUTC = startOfTodayUTC(userTZ);
        const { data: meals } = await supabase
          .from('food_logs')
          .select('meal_type')
          .eq('user_id', user.id)
          .gte('logged_at', todayStartUTC);

        const alreadyLogged = (meals || []).some(function(m) {
          return m.meal_type === mealType;
        });

        if (alreadyLogged) { skipped++; continue; }

        await twilioClient.messages.create({
          contentSid: templateSid,
          from: FROM,
          to: 'whatsapp:' + user.phone
        });

        sent++;
      } catch(userErr) {
        console.error('Reminder failed for user:', user.id, userErr.message);
      }
    }

    res.json({ message: 'WhatsApp reminder (' + mealType + '). Sent: ' + sent + ', Skipped: ' + skipped });
  } catch(err) {
    console.error('Reminder error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
