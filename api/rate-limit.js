import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Different limiters for different endpoint types
export const signupLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(3, '1 h'),
  analytics: true,
  prefix: 'rl:signup',
});

export const loginLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, '1 m'),
  analytics: true,
  prefix: 'rl:login',
});

export const resetLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(3, '1 h'),
  analytics: true,
  prefix: 'rl:reset',
});

export const foodAnalysisLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, '1 h'),
  analytics: true,
  prefix: 'rl:food',
});

// Helper to get the client identifier (IP for unauthed, user ID for authed)
export function getClientId(req, userId) {
  if (userId) return 'user:' + userId;
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress || 'unknown';
  return 'ip:' + ip;
}

// Wrapper that checks the limit and returns true if allowed, false if blocked
export async function checkRateLimit(limiter, identifier) {
  try {
    const { success, limit, remaining, reset } = await limiter.limit(identifier);
    return { success, limit, remaining, reset };
  } catch (err) {
    console.error('Rate limit check failed:', err.message);
    // Fail open — if Redis is down, don't block users
    return { success: true, limit: 0, remaining: 0, reset: 0 };
  }
}
