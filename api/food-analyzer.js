import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

function getMealType() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const pstHour = (utcHour - 7 + 24) % 24;
  if (pstHour < 11) return 'breakfast';
  if (pstHour < 15) return 'lunch';
  if (pstHour < 17) return 'snack';
  return 'dinner';
}

export async function analyzeFood(userId, type, content, imageBase64, imageMimeType, userProfile) {
  const autoMealType = getMealType();
  const conditionsText = userProfile?.conditions?.filter(c => c !== 'none').join(', ') || 'none';
  const dietText = userProfile?.diet?.filter(d => d !== 'none').join(', ') || 'none';

  let messages = [];

  const systemPrompt = `You are a nutrition analyst for someone with these conditions: ${conditionsText}. Dietary approach: ${dietText}.

Respond ONLY with valid JSON, no markdown, no backticks. Format:
{
  "description": "Short description of the meal",
  "items": [{"name": "item name", "calories": 0, "protein": 0, "carbs": 0, "fat": 0}],
  "total": {"calories": 0, "protein": 0, "carbs": 0, "fat": 0},
  "flags": ["any dietary warnings based on their conditions"],
  "meal_type": "breakfast|lunch|dinner|snack",
  "insight": "One sentence connecting this meal to their health conditions"
}

For flags: if FODMAP diet, flag garlic, onion, wheat, lactose, legumes. If endometriosis, flag inflammatory foods (processed, high sugar, alcohol, red meat). If keto, flag high carbs. Be specific about which ingredient triggered the flag.`;

  if (type === 'photo' && imageBase64) {
    messages = [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: imageMimeType, data: imageBase64 } },
        { type: 'text', text: systemPrompt + '\n\nAnalyze this meal photo.' }
      ]
    }];
  } else {
    messages = [{
      role: 'user',
      content: systemPrompt + '\n\nAnalyze this meal: ' + content
    }];
  }

  const claudeRes = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-4-20250514', max_tokens: 600, messages },
    { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
  );

  const raw = claudeRes.data.content[0].text;
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch(e) {
    parsed = { description: raw, items: [], total: { calories: 0, protein: 0, carbs: 0, fat: 0 }, flags: [], meal_type: 'snack', insight: '' };
  }

  await supabase.from('food_logs').insert({
    user_id: userId,
    meal_type: autoMealType,
    description: parsed.description,
    calories: parsed.total?.calories || 0,
    protein: parsed.total?.protein || 0,
    carbs: parsed.total?.carbs || 0,
    fat: parsed.total?.fat || 0,
    flags: parsed.flags || [],
    raw_input: type === 'photo' ? 'photo upload' : content,
  });

  return parsed;
}
