// api/agent-tools.js
// Tool definitions and implementations for the Health Investigator agent.
// Each tool has:
//   1. A schema (JSON) for Claude's tool use API
//   2. An execute() function that runs when Claude calls the tool
//
// Tools are grouped into:
//   - DATA: fetch biometric/food/symptom data from Supabase
//   - MEMORY: retrieve past patterns and investigations (RAG)
//   - ACTION: send messages to the user (with communication lock)

import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';
import { getUserTimezone, dateStringInTZ, utcToTZParts } from './timezone-utils.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM = process.env.TWILIO_WHATSAPP_NUMBER;

// =====================================================================
// Tool schemas (sent to Claude so it knows what tools are available)
// =====================================================================

export const TOOL_SCHEMAS = [
  {
    name: 'fetch_recovery',
    description: 'Fetch WHOOP recovery data (recovery score, HRV, resting heart rate, SpO2) for a user over a number of days. Returns most recent first.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Number of days of data to fetch (1-14)', default: 7 }
      },
      required: []
    }
  },
  {
    name: 'fetch_sleep',
    description: 'Fetch WHOOP sleep data (duration, stages, efficiency, debt, respiratory rate) for a user. Returns most recent first.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Number of days of sleep data to fetch (1-14)', default: 7 }
      },
      required: []
    }
  },
  {
    name: 'fetch_food_logs',
    description: 'Fetch food logs (meals, calories, macros, timestamps, flags) for a user. Returns most recent first with daily totals.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Number of days of food data to fetch (1-14)', default: 7 }
      },
      required: []
    }
  },
  {
    name: 'fetch_symptoms',
    description: 'Fetch symptom check-in data (pain, bloating, energy, mood scores 0-10) for a user. Returns most recent first.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Number of days of symptom data to fetch (1-14)', default: 7 }
      },
      required: []
    }
  },
  {
    name: 'fetch_workouts',
    description: 'Fetch WHOOP workout data (sport, duration, strain, heart rate) for a user. Returns most recent first.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Number of days of workout data to fetch (1-14)', default: 14 }
      },
      required: []
    }
  },
  {
    name: 'check_past_patterns',
    description: 'Retrieve known patterns the system has previously discovered about this user (e.g., "late meals correlate with recovery drops"). These are confirmed observations from past investigations.',
    input_schema: {
      type: 'object',
      properties: {
        pattern_type: { type: 'string', description: 'Optional filter by pattern type (e.g., "food_recovery_correlation", "sleep_pattern"). Omit to get all active patterns.' }
      },
      required: []
    }
  },
  {
    name: 'check_past_investigations',
    description: 'Search past investigations for this user to see if similar anomalies have been investigated before. Returns investigation summaries with conclusions.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for (e.g., "recovery drop", "high pain", "sleep issues")' }
      },
      required: ['query']
    }
  },
  {
    name: 'send_whatsapp',
    description: 'Send a finding or recommendation to the user via WhatsApp. Use for timely, actionable findings. Keep messages warm, specific, and under 500 characters. Use correlational language only.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message to send (under 500 characters, warm tone, correlational language, no diagnoses)' }
      },
      required: ['message']
    }
  },
  {
    name: 'send_email',
    description: 'Send a detailed finding to the user via email. Use for longer explanations or when WhatsApp would be too brief. Include a clear subject line.',
    input_schema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body (HTML allowed, warm tone, correlational language, no diagnoses)' }
      },
      required: ['subject', 'body']
    }
  },
  {
    name: 'store_pattern',
    description: 'Store a pattern you discovered during this investigation. The pattern will be remembered for future investigations and shared with the morning brief agent. Only store patterns you have evidence for (at least 2 data points).',
    input_schema: {
      type: 'object',
      properties: {
        pattern_type: { type: 'string', description: 'Category: food_recovery_correlation, sleep_pattern, meal_timing, exercise_impact, symptom_trigger, restriction_cycle' },
        description: { type: 'string', description: 'Clear description of the pattern observed (e.g., "Late meals after 9 PM correlate with 20%+ recovery drops the following day")' },
        confidence: { type: 'number', description: 'Confidence level 0.0 to 1.0 based on evidence strength (0.3=weak, 0.5=moderate, 0.7=strong, 0.9=very strong)' }
      },
      required: ['pattern_type', 'description', 'confidence']
    }
  }
];

