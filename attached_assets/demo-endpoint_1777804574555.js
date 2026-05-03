// ─── DEMO ENDPOINT ────────────────────────────────────────────────────────────
// Paste în server.js înainte de app.listen()
// One-time free assessment — email gate, bypass pentru BYPASS_EMAILS
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/demo', async (req, res) => {
  const { email, subject, body, company, subscribers } = req.body;

  if (!email || !subject || !body) {
    return res.status(400).json({ error: 'email, subject and body required' });
  }

  const emailLower = email.toLowerCase().trim();

  // Bypass pentru admin
  const bypass = isAdmin(emailLower);

  if (!bypass) {
    // Verifică dacă emailul a mai folosit demo-ul
    try {
      const r = await pool.query(
        'SELECT audit_count FROM audit_usage WHERE email = $1',
        [emailLower]
      );
      if (r.rows.length > 0 && r.rows[0].audit_count >= 1) {
        return res.json({ alreadyUsed: true });
      }
    } catch (e) {
      console.error('[api/demo] check usage error:', e.message);
    }
  }

  // Înregistrează folosirea (înainte să ruleze — previne double-submit)
  if (!bypass) {
    try {
      await pool.query(`
        INSERT INTO audit_usage (email, audit_count, first_audit_at, last_audit_at)
        VALUES ($1, 1, NOW(), NOW())
        ON CONFLICT (email) DO UPDATE SET
          audit_count = audit_usage.audit_count + 1,
          last_audit_at = NOW()
      `, [emailLower]);
    } catch (e) {
      console.error('[api/demo] record usage error:', e.message);
    }
  }

  // Creează job async — același pattern ca /api/architecture
  const jobId = makeJobId();
  jobs.set(jobId, { status: 'pending', created: Date.now() });
  res.json({ jobId });

  // Rulează assessment async
  (async () => {
    try {
      // DIAGNOSTIC — toate 7 bug-urile
      const diagnosticPrompt = `You are the Strategic Flow diagnostic engine. Analyse this SaaS email for structural failures.

Company: ${company || 'Unknown'}
Subject: ${subject}
Body:
${body.slice(0, 3000)}

Run the complete 7-bug diagnostic. Check ALL 7 structural bugs:
1. Filing label subject — subject announces the product, not the reader's problem
2. Caveat opener — email opens with disclaimer/rollout notice before value
3. Feature-first language — describes architecture not reader outcome
4. Flat visual hierarchy — major and minor updates at same visual weight
5. Zero quantified claims — no numbers, benchmarks, or time-saved data
6. Weak or missing CTA — no ownership language ("Learn more" vs "Fix my X")
7. Buried contrast — before/after comparison hidden in fine print or absent

Score 1-10:
1-3 = 5+ bugs present
4-6 = 3-4 bugs present
7-8 = 1-2 bugs present
9-10 = consequence-first throughout

Return ONLY valid JSON:
{
  "score": <number 1-10>,
  "bugs": [
    { "name": "<bug name>", "description": "<specific problem in THIS email, one sentence>" }
  ],
  "currentOpenRate": <estimated open rate as decimal e.g. 0.18>
}`;

      const diagnostic = await claudeJSON(diagnosticPrompt, 1500);
      if (!diagnostic) throw new Error('Diagnostic failed');

      // REBUILD — subject + hook + CTA
      const rebuildPrompt = `You are the Strategic Flow rebuild engine.

Company: ${company || 'Unknown'}
Original subject: ${subject}
Original body:
${body.slice(0, 2000)}

Diagnostic score: ${diagnostic.score}/10
Bugs: ${(diagnostic.bugs || []).map(b => b.name).join(', ')}

Apply Strategic Flow fixes and return ONLY valid JSON:
{
  "rebuiltScore": <number 7-10>,
  "projectedOpenRate": <decimal e.g. 0.29>,
  "abSubjects": [
    { "subject": "<variant 1 — curiosity gap>", "openRate": "<e.g. 29%>" },
    { "subject": "<variant 2 — consequence-first>", "openRate": "<e.g. 31%>" },
    { "subject": "<variant 3 — number or name>", "openRate": "<e.g. 28%>" }
  ],
  "whatChanged": [
    { "fix": "Fix 1 — Subject line", "before": "<original subject>", "after": "<rebuilt subject>", "why": "<one sentence>" },
    { "fix": "Fix 2 — Preview text", "before": "<original or inferred>", "after": "<rebuilt>", "why": "<one sentence>" },
    { "fix": "Fix 3 — Hook", "before": "<original first line>", "after": "<rebuilt first line>", "why": "<one sentence>" },
    { "fix": "Fix 4 — CTA", "before": "<original CTA>", "after": "<rebuilt CTA with ownership language>", "why": "<one sentence>" }
  ]
}`;

      const rebuild = await claudeJSON(rebuildPrompt, 1500);
      if (!rebuild) throw new Error('Rebuild failed');

      // Notifică Alex
      try {
        await notify(
          'New demo — ' + emailLower,
          `<p>Demo run by: <strong>${emailLower}</strong></p>
           <p>Company: ${company || 'Unknown'}</p>
           <p>Subject: "${subject}"</p>
           <p>Score: ${diagnostic.score}/10 → ${rebuild.rebuiltScore}/10</p>
           <p>Subscribers: ${subscribers || 'not provided'}</p>`
        );
      } catch (e) {
        console.error('[api/demo] notify error:', e.message);
      }

      // Asamblează rezultatul
      const result = {
        score: diagnostic.score,
        rebuiltScore: rebuild.rebuiltScore || 9,
        bugs: diagnostic.bugs || [],
        currentOpenRate: diagnostic.currentOpenRate || 0.18,
        projectedOpenRate: rebuild.projectedOpenRate || 0.30,
        abSubjects: rebuild.abSubjects || [],
        whatChanged: rebuild.whatChanged || [],
        originalSubject: subject
      };

      jobs.set(jobId, { status: 'complete', result, created: Date.now() });

    } catch (err) {
      console.error('[api/demo] job failed:', err.message);
      jobs.set(jobId, { status: 'failed', error: err.message, created: Date.now() });
    }
  })();
});

// ─── END DEMO ENDPOINT ────────────────────────────────────────────────────────
