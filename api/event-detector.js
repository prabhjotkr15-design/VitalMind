// api/event-detector.js
// Anomaly detection for the Health Investigator agent.
//
// Called after WHOOP data is fetched (e.g., during daily-brief processing).
// Checks for anomalies that warrant investigation:
//   - Recovery dropped >20% vs 7-day average
//   - HRV dropped >15% vs 7-day average
//   - RHR increased >10% vs 7-day average
//   - 3+ consecutive days of declining recovery
//   - Sleep debt >2 hours accumulated
//
// Each anomaly is scored for severity and deduplicated (no double investigations).
// High-priority anomalies trigger the Health Investigator immediately.

import { createClient } from '@supabase/supabase-js';
import { investigate } from './health-investigator.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// =====================================================================
// Anomaly detection thresholds
// =====================================================================

const THRESHOLDS = {
  recovery_drop_pct: 20,        // recovery dropped >20% from 7-day avg
  hrv_drop_pct: 15,             // HRV dropped >15% from 7-day avg
  rhr_increase_pct: 10,         // RHR increased >10% from 7-day avg
  consecutive_decline_days: 3,  // 3+ days of declining recovery
  sleep_debt_hours: 2,          // accumulated sleep debt >2 hours
};

// =====================================================================
// Core detection function
// =====================================================================

