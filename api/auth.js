import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { encrypt, decrypt } from './encrypt.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const JWT_SECRET = process.env.JWT_SECRET;

export async function signup(email, password) {
  const password_hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase
    .from('users')
    .insert({ email, password_hash })
    .select()
    .single();
  if (error) throw new Error(error.message);
  const token = jwt.sign({ userId: data.id, email }, JWT_SECRET, { expiresIn: '30d' });
  return { token, userId: data.id };
}

export async function login(email, password) {
  const { data, error } = await supabase
    .from('users')
    .select()
    .eq('email', email)
    .single();
  if (error || !data) throw new Error('User not found');
  const valid = await bcrypt.compare(password, data.password_hash);
  if (!valid) throw new Error('Invalid password');
  const token = jwt.sign({ userId: data.id, email }, JWT_SECRET, { expiresIn: '30d' });
  return { token, userId: data.id };
}

export async function saveWhoopTokens(userId, accessToken, refreshToken) {
  const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
  const encryptedAccess = encrypt(accessToken);
  const encryptedRefresh = refreshToken ? encrypt(refreshToken) : null;
  const { error } = await supabase
    .from('whoop_tokens')
    .upsert({
      user_id: userId,
      access_token: encryptedAccess,
      refresh_token: encryptedRefresh,
      expires_at: expiresAt,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
}

export async function getWhoopTokens(userId) {
  const { data, error } = await supabase
    .from('whoop_tokens')
    .select()
    .eq('user_id', userId)
    .single();
  if (error || !data) return null;
  try {
    return {
      access_token: decrypt(data.access_token),
      refresh_token: data.refresh_token ? decrypt(data.refresh_token) : null,
      expires_at: data.expires_at
    };
  } catch(e) {
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at
    };
  }
}

export async function saveProfile(userId, profile) {
  const { error } = await supabase
    .from('user_profiles')
    .upsert({
      user_id: userId,
      goal: profile.goal,
      conditions: profile.conditions,
      diet: profile.diet,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
}

export async function getProfile(userId) {
  const { data } = await supabase
    .from('user_profiles')
    .select()
    .eq('user_id', userId)
    .single();
  return data;
}


export async function refreshWhoopToken(userId) {
  const { data: tokenRow } = await supabase
    .from('whoop_tokens')
    .select()
    .eq('user_id', userId)
    .single();
  if (!tokenRow?.refresh_token) return null;

  let refreshToken;
  try { refreshToken = decrypt(tokenRow.refresh_token); }
  catch(e) { refreshToken = tokenRow.refresh_token; }

  if (!refreshToken) return null;

  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', refreshToken);
  params.append('client_id', process.env.WHOOP_CLIENT_ID);
  params.append('client_secret', process.env.WHOOP_CLIENT_SECRET);

  const response = await (await import('axios')).default.post(
    'https://api.prod.whoop.com/oauth/oauth2/token',
    params,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const { access_token, refresh_token: newRefresh } = response.data;
  await saveWhoopTokens(userId, access_token, newRefresh || refreshToken);
  return access_token;
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}
