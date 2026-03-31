import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';
import { analyzeFood } from './food-analyzer.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM = process.env.TWILIO_WHATSAPP_NUMBER;

export async function sendWhatsApp(to, message) {
  return client.messages.create({
    body: message,
    from: FROM,
    to: 'whatsapp:' + to
  });
}

export async function handleIncoming(req, res) {
  const body = req.body.Body || '';
  const from = req.body.From || '';
  const numMedia = parseInt(req.body.NumMedia || '0');
  const phone = from.replace('whatsapp:', '');

  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('phone', phone)
    .single();

  if (!user) {
    const twiml = '<Response><Message>Welcome! To use VitalMind on WhatsApp, first sign up at vitalmindai.community and add your phone number to your profile.</Message></Response>';
    res.type('text/xml').send(twiml);
    return;
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select()
    .eq('user_id', user.id)
    .single();

  try {
    let result;

    if (numMedia > 0) {
      const mediaUrl = req.body.MediaUrl0;
      const mediaType = req.body.MediaContentType0;

      if (mediaType && mediaType.startsWith('image/')) {
        const axios = (await import('axios')).default;
        const imgRes = await axios.get(mediaUrl, {
          responseType: 'arraybuffer',
          auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }
        });
        const base64 = Buffer.from(imgRes.data).toString('base64');
        result = await analyzeFood(user.id, 'photo', null, base64, mediaType, profile);
      } else {
        const twiml = '<Response><Message>Send a photo of your meal or describe it in text. Voice notes coming soon!</Message></Response>';
        res.type('text/xml').send(twiml);
        return;
      }
    } else if (body.trim()) {
      result = await analyzeFood(user.id, 'text', body.trim(), null, null, profile);
    } else {
      const twiml = '<Response><Message>Send a photo of your meal or describe what you ate!</Message></Response>';
      res.type('text/xml').send(twiml);
      return;
    }

    const flags = result.flags && result.flags.length > 0 ? '\n\n⚠️ ' + result.flags.join('\n⚠️ ') : '';
    const reply = '✅ Logged: ' + result.description +
      '\n\n🔢 ' + result.total.calories + ' cal | P ' + result.total.protein + 'g | C ' + result.total.carbs + 'g | F ' + result.total.fat + 'g' +
      flags +
      (result.insight ? '\n\n💡 ' + result.insight : '');

    const twiml = '<Response><Message>' + reply + '</Message></Response>';
    res.type('text/xml').send(twiml);

  } catch(err) {
    console.error('WhatsApp handler error:', err.message);
    const twiml = '<Response><Message>Something went wrong analyzing your meal. Please try again.</Message></Response>';
    res.type('text/xml').send(twiml);
  }
}