export async function detectAnomalies(userId, whoopData) {
  if (!whoopData || !whoopData.recovery || whoopData.recovery.length === 0) {
    return { anomalies: [], investigated: false };
  }

  const recovery = whoopData.recovery || [];
  const sleep = whoopData.sleep || [];
  const anomalies = [];

  // --- Check 1: Recovery drop vs 7-day average ---
  if (recovery.length >= 2) {
    const latest = recovery[0]?.score?.recovery_score;
    const others = recovery.slice(1).map(r => r.score?.recovery_score).filter(s => s != null);

    if (latest != null && others.length > 0) {
      const avg = others.reduce((a, b) => a + b, 0) / others.length;
      const dropPct = ((avg - latest) / avg) * 100;

      if (dropPct >= THRESHOLDS.recovery_drop_pct) {
        const severity = dropPct >= 40 ? 'high' : dropPct >= 30 ? 'medium' : 'low';
        anomalies.push({
          event_type: 'recovery_drop',
          severity,
          event_data: {
            current_recovery: latest,
            seven_day_avg: Math.round(avg * 10) / 10,
            drop_pct: Math.round(dropPct * 10) / 10,
            description: `Recovery ${latest}% is ${Math.round(dropPct)}% below 7-day average of ${Math.round(avg)}%`,
          },
        });
      }
    }
  }

  // --- Check 2: HRV drop vs 7-day average ---
  if (recovery.length >= 2) {
    const latestHRV = recovery[0]?.score?.hrv_rmssd_milli;
    const otherHRVs = recovery.slice(1).map(r => r.score?.hrv_rmssd_milli).filter(v => v != null);

    if (latestHRV != null && otherHRVs.length > 0) {
      const avg = otherHRVs.reduce((a, b) => a + b, 0) / otherHRVs.length;
      const dropPct = ((avg - latestHRV) / avg) * 100;

      if (dropPct >= THRESHOLDS.hrv_drop_pct) {
        const severity = dropPct >= 30 ? 'high' : dropPct >= 20 ? 'medium' : 'low';
        anomalies.push({
          event_type: 'hrv_anomaly',
          severity,
          event_data: {
            current_hrv: Math.round(latestHRV * 10) / 10,
            seven_day_avg: Math.round(avg * 10) / 10,
            drop_pct: Math.round(dropPct * 10) / 10,
            description: `HRV ${latestHRV.toFixed(1)} ms is ${Math.round(dropPct)}% below 7-day average of ${avg.toFixed(1)} ms`,
          },
        });
      }
    }
  }

  // --- Check 3: RHR increase vs 7-day average ---
  if (recovery.length >= 2) {
    const latestRHR = recovery[0]?.score?.resting_heart_rate;
    const otherRHRs = recovery.slice(1).map(r => r.score?.resting_heart_rate).filter(v => v != null);

    if (latestRHR != null && otherRHRs.length > 0) {
      const avg = otherRHRs.reduce((a, b) => a + b, 0) / otherRHRs.length;
      const increasePct = ((latestRHR - avg) / avg) * 100;

      if (increasePct >= THRESHOLDS.rhr_increase_pct) {
        const severity = increasePct >= 20 ? 'high' : increasePct >= 15 ? 'medium' : 'low';
        anomalies.push({
          event_type: 'rhr_increase',
          severity,
          event_data: {
            current_rhr: latestRHR,
            seven_day_avg: Math.round(avg * 10) / 10,
            increase_pct: Math.round(increasePct * 10) / 10,
            description: `RHR ${latestRHR} bpm is ${Math.round(increasePct)}% above 7-day average of ${Math.round(avg)} bpm`,
          },
        });
      }
    }
  }

  // --- Check 4: Consecutive declining recovery ---
  if (recovery.length >= THRESHOLDS.consecutive_decline_days + 1) {
    let consecutiveDeclines = 0;
    for (let i = 0; i < recovery.length - 1; i++) {
      const current = recovery[i]?.score?.recovery_score;
      const previous = recovery[i + 1]?.score?.recovery_score;
      if (current != null && previous != null && current < previous) {
        consecutiveDeclines++;
      } else {
        break;
      }
    }

    if (consecutiveDeclines >= THRESHOLDS.consecutive_decline_days) {
      const scores = recovery.slice(0, consecutiveDeclines + 1).map(r => r.score?.recovery_score);
      anomalies.push({
        event_type: 'consecutive_decline',
        severity: consecutiveDeclines >= 5 ? 'high' : consecutiveDeclines >= 4 ? 'medium' : 'low',
        event_data: {
          consecutive_days: consecutiveDeclines,
          scores: scores,
          description: `Recovery has declined ${consecutiveDeclines} consecutive days: ${scores.join(' → ')}%`,
        },
      });
    }
  }

  // --- Check 5: Sleep debt accumulation ---
  if (sleep.length > 0) {
    const latestDebtMs = sleep[0]?.score?.sleep_needed?.need_from_sleep_debt_milli || 0;
    const debtHours = latestDebtMs / 3600000;

    if (debtHours >= THRESHOLDS.sleep_debt_hours) {
      anomalies.push({
        event_type: 'sleep_debt',
        severity: debtHours >= 4 ? 'high' : debtHours >= 3 ? 'medium' : 'low',
        event_data: {
          sleep_debt_hours: Math.round(debtHours * 10) / 10,
          description: `Sleep debt has accumulated to ${debtHours.toFixed(1)} hours`,
        },
      });
    }
  }

  // =====================================================================
  // Process anomalies: deduplicate, store, and trigger investigations
  // =====================================================================

  if (anomalies.length === 0) {
    return { anomalies: [], investigated: false };
  }

  // Pick the highest-severity anomaly to investigate
  // (don't run multiple investigations at once for the same user)
  const severityOrder = { high: 1, medium: 2, low: 3 };
  anomalies.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  const primary = anomalies[0];

  // Deduplication: check if user already has a queued or running investigation
  const { data: existingQueue } = await supabase
    .from('investigation_queue')
    .select('id, status')
    .eq('user_id', userId)
    .in('status', ['queued', 'running'])
    .limit(1);

  if (existingQueue && existingQueue.length > 0) {
    console.log(`[EVENT-DETECTOR] User ${userId} already has a ${existingQueue[0].status} investigation. Skipping.`);
    // Still store the events for record-keeping
    for (const a of anomalies) {
      await supabase.from('agent_events').insert({
        user_id: userId,
        event_type: a.event_type,
        event_data: a.event_data,
        severity: a.severity,
      });
    }
    return { anomalies, investigated: false, reason: 'existing_investigation' };
  }

  // Also check for recent investigations (within last 6 hours) to avoid spam
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { data: recentInvestigations } = await supabase
    .from('agent_events')
    .select('id')
    .eq('user_id', userId)
    .gte('created_at', sixHoursAgo)
    .not('investigation_id', 'is', null)
    .limit(1);

  if (recentInvestigations && recentInvestigations.length > 0) {
    console.log(`[EVENT-DETECTOR] User ${userId} had an investigation within 6 hours. Skipping.`);
    for (const a of anomalies) {
      await supabase.from('agent_events').insert({
        user_id: userId,
        event_type: a.event_type,
        event_data: a.event_data,
        severity: a.severity,
      });
    }
    return { anomalies, investigated: false, reason: 'recent_investigation' };
  }

  // Store all anomaly events
  const eventIds = [];
  for (const a of anomalies) {
    const { data: inserted } = await supabase.from('agent_events').insert({
      user_id: userId,
      event_type: a.event_type,
      event_data: a.event_data,
      severity: a.severity,
    }).select('id').single();
    if (inserted) eventIds.push(inserted.id);
  }

  // Insert into investigation queue
  const primaryEventId = eventIds[0];
  await supabase.from('investigation_queue').insert({
    user_id: userId,
    event_id: primaryEventId,
    priority: severityOrder[primary.severity],
    status: 'queued',
  });

  console.log(`[EVENT-DETECTOR] Detected ${anomalies.length} anomalies for user ${userId}. Primary: ${primary.event_type} (${primary.severity}). Starting investigation.`);

  // Combine all anomalies into the event data for the investigator
  const combinedEventData = {
    primary_anomaly: primary.event_data,
    all_anomalies: anomalies.map(a => ({
      type: a.event_type,
      severity: a.severity,
      ...a.event_data,
    })),
  };

  // Trigger the investigation
  let result;
  try {
    result = await investigate({
      userId,
      eventId: primaryEventId,
      eventType: primary.event_type,
      eventData: combinedEventData,
      severity: primary.severity,
    });
  } catch (err) {
    console.error(`[EVENT-DETECTOR] Investigation failed:`, err.message);
    result = { status: 'error', error: err.message };
  }

  return {
    anomalies,
    investigated: true,
    primary_event: primary,
    investigation_result: result,
  };
}


