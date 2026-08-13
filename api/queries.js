const crypto = require('crypto');

function authorized(header, secret) {
  if (!header || !header.startsWith('Bearer ')) return false;
  const supplied = header.slice(7);
  const expected = Buffer.from(secret);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.QUERY_LOG_TOKEN;
  if (!secret) {
    console.error('Query log access denied: QUERY_LOG_TOKEN is not configured');
    return res.status(503).json({ error: 'Service unavailable' });
  }

  if (!authorized(req.headers.authorization, secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    console.error('Query log access denied: storage is not configured');
    return res.status(503).json({ error: 'Service unavailable' });
  }

  try {
    const [qResp, vResp] = await Promise.all([
      fetch(`${url}/lrange/eolpc:queries/0/49`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${url}/lrange/eolpc:visits/0/49`, { headers: { Authorization: `Bearer ${token}` } })
    ]);

    if (!qResp.ok || !vResp.ok) {
      console.error('Query log storage request failed', {
        queriesStatus: qResp.status,
        visitsStatus: vResp.status
      });
      return res.status(502).json({ error: 'Unable to retrieve records' });
    }

    const [qData, vData] = await Promise.all([qResp.json(), vResp.json()]);

    const parse = arr => (arr?.result || []).map(s => {
      try { return JSON.parse(decodeURIComponent(s)); } catch { return s; }
    });

    return res.status(200).json({
      queries: parse(qData),
      visits: parse(vData),
      retrieved: new Date().toISOString()
    });
  } catch {
    console.error('Query log retrieval failed');
    return res.status(500).json({ error: 'Unable to retrieve records' });
  }
};
