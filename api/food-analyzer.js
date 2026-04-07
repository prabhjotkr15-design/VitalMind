import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function getMealType(textContent) {
  if (textContent) {
    const lower = textContent.toLowerCase();
    if (lower.includes('breakfast') || lower.includes('morning meal')) return 'breakfast';
    if (lower.includes('lunch') || lower.includes('midday')) return 'lunch';
    if (lower.includes('dinner') || lower.includes('supper') || lower.includes('evening meal')) return 'dinner';
    if (lower.includes('snack') || lower.includes('snacking')) return 'snack';
    if (lower.match(/for (my )?brunch/)) return 'lunch';
  }
  const now = new Date();
  const utcHour = now.getUTCHours();
  const pstHour = (utcHour - 7 + 24) % 24;
  if (pstHour < 11) return 'breakfast';
  if (pstHour < 15) return 'lunch';
  if (pstHour < 17) return 'snack';
  return 'dinner';
}

export async function analyzeFood(userId, type, content, imageBase64, imageMimeType, userProfile) {
  const autoMealType = getMealType(content);
  const conditionsText = userProfile?.conditions?.filter(c => c !== 'none').join(', ') || 'none';
  const dietText = userProfile?.diet?.filter(d => d !== 'none').join(', ') || 'none';

  let messages = [];

  const systemPrompt = `You are a nutrition analyst for someone with these conditions: ${conditionsText}. Dietary approach: ${dietText}.

RULES:
1. NEVER ask follow-up questions. Analyze what you are given immediately.
2. When details are missing, assume the MOST COMMON preparation and state your assumption in each item name.
3. Examples of good item names with assumptions: "Matcha coffee (assumed: no milk, 12oz)", "Boiled egg (large, no oil)", "Chicken breast (grilled, 6oz)"
4. Use USDA standard values. Be precise.
5. The same description must ALWAYS produce the exact same numbers.

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
    { model: 'claude-sonnet-4-20250514', max_tokens: 600, temperature: 0, messages },
    { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
  );

  const raw = claudeRes.data.content[0].text;
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch(e) {
    parsed = { description: raw, items: [], total: { calories: 0, protein: 0, carbs: 0, fat: 0 }, flags: [], meal_type: 'snack', insight: '' };
  }

  // Calculate totals from items to avoid Claude inconsistencies
  let calculatedTotal;
  if (parsed.items && parsed.items.length > 0) {
    calculatedTotal = parsed.items.reduce((acc, item) => ({
      calories: acc.calories + (item.calories || 0),
      protein: acc.protein + (item.protein || 0),
      carbs: acc.carbs + (item.carbs || 0),
      fat: acc.fat + (item.fat || 0)
    }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  } else {
    calculatedTotal = parsed.total || { calories: 0, protein: 0, carbs: 0, fat: 0 };
  }

  parsed.total = calculatedTotal;

  await supabase.from('food_logs').insert({
    user_id: userId,
    meal_type: autoMealType,
    description: parsed.description,
    calories: calculatedTotal.calories,
    protein: calculatedTotal.protein,
    carbs: calculatedTotal.carbs,
    fat: calculatedTotal.fat,
    flags: parsed.flags || [],
    raw_input: type === 'photo' ? 'photo upload' : content,
  });

  parsed.meal_type = autoMealType;
  return parsed;
}
