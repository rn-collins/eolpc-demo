module.exports = async function handler(req, res) {
  // Simple token gate - set QUERY_LOG_TOKEN in Vercel env vars
  const secret = process.env.QUERY_LOG_TOKEN;
  if (secret && req.query.token !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return res.status(200).json({
      message: 'Upstash not configured. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to Vercel env vars.',
      queries: [],
      visits: []
    });
  }

  try {
    const [qResp, vResp] = await Promise.all([
      fetch(`${url}/lrange/eolpc:queries/0/49`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${url}/lrange/eolpc:visits/0/49`, { headers: { Authorization: `Bearer ${token}` } })
    ]);

    const [qData, vData] = await Promise.all([qResp.json(), vResp.json()]);

    const parse = arr => (arr?.result || []).map(s => {
      try { return JSON.parse(decodeURIComponent(s)); } catch { return s; }
    });

    return res.status(200).json({
      queries: parse(qData),
      visits: parse(vData),
      retrieved: new Date().toISOString()
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
