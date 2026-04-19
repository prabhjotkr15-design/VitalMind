import twilio from 'twilio';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import { detectSymptomAnomalies } from './event-detector.js';
import { analyzeFood } from './food-analyzer.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM = process.env.TWILIO_WHATSAPP_NUMBER;

function validateTwilioRequest(req) {
  const twilioSignature = req.headers['x-twilio-signature'];
  if (!twilioSignature) return false;
  const url = 'https://vitalmindai.community' + req.originalUrl;
  return twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    twilioSignature,
    url,
    req.body
  );
}

export async function sendWhatsApp(to, message) {
  return client.messages.create({
    body: message,
    from: FROM,
    to: 'whatsapp:' + to
  });
}

function reply(res, message) {
  const escaped = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  res.type('text/xml').send('<Response><Message>' + escaped + '</Message></Response>');
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
  const transcription = await openai.audio.transcriptions.create({ file: file, model: 'whisper-1' });
  return transcription.text;
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
        content: 'The user described their meal as: "' + foodDescription + '"\nConditions: ' + conditions + '. Diet: ' + diet + '.\nAsk 2-3 SHORT clarifying questions about portion size, preparation, and key ingredients. DO NOT ask about items already specified. Respond ONLY with a numbered list. Nothing else.'
      }]
    },
    { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
  );
  return res.data.content[0].text;
}

async function processSymptomReply(user, body, res) {
  const text = body.trim().toLowerCase();

  if (text === 'skip') {
    await supabase.from('pending_meals').delete().eq('user_id', user.id);
    return reply(res, 'No problem — see you tomorrow! 💜');
  }

  const numbers = body.trim().match(/\d+/g);
  if (!numbers || numbers.length < 4) {
    return reply(res, 'I need 4 numbers separated by spaces:\n\nPain (0-10) Bloating (0-10) Energy (0-10) Mood (0-10)\n\nExample: 3 5 7 8');
  }

  const [pain, bloating, energy, mood] = numbers.slice(0, 4).map(Number);
  if ([pain, bloating, energy, mood].some(n => n < 0 || n > 10)) {
    return reply(res, 'Each number should be between 0 and 10. Try again like this: 3 5 7 8');
  }

  await supabase.from('symptom_logs').insert({
    user_id: user.id, pain, bloating, energy, mood
  });
  await supabase.from('pending_meals').delete().eq('user_id', user.id);

  // Trigger symptom anomaly detection (non-blocking)
  detectSymptomAnomalies(user.id, { pain, bloating, energy, mood }).catch(err => {
    console.error('[EVENT-DETECTOR] Symptom detection error:', err.message);
  });

  const summary = pain >= 7 ? 'Tough day. I am sorry. ' : pain >= 4 ? 'Got it. ' : 'Glad you are feeling decent today. ';
  return reply(res, '✅ Logged: pain ' + pain + ', bloating ' + bloating + ', energy ' + energy + ', mood ' + mood + '\n\n' + summary + 'I will use this to find your patterns. See you tomorrow 💜');
}

async function processFoodClarificationReply(user, pending, body, profile, res) {
  const combined = pending.original_input + '. Additional details: ' + body.trim();
  await supabase.from('pending_meals').delete().eq('user_id', user.id);

  let result;
  try {
    if (pending.input_type === 'photo' && pending.image_base64) {
      result = await analyzeFood(user.id, 'photo', combined, pending.image_base64, pending.image_mime, profile);
    } else {
      result = await analyzeFood(user.id, 'text', combined, null, null, profile);
    }
  } catch(err) {
    if (err.code === 'NOT_FOOD') {
      return reply(res, "I couldn't recognize any food in your message. Try describing what you ate (like 'grilled chicken with rice') or send a photo!");
    }
    throw err;
  }

  const flags = result.flags && result.flags.length > 0 ? '\n\n⚠️ ' + result.flags.join('\n⚠️ ') : '';
  const message = '✅ Logged: ' + result.description +
    '\n\n🔢 ' + result.total.calories + ' cal | P ' + result.total.protein + 'g | C ' + result.total.carbs + 'g | F ' + result.total.fat + 'g' +
    flags +
    (result.insight ? '\n\n💡 ' + result.insight : '');

  return reply(res, message);
}

