// server.js
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// PostgreSQL接続（Renderの環境変数から自動取得）
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// テーブル作成（初回のみ）
pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    recovery_code TEXT,
    best_score INTEGER DEFAULT 0,
    coins INTEGER DEFAULT 0,
    skins TEXT DEFAULT '["default"]',
    equipped_skin TEXT DEFAULT 'default',
    quests TEXT DEFAULT '[]',
    created_at TIMESTAMP DEFAULT NOW()
  );
`);

// ===== ユーザー登録 =====
app.post('/api/register', async (req, res) => {
  const { id, password } = req.body;
  if (!id || !password || password.length < 6) {
    return res.status(400).json({ error: 'IDとパスワード(6文字以上)が必要です' });
  }
  try {
    const existing = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'このIDは既に使われています' });
    }
    const hash = await bcrypt.hash(password, 10);
    const recoveryCode = Math.random().toString(36).slice(2, 10).toUpperCase() + '-' +
                         Math.random().toString(36).slice(2, 10).toUpperCase();
    await pool.query(
      'INSERT INTO users (id, password_hash, recovery_code) VALUES ($1, $2, $3)',
      [id, hash, recoveryCode]
    );
    const token = jwt.sign({ id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, id, recoveryCode });
  } catch (err) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ===== ログイン =====
app.post('/api/login', async (req, res) => {
  const { id, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'IDまたはパスワードが間違っています' });
    }
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'IDまたはパスワードが間違っています' });
    }
    const token = jwt.sign({ id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, id, bestScore: user.best_score, coins: user.coins });
  } catch (err) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ===== データ同期（保存） =====
app.post('/api/sync', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    const { bestScore, coins, skins, equippedSkin, quests } = req.body;
    await pool.query(
      `UPDATE users SET 
        best_score = $1, coins = $2, skins = $3, equipped_skin = $4, quests = $5
       WHERE id = $6`,
      [bestScore || 0, coins || 0, JSON.stringify(skins), equippedSkin || 'default', JSON.stringify(quests || []), id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(401).json({ error: '認証エラー' });
  }
});

// ===== データ取得 =====
app.get('/api/sync', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    const user = result.rows[0];
    res.json({
      bestScore: user.best_score,
      coins: user.coins,
      skins: JSON.parse(user.skins || '["default"]'),
      equippedSkin: user.equipped_skin || 'default',
      quests: JSON.parse(user.quests || '[]')
    });
  } catch (err) {
    res.status(401).json({ error: '認証エラー' });
  }
});

// ===== 復元 =====
app.post('/api/recover', async (req, res) => {
  const { id, recoveryCode, newPassword } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1 AND recovery_code = $2', [id, recoveryCode]);
    if (result.rows.length === 0) {
      return res.status(400).json({ error: '復元コードが間違っています' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