// =====================================================================
// Communication lock helpers
// =====================================================================

async function acquireMessageLock(userId, agentName, cooldownMinutes = 120, bypassCooldown = false) {
  const now = new Date();

  // Check if another agent holds the lock or cooldown is active
  const { data: lock } = await supabase
    .from('user_message_locks')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (lock) {
    // Check cooldown (skip if user initiated the request)
    if (!bypassCooldown && lock.cooldown_until && new Date(lock.cooldown_until) > now) {
      return { acquired: false, reason: 'cooldown_active', cooldown_until: lock.cooldown_until };
    }
    // Check if lock is held and not expired
    if (lock.locked_by && lock.locked_by !== agentName && lock.lock_expires_at && new Date(lock.lock_expires_at) > now) {
      return { acquired: false, reason: 'locked_by_' + lock.locked_by, lock_expires_at: lock.lock_expires_at };
    }
    // Update existing lock
    await supabase.from('user_message_locks').update({
      locked_by: agentName,
      locked_at: now.toISOString(),
      lock_expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    }).eq('user_id', userId);
  } else {
    // Insert new lock
    await supabase.from('user_message_locks').insert({
      user_id: userId,
      locked_by: agentName,
      locked_at: now.toISOString(),
      lock_expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    });
  }

  return { acquired: true };
}

async function releaseMessageLock(userId, agentName, cooldownMinutes = 120) {
  const now = new Date();
  await supabase.from('user_message_locks').update({
    locked_by: null,
    locked_at: null,
    lock_expires_at: null,
    last_message_at: now.toISOString(),
    cooldown_until: new Date(now.getTime() + cooldownMinutes * 60 * 1000).toISOString(),
  }).eq('user_id', userId);
}

// =====================================================================
// Agent message bus helpers
// =====================================================================

async function postAgentMessage(fromAgent, userId, messageType, payload, toAgent = null, priority = 5) {
  await supabase.from('agent_messages').insert({
    from_agent: fromAgent,
    to_agent: toAgent,
    user_id: userId,
    message_type: messageType,
    payload,
    priority,
  });
}

async function getPendingMessages(userId, forAgent = null) {
  let query = supabase.from('agent_messages')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(20);

  if (forAgent) {
    query = query.or(`to_agent.eq.${forAgent},to_agent.is.null`);
  }

  const { data } = await query;
  return data || [];
}

// =====================================================================
// Tool implementations
// =====================================================================

async function executeFetchRecovery(userId, input) {
  const days = Math.min(input.days || 7, 14);
  const tz = await getUserTimezone(userId);
  const sinceDate = dateStringInTZ(tz, new Date(Date.now() - days * 86400000));

  // Recovery data comes from WHOOP — but we don't have direct WHOOP API access here.
  // The daily-brief already fetches and we can query what's been stored.
  // For now, use the WHOOP API directly via stored token.
  const { data: tokenRow } = await supabase
    .from('whoop_tokens')
    .select('access_token')
    .eq('user_id', userId)
    .single();

  if (!tokenRow) return { error: 'No WHOOP connected', data: [] };

  let accessToken;
  try {
    const { decrypt } = await import('./encrypt.js');
    accessToken = decrypt(tokenRow.access_token);
  } catch (e) {
    accessToken = tokenRow.access_token;
  }

  try {
    const axios = (await import('axios')).default;
    const headers = { Authorization: 'Bearer ' + accessToken };
    const res = await axios.get('https://api.prod.whoop.com/developer/v2/recovery?limit=' + days, { headers });
    const records = res.data?.records || [];

    // Convert to clean format with user's timezone
    return {
      data: records.map(r => {
        const dateParts = r.created_at ? utcToTZParts(r.created_at, tz) : null;
        return {
          date: dateParts?.date || 'unknown',
          day_label: dateParts?.dayOfWeek || '',
          recovery_score: r.score?.recovery_score ?? null,
          hrv_ms: r.score?.hrv_rmssd_milli ? parseFloat(r.score.hrv_rmssd_milli.toFixed(1)) : null,
          resting_heart_rate: r.score?.resting_heart_rate ?? null,
          spo2: r.score?.spo2_percentage ? parseFloat(r.score.spo2_percentage.toFixed(1)) : null,
          skin_temp_celsius: r.score?.skin_temp_celsius ? parseFloat(r.score.skin_temp_celsius.toFixed(1)) : null,
        };
      }),
      count: records.length,
    };
  } catch (err) {
    // Try token refresh
    try {
      const { refreshWhoopToken } = await import('./auth.js');
      const newToken = await refreshWhoopToken(userId);
      if (newToken) {
        const axios = (await import('axios')).default;
        const headers = { Authorization: 'Bearer ' + newToken };
        const res = await axios.get('https://api.prod.whoop.com/developer/v2/recovery?limit=' + days, { headers });
        const records = res.data?.records || [];
        return {
          data: records.map(r => ({
            date: r.created_at ? utcToTZParts(r.created_at, tz)?.date : 'unknown',
            recovery_score: r.score?.recovery_score ?? null,
            hrv_ms: r.score?.hrv_rmssd_milli ? parseFloat(r.score.hrv_rmssd_milli.toFixed(1)) : null,
            resting_heart_rate: r.score?.resting_heart_rate ?? null,
          })),
          count: records.length,
        };
      }
    } catch (refreshErr) {
      // Refresh failed
    }
    return { error: 'Failed to fetch recovery: ' + (err.response?.status || err.message), data: [] };
  }
}

