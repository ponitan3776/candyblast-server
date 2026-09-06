const router = require('express').Router();
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// ===================== メッセージ取得 =====================
router.get('/chat/messages', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, user_id, message, timestamp FROM chat_messages ORDER BY timestamp DESC LIMIT 50'
    );
    res.json(result.rows.reverse());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'メッセージ取得エラー' });
  }
});

// ===================== メッセージ送信 =====================
router.post('/chat/send', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    const { message } = req.body;
    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: 'メッセージを入力してください' });
    }
    if (message.length > 200) {
      return res.status(400).json({ error: 'メッセージは200文字以内にしてください' });
    }
    const result = await pool.query(
      'INSERT INTO chat_messages (user_id, message) VALUES ($1, $2) RETURNING id, user_id, message, timestamp',
      [id, message.trim()]
    );
    // 古いメッセージを削除（最新50件だけ残す）
    await pool.query(`
      DELETE FROM chat_messages WHERE id NOT IN (
        SELECT id FROM chat_messages ORDER BY timestamp DESC LIMIT 50
      )
    `);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(401).json({ error: '認証エラー' });
  }
});

module.exports = router;
