// ─── BATCH SINGLE ENDPOINT ────────────────────────────────────────────────────
// Paste în server.js înainte de app.listen()
// Procesează un singur email din batch — apelat de mai multe ori din batch.html
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/batch-single', async (req, res) => {
  if (!req.session || !req.session.userEmail) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const { subject, body } = req.body;

  if (!subject || !body) {
    return res.status(400).json({ error: 'subject and body required' });
  }

  try {
    const prompt = `You are the Strategic Flow diagnostic and rebuild engine.

Subject: ${subject}
Body: ${(body || '').slice(0, 1000)}

Return ONLY valid JSON:
{
  "score": <1-10>,
  "rebuiltScore": <7-10>,
  "currentOpenRate": <decimal e.g. 0.18>,
  "projectedOpenRate": <decimal e.g. 0.29>,
  "bugs": [
    {"name":"<bug name>","description":"<one sentence specific to this email>"}
  ],
  "abSubjects": [
    {"subject":"<best rebuilt subject>","openRate":"<e.g. 31%>"}
  ]
}`;

    const result = await claudeJSON(prompt, 800);
    if (!result) throw new Error('Claude returned null');

    res.json({ result });

  } catch (err) {
    console.error('[api/batch-single]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── END BATCH SINGLE ENDPOINT ───────────────────────────────────────────────