async function executeFetchSleep(userId, input) {
  const days = Math.min(input.days || 7, 14);
  const tz = await getUserTimezone(userId);

  const { data: tokenRow } = await supabase
    .from('whoop_tokens').select('access_token').eq('user_id', userId).single();
  if (!tokenRow) return { error: 'No WHOOP connected', data: [] };

  let accessToken;
  try { const { decrypt } = await import('./encrypt.js'); accessToken = decrypt(tokenRow.access_token); }
  catch (e) { accessToken = tokenRow.access_token; }

  try {
    const axios = (await import('axios')).default;
    const headers = { Authorization: 'Bearer ' + accessToken };
    const res = await axios.get('https://api.prod.whoop.com/developer/v2/activity/sleep?limit=' + days, { headers });
    const records = res.data?.records || [];

    return {
      data: records.map(s => {
        const startParts = utcToTZParts(s.start, tz);
        const endParts = utcToTZParts(s.end, tz);
        const stages = s.score?.stage_summary || {};
        const inBedMs = stages.total_in_bed_time_milli || 0;
        const awakeMs = stages.total_awake_time_milli || 0;
        const asleepMs = inBedMs - awakeMs;
        const deepMs = stages.total_slow_wave_sleep_time_milli || 0;
        const remMs = stages.total_rem_sleep_time_milli || 0;
        const need = s.score?.sleep_needed || {};
        const debtMs = need.need_from_sleep_debt_milli || 0;

        return {
          date: endParts?.date || 'unknown',
          in_bed: (startParts?.fullString || '') + ' → ' + (endParts?.fullString || ''),
          hours_asleep: Math.round((asleepMs / 3600000) * 10) / 10,
          hours_deep: Math.round((deepMs / 3600000) * 10) / 10,
          hours_rem: Math.round((remMs / 3600000) * 10) / 10,
          sleep_efficiency_pct: s.score?.sleep_efficiency_percentage ? parseFloat(s.score.sleep_efficiency_percentage.toFixed(1)) : null,
          sleep_debt_hours: Math.round((debtMs / 3600000) * 10) / 10,
          disturbances: stages.disturbance_count || 0,
          respiratory_rate: s.score?.respiratory_rate ? parseFloat(s.score.respiratory_rate.toFixed(1)) : null,
          is_nap: s.nap || false,
        };
      }),
      count: records.length,
    };
  } catch (err) {
    try {
      const { refreshWhoopToken } = await import('./auth.js');
      const newToken = await refreshWhoopToken(userId);
      if (newToken) {
        const axios = (await import('axios')).default;
        const res = await axios.get('https://api.prod.whoop.com/developer/v2/activity/sleep?limit=' + days, {
          headers: { Authorization: 'Bearer ' + newToken }
        });
        return { data: (res.data?.records || []).map(s => ({ date: utcToTZParts(s.end, tz)?.date, hours_asleep: Math.round(((s.score?.stage_summary?.total_in_bed_time_milli || 0) - (s.score?.stage_summary?.total_awake_time_milli || 0)) / 3600000 * 10) / 10 })), count: (res.data?.records || []).length };
      }
    } catch (e) {}
    return { error: 'Failed to fetch sleep: ' + (err.response?.status || err.message), data: [] };
  }
}

