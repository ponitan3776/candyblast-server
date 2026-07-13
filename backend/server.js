const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// ===== Discord Webhook（環境変数 or 直書き） =====
const DISCORD_WEBHOOK_AUTH = process.env.DISCORD_WEBHOOK_AUTH || 'https://discord.com/api/webhooks/1525717594068484269/7X2VC7lNmTBClwuvIW2dUVCBXvQ0MvLvEOysc6CfJ5alH053dPRSyk1QLdHdbUQIT9XZ';
const DISCORD_WEBHOOK_LOGIN = process.env.DISCORD_WEBHOOK_LOGIN || 'https://discord.com/api/webhooks/1525717768887074931/xoPqn15l2ZzJ5TZLXjI74gyrnZDRjjAXnBJLlRfcdyb2-zOy2Y0BIOv1TFtyV777ZyN8';

// ===== Discord通知関数 =====
async function sendDiscordNotification(webhookUrl, title, description, color = 0x5865F2, fields = []) {
  if (!webhookUrl) return;
  try {
    const payload = {
      embeds: [{
        title,
        description,
        color,
        timestamp: new Date().toISOString(),
        fields,
        footer: { text: 'CandyBlast Auth System' }
      }]
    };
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('Discord通知失敗:', err.message);
  }
}

// ===== テーブル作成（初回のみ） =====
pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    recovery_code TEXT,
    recovery_code_used BOOLEAN DEFAULT FALSE,
    best_score INTEGER DEFAULT 0,
    coins INTEGER DEFAULT 0,
    skins TEXT DEFAULT '["default"]',
    equipped_skin TEXT DEFAULT 'default',
    quests TEXT DEFAULT '[]',
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
  );
`);

// ===== 復元コード生成 =====
function generateRecoveryCode() {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    parts.push(Math.random().toString(36).slice(2, 6).toUpperCase());
  }
  return parts.join('-');
}

// ===== ユーザー登録 =====
app.post('/api/register', async (req, res) => {
  const { id, password } = req.body;
  if (!id || !password || password.length < 6) {
    return res.status(400).json({ error: 'IDとパスワード(6文字以上)が必要です' });
  }
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(id)) {
    return res.status(400).json({ error: 'IDは半角英数字とアンダースコアで3〜20文字です' });
  }
  try {
    const existing = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'このIDは既に使われています' });
    }
    const hash = await bcrypt.hash(password, 10);
    const recoveryCode = generateRecoveryCode();
    await pool.query(
      'INSERT INTO users (id, password_hash, recovery_code, recovery_code_used) VALUES ($1, $2, $3, $4)',
      [id, hash, recoveryCode, false]
    );
    const token = jwt.sign({ id }, JWT_SECRET, { expiresIn: '7d' });

    await sendDiscordNotification(
      DISCORD_WEBHOOK_AUTH,
      '📝 新規ユーザー登録',
      `ユーザー **${id}** が新規登録しました！`,
      0x00FF00,
      [
        { name: '🔑 復元コード', value: `\`${recoveryCode}\``, inline: false },
        { name: '📅 登録日時', value: new Date().toLocaleString('ja-JP'), inline: true }
      ]
    );
    res.json({ token, id, recoveryCode });
  } catch (err) {
    console.error(err);
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
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [id]);
    const token = jwt.sign({ id }, JWT_SECRET, { expiresIn: '7d' });

    await sendDiscordNotification(
      DISCORD_WEBHOOK_LOGIN,
      '🔐 ログイン検出',
      `ユーザー **${id}** がログインしました。`,
      0x5865F2,
      [
        { name: '🕐 ログイン日時', value: new Date().toLocaleString('ja-JP'), inline: true },
        { name: '🏆 現在のベストスコア', value: `${user.best_score || 0}点`, inline: true }
      ]
    );
    res.json({ token, id, bestScore: user.best_score, coins: user.coins, lastLogin: user.last_login });
  } catch (err) {
    console.error(err);
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

// ===== パスワード復元 =====
app.post('/api/recover', async (req, res) => {
  const { id, recoveryCode, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: '新しいパスワードは6文字以上が必要です' });
  }
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE id = $1 AND recovery_code = $2 AND recovery_code_used = false',
      [id, recoveryCode]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: '無効な復元コードです（既に使われたか期限切れです）' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    const newRecoveryCode = generateRecoveryCode();
    await pool.query(
      'UPDATE users SET password_hash = $1, recovery_code = $2, recovery_code_used = false WHERE id = $3',
      [hash, newRecoveryCode, id]
    );
    await sendDiscordNotification(
      DISCORD_WEBHOOK_AUTH,
      '🔄 パスワード再設定',
      `ユーザー **${id}** のパスワードが再設定されました。`,
      0xFFA500,
      [
        { name: '🆕 新しい復元コード', value: `\`${newRecoveryCode}\``, inline: false },
        { name: '⚠️ 注意', value: 'このコードは使い捨てです。次回再設定時に再発行されます。', inline: false }
      ]
    );
    res.json({ success: true, message: 'パスワードを再設定しました。', newRecoveryCode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ===== 復元コード再発行 =====
app.post('/api/renew-recovery', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'IDが必要です' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'ユーザーが見つかりません' });
    }
    const newRecoveryCode = generateRecoveryCode();
    await pool.query(
      'UPDATE users SET recovery_code = $1, recovery_code_used = false WHERE id = $2',
      [newRecoveryCode, id]
    );
    await sendDiscordNotification(
      DISCORD_WEBHOOK_AUTH,
      '🔑 復元コード再発行',
      `ユーザー **${id}** の復元コードが再発行されました。`,
      0x9B59B6,
      [{ name: '🆕 新しい復元コード', value: `\`${newRecoveryCode}\``, inline: false }]
    );
    res.json({ success: true, recoveryCode: newRecoveryCode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ===== ⭐ ランキング取得（TOP10 + 総ユーザー数） =====
app.get('/api/ranking', async (req, res) => {
  try {
    const topResult = await pool.query(
      'SELECT id, best_score FROM users WHERE best_score > 0 ORDER BY best_score DESC LIMIT 10'
    );
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM users WHERE best_score > 0'
    );
    res.json({
      top: topResult.rows,
      totalUsers: parseInt(countResult.rows[0].count)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ランキング取得エラー' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
