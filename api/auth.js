import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
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
  const { error } = await supabase
    .from('whoop_tokens')
    .upsert({
      user_id: userId,
      access_token: accessToken,
      refresh_token: refreshToken,
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
  return data;
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

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}
