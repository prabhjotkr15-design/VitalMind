// api/timezone-utils.js
// Shared timezone helper for VitalMind.
// All functions use IANA timezone names (e.g., "America/Los_Angeles", "Asia/Kolkata").
// JavaScript's Intl.DateTimeFormat handles DST automatically — no hardcoded offsets.
//
// Replaces all the scattered "-7 * 60 * 60 * 1000" PST math across the codebase.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ---------- Cache for user timezone lookups (5 minute TTL) ----------
const tzCache = new Map(); // userId -> { tz, expiresAt }
const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TZ = 'America/Los_Angeles';

/**
 * Fetches the user's timezone from user_profiles.
 * Returns IANA timezone name. Falls back to America/Los_Angeles.
 * Cached for 5 minutes per user.
 */
export async function getUserTimezone(userId) {
  if (!userId) return DEFAULT_TZ;
  const cached = tzCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.tz;
  }
  try {
    const { data } = await supabase
      .from('user_profiles')
      .select('timezone')
      .eq('user_id', userId)
      .single();
    const tz = (data && data.timezone) ? data.timezone : DEFAULT_TZ;
    tzCache.set(userId, { tz, expiresAt: Date.now() + CACHE_TTL_MS });
    return tz;
  } catch (err) {
    console.error('getUserTimezone failed for', userId, err.message);
    return DEFAULT_TZ;
  }
}

/**
 * Clear the cache for a user (call when their timezone preference changes)
 */
export function clearTimezoneCache(userId) {
  if (userId) tzCache.delete(userId);
  else tzCache.clear();
}

// ---------- Pure timezone conversion helpers (no DB) ----------

/**
 * Get the current hour (0-23) in a given timezone.
 */
export function hourInTZ(timezone, dateInput) {
  const d = dateInput ? new Date(dateInput) : new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
  });
  // Intl returns "24" for midnight in some locales — normalize
  const parts = fmt.formatToParts(d);
  const hourPart = parts.find(p => p.type === 'hour');
  let h = parseInt(hourPart?.value || '0', 10);
  if (h === 24) h = 0;
  return h;
}

/**
 * Get the date string YYYY-MM-DD in a given timezone.
 */
export function dateStringInTZ(timezone, dateInput) {
  const d = dateInput ? new Date(dateInput) : new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d); // en-CA gives YYYY-MM-DD natively
}

/**
 * Format a UTC timestamp as a human-readable string in user's local timezone.
 * Example: "2026-04-15 7:00 PM PDT"
 */
export function utcToTZString(utcISOString, timezone) {
  if (!utcISOString) return null;
  const d = new Date(utcISOString);
  const dateStr = dateStringInTZ(timezone, d);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
  const timeStr = fmt.format(d);
  return dateStr + ' ' + timeStr;
}

/**
 * Get a structured breakdown of a UTC timestamp in user's timezone.
 * Returns { date, time, hour24, dayOfWeek, fullString }
 */
export function utcToTZParts(utcISOString, timezone) {
  if (!utcISOString) return null;
  const d = new Date(utcISOString);
  const date = dateStringInTZ(timezone, d);
  const hour24 = hourInTZ(timezone, d);
  const minFmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, minute: '2-digit' });
  const minute = minFmt.format(d).padStart(2, '0');
  const tFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const time = tFmt.format(d);
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' });
  const dayOfWeek = dayFmt.format(d);
  const tzNameFmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'short' });
  const tzPart = tzNameFmt.formatToParts(d).find(p => p.type === 'timeZoneName');
  const tzShort = tzPart ? tzPart.value : timezone;
  return {
    date,
    time,
    hour24,
    minute: parseInt(minute, 10),
    dayOfWeek,
    tzShort,
    fullString: date + ' ' + time + ' ' + tzShort,
  };
}

/**
 * Returns the UTC ISO string for "midnight today" in the given timezone.
 * Useful for "today" range queries: WHERE logged_at >= startOfTodayUTC(tz)
 */
export function startOfTodayUTC(timezone) {
  const today = dateStringInTZ(timezone, new Date());
  return localMidnightToUTC(today, timezone);
}

/**
 * Given a date string (YYYY-MM-DD) and a timezone, returns the UTC ISO string
 * representing midnight on that date in that timezone.
 */
export function localMidnightToUTC(dateStr, timezone) {
  // Use a known UTC time, find the offset, apply it.
  // Trick: ask "what time is it in the target TZ when UTC is midnight on this date?"
  // Then compute the difference.
  const probeUTC = new Date(dateStr + 'T12:00:00Z'); // midday UTC of the date
  const tzString = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(probeUTC);
  // tzString looks like "04/15/2026, 05:00:00"
  const [datePart, timePart] = tzString.split(', ');
  const [mm, dd, yyyy] = datePart.split('/');
  const [hh, mi, ss] = timePart.split(':');
  // Local time at probeUTC (in target tz)
  const localAtProbe = new Date(Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mi, +ss));
  // Offset = probeUTC - localAtProbe (in ms)
  const offsetMs = probeUTC.getTime() - localAtProbe.getTime();
  // Now: midnight local = midnight UTC on dateStr + offset
  const midnightUTCnaive = new Date(dateStr + 'T00:00:00Z');
  const midnightLocalAsUTC = new Date(midnightUTCnaive.getTime() + offsetMs);
  return midnightLocalAsUTC.toISOString();
}

/**
 * Given a time string in HH:MM (24h) format, a timezone, and a reference Date (for "today"),
 * returns the UTC ISO string. If the resulting time is in the future relative to current
 * UTC, assumes user meant yesterday.
 *
 * Used by food analyzer: user said "I ate at 7 PM" → interpret in their TZ → store UTC
 */
export function parseUserStatedTimeToUTC(timeStr, timezone, referenceUTC) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const m = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;

  const refUTC = referenceUTC ? new Date(referenceUTC) : new Date();
  const todayLocal = dateStringInTZ(timezone, refUTC);

  // Compute UTC for "today at h:mi local"
  const todayMidnightUTC = new Date(localMidnightToUTC(todayLocal, timezone));
  const candidateUTC = new Date(todayMidnightUTC.getTime() + (h * 60 + mi) * 60 * 1000);

  // If the candidate time is in the future, the user must have meant yesterday
  if (candidateUTC.getTime() > refUTC.getTime()) {
    return new Date(candidateUTC.getTime() - 24 * 60 * 60 * 1000).toISOString();
  }
  return candidateUTC.toISOString();
}

/**
 * Returns the offset (in minutes) between UTC and the given timezone at a given time.
 * Positive means timezone is ahead of UTC. e.g., IST = +330, PST = -480 (without DST), PDT = -420.
 */
export function tzOffsetMinutes(timezone, dateInput) {
  const d = dateInput ? new Date(dateInput) : new Date();
  const tzString = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d);
  const [datePart, timePart] = tzString.split(', ');
  const [mm, dd, yyyy] = datePart.split('/');
  const [hh, mi, ss] = timePart.split(':');
  const localAsUTC = Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mi, +ss);
  return Math.round((localAsUTC - d.getTime()) / 60000);
}