async function executeFetchFoodLogs(userId, input) {
  const days = Math.min(input.days || 7, 14);
  const tz = await getUserTimezone(userId);
  const sinceDate = dateStringInTZ(tz, new Date(Date.now() - days * 86400000));

  const { data: logs } = await supabase
    .from('food_logs')
    .select('description, calories, protein, carbs, fat, meal_type, logged_at, flags')
    .eq('user_id', userId)
    .gte('logged_at', sinceDate + 'T00:00:00')
    .order('logged_at', { ascending: false });

  if (!logs || logs.length === 0) return { data: [], daily_totals: [], count: 0 };

  // Group by local date and compute daily totals
  const byDate = {};
  const formatted = logs.map(f => {
    const parts = utcToTZParts(f.logged_at, tz);
    const date = parts?.date || 'unknown';
    if (!byDate[date]) byDate[date] = { calories: 0, protein: 0, carbs: 0, fat: 0, meal_count: 0 };
    byDate[date].calories += f.calories || 0;
    byDate[date].protein += f.protein || 0;
    byDate[date].carbs += f.carbs || 0;
    byDate[date].fat += f.fat || 0;
    byDate[date].meal_count++;
    return {
      date,
      time: parts?.time || '',
      meal_type: f.meal_type || 'snack',
      description: f.description,
      calories: f.calories,
      protein: f.protein,
      carbs: f.carbs,
      fat: f.fat,
      flags: f.flags || [],
    };
  });

  const daily_totals = Object.entries(byDate)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, totals]) => ({ date, ...totals }));

  return { data: formatted, daily_totals, count: formatted.length };
}

async function executeFetchSymptoms(userId, input) {
  const days = Math.min(input.days || 7, 14);
  const tz = await getUserTimezone(userId);
  const sinceDate = dateStringInTZ(tz, new Date(Date.now() - days * 86400000));

  const { data: logs } = await supabase
    .from('symptom_logs')
    .select('pain, bloating, energy, mood, logged_at')
    .eq('user_id', userId)
    .gte('logged_at', sinceDate + 'T00:00:00')
    .order('logged_at', { ascending: false });

  if (!logs || logs.length === 0) return { data: [], count: 0 };

  return {
    data: logs.map(s => ({
      date: utcToTZParts(s.logged_at, tz)?.date || 'unknown',
      pain: s.pain,
      bloating: s.bloating,
      energy: s.energy,
      mood: s.mood,
    })),
    count: logs.length,
  };
}

async function executeFetchWorkouts(userId, input) {
  const days = Math.min(input.days || 14, 14);
  const tz = await getUserTimezone(userId);

  const { data: tokenRow } = await supabase
    .from('whoop_tokens').select('access_token').eq('user_id', userId).single();
  if (!tokenRow) return { error: 'No WHOOP connected', data: [] };

  let accessToken;
  try { const { decrypt } = await import('./encrypt.js'); accessToken = decrypt(tokenRow.access_token); }
  catch (e) { accessToken = tokenRow.access_token; }

  try {
    const axios = (await import('axios')).default;
    const headers = { Authorization: 'Bearer ' + accessToken };
    const res = await axios.get('https://api.prod.whoop.com/developer/v2/activity/workout?limit=' + days, { headers });
    const records = res.data?.records || [];

    if (records.length === 0) {
      // Also compute days since last known workout
      return { data: [], count: 0, note: 'No workouts found in last ' + days + ' days' };
    }

    return {
      data: records.map(w => {
        const startParts = utcToTZParts(w.start, tz);
        const durationMs = new Date(w.end).getTime() - new Date(w.start).getTime();
        const durationMin = Math.round(durationMs / 60000);
        return {
          date: startParts?.date || 'unknown',
          time: startParts?.time || '',
          sport: w.sport_name || 'unknown',
          duration_minutes: durationMin,
          strain: w.score?.strain ? parseFloat(w.score.strain.toFixed(1)) : null,
          avg_heart_rate: w.score?.average_heart_rate || null,
          max_heart_rate: w.score?.max_heart_rate || null,
        };
      }),
      count: records.length,
    };
  } catch (err) {
    try {
      const { refreshWhoopToken } = await import('./auth.js');
      const newToken = await refreshWhoopToken(userId);
      if (newToken) {
        const axios = (await import('axios')).default;
        const res = await axios.get('https://api.prod.whoop.com/developer/v2/activity/workout?limit=' + days, {
          headers: { Authorization: 'Bearer ' + newToken }
        });
        return { data: (res.data?.records || []).map(w => ({ date: utcToTZParts(w.start, tz)?.date, sport: w.sport_name, strain: w.score?.strain })), count: (res.data?.records || []).length };
      }
    } catch (e) {}
    return { error: 'Failed to fetch workouts: ' + (err.response?.status || err.message), data: [] };
  }
}