async function processNewMeal(user, body, numMedia, req, profile, conditionsText, dietText, res) {
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
      const transcribed = await transcribeAudio(mediaUrl);
      if (!transcribed || transcribed.trim().length === 0) {
        return reply(res, 'Sorry, I could not understand the voice note. Try sending a text message or photo instead.');
      }
      originalInput = transcribed.trim();
      inputType = 'text';
    } else {
      return reply(res, 'Send a photo of your meal, a voice note, or describe it in text!');
    }
  } else if (body.trim()) {
    originalInput = body.trim();
    inputType = 'text';
  } else {
    return reply(res, 'Send a photo of your meal or describe what you ate!');
  }

  await supabase.from('pending_meals').delete().eq('user_id', user.id);
  await supabase.from('pending_meals').insert({
    user_id: user.id,
    original_input: originalInput,
    input_type: inputType,
    image_base64: imageBase64,
    image_mime: imageMime
  });

  const questions = await askClarification(originalInput, conditionsText, dietText);
  return reply(res, 'Got it — ' + originalInput + '\n\nQuick questions for accuracy:\n' + questions + '\n\nReply with your answers and I will log it!');
}

export async function handleIncoming(req, res) {
  if (!validateTwilioRequest(req)) {
    console.error('Twilio signature validation failed');
    return res.status(403).send('Forbidden');
  }
  const body = req.body.Body || '';
  const from = req.body.From || '';
  const numMedia = parseInt(req.body.NumMedia || '0');
  const phone = from.replace('whatsapp:', '');

  const { data: user } = await supabase.from('users').select('id').eq('phone', phone).single();
  if (!user) {
    return reply(res, 'Welcome! To use VitalMind on WhatsApp, first sign up at vitalmindai.community and add your phone number to your profile.');
  }

  const { data: profile } = await supabase.from('user_profiles').select().eq('user_id', user.id).single();
  const conditionsText = profile?.conditions?.filter(c => c !== 'none').join(', ') || 'none';
  const dietText = profile?.diet?.filter(d => d !== 'none').join(', ') || 'none';

  try {
    // Get the most recent pending row
    const { data: pendingRows } = await supabase
      .from('pending_meals')
      .select()
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1);

    const pending = pendingRows && pendingRows.length > 0 ? pendingRows[0] : null;
    const pendingAge = pending ? (Date.now() - new Date(pending.created_at).getTime()) / 60000 : 999;

    // ROUTE 1: Symptom check-in reply (text only, within 12 hours)
    if (pending && pending.input_type === 'symptom' && numMedia === 0 && body.trim() && pendingAge < 720) {
      return await processSymptomReply(user, body, res);
    }

    // ROUTE 2.5: Health question — triggers investigator
    if (numMedia === 0 && body.trim()) {
      const lower = body.trim().toLowerCase();

      // Quick shortcuts — no Claude call needed
      let isQuestion = false;
      if (lower === 'why' || lower === 'more' || lower === 'tell me more') {
        isQuestion = true;
      } else {
        // Let Claude classify: health question or food description?
        try {
          const axios = (await import('axios')).default;
          const classifyRes = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-sonnet-4-20250514',
            max_tokens: 10,
            temperature: 0,
            messages: [{ role: 'user', content: 'Classify this message from a health app user. Is it (A) a question about their health, body, recovery, sleep, symptoms, or wellbeing, or (B) a description of food they ate or want to log?\n\nMessage: "' + body.trim().replace(/"/g, '\\"') + '"\n\nReply with ONLY the letter A or B.' }]
          }, {
            headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            timeout: 5000,
          });
          const answer = (classifyRes.data?.content?.[0]?.text || '').trim().toUpperCase();
          isQuestion = answer.startsWith('A');
        } catch (e) {
          isQuestion = false;
        }
      }

      if (isQuestion) {
        // Non-blocking — send immediate reply, then investigate in background
        reply(res, '🔍 Good question — let me look into your data. I\'ll message you with what I find.');
        // Trigger investigation as a separate Vercel function (survives after this response ends)
        const axios = (await import('axios')).default;
        axios.post((process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://vitalmindai.community') + '/api/investigate', {
          user_id: user.id,
          event_type: 'user_question',
          event_data: { question: body.trim(), description: 'User asked: ' + body.trim() },
          severity: 'medium',
        }, {
          headers: { 'Authorization': 'Bearer ' + process.env.CRON_SECRET, 'Content-Type': 'application/json' },
          timeout: 120000,
        }).catch(err => {
          console.error('[INVESTIGATOR] Failed to trigger investigation:', err.message);
        });
        return;
      }
    }

        // ROUTE 2: Food clarification reply (text only, within 30 min)
    if (pending && pending.input_type !== 'symptom' && numMedia === 0 && body.trim() && pendingAge < 30) {
      return await processFoodClarificationReply(user, pending, body, profile, res);
    }

    // ROUTE 3: New meal (photo, voice, or text)
    return await processNewMeal(user, body, numMedia, req, profile, conditionsText, dietText, res);

  } catch(err) {
    console.error('WhatsApp handler error:', err.message);
    return reply(res, 'Something went wrong. Please try again.');
  }
}
