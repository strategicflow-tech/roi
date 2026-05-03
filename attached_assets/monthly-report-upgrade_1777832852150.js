// ─── MONTHLY REPORT UPGRADE ───────────────────────────────────────────────────
// DOUĂ MODIFICĂRI în server.js:
//
// MODIFICAREA 1 — Paste endpoint nou înainte de app.listen()
// MODIFICAREA 2 — Înlocuiește runMonthlyAudit() cu versiunea extinsă
// ─────────────────────────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════════
// MODIFICAREA 1 — ENDPOINT NOU — paste înainte de app.listen()
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/monthly-report', async (req, res) => {
  if (!req.session || !req.session.userEmail) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const email = req.session.userEmail;

  try {
    // Ultimele 60 de zile de rebuilds
    const r = await pool.query(`
      SELECT
        original_subject,
        rebuilt_subject,
        company,
        conversion_score,
        ab_subjects,
        content_calendar,
        created_at
      FROM newsletters
      WHERE email = $1
        AND created_at >= NOW() - INTERVAL '60 days'
      ORDER BY created_at DESC
      LIMIT 100
    `, [email]);

    const rows = r.rows;

    if (rows.length === 0) {
      return res.json({ hasData: false });
    }

    // Calculează scoruri
    const scores = rows.map(row => {
      try {
        const cs = typeof row.conversion_score === 'string'
          ? JSON.parse(row.conversion_score)
          : row.conversion_score;
        return {
          before: cs?.score || cs?.originalScore || cs?.before || null,
          after: cs?.rebuiltScore || cs?.newScore || cs?.after || null,
          subject: row.original_subject,
          rebuiltSubject: row.rebuilt_subject,
          date: row.created_at,
          company: row.company
        };
      } catch (e) {
        return { before: null, after: null, subject: row.original_subject, date: row.created_at };
      }
    }).filter(s => s.before !== null);

    // Luna curentă vs luna anterioară
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const thisMonth = scores.filter(s => new Date(s.date) >= thisMonthStart);
    const lastMonth = scores.filter(s => new Date(s.date) >= lastMonthStart && new Date(s.date) < thisMonthStart);

    const avg = arr => arr.length > 0 ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : null;

    const thisAvgBefore = avg(thisMonth.map(s => s.before));
    const thisAvgAfter = avg(thisMonth.map(s => s.after).filter(Boolean));
    const lastAvgBefore = avg(lastMonth.map(s => s.before));
    const lastAvgAfter = avg(lastMonth.map(s => s.after).filter(Boolean));

    // Worst performer questo mese
    const worstThisMonth = thisMonth.sort((a, b) => (a.before || 10) - (b.before || 10))[0] || null;
    const bestThisMonth = thisMonth.sort((a, b) => ((b.after || 0) - (b.before || 0)) - ((a.after || 0) - (a.before || 0)))[0] || null;

    res.json({
      hasData: true,
      thisMonth: {
        count: thisMonth.length,
        avgScoreBefore: thisAvgBefore,
        avgScoreAfter: thisAvgAfter,
        scores: thisMonth.slice(0, 10)
      },
      lastMonth: {
        count: lastMonth.length,
        avgScoreBefore: lastAvgBefore,
        avgScoreAfter: lastAvgAfter
      },
      trend: {
        direction: thisAvgBefore && lastAvgBefore
          ? parseFloat(thisAvgAfter) > parseFloat(lastAvgAfter) ? 'up' : 'down'
          : 'neutral',
        delta: thisAvgAfter && lastAvgAfter
          ? (parseFloat(thisAvgAfter) - parseFloat(lastAvgAfter)).toFixed(1)
          : null
      },
      worstThisMonth,
      bestThisMonth,
      totalRebuilds: rows.length
    });

  } catch (err) {
    console.error('[api/monthly-report]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// MODIFICAREA 2 — înlocuiești funcția runMonthlyAudit() existentă
// Găsești: async function runMonthlyAudit() {
// Înlocuiești întreaga funcție cu aceasta:
// ══════════════════════════════════════════════════════════════════════════════

async function runMonthlyAudit() {
  console.log('[scheduler] Running monthly audit...');

  try {
    // Guard — nu trimite de două ori în aceeași lună
    const thisMonth = new Date().toISOString().slice(0, 7);
    const last = await pool.query(
      "SELECT value FROM system_config WHERE key = 'last_monthly_audit'",
    );
    if (last.rows[0]?.value === thisMonth) {
      console.log('[scheduler] Monthly audit already sent this month, skipping.');
      return;
    }

    // Ia toți userii activi cu tier architecture sau high_impact
    const users = await pool.query(`
      SELECT email FROM users
      WHERE tier IN ('architecture', 'high_impact')
        AND last_used_at >= NOW() - INTERVAL '60 days'
    `);

    console.log(`[scheduler] Sending monthly report to ${users.rows.length} users`);

    for (const user of users.rows) {
      try {
        await sendMonthlyReportEmail(user.email);
      } catch (e) {
        console.error(`[scheduler] Failed for ${user.email}:`, e.message);
      }
    }

    // Marchează ca trimis
    await pool.query(`
      INSERT INTO system_config (key, value) VALUES ('last_monthly_audit', $1)
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
    `, [thisMonth]);

    console.log('[scheduler] Monthly audit complete.');

  } catch (err) {
    console.error('[scheduler] Monthly audit failed:', err.message);
  }
}

async function sendMonthlyReportEmail(email) {
  // Ia datele din ultimele 30 de zile
  const r = await pool.query(`
    SELECT original_subject, rebuilt_subject, conversion_score, created_at
    FROM newsletters
    WHERE email = $1
      AND created_at >= NOW() - INTERVAL '30 days'
    ORDER BY created_at DESC
    LIMIT 20
  `, [email]);

  const rows = r.rows;
  if (rows.length === 0) return; // Skip useri fără activitate

  // Calculează scoruri
  const scored = rows.map(row => {
    try {
      const cs = typeof row.conversion_score === 'string'
        ? JSON.parse(row.conversion_score) : row.conversion_score;
      return {
        subject: row.original_subject,
        before: cs?.score || cs?.originalScore || null,
        after: cs?.rebuiltScore || cs?.newScore || null,
        date: new Date(row.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      };
    } catch (e) { return null; }
  }).filter(Boolean);

  const avgBefore = scored.length > 0
    ? (scored.reduce((a, b) => a + (b.before || 0), 0) / scored.length).toFixed(1)
    : '—';
  const avgAfter = scored.length > 0
    ? (scored.reduce((a, b) => a + (b.after || 0), 0) / scored.length).toFixed(1)
    : '—';

  const emailRows = scored.slice(0, 5).map(s => `
    <tr>
      <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.06);font-size:13px;color:#f4f2ed;">${s.subject || '—'}</td>
      <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.06);font-family:monospace;font-size:12px;color:#ff4d2e;text-align:center;">${s.before || '—'}/10</td>
      <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.06);font-family:monospace;font-size:12px;color:#4A8FE7;text-align:center;">${s.after || '—'}/10</td>
      <td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.06);font-family:monospace;font-size:11px;color:#a8a39b;text-align:right;">${s.date}</td>
    </tr>
  `).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0a08;color:#f4f2ed;padding:48px 40px;border:1px solid rgba(255,255,255,0.1);">
      <p style="font-size:11px;letter-spacing:0.1em;color:#a8a39b;text-transform:uppercase;margin:0 0 40px;">Strategic Flow Architecture — Monthly Report</p>

      <h2 style="font-size:28px;margin:0 0 8px;font-weight:600;">Your email performance<br>this month.</h2>
      <p style="font-size:14px;color:#a8a39b;margin:0 0 40px;">${new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</p>

      <!-- Score summary -->
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid rgba(255,255,255,0.1);margin-bottom:32px;">
        <tr>
          <td style="padding:24px;border-right:1px solid rgba(255,255,255,0.1);text-align:center;">
            <div style="font-size:11px;letter-spacing:0.1em;color:#a8a39b;text-transform:uppercase;margin-bottom:8px;">Emails rebuilt</div>
            <div style="font-size:40px;font-weight:700;color:#4A8FE7;">${scored.length}</div>
          </td>
          <td style="padding:24px;border-right:1px solid rgba(255,255,255,0.1);text-align:center;">
            <div style="font-size:11px;letter-spacing:0.1em;color:#a8a39b;text-transform:uppercase;margin-bottom:8px;">Avg score before</div>
            <div style="font-size:40px;font-weight:700;color:#ff4d2e;">${avgBefore}</div>
          </td>
          <td style="padding:24px;text-align:center;">
            <div style="font-size:11px;letter-spacing:0.1em;color:#a8a39b;text-transform:uppercase;margin-bottom:8px;">Avg score after</div>
            <div style="font-size:40px;font-weight:700;color:#4A8FE7;">${avgAfter}</div>
          </td>
        </tr>
      </table>

      <!-- Email list -->
      ${emailRows ? `
        <p style="font-size:11px;letter-spacing:0.1em;color:#a8a39b;text-transform:uppercase;margin:0 0 12px;">This month's rebuilds</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid rgba(255,255,255,0.1);margin-bottom:32px;">
          <tr style="background:rgba(255,255,255,0.04);">
            <th style="padding:10px 16px;text-align:left;font-size:10px;letter-spacing:0.08em;color:#a8a39b;text-transform:uppercase;font-weight:400;">Subject</th>
            <th style="padding:10px 16px;text-align:center;font-size:10px;letter-spacing:0.08em;color:#a8a39b;text-transform:uppercase;font-weight:400;">Before</th>
            <th style="padding:10px 16px;text-align:center;font-size:10px;letter-spacing:0.08em;color:#a8a39b;text-transform:uppercase;font-weight:400;">After</th>
            <th style="padding:10px 16px;text-align:right;font-size:10px;letter-spacing:0.08em;color:#a8a39b;text-transform:uppercase;font-weight:400;">Date</th>
          </tr>
          ${emailRows}
        </table>
      ` : ''}

      <a href="https://strategic-flow-audit.replit.app/report.html" style="display:inline-block;background:#4A8FE7;color:#ffffff;padding:14px 28px;text-decoration:none;font-size:14px;font-weight:600;margin-bottom:32px;">
        View Full Report →
      </a>

      <p style="font-size:12px;color:#6b6760;margin:0;line-height:1.6;">
        Strategic Flow Architecture · strategicflow@proton.me
      </p>
    </div>
  `;

  await resend.emails.send({
    from: SENDER,
    to: email,
    subject: `Your Strategic Flow report — ${new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`,
    html
  });

  console.log(`[scheduler] Monthly report sent to ${email}`);
}

// ─── END MONTHLY REPORT UPGRADE ──────────────────────────────────────────────