async function executeCheckPastPatterns(userId, input) {
  let query = supabase
    .from('agent_learnings')
    .select('pattern_type, pattern_description, confidence, evidence_count, last_confirmed_at')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('confidence', { ascending: false });

  if (input.pattern_type) {
    query = query.eq('pattern_type', input.pattern_type);
  }

  const { data } = await query.limit(20);
  if (!data || data.length === 0) {
    return { patterns: [], count: 0, note: 'No known patterns yet for this user. This may be an early investigation.' };
  }

  return {
    patterns: data.map(p => ({
      type: p.pattern_type,
      description: p.pattern_description,
      confidence: p.confidence,
      times_observed: p.evidence_count,
      last_confirmed: p.last_confirmed_at,
    })),
    count: data.length,
  };
}

async function executeCheckPastInvestigations(userId, input) {
  const query = input.query || '';

  // Get recent investigation conclusions (the last step of each investigation)
  const { data: conclusions } = await supabase
    .from('agent_traces')
    .select('investigation_id, reasoning, created_at')
    .eq('user_id', userId)
    .eq('action', 'conclude')
    .order('created_at', { ascending: false })
    .limit(10);

  if (!conclusions || conclusions.length === 0) {
    return { investigations: [], count: 0, note: 'No past investigations found. This is the first investigation for this user.' };
  }

  // Simple keyword matching on conclusions
  const queryWords = query.toLowerCase().split(/\s+/);
  const relevant = conclusions.filter(c => {
    const text = (c.reasoning || '').toLowerCase();
    return queryWords.some(w => text.includes(w));
  });

  const results = (relevant.length > 0 ? relevant : conclusions.slice(0, 5)).map(c => ({
    investigation_id: c.investigation_id,
    conclusion: c.reasoning,
    date: c.created_at,
  }));

  return { investigations: results, count: results.length };
}

async function executeSendWhatsapp(userId, input, investigationId, bypassCooldown = false) {
  const message = input.message;
  if (!message || message.length === 0) return { error: 'Empty message' };
  if (message.length > 1000) return { error: 'Message too long (max 1000 characters)' };

  // Acquire communication lock (bypass cooldown for user-initiated questions)
  const lock = await acquireMessageLock(userId, 'health_investigator', 120, bypassCooldown);
  if (!lock.acquired) {
    return {
      sent: false,
      reason: lock.reason,
      note: 'Another agent recently messaged this user or holds the lock. Finding saved but not sent.',
    };
  }

  // Get user's phone number
  const { data: user } = await supabase.from('users').select('phone').eq('id', userId).single();
  if (!user?.phone) {
    await releaseMessageLock(userId, 'health_investigator', 0);
    return { sent: false, reason: 'no_phone_number' };
  }

  try {
    await twilioClient.messages.create({
      body: '🔍 Health Insight\n\n' + message + '\n\nReply \'why\' to dig deeper into this pattern.',
      from: FROM,
      to: 'whatsapp:' + user.phone,
    });

    // Release lock with cooldown
    await releaseMessageLock(userId, 'health_investigator', 120);

    // Post to agent message bus
    await postAgentMessage('health_investigator', userId, 'finding_sent', {
      channel: 'whatsapp',
      message: message,
      investigation_id: investigationId,
    });

    return { sent: true, channel: 'whatsapp' };
  } catch (err) {
    await releaseMessageLock(userId, 'health_investigator', 0);
    return { sent: false, error: 'WhatsApp send failed: ' + err.message };
  }
}

