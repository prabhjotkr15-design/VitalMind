// api/whoop-summarizer.js
// Shared module: converts raw input_data (WHOOP + food + profile) into a clean
// human-readable markdown summary. Used by both the brief writer (daily-brief.js)
// and the judges (quality-check.js) so they work from identical pre-computed facts.
//
// Key principles:
// - All times converted to local user timezone (PST for current users)
// - All durations in ms converted to "Xh Ym" format
// - Percentages pre-computed (we don't trust LLM math)
// - Explicit relative date labels (yesterday, 2 days ago) so the LLM can't confuse dates
// - Summary only, no raw data — forces the LLM to work from clean ground truth

// =====================================================================
// Time and date helpers
// =====================================================================

// Convert a UTC ISO string to a Date object in PST (-07:00 offset)
// Returns { date: 'YYYY-MM-DD', time: 'HH:MM AM/PM', dayOfWeek: 'Tuesday' }
function utcToPST(utcISOString) {
  if (!utcISOString) return null;
  const utcDate = new Date(utcISOString);
  // Apply -7 hour offset for PST
  const pstDate = new Date(utcDate.getTime() - 7 * 60 * 60 * 1000);
  const year = pstDate.getUTCFullYear();
  const month = String(pstDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(pstDate.getUTCDate()).padStart(2, '0');
  let hours = pstDate.getUTCHours();
  const minutes = String(pstDate.getUTCMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return {
    date: year + '-' + month + '-' + day,
    time: hours + ':' + minutes + ' ' + ampm,
    dayOfWeek: dayNames[pstDate.getUTCDay()],
    fullPST: year + '-' + month + '-' + day + ' ' + hours + ':' + minutes + ' ' + ampm + ' PST',
  };
}

// Convert milliseconds to "Xh Ym" format
function msToHoursMinutes(ms) {
  if (!ms || ms < 0) return '0h 0m';
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours + 'h ' + minutes + 'm';
}

// Convert milliseconds to decimal hours (1 decimal place)
function msToDecimalHours(ms) {
  if (!ms || ms < 0) return 0;
  return Math.round((ms / 3600000) * 10) / 10;
}

// Get a relative date label (yesterday, 2 days ago, etc) given a date string and a reference "today"
function relativeDateLabel(targetDateStr, todayDateStr) {
  if (targetDateStr === todayDateStr) return 'today';
  const target = new Date(targetDateStr + 'T00:00:00Z');
  const today = new Date(todayDateStr + 'T00:00:00Z');
  const diffDays = Math.round((today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 1) return 'yesterday';
  if (diffDays > 1 && diffDays <= 7) return diffDays + ' days ago';
  if (diffDays < 0) return Math.abs(diffDays) + ' days from now';
  return targetDateStr;
}

// Get today's date in PST as YYYY-MM-DD
function getTodayPSTDateString() {
  const now = new Date();
  const pst = new Date(now.getTime() - 7 * 60 * 60 * 1000);
  return pst.getUTCFullYear() + '-' +
    String(pst.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(pst.getUTCDate()).padStart(2, '0');
}

// Compute percentage change from one value to another, signed
function pctChange(from, to) {
  if (from === null || from === undefined || to === null || to === undefined) return null;
  if (from === 0) return null;
  const change = ((to - from) / from) * 100;
  return Math.round(change * 10) / 10;
}

// Format a signed percentage with explicit + or -
function formatPct(pct) {
  if (pct === null) return 'n/a';
  if (pct === 0) return '0.0%';
  return (pct > 0 ? '+' : '') + pct.toFixed(1) + '%';
}

// =====================================================================
// Recovery summarizer
// =====================================================================

function summarizeRecovery(recoveryArr, sleepArr) {
  if (!recoveryArr || recoveryArr.length === 0) {
    return '## Recovery\nNo recovery data available.\n';
  }

  // Build a sleep_id → sleep start date lookup so we can attach dates to recoveries
  const sleepIdToDate = {};
  for (const s of (sleepArr || [])) {
    if (s.id && s.start) {
      const pst = utcToPST(s.end || s.start);
      if (pst) sleepIdToDate[s.id] = pst.date;
    }
  }

  // Build records sorted most recent first (already are, but be safe)
  const records = recoveryArr.map(r => {
    const date = sleepIdToDate[r.sleep_id] || (r.created_at ? utcToPST(r.created_at)?.date : null);
    return {
      date,
      recovery: r.score?.recovery_score ?? null,
      hrv: r.score?.hrv_rmssd_milli ?? null,
      rhr: r.score?.resting_heart_rate ?? null,
      spo2: r.score?.spo2_percentage ?? null,
      skinTemp: r.score?.skin_temp_celsius ?? null,
    };
  }).filter(r => r.date);

  if (records.length === 0) return '## Recovery\nNo recovery data available.\n';

  records.sort((a, b) => b.date.localeCompare(a.date));
  const todayPST = getTodayPSTDateString();

  let out = '## Recovery (most recent first)\n';
  for (const r of records) {
    const label = relativeDateLabel(r.date, todayPST);
    out += '- ' + r.date + ' (' + label + '): Recovery ' + r.recovery + '% | HRV ' +
      (r.hrv ? r.hrv.toFixed(1) : 'n/a') + ' ms | RHR ' + r.rhr + ' bpm';
    if (r.spo2 !== null) out += ' | SpO2 ' + r.spo2.toFixed(1) + '%';
    if (r.skinTemp !== null) out += ' | Skin ' + r.skinTemp.toFixed(1) + '°C';
    out += '\n';
  }

  // Pre-computed percentage changes: most recent vs previous, and most recent vs 7-day
  if (records.length >= 2) {
    const today = records[0];
    const yest = records[1];
    out += '\n### Recovery percentage changes (most recent vs previous day)\n';
    out += '- Recovery: ' + today.recovery + '% vs ' + yest.recovery + '% = ' + formatPct(pctChange(yest.recovery, today.recovery)) + '\n';
    out += '- HRV: ' + (today.hrv?.toFixed(1) || 'n/a') + ' vs ' + (yest.hrv?.toFixed(1) || 'n/a') + ' = ' + formatPct(pctChange(yest.hrv, today.hrv)) + '\n';
    out += '- RHR: ' + today.rhr + ' vs ' + yest.rhr + ' = ' + formatPct(pctChange(yest.rhr, today.rhr)) + '\n';
  }
  if (records.length >= 7) {
    const today = records[0];
    const weekAgo = records[6];
    out += '\n### Recovery percentage changes (most recent vs 7 days prior)\n';
    out += '- Recovery: ' + today.recovery + '% vs ' + weekAgo.recovery + '% = ' + formatPct(pctChange(weekAgo.recovery, today.recovery)) + '\n';
    out += '- HRV: ' + (today.hrv?.toFixed(1) || 'n/a') + ' vs ' + (weekAgo.hrv?.toFixed(1) || 'n/a') + ' = ' + formatPct(pctChange(weekAgo.hrv, today.hrv)) + '\n';
    out += '- RHR: ' + today.rhr + ' vs ' + weekAgo.rhr + ' = ' + formatPct(pctChange(weekAgo.rhr, today.rhr)) + '\n';
  }

  return out + '\n';
}

// =====================================================================
// Sleep summarizer
// =====================================================================

function summarizeSleep(sleepArr) {
  if (!sleepArr || sleepArr.length === 0) {
    return '## Sleep\nNo sleep data available.\n';
  }

  // Sort most recent first by end time
  const sorted = [...sleepArr].sort((a, b) =>
    (b.end || '').localeCompare(a.end || '')
  );

  const todayPST = getTodayPSTDateString();
  let out = '## Sleep (most recent first)\n';

  for (const s of sorted) {
    const startPST = utcToPST(s.start);
    const endPST = utcToPST(s.end);
    if (!startPST || !endPST) continue;

    const label = relativeDateLabel(endPST.date, todayPST);
    const stages = s.score?.stage_summary || {};
    const inBedMs = stages.total_in_bed_time_milli || 0;
    const awakeMs = stages.total_awake_time_milli || 0;
    const asleepMs = inBedMs - awakeMs;
    const remMs = stages.total_rem_sleep_time_milli || 0;
    const lightMs = stages.total_light_sleep_time_milli || 0;
    const deepMs = stages.total_slow_wave_sleep_time_milli || 0;

    const need = s.score?.sleep_needed || {};
    const totalNeedMs = (need.baseline_milli || 0) +
      (need.need_from_recent_nap_milli || 0) +
      (need.need_from_sleep_debt_milli || 0) +
      (need.need_from_recent_strain_milli || 0);
    const debtMs = need.need_from_sleep_debt_milli || 0;

    out += '\n### ' + endPST.date + ' (' + label + ')' + (s.nap ? ' [NAP]' : '') + '\n';
    out += '- In bed: ' + startPST.fullPST + ' → ' + endPST.fullPST + '\n';
    out += '- Time in bed: ' + msToHoursMinutes(inBedMs) + ' (' + msToDecimalHours(inBedMs) + ' hours)\n';
    out += '- Time asleep: ' + msToHoursMinutes(asleepMs) + ' (' + msToDecimalHours(asleepMs) + ' hours)\n';
    out += '- Awake during night: ' + msToHoursMinutes(awakeMs) + '\n';
    out += '- Deep (slow wave): ' + msToHoursMinutes(deepMs) + '\n';
    out += '- REM: ' + msToHoursMinutes(remMs) + '\n';
    out += '- Light: ' + msToHoursMinutes(lightMs) + '\n';
    out += '- Disturbances: ' + (stages.disturbance_count || 0) + '\n';
    out += '- Sleep efficiency: ' + (s.score?.sleep_efficiency_percentage?.toFixed(1) || 'n/a') + '%\n';
    out += '- Sleep consistency: ' + (s.score?.sleep_consistency_percentage || 'n/a') + '%\n';
    out += '- Sleep performance: ' + (s.score?.sleep_performance_percentage || 'n/a') + '%\n';
    out += '- Sleep needed (per WHOOP): ' + msToHoursMinutes(totalNeedMs) + '\n';
    out += '- Sleep debt: ' + msToHoursMinutes(debtMs) + '\n';
    out += '- Respiratory rate: ' + (s.score?.respiratory_rate?.toFixed(1) || 'n/a') + '\n';
  }

  // Pre-computed sleep duration changes
  if (sorted.length >= 2) {
    const todayStages = sorted[0].score?.stage_summary || {};
    const yestStages = sorted[1].score?.stage_summary || {};
    const todayAsleep = (todayStages.total_in_bed_time_milli || 0) - (todayStages.total_awake_time_milli || 0);
    const yestAsleep = (yestStages.total_in_bed_time_milli || 0) - (yestStages.total_awake_time_milli || 0);
    const todayDeep = todayStages.total_slow_wave_sleep_time_milli || 0;
    const yestDeep = yestStages.total_slow_wave_sleep_time_milli || 0;
    const todayRem = todayStages.total_rem_sleep_time_milli || 0;
    const yestRem = yestStages.total_rem_sleep_time_milli || 0;

    out += '\n### Sleep percentage changes (most recent vs previous night)\n';
    out += '- Time asleep: ' + msToDecimalHours(todayAsleep) + 'h vs ' + msToDecimalHours(yestAsleep) + 'h = ' + formatPct(pctChange(yestAsleep, todayAsleep)) + '\n';
    out += '- Deep sleep: ' + msToDecimalHours(todayDeep) + 'h vs ' + msToDecimalHours(yestDeep) + 'h = ' + formatPct(pctChange(yestDeep, todayDeep)) + '\n';
    out += '- REM sleep: ' + msToDecimalHours(todayRem) + 'h vs ' + msToDecimalHours(yestRem) + 'h = ' + formatPct(pctChange(yestRem, todayRem)) + '\n';
  }

  return out + '\n';
}

// =====================================================================
// Workout summarizer
// =====================================================================

function summarizeWorkouts(workoutArr) {
  if (!workoutArr || workoutArr.length === 0) {
    return '## Workouts\nNo workouts logged in the last 7 days.\n\n';
  }

  const sorted = [...workoutArr].sort((a, b) =>
    (b.start || '').localeCompare(a.start || '')
  );

  const todayPST = getTodayPSTDateString();
  let out = '## Workouts (most recent first)\n';

  for (const w of sorted) {
    const startPST = utcToPST(w.start);
    const endPST = utcToPST(w.end);
    if (!startPST || !endPST) continue;
    const durationMs = new Date(w.end).getTime() - new Date(w.start).getTime();
    const label = relativeDateLabel(startPST.date, todayPST);

    out += '- ' + startPST.date + ' (' + label + '): ' + (w.sport_name || 'unknown') +
      ' | ' + msToHoursMinutes(durationMs) +
      ' | strain ' + (w.score?.strain?.toFixed(1) || 'n/a') +
      ' | avg HR ' + (w.score?.average_heart_rate || 'n/a') +
      ' | max HR ' + (w.score?.max_heart_rate || 'n/a') + '\n';
  }

  // Days since last workout
  if (sorted.length > 0) {
    const lastStart = utcToPST(sorted[0].start);
    if (lastStart) {
      const diffDays = Math.round(
        (new Date(todayPST + 'T00:00:00Z').getTime() - new Date(lastStart.date + 'T00:00:00Z').getTime()) / (1000 * 60 * 60 * 24)
      );
      out += '\nDays since last workout: ' + diffDays + '\n';
    }
  }

  return out + '\n';
}

// =====================================================================
// Food summarizer
// =====================================================================

function summarizeFood(foodArr) {
  if (!foodArr || foodArr.length === 0) {
    return '## Food logs\nNo food logged.\n\n';
  }

  // Group by PST date
  const byDate = {};
  for (const f of foodArr) {
    const pst = utcToPST(f.logged_at);
    if (!pst) continue;
    if (!byDate[pst.date]) byDate[pst.date] = [];
    byDate[pst.date].push({ ...f, pst });
  }

  // Sort dates most recent first
  const sortedDates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));
  const todayPST = getTodayPSTDateString();

  let out = '## Food logs (most recent day first)\n';

  for (const date of sortedDates) {
    const label = relativeDateLabel(date, todayPST);
    const items = byDate[date].sort((a, b) => (a.logged_at || '').localeCompare(b.logged_at || ''));

    let totalCal = 0, totalP = 0, totalC = 0, totalF = 0;
    for (const item of items) {
      totalCal += item.calories || 0;
      totalP += item.protein || 0;
      totalC += item.carbs || 0;
      totalF += item.fat || 0;
    }

    out += '\n### ' + date + ' (' + label + ')\n';
    for (const item of items) {
      out += '- ' + item.pst.time + ' [' + (item.meal_type || 'snack') + '] ' +
        (item.description || 'unnamed') + ': ' +
        (item.calories || 0) + ' cal, ' +
        (item.protein || 0) + 'g P, ' +
        (item.carbs || 0) + 'g C, ' +
        (item.fat || 0) + 'g F\n';
    }
    out += '- **Daily total: ' + totalCal + ' cal, ' + totalP + 'g P, ' + totalC + 'g C, ' + totalF + 'g F**\n';
  }

  return out + '\n';
}

// =====================================================================
// User profile summarizer
// =====================================================================

function summarizeProfile(profile) {
  let out = '## User context\n';
  if (!profile) return out + 'No profile data.\n\n';
  out += '- Conditions: ' + (profile.conditions || 'not specified') + '\n';
  out += '- Diet preference: ' + (profile.diet || 'not specified') + '\n';
  out += '- Goal: ' + (profile.goal || 'not specified') + '\n';
  return out + '\n';
}

// =====================================================================
// Main entry point
// =====================================================================

export function summarizeForLLM(inputData) {
  if (!inputData || typeof inputData !== 'object') {
    return '## ERROR\nNo input data provided.\n';
  }

  const profile = inputData.userProfile || {};
  const whoop = inputData.whoopData || {};
  const foodLogs = inputData.foodLogs || [];

  const todayPST = getTodayPSTDateString();

  let out = '# DATA SUMMARY (pre-computed, ground truth)\n\n';
  out += 'Generated for date: **' + todayPST + ' PST**\n';
  out += 'All times converted to PST. All durations in hours/minutes. All percentages pre-computed — DO NOT recompute, use these values directly.\n\n';
  out += '---\n\n';
  out += summarizeProfile(profile);
  out += summarizeRecovery(whoop.recovery, whoop.sleep);
  out += summarizeSleep(whoop.sleep);
  out += summarizeWorkouts(whoop.workout);
  out += summarizeFood(foodLogs);
  out += '---\n';
  out += '**END OF DATA SUMMARY**\n';

  return out;
}
