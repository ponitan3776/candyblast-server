const router = require('express').Router();
const pool = require('../db/pool');

// ===================== ランキング取得 =====================
router.get('/ranking', async (req, res) => {
  const mode = req.query.mode || 'soft';
  const type = req.query.type || 'score';
  try {
    let query, countQuery;
    if (type === 'coins') {
      query = `SELECT id, coins as value FROM users WHERE coins > 0 ORDER BY coins DESC LIMIT 10`;
      countQuery = `SELECT COUNT(*) FROM users WHERE coins > 0`;
    } else if (type === 'playtime') {
      query = `SELECT id, play_time as value FROM users WHERE play_time > 0 ORDER BY play_time DESC LIMIT 10`;
      countQuery = `SELECT COUNT(*) FROM users WHERE play_time > 0`;
    } else {
      query = `
        SELECT id, best_scores->>'${mode}' as value
        FROM users
        WHERE best_scores->>'${mode}' IS NOT NULL AND best_scores->>'${mode}' != '0'
        ORDER BY (best_scores->>'${mode}')::int DESC
        LIMIT 10
      `;
      countQuery = `
        SELECT COUNT(*) FROM users WHERE best_scores->>'${mode}' IS NOT NULL AND best_scores->>'${mode}' != '0'
      `;
    }
    const topResult = await pool.query(query);
    const countResult = await pool.query(countQuery);
    const top = topResult.rows.map(r => ({
      id: r.id,
      value: parseInt(r.value)
    }));
    res.json({
      top,
      totalUsers: parseInt(countResult.rows[0].count)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ランキング取得エラー' });
  }
});

module.exports = router;
