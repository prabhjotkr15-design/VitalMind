import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

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

Use these STANDARD calorie references for consistency. Do NOT deviate from these baseline values:
- Boiled egg: 78 cal, 6g protein, 0.6g carbs, 5g fat (each)
- Matcha latte (12oz, with milk): 120 cal, 4g protein, 15g carbs, 4g fat
- Black coffee/matcha (no milk): 5 cal, 0g protein, 1g carbs, 0g fat
- Chicken breast (6oz grilled): 280 cal, 52g protein, 0g carbs, 6g fat
- Brown rice (1 cup cooked): 215 cal, 5g protein, 45g carbs, 2g fat
- Oatmeal (1 cup cooked): 150 cal, 5g protein, 27g carbs, 3g fat
- Banana (medium): 105 cal, 1g protein, 27g carbs, 0g fat
- Avocado (half): 160 cal, 2g protein, 9g carbs, 15g fat
- Spinach salad (2 cups): 14 cal, 2g protein, 2g carbs, 0g fat

Use these as anchors. For items not listed, estimate based on USDA standard portions. Be consistent — the same meal described twice must produce the same numbers.

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