// =====================================================================
// Symptom anomaly detection (called after symptom check-in reply)
// =====================================================================

export async function detectSymptomAnomalies(userId, symptomData) {
  const { pain, bloating, energy, mood } = symptomData;
  const anomalies = [];

  // High pain
  if (pain >= 7) {
    anomalies.push({
      event_type: 'pain_spike',
      severity: pain >= 9 ? 'high' : pain >= 8 ? 'medium' : 'low',
      event_data: {
        pain_score: pain,
        bloating_score: bloating,
        energy_score: energy,
        mood_score: mood,
        description: 'Pain reported at ' + pain + '/10',
      },
    });
  }

  // High bloating
  if (bloating >= 7) {
    anomalies.push({
      event_type: 'bloating_spike',
      severity: bloating >= 9 ? 'high' : bloating >= 8 ? 'medium' : 'low',
      event_data: {
        pain_score: pain,
        bloating_score: bloating,
        energy_score: energy,
        mood_score: mood,
        description: 'Bloating reported at ' + bloating + '/10',
      },
    });
  }

  // Very low energy
  if (energy <= 3) {
    anomalies.push({
      event_type: 'low_energy',
      severity: energy <= 1 ? 'high' : energy <= 2 ? 'medium' : 'low',
      event_data: {
        pain_score: pain,
        bloating_score: bloating,
        energy_score: energy,
        mood_score: mood,
        description: 'Energy reported at ' + energy + '/10',
      },
    });
  }

  // Very low mood
  if (mood <= 3) {
    anomalies.push({
      event_type: 'low_mood',
      severity: mood <= 1 ? 'high' : mood <= 2 ? 'medium' : 'low',
      event_data: {
        pain_score: pain,
        bloating_score: bloating,
        energy_score: energy,
        mood_score: mood,
        description: 'Mood reported at ' + mood + '/10',
      },
    });
  }

  // Combined distress — multiple bad signals at once
  const badSignals = [pain >= 7, bloating >= 7, energy <= 3, mood <= 3].filter(Boolean).length;
  if (badSignals >= 2 && anomalies.length > 0) {
    // Upgrade the primary anomaly severity
    anomalies[0].severity = 'high';
    anomalies[0].event_data.combined_distress = true;
    anomalies[0].event_data.bad_signal_count = badSignals;
    anomalies[0].event_data.description += ' (combined with ' + (badSignals - 1) + ' other distress signal' + (badSignals > 2 ? 's' : '') + ')';
  }

  if (anomalies.length === 0) {
    return { anomalies: [], investigated: false };
  }

  // Deduplication — same as WHOOP anomalies
  const { data: existingQueue } = await supabase
    .from('investigation_queue')
    .select('id, status')
    .eq('user_id', userId)
    .in('status', ['queued', 'running'])
    .limit(1);

  if (existingQueue && existingQueue.length > 0) {
    for (const a of anomalies) {
      await supabase.from('agent_events').insert({
        user_id: userId, event_type: a.event_type, event_data: a.event_data, severity: a.severity,
      });
    }
    return { anomalies, investigated: false, reason: 'existing_investigation' };
  }

  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { data: recentInv } = await supabase
    .from('agent_events')
    .select('id')
    .eq('user_id', userId)
    .gte('created_at', sixHoursAgo)
    .not('investigation_id', 'is', null)
    .limit(1);

  if (recentInv && recentInv.length > 0) {
    for (const a of anomalies) {
      await supabase.from('agent_events').insert({
        user_id: userId, event_type: a.event_type, event_data: a.event_data, severity: a.severity,
      });
    }
    return { anomalies, investigated: false, reason: 'recent_investigation' };
  }

  // Store events and queue investigation
  const severityOrder = { high: 1, medium: 2, low: 3 };
  anomalies.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  const primary = anomalies[0];

  const eventIds = [];
  for (const a of anomalies) {
    const { data: inserted } = await supabase.from('agent_events').insert({
      user_id: userId, event_type: a.event_type, event_data: a.event_data, severity: a.severity,
    }).select('id').single();
    if (inserted) eventIds.push(inserted.id);
  }

  const primaryEventId = eventIds[0];
  await supabase.from('investigation_queue').insert({
    user_id: userId, event_id: primaryEventId,
    priority: severityOrder[primary.severity], status: 'queued',
  });

  const combinedEventData = {
    primary_anomaly: primary.event_data,
    all_anomalies: anomalies.map(a => ({ type: a.event_type, severity: a.severity, ...a.event_data })),
  };

  let result;
  try {
    result = await investigate({
      userId, eventId: primaryEventId, eventType: primary.event_type,
      eventData: combinedEventData, severity: primary.severity,
    });
  } catch (err) {
    result = { status: 'error', error: err.message };
  }

  return { anomalies, investigated: true, primary_event: primary, investigation_result: result };
}
