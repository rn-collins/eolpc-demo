module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { visitorId, referrer } = req.body || {};
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  const ua = req.headers['user-agent'] || '';
  const ts = new Date().toISOString();

  const visit = { ts, visitorId, referrer, ip: ip.slice(0, 20), ua: ua.slice(0, 80) };

  await logVisit(visit);
  await notifySlack(`👁️ *EOLPC demo opened*\n${ts}\nIP: ${ip.slice(0, 20)}`);

  return res.status(200).json({ ok: true });
};

async function logVisit(entry) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    const val = encodeURIComponent(JSON.stringify(entry));
    await fetch(`${url}/lpush/eolpc:visits/${val}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (_) {}
}

async function notifySlack(text) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
  } catch (_) {}
}
