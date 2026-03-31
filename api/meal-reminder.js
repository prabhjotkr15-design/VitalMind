import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM = process.env.TWILIO_WHATSAPP_NUMBER;

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const mealType = req.body?.meal || 'meal';

  const messages = {
    breakfast: "Good morning! ☀️ Time to log your breakfast. Send a photo of your plate, a voice note, or just type what you had.",
    lunch: "Hey! 🍽️ Don't forget to log your lunch. Photo, voice, or text — takes 10 seconds.",
    dinner: "Evening! 🌙 Time to log your dinner. The more VitalMind knows about what you eat, the smarter your morning brief gets."
  };

  const msg = messages[mealType] || messages.lunch;

  const now = new Date();
  const pst = new Date(now.getTime() - 7 * 60 * 60 * 1000);
  const today = pst.toISOString().split('T')[0];

  try {
    const { data: users } = await supabase.from('users').select('id, phone');
    if (!users || users.length === 0) return res.json({ message: 'No users' });

    let sent = 0;
    let skipped = 0;

    for (const user of users) {
      if (!user.phone) { skipped++; continue; }

      try {
        const { data: meals } = await supabase
          .from('food_logs')
          .select('meal_type')
          .eq('user_id', user.id)
          .gte('logged_at', today + 'T00:00:00');

        const alreadyLogged = (meals || []).some(function(m) {
          return m.meal_type === mealType;
        });

        if (alreadyLogged) { skipped++; continue; }

        await twilioClient.messages.create({
          body: msg,
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