async function executeSendEmail(userId, input, investigationId) {
  const { subject, body } = input;
  if (!subject || !body) return { error: 'Subject and body required' };

  // Acquire communication lock
  const lock = await acquireMessageLock(userId, 'health_investigator');
  if (!lock.acquired) {
    return {
      sent: false,
      reason: lock.reason,
      note: 'Another agent recently messaged this user or holds the lock.',
    };
  }

  const { data: user } = await supabase.from('users').select('email').eq('id', userId).single();
  if (!user?.email) {
    await releaseMessageLock(userId, 'health_investigator', 0);
    return { sent: false, reason: 'no_email' };
  }

  try {
    const { Resend } = await import('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'VitalMind <onboarding@resend.dev>',
      to: user.email,
      subject: '🔍 ' + subject,
      html: body,
    });

    await releaseMessageLock(userId, 'health_investigator', 120);

    await postAgentMessage('health_investigator', userId, 'finding_sent', {
      channel: 'email',
      subject,
      investigation_id: investigationId,
    });

    return { sent: true, channel: 'email' };
  } catch (err) {
    await releaseMessageLock(userId, 'health_investigator', 0);
    return { sent: false, error: 'Email send failed: ' + err.message };
  }
}

// =====================================================================
// Tool executor — routes Claude's tool calls to the right function
// =====================================================================

async function executeStorePattern(userId, input, investigationId) {
  const { pattern_type, description, confidence } = input;
  if (!pattern_type || !description) return { error: 'pattern_type and description required' };
  const conf = Math.min(Math.max(confidence || 0.5, 0), 1);

  // Check if this pattern type already exists for this user
  const { data: existing } = await supabase
    .from('agent_learnings')
    .select('id, evidence_count, confidence, investigation_ids')
    .eq('user_id', userId)
    .eq('pattern_type', pattern_type)
    .eq('status', 'active')
    .single();

  if (existing) {
    const newCount = (existing.evidence_count || 1) + 1;
    const newConf = Math.min(0.95, conf * 0.4 + (existing.confidence || 0.5) * 0.6);
    const ids = existing.investigation_ids || [];
    if (investigationId) ids.push(investigationId);
    await supabase.from('agent_learnings').update({
      pattern_description: description,
      evidence_count: newCount,
      confidence: newConf,
      last_confirmed_at: new Date().toISOString(),
      investigation_ids: ids,
    }).eq('id', existing.id);

    await postAgentMessage('health_investigator', userId, 'pattern_discovered', {
      pattern_type, description, confidence: newConf, investigation_id: investigationId,
    });

    return { stored: true, action: 'updated', evidence_count: newCount, confidence: newConf };
  }

  const { data: inserted } = await supabase.from('agent_learnings').insert({
    user_id: userId,
    pattern_type,
    pattern_description: description,
    confidence: conf,
    evidence_count: 1,
    source_agent: 'health_investigator',
    investigation_ids: investigationId ? [investigationId] : [],
  }).select('id').single();

  await postAgentMessage('health_investigator', userId, 'pattern_discovered', {
    pattern_type, description, confidence: conf, investigation_id: investigationId,
  });

  return { stored: true, action: 'created', id: inserted?.id };
}

export async function executeTool(toolName, userId, input, investigationId, options = {}) {
  const bypassCooldown = options.bypassCooldown || false;
  switch (toolName) {
    case 'fetch_recovery':
      return await executeFetchRecovery(userId, input);
    case 'fetch_sleep':
      return await executeFetchSleep(userId, input);
    case 'fetch_food_logs':
      return await executeFetchFoodLogs(userId, input);
    case 'fetch_symptoms':
      return await executeFetchSymptoms(userId, input);
    case 'fetch_workouts':
      return await executeFetchWorkouts(userId, input);
    case 'check_past_patterns':
      return await executeCheckPastPatterns(userId, input);
    case 'check_past_investigations':
      return await executeCheckPastInvestigations(userId, input);
    case 'send_whatsapp':
      return await executeSendWhatsapp(userId, input, investigationId, bypassCooldown);
    case 'send_email':
      return await executeSendEmail(userId, input, investigationId);
    case 'store_pattern':
      return await executeStorePattern(userId, input, investigationId);
    default:
      return { error: 'Unknown tool: ' + toolName };
  }
}

// Export helpers for use by other modules
export { postAgentMessage, getPendingMessages };
