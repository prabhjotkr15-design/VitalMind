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

  try {
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('user_id, symptom_method')
      .eq('symptom_method', 'whatsapp');

    if (!profiles || profiles.length === 0) {
      return res.json({ message: 'No WhatsApp symptom users' });
    }

    let sent = 0;
    let skipped = 0;

    const now = new Date();
    const pst = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const today = pst.toISOString().split('T')[0];

    for (const profile of profiles) {
      try {
        const { data: user } = await supabase.from('users').select('phone').eq('id', profile.user_id).single();
        if (!user?.phone) { skipped++; continue; }

        // Skip if already logged today
        const { data: existing } = await supabase
          .from('symptom_logs')
          .select('id')
          .eq('user_id', profile.user_id)
          .gte('logged_at', today + 'T00:00:00')
          .limit(1);

        if (existing && existing.length > 0) { skipped++; continue; }

        // Mark as pending symptom check-in
        await supabase.from('pending_meals').delete().eq('user_id', profile.user_id);
        await supabase.from('pending_meals').insert({
          user_id: profile.user_id,
          original_input: 'SYMPTOM_CHECKIN',
          input_type: 'symptom'
        });

        await twilioClient.messages.create({
          body: 'Quick check-in 💜\n\nHow is your body today? Reply with 4 numbers separated by spaces:\n\nPain (0-10) Bloating (0-10) Energy (0-10) Mood (0-10)\n\nExample: 3 5 7 8\n\nReply "skip" if today was normal',
          from: FROM,
          to: 'whatsapp:' + user.phone
        });

        sent++;
      } catch(userErr) {
        console.error('Symptom check-in failed:', profile.user_id, userErr.message);
      }
    }

    res.json({ message: 'Symptom check-in sent: ' + sent + ', skipped: ' + skipped });
  } catch(err) {
    console.error('Symptom check-in error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
