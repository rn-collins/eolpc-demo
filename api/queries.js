module.exports = function retired(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(410).json({ error: 'This prototype has been retired.' });
};
