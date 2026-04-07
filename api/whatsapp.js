import twilio from 'twilio';
import OpenAI from 'openai';
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
        content: `The user described their meal as: "${foodDescription}"
Their health conditions: ${conditions}. Diet: ${diet}.
Ask 2-3 SHORT clarifying questions about this EXACT meal. Focus on portion size, preparation method, and key ingredients that affect calories.
DO NOT ask about items they already specified clearly.
Respond ONLY with a numbered list of questions. Nothing else.`
      }]
    },
    { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
  );
  return res.data.content[0].text;
}

async function transcribeAudio(mediaUrl) {
  const axios = (await import('axios')).default;
  const audioRes = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }
  });
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const audioBuffer = Buffer.from(audioRes.data);
  const file = new File([audioBuffer], 'voice.ogg', { type: 'audio/ogg' });
  const transcription = await openai.audio.transcriptions.create({
    file: file,
    model: 'whisper-1',
  });
  return transcription.text;
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
    // Check for pending meal waiting for clarification
    const { data: pendingRows } = await supabase
      .from('pending_meals')
      .select()
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1);

    const pending = pendingRows && pendingRows.length > 0 ? pendingRows[0] : null;
    const pendingAge = pending ? (Date.now() - new Date(pending.created_at).getTime()) / 60000 : 999;

    // STEP 1.5: Handle symptom check-in reply
    if (pending && pending.original_input === 'SYMPTOM_CHECKIN' && pendingAge < 720 && numMedia === 0 && body.trim()) {
      const text = body.trim().toLowerCase();

      if (text === 'skip') {
        await supabase.from('pending_meals').delete().eq('user_id', user.id);
        const twiml = '<Response><Message>No problem — see you tomorrow! 💜</Message></Response>';
        res.type('text/xml').send(twiml);
        return;
      }

      const numbers = body.trim().match(/\d+/g);
      if (!numbers || numbers.length < 4) {
        const twiml = '<Response><Message>I need 4 numbers separated by spaces:\n\nPain (0-10) Bloating (0-10) Energy (0-10) Mood (0-10)\n\nExample: 3 5 7 8</Message></Response>';
        res.type('text/xml').send(twiml);
        return;
      }

      const [pain, bloating, energy, mood] = numbers.slice(0, 4).map(Number);
      const validRange = (n) => n >= 0 && n <= 10;
      if (!validRange(pain) || !validRange(bloating) || !validRange(energy) || !validRange(mood)) {
        const twiml = '<Response><Message>Each number should be between 0 and 10. Try again like this: 3 5 7 8</Message></Response>';
        res.type('text/xml').send(twiml);
        return;
      }

      await supabase.from('symptom_logs').insert({
        user_id: user.id,
        pain: pain,
        bloating: bloating,
        energy: energy,
        mood: mood
      });

      await supabase.from('pending_meals').delete().eq('user_id', user.id);

      const summary = pain >= 7 ? 'Tough day. I am sorry. ' : pain >= 4 ? 'Got it. ' : 'Glad you are feeling decent today. ';
      const twiml = '<Response><Message>✅ Logged: pain ' + pain + ', bloating ' + bloating + ', energy ' + energy + ', mood ' + mood + '\n\n' + summary + 'I will use this to find your patterns. See you tomorrow 💜</Message></Response>';
      res.type('text/xml').send(twiml);
      return;
    }

    // STEP 2: User is answering clarification questions
    if (pending && pending.original_input !== 'SYMPTOM_CHECKIN' && pendingAge < 30 && numMedia === 0 && body.trim()) {
      const combined = pending.original_input + '. Additional details from user: ' + body.trim();

      // Delete pending FIRST to prevent loops
      await supabase.from('pending_meals').delete().eq('user_id', user.id);

      let result;
      if (pending.input_type === 'photo' && pending.image_base64) {
        result = await analyzeFood(user.id, 'photo', combined, pending.image_base64, pending.image_mime, profile);
      } else {
        result = await analyzeFood(user.id, 'text', combined, null, null, profile);
      }

      const flags = result.flags && result.flags.length > 0 ? '\n\n⚠️ ' + result.flags.join('\n⚠️ ') : '';
      const reply = '✅ Logged: ' + result.description +
        '\n\n🔢 ' + result.total.calories + ' cal | P ' + result.total.protein + 'g | C ' + result.total.carbs + 'g | F ' + result.total.fat + 'g' +
        flags +
        (result.insight ? '\n\n💡 ' + result.insight : '');

      const twiml = '<Response><Message>' + reply + '</Message></Response>';
      res.type('text/xml').send(twiml);
      return;
    }

    // STEP 1: New meal input
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
      } else if (mediaType && (mediaType.startsWith('audio/') || mediaType.includes('ogg'))) {
        const transcribed = await transcribeAudio(req.body.MediaUrl0);
        if (!transcribed || transcribed.trim().length === 0) {
          const twiml = '<Response><Message>Sorry, I could not understand the voice note. Try sending a text message or photo instead.</Message></Response>';
          res.type('text/xml').send(twiml);
          return;
        }
        originalInput = transcribed.trim();
        inputType = 'text';
      } else {
        const twiml = '<Response><Message>Send a photo of your meal, a voice note, or describe it in text!</Message></Response>';
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

    // Clear any old pending meals
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
    const twiml = '<Response><Message>Got it — ' + originalInput + '\n\nQuick questions for accuracy:\n' + questions + '\n\nReply with your answers and I\'ll log it!</Message></Response>';
    res.type('text/xml').send(twiml);

  } catch(err) {
    console.error('WhatsApp handler error:', err.message);
    const twiml = '<Response><Message>Something went wrong. Please try again.</Message></Response>';
    res.type('text/xml').send(twiml);
  }
}
