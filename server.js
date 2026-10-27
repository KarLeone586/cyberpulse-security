import express from 'express';
import crypto from 'node:crypto';
import pg from 'pg';
import twilio from 'twilio';

const { Pool } = pg;
const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sms = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : null;
app.use(express.json());

function isPhone(value) { return /^\+?[1-9]\d{7,14}$/.test(value); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function makeCode() { return String(crypto.randomInt(100000, 1000000)); }

app.post('/api/auth/request-code', async (req, res) => {
  const contact = String(req.body.contact || '').trim().toLowerCase();
  if (!contact || (!isPhone(contact) && !contact.includes('@'))) return res.status(400).json({ error: 'Введите корректный email или телефон' });
  const type = isPhone(contact) ? 'phone' : 'email';
  const user = await pool.query(`INSERT INTO users(contact, contact_type) VALUES($1,$2) ON CONFLICT(contact) DO UPDATE SET contact=EXCLUDED.contact RETURNING id`, [contact, type]);
  const code = makeCode();
  await pool.query(`INSERT INTO login_codes(user_id, code_hash, expires_at) VALUES($1,$2,now()+interval '10 minutes')`, [user.rows[0].id, hash(code)]);
  if (type === 'phone' && sms) await sms.messages.create({ body: `CyberPulse: ваш код входа ${code}. Никому его не сообщайте.`, from: process.env.TWILIO_FROM, to: contact });
  if (process.env.NODE_ENV !== 'production') console.log(`[demo] login code for ${contact}: ${code}`);
  res.json({ ok: true, delivery: type === 'phone' && sms ? 'sms' : 'demo' });
});

app.post('/api/auth/verify-code', async (req, res) => {
  const contact = String(req.body.contact || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const result = await pool.query(`SELECT lc.id, lc.user_id FROM login_codes lc JOIN users u ON u.id=lc.user_id WHERE u.contact=$1 AND lc.code_hash=$2 AND lc.consumed_at IS NULL AND lc.expires_at>now() ORDER BY lc.created_at DESC LIMIT 1`, [contact, hash(code)]);
  if (!result.rowCount) return res.status(401).json({ error: 'Код неверный или истёк' });
  await pool.query('UPDATE login_codes SET consumed_at=now() WHERE id=$1', [result.rows[0].id]);
  await pool.query('UPDATE users SET verified_at=now() WHERE id=$1', [result.rows[0].user_id]);
  res.json({ ok: true, userId: result.rows[0].user_id });
});

app.post('/api/orders', async (req, res) => {
  const { userId = null, service, plan = null, description = '' } = req.body;
  if (!service) return res.status(400).json({ error: 'Укажите услугу' });
  const number = `CP-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
  const result = await pool.query('INSERT INTO orders(public_number,user_id,service,plan,description) VALUES($1,$2,$3,$4,$5) RETURNING public_number,status,created_at', [number, userId, service, plan, description.slice(0, 2000)]);
  res.status(201).json(result.rows[0]);
});

app.listen(process.env.PORT || 3000, () => console.log('CyberPulse API ready'));
