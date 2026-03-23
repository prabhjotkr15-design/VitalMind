import crypto from 'crypto';

const ALGO = 'aes-256-gcm';

function getKey() {
  if (!process.env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY not set');
  return Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
}

export function encrypt(text) {
  const key = getKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + tag + ':' + encrypted;
}

export function decrypt(data) {
  const key = getKey();
  const parts = data.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
