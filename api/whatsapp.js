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

async function askClarification(foodDescription, conditions, diet) {
  const axios = (await import('axios')).default;
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      temperature: 0,
      messages: [{
        role: 'user',
        content: `You are a nutrition assistant. The user described their meal as: "${foodDescription}"

Their health conditions: ${conditions}. Diet: ${diet}.

Ask 2-4 SHORT, specific clarifying questions about this EXACT meal to get accurate calorie estimates. Focus on:
- Portion sizes (how much/how many)
- Preparation method (if unclear)
- Key ingredients that affect calories (milk type, oil, sweetener, sauce)

DO NOT ask about items they already specified clearly.
DO NOT repeat what they told you.
Keep questions short — one line each.

Respond ONLY with the questions as a numbered list. Nothing else. No greeting, no preamble.`
      }]
    },
    { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
  );
  return res.data.content[0].text;
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

  const conditionsText = profile?.conditions?.filter(c => c !== 'none').join(', ') || 'none';
  const dietText = profile?.diet?.filter(d => d !== 'none').join(', ') || 'none';

  try {
    // Check if there is a pending meal waiting for clarification
    const { data: pending } = await supabase
      .from('pending_meals')
      .select()
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1);

    const hasPending = pending && pending.length > 0;
    const pendingAge = hasPending ? (Date.now() - new Date(pending[0].created_at).getTime()) / 60000 : 999;

    // If there is a recent pending meal (less than 30 min old) and user sent text, treat as clarification answers
    if (hasPending && pendingAge < 30 && numMedia === 0 && body.trim()) {
      const combined = pending[0].original_input + '. Additional details: ' + body.trim();

      let result;
      if (pending[0].input_type === 'photo' && pending[0].image_base64) {
        result = await analyzeFood(user.id, 'photo', combined, pending[0].image_base64, pending[0].image_mime, profile);
      } else {
        result = await analyzeFood(user.id, 'text', combined, null, null, profile);
      }

      // Delete pending meal
      await supabase.from('pending_meals').delete().eq('user_id', user.id);

      const flags = result.flags && result.flags.length > 0 ? '\n\n⚠️ ' + result.flags.join('\n⚠️ ') : '';
      const reply = '✅ Logged: ' + result.description +
        '\n\n🔢 ' + result.total.calories + ' cal | P ' + result.total.protein + 'g | C ' + result.total.carbs + 'g | F ' + result.total.fat + 'g' +
        flags +
        (result.insight ? '\n\n💡 ' + result.insight : '');

      const twiml = '<Response><Message>' + reply + '</Message></Response>';
      res.type('text/xml').send(twiml);
      return;
    }

    // New meal input — store as pending and ask questions
    let originalInput = '';
    let inputType = 'text';
    let imageBase64 = null;
    let imageMime = null;

    if (numMedia > 0) {
      const mediaUrl = req.body.MediaUrl0;
      const mediaType = req.body.MediaContentType0;

      if (mediaType && mediaType.startsWith('image/')) {
        const axios = (await import('axios')).default;
        const imgRes = await axios.get(mediaUrl, {
          responseType: 'arraybuffer',
          auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }
        });
        imageBase64 = Buffer.from(imgRes.data).toString('base64');
        imageMime = mediaType;
        inputType = 'photo';
        originalInput = body.trim() || 'Photo of meal';
      } else {
        const twiml = '<Response><Message>Send a photo of your meal or describe it in text!</Message></Response>';
        res.type('text/xml').send(twiml);
        return;
      }
    } else if (body.trim()) {
      originalInput = body.trim();
      inputType = 'text';
    } else {
      const twiml = '<Response><Message>Send a photo of your meal or describe what you ate!</Message></Response>';
      res.type('text/xml').send(twiml);
      return;
    }

    // Clear any old pending meals for this user
    await supabase.from('pending_meals').delete().eq('user_id', user.id);

    // Store as pending
    await supabase.from('pending_meals').insert({
      user_id: user.id,
      original_input: originalInput,
      input_type: inputType,
      image_base64: imageBase64,
      image_mime: imageMime
    });

    // Ask clarification questions
    const questions = await askClarification(originalInput, conditionsText, dietText);
    const twiml = '<Response><Message>Got it — ' + originalInput + '\n\nQuick questions for accuracy:\n' + questions + '\n\nReply with your answers and I will log it!</Message></Response>';
    res.type('text/xml').send(twiml);

  } catch(err) {
    console.error('WhatsApp handler error:', err.message);
    const twiml = '<Response><Message>Something went wrong. Please try again.</Message></Response>';
    res.type('text/xml').send(twiml);
  }
}
