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
  // If this is a photo refinement, delete the previous food log entry
  if (pending.input_type === 'photo_refinement') {
    const { data: lastLog } = await supabase.from('food_logs')
      .select('id').eq('user_id', user.id)
      .order('created_at', { ascending: false }).limit(1).single();
    if (lastLog) {
      await supabase.from('food_logs').delete().eq('id', lastLog.id);
    }
  }

  let result;
  try {
    if ((pending.input_type === 'photo' || pending.input_type === 'photo_refinement') && pending.image_base64) {
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
  const message = '✅ ' + (pending.input_type === 'photo_refinement' ? 'Updated' : 'Logged') + ': ' + result.description +
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

  // --- PHOTO PATH: Analyze immediately with Claude Vision ---
  if (inputType === 'photo' && imageBase64) {
    try {
      const { analyzeFood } = await import('./food-analyzer.js');
      const result = await analyzeFood(user.id, 'photo', originalInput, imageBase64, imageMime, profile);
      const flags = result.flags && result.flags.length > 0 ? '\n\n⚠️ ' + result.flags.join('\n⚠️ ') : '';
      const message = '✅ Logged: ' + result.description +
        '\n\n🔢 ' + result.total.calories + ' cal | P ' + result.total.protein + 'g | C ' + result.total.carbs + 'g | F ' + result.total.fat + 'g' +
        flags +
        (result.insight ? '\n\n💡 ' + result.insight : '');
      // Store in pending for optional refinement
      await supabase.from('pending_meals').insert({
        user_id: user.id,
        original_input: originalInput || 'Photo of meal',
        input_type: 'photo_refinement',
        image_base64: imageBase64,
        image_mime: imageMime
      });
      return reply(res, message + '\n\nWant to refine? Reply with details like ingredients, portion size, or how it was made.');
    } catch (err) {
      if (err.code === 'NOT_FOOD') {
        return reply(res, "I couldn't recognize any food in your photo. Try a clearer photo or describe what you ate!");
      }
      console.error('[PHOTO] Analysis failed:', err.message);
    }
  }

  // --- TEXT PATH (or photo fallback): Store and ask clarification ---
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

    // ROUTE 2.5: Classify text messages — health question, follow-up, or food?
    if (numMedia === 0 && body.trim()) {
      const userMessage = body.trim();

      // Build context for the classifier
      let classifyContext = '';
      if (pending && pending.input_type !== 'symptom' && pendingAge < 30) {
        classifyContext += 'Context: The app asked the user about "' + (pending.original_input || '').substring(0, 100) + '" ' + Math.round(pendingAge) + ' minutes ago and is waiting for portion/preparation details.\n';
      }

      // Check for recent findings sent to this user (within 1 hour)
      let recentFinding = null;
      try {
        const { data: recentFindings } = await supabase
          .from('agent_messages')
          .select('payload, created_at')
          .eq('user_id', user.id)
          .eq('message_type', 'finding_sent')
          .gte('created_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())
          .order('created_at', { ascending: false })
          .limit(1);
        if (recentFindings && recentFindings.length > 0) {
          recentFinding = recentFindings[0];
          const findingText = recentFinding.payload?.message || JSON.stringify(recentFinding.payload);
          classifyContext += 'Context: The app recently sent this health finding to the user: "' + findingText.substring(0, 200) + '"\n';
        }
      } catch (e) {}

      if (!classifyContext) {
        classifyContext = 'Context: No pending conversations or recent findings.\n';
      }

      // Three-way classification via Claude
      let classification = 'B';
      try {
        const axiosClassify = (await import('axios')).default;
        const classifyRes = await axiosClassify.post('https://api.anthropic.com/v1/messages', {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 10,
          temperature: 0,
          messages: [{ role: 'user', content: 'You are routing a WhatsApp message in a health app. Classify as:\nA - New health question (about their recovery, sleep, symptoms, body, health, what to eat for health reasons, what to do)\nB - Food description, food logging, or answering a food-related question (portion size, preparation, ingredients)\nC - Follow-up or response to a recent health finding (asking for more detail, saying thanks, reacting to advice)\n\n' + classifyContext + '\nMessage: "' + userMessage.replace(/"/g, '\\"') + '"\n\nReply with ONLY the letter A, B, or C.' }]
        }, {
          headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          timeout: 8000,
        });
        const answer = (classifyRes.data?.content?.[0]?.text || '').trim().toUpperCase();
        if (answer.startsWith('A')) classification = 'A';
        else if (answer.startsWith('C')) classification = 'C';
        else classification = 'B';
      } catch (classifyErr) {
        console.error('[CLASSIFY] Error:', classifyErr.message);
        classification = 'B';
      }

      // --- CATEGORY C: Follow-up on recent finding ---
      if (classification === 'C') {
        if (recentFinding && recentFinding.payload) {
          try {
            const axiosRewrite = (await import('axios')).default;
            const findingText = recentFinding.payload.message || JSON.stringify(recentFinding.payload);
            const rewriteRes = await axiosRewrite.post('https://api.anthropic.com/v1/messages', {
              model: 'claude-sonnet-4-20250514',
              max_tokens: 400,
              temperature: 0,
              messages: [{ role: 'user', content: 'You are a warm health companion for someone with chronic conditions. The user received this health finding:\n\n"' + findingText.replace(/"/g, '\\"') + '"\n\nThey replied: "' + userMessage.replace(/"/g, '\\"') + '"\n\nWrite a warm, helpful response under 800 characters. Use correlational language only. Reference specific data points from the finding. No diagnoses. No medication recommendations. If they said thanks, acknowledge warmly and offer to keep watching their data.' }]
            }, {
              headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
              timeout: 10000,
            });
            const userReply = rewriteRes.data?.content?.[0]?.text || '';
            if (userReply) {
              return reply(res, userReply);
            }
          } catch (rewriteErr) {
            console.error('[FOLLOWUP] Rewrite error:', rewriteErr.message);
          }
          return reply(res, 'I recently looked into your data and found some patterns. Ask me something specific like "how is my sleep?" or "what should I eat?" and I\'ll investigate further.');
        }
        classification = 'A';
      }

      // --- CATEGORY A: New health question ---
      if (classification === 'A') {
        try {
          const { data: evt } = await supabase.from('agent_events').insert({
            user_id: user.id,
            event_type: 'user_question',
            event_data: { question: userMessage, description: 'User asked: ' + userMessage },
            severity: 'medium',
          }).select('id').single();
          if (evt) {
            await supabase.from('investigation_queue').insert({
              user_id: user.id,
              event_id: evt.id,
              priority: 2,
              status: 'queued',
            });
          }
        } catch (queueErr) {
          console.error('[INVESTIGATE] Queue insert error:', queueErr.message);
        }

        try {
          fetch('https://vitalmindai.community/api/investigate', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + process.env.CRON_SECRET,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              user_id: user.id,
              event_type: 'user_question',
              event_data: { question: userMessage, description: 'User asked: ' + userMessage },
              severity: 'medium',
            }),
            keepalive: true,
          });
        } catch (fetchErr) {
          console.error('[INVESTIGATE] Fetch error:', fetchErr.message);
        }

        return reply(res, '🔍 Good question — looking into your data now. I\'ll message you with what I find.');
      }

      // --- CATEGORY B: Food — fall through to Route 2 and Route 3 below ---
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
