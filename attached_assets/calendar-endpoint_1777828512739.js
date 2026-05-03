// ─── CALENDAR ENDPOINT ────────────────────────────────────────────────────────
// Paste în server.js înainte de app.listen()
// Returnează toate calendarele generate pentru userul logat
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/calendar', async (req, res) => {
  if (!req.session || !req.session.userEmail) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const email = req.session.userEmail;

  try {
    const r = await pool.query(`
      SELECT
        original_subject,
        company,
        conversion_score,
        rebuilt_subject,
        content_calendar,
        key_changes,
        created_at
      FROM newsletters
      WHERE email = $1
        AND content_calendar IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 50
    `, [email]);

    const entries = r.rows.map(row => {
      let contentCalendar = [];
      let calendarWeeks = {};
      let score = null;
      let rebuiltScore = null;

      // Parse content_calendar JSON
      try {
        const cal = typeof row.content_calendar === 'string'
          ? JSON.parse(row.content_calendar)
          : row.content_calendar;

        if (cal && cal.follow_ups) {
          contentCalendar = cal.follow_ups;
        } else if (Array.isArray(cal)) {
          contentCalendar = cal;
        }
      } catch (e) {}

      // Parse conversion_score for before/after scores
      try {
        const cs = typeof row.conversion_score === 'string'
          ? JSON.parse(row.conversion_score)
          : row.conversion_score;

        if (cs) {
          score = cs.score || cs.originalScore || cs.before || null;
          rebuiltScore = cs.rebuiltScore || cs.newScore || cs.after || null;
        }
      } catch (e) {}

      // Parse key_changes for calendar weeks
      try {
        const kc = typeof row.key_changes === 'string'
          ? JSON.parse(row.key_changes)
          : row.key_changes;

        if (kc && kc.calendarWeeks) {
          calendarWeeks = kc.calendarWeeks;
        } else if (kc && kc.week1) {
          calendarWeeks = kc;
        }
      } catch (e) {}

      return {
        originalSubject: row.original_subject,
        company: row.company,
        score,
        rebuiltScore,
        contentCalendar,
        calendarWeeks,
        createdAt: row.created_at
      };
    });

    res.json({ entries });

  } catch (err) {
    console.error('[api/calendar] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── END CALENDAR ENDPOINT ────────────────────────────────────────────────────
