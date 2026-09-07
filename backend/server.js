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

const DISCORD_WEBHOOK_AUTH = process.env.DISCORD_WEBHOOK_AUTH || '';
const DISCORD_WEBHOOK_LOGIN = process.env.DISCORD_WEBHOOK_LOGIN || '';

async function sendDiscordNotification(webhookUrl, title, description, color = 0x5865F2, fields = []) {
  if (!webhookUrl) return;
  try {
    const payload = {
      embeds: [{
        title, description, color,
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

// ===================== テーブル作成（起動時に順番に実行） =====================
// 以前は4つの pool.query() を並列に投げていたため、
// 「users テーブルがまだ存在しないのに ALTER TABLE users が先に実行される」
// という競合が起き、Renderの起動ログにエラーが出る原因になっていました。
// ここでは await で順番に実行し、失敗時もサーバーが落ちないようにします。
async function initDb() {
  await pool.query(`
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

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS best_scores JSONB DEFAULT '{}';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_settings JSONB DEFAULT '{"disabledBlocks":[],"safetyMode":false}';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS quest_progress JSONB DEFAULT '{}';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS play_time INTEGER DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active TIMESTAMP;
  `);
  console.log('✅ users テーブル準備完了');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON chat_messages(timestamp);
  `);
  console.log('✅ チャットテーブル作成完了');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id SERIAL PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(from_id, to_id)
    );
    CREATE TABLE IF NOT EXISTS friends (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, friend_id)
    );
    CREATE TABLE IF NOT EXISTS dm_messages (
      id SERIAL PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      message TEXT NOT NULL,
      is_read BOOLEAN DEFAULT FALSE,
      timestamp TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_dm_pair ON dm_messages(from_id, to_id);
  `);
  console.log('✅ フレンド／DMテーブル作成完了');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ お知らせテーブル作成完了');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS duels (
      id SERIAL PRIMARY KEY,
      challenger_id TEXT NOT NULL,
      opponent_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      duration INTEGER DEFAULT 60,
      challenger_score INTEGER,
      opponent_score INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ 対決(デュエル)テーブル作成完了');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_events (
      id SERIAL PRIMARY KEY,
      hour_jst INTEGER NOT NULL,
      ranking_mode TEXT NOT NULL,
      rank_position INTEGER NOT NULL,
      reward_coins INTEGER NOT NULL,
      last_triggered_date TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ スケジュールイベントテーブル作成完了');
}

function generateRecoveryCode() {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    parts.push(Math.random().toString(36).slice(2, 6).toUpperCase());
  }
  return parts.join('-');
}

// ===================== ユーザー登録 =====================
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

// ===================== ログイン =====================
app.post('/api/login', async (req, res) => {
  const { id, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'IDまたはパスワードが間違っています' });
    }
    const user = result.rows[0];
    if (user.banned) {
      return res.status(403).json({ error: 'このアカウントはBANされています' });
    }
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
    res.json({
      token,
      id,
      bestScore: user.best_score,
      bestScores: user.best_scores || {},
      coins: user.coins,
      playTime: user.play_time || 0,
      lastLogin: user.last_login
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ===================== データ同期 =====================
app.post('/api/sync', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    const { bestScore, coins, skins, equippedSkin, quests, mode, size, playTime } = req.body;
    const updateFields = [];
    const values = [];
    let paramCount = 1;

    if (size === 8 && mode && bestScore !== undefined) {
      const userResult = await pool.query('SELECT best_scores FROM users WHERE id = $1', [id]);
      let bestScores = userResult.rows[0]?.best_scores || {};
      if (!bestScores[mode] || bestScore > bestScores[mode]) {
        bestScores[mode] = bestScore;
        updateFields.push(`best_scores = $${paramCount++}`);
        values.push(JSON.stringify(bestScores));
      }
      if (bestScore > 0) {
        const currentBest = userResult.rows[0]?.best_score || 0;
        if (bestScore > currentBest) {
          updateFields.push(`best_score = $${paramCount++}`);
          values.push(bestScore);
        }
      }
    }

    if (coins !== undefined) {
      updateFields.push(`coins = $${paramCount++}`);
      values.push(coins || 0);
    }
    if (skins !== undefined) {
      updateFields.push(`skins = $${paramCount++}`);
      values.push(JSON.stringify(skins));
    }
    if (equippedSkin !== undefined) {
      updateFields.push(`equipped_skin = $${paramCount++}`);
      values.push(equippedSkin || 'default');
    }
    if (quests !== undefined) {
      updateFields.push(`quests = $${paramCount++}`);
      values.push(JSON.stringify(quests || []));
    }
    if (playTime !== undefined) {
      updateFields.push(`play_time = $${paramCount++}`);
      values.push(playTime || 0);
    }

    if (updateFields.length === 0) {
      return res.json({ success: true });
    }
    values.push(id);
    const query = `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${paramCount}`;
    await pool.query(query, values);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(401).json({ error: '認証エラー' });
  }
});

// ===================== データ取得 =====================
app.get('/api/sync', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    // このポーリング(5秒おき)自体をオンライン状態のハートビートとして使う
    pool.query('UPDATE users SET last_active = NOW() WHERE id = $1', [id]).catch(()=>{});
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    const user = result.rows[0];
    res.json({
      bestScore: user.best_score,
      bestScores: user.best_scores || {},
      coins: user.coins,
      playTime: user.play_time || 0,
      skins: JSON.parse(user.skins || '["default"]'),
      equippedSkin: user.equipped_skin || 'default',
      quests: JSON.parse(user.quests || '[]')
    });
  } catch (err) {
    res.status(401).json({ error: '認証エラー' });
  }
});

// ===================== サーバーお知らせ(管理者コマンドから配信) =====================
app.get('/api/announcements/latest', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, message, created_at FROM announcements ORDER BY id DESC LIMIT 1');
    if (result.rows.length === 0) return res.json({ announcement: null });
    res.json({ announcement: result.rows[0] });
  } catch (err) {
    res.json({ announcement: null });
  }
});

// ===================== パスワード復元 =====================
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

// ===================== 復元コード再発行 =====================
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

// ===================== ランキング取得 =====================
app.get('/api/ranking', async (req, res) => {
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

// ===================== 🆕 スケジュールイベント(自動報酬) =====================
function getJSTNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
}
function jstDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// イベント一覧(次回発生時刻を計算して返す。ログイン不要で誰でも見られる)
app.get('/api/events/list', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM scheduled_events ORDER BY hour_jst');
    const jstNow = getJSTNow();
    const events = result.rows.map(e => {
      // 次にこのイベントが発生するJST日時を計算
      const next = new Date(jstNow);
      next.setHours(e.hour_jst, 0, 0, 0);
      if (next <= jstNow) next.setDate(next.getDate() + 1);
      const msUntilJST = next.getTime() - jstNow.getTime();
      return {
        id: e.id,
        hourJst: e.hour_jst,
        rankingMode: e.ranking_mode,
        rankPosition: e.rank_position,
        rewardCoins: e.reward_coins,
        secondsUntilNext: Math.round(msUntilJST / 1000)
      };
    });
    res.json({ events });
  } catch (err) {
    res.json({ events: [] });
  }
});

// 毎分チェックし、該当時刻(JST)になったイベントの報酬を自動配布する
async function runEventScheduler() {
  try {
    const jstNow = getJSTNow();
    const hour = jstNow.getHours();
    const dateKey = jstDateKey(jstNow);
    const events = await pool.query('SELECT * FROM scheduled_events WHERE hour_jst = $1', [hour]);
    for (const ev of events.rows) {
      if (ev.last_triggered_date === dateKey) continue; // 本日は配布済み
      const mode = ev.ranking_mode;
      const rankResult = await pool.query(
        `SELECT id FROM users
         WHERE best_scores->>'${mode}' IS NOT NULL AND best_scores->>'${mode}' != '0'
         ORDER BY (best_scores->>'${mode}')::int DESC
         LIMIT 1 OFFSET $1`,
        [ev.rank_position - 1]
      );
      const target = rankResult.rows[0];
      if (target) {
        await pool.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [ev.reward_coins, target.id]);
        console.log(`🎁 イベント報酬配布: ${target.id} に ${ev.reward_coins}コイン（${mode}ランキング${ev.rank_position}位）`);
      }
      await pool.query('UPDATE scheduled_events SET last_triggered_date = $1 WHERE id = $2', [dateKey, ev.id]);
    }
  } catch (err) {
    console.error('イベントスケジューラーエラー:', err.message);
  }
}
setInterval(runEventScheduler, 60 * 1000);

// ===================== クエスト管理API =====================
app.get('/api/quests/progress', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    const result = await pool.query('SELECT quest_progress FROM users WHERE id = $1', [id]);
    const progress = result.rows[0]?.quest_progress || {};
    res.json({ progress });
  } catch (err) {
    res.status(401).json({ error: '認証エラー' });
  }
});

app.post('/api/quests/update', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    const { questId, progress, claimed } = req.body;
    const result = await pool.query('SELECT quest_progress FROM users WHERE id = $1', [id]);
    let questProgress = result.rows[0]?.quest_progress || {};
    questProgress[questId] = { progress, claimed: claimed || false };
    await pool.query('UPDATE users SET quest_progress = $1 WHERE id = $2', [JSON.stringify(questProgress), id]);
    res.json({ success: true, questProgress });
  } catch (err) {
    res.status(401).json({ error: '認証エラー' });
  }
});

app.post('/api/quests/claim', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    const { questId, reward } = req.body;
    const result = await pool.query('SELECT quest_progress, coins FROM users WHERE id = $1', [id]);
    let questProgress = result.rows[0]?.quest_progress || {};
    const currentCoins = result.rows[0]?.coins || 0;
    if (questProgress[questId]?.claimed) {
      return res.status(400).json({ error: 'このクエストは既に受け取り済みです' });
    }
    const newCoins = currentCoins + reward;
    questProgress[questId] = { progress: questProgress[questId]?.progress || 0, claimed: true };
    await pool.query(
      'UPDATE users SET quest_progress = $1, coins = $2 WHERE id = $3',
      [JSON.stringify(questProgress), newCoins, id]
    );
    res.json({ success: true, coins: newCoins, questProgress });
  } catch (err) {
    res.status(401).json({ error: '認証エラー' });
  }
});

// ===================== アカウント削除 =====================
app.delete('/api/account/delete', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(401).json({ error: '認証エラー' });
  }
});

// ===================== 認証ヘルパー =====================
function requireAuth(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) { const e = new Error('認証が必要です'); e.status = 401; throw e; }
  try {
    return jwt.verify(token, JWT_SECRET).id;
  } catch (err) {
    const e = new Error('認証エラー'); e.status = 401; throw e;
  }
}

async function areFriends(a, b) {
  const r = await pool.query('SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2', [a, b]);
  return r.rows.length > 0;
}

// ===================== 🆕 フレンドAPI =====================
app.post('/api/friends/request', async (req, res) => {
  try {
    const id = requireAuth(req);
    const { toId } = req.body;
    if (!toId || toId === id) return res.status(400).json({ error: '有効なユーザーIDを指定してください' });
    const target = await pool.query('SELECT id FROM users WHERE id = $1', [toId]);
    if (target.rows.length === 0) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    if (await areFriends(id, toId)) return res.status(400).json({ error: '既にフレンドです' });
    const existing = await pool.query(
      `SELECT * FROM friend_requests WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1)`,
      [id, toId]
    );
    const pendingOpposite = existing.rows.find(r => r.status === 'pending' && r.from_id === toId && r.to_id === id);
    if (pendingOpposite) {
      // 相手からの申請が既にある場合は自動承認
      await pool.query('DELETE FROM friend_requests WHERE id = $1', [pendingOpposite.id]);
      await pool.query('INSERT INTO friends (user_id, friend_id) VALUES ($1,$2),($2,$1) ON CONFLICT DO NOTHING', [id, toId]);
      return res.json({ success: true, autoAccepted: true });
    }
    const pendingSame = existing.rows.find(r => r.status === 'pending' && r.from_id === id && r.to_id === toId);
    if (pendingSame) return res.status(400).json({ error: '既に申請済みです' });
    await pool.query(
      `INSERT INTO friend_requests (from_id, to_id, status) VALUES ($1,$2,'pending')
       ON CONFLICT (from_id, to_id) DO UPDATE SET status='pending', created_at=NOW()`,
      [id, toId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  }
});

app.post('/api/friends/respond', async (req, res) => {
  try {
    const id = requireAuth(req);
    const { fromId, action } = req.body;
    if (!fromId || !['accept', 'decline'].includes(action)) return res.status(400).json({ error: '不正なリクエストです' });
    const reqRow = await pool.query(
      `SELECT * FROM friend_requests WHERE from_id=$1 AND to_id=$2 AND status='pending'`,
      [fromId, id]
    );
    if (reqRow.rows.length === 0) return res.status(404).json({ error: '申請が見つかりません' });
    await pool.query('DELETE FROM friend_requests WHERE from_id=$1 AND to_id=$2', [fromId, id]);
    if (action === 'accept') {
      await pool.query('INSERT INTO friends (user_id, friend_id) VALUES ($1,$2),($2,$1) ON CONFLICT DO NOTHING', [id, fromId]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  }
});

app.post('/api/friends/cancel', async (req, res) => {
  try {
    const id = requireAuth(req);
    const { toId } = req.body;
    await pool.query(`DELETE FROM friend_requests WHERE from_id=$1 AND to_id=$2 AND status='pending'`, [id, toId]);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  }
});

app.delete('/api/friends/remove', async (req, res) => {
  try {
    const id = requireAuth(req);
    const { friendId } = req.body;
    await pool.query('DELETE FROM friends WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)', [id, friendId]);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  }
});

app.get('/api/friends/list', async (req, res) => {
  try {
    const id = requireAuth(req);
    const friendsResult = await pool.query(
      `SELECT u.id, u.best_score, u.coins,
        (u.last_active IS NOT NULL AND u.last_active > NOW() - INTERVAL '20 seconds') AS online
       FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = $1 ORDER BY u.id`,
      [id]
    );
    const incoming = await pool.query(
      `SELECT from_id AS id, created_at FROM friend_requests WHERE to_id=$1 AND status='pending' ORDER BY created_at DESC`,
      [id]
    );
    const outgoing = await pool.query(
      `SELECT to_id AS id, created_at FROM friend_requests WHERE from_id=$1 AND status='pending' ORDER BY created_at DESC`,
      [id]
    );
    res.json({ friends: friendsResult.rows, incoming: incoming.rows, outgoing: outgoing.rows });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  }
});

// ===================== 🆕 フレンド対決(デュエル) =====================
app.post('/api/duels/challenge', async (req, res) => {
  try {
    const id = requireAuth(req);
    const { opponentId } = req.body;
    if (!opponentId) { const e = new Error('対戦相手を指定してください'); e.status = 400; throw e; }
    if (!(await areFriends(id, opponentId))) { const e = new Error('フレンドのみ対決できます'); e.status = 403; throw e; }
    const result = await pool.query(
      `INSERT INTO duels (challenger_id, opponent_id) VALUES ($1, $2) RETURNING *`,
      [id, opponentId]
    );
    res.json({ duel: result.rows[0] });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  }
});

app.post('/api/duels/:id/respond', async (req, res) => {
  try {
    const id = requireAuth(req);
    const { accept } = req.body;
    const duelId = req.params.id;
    const duelResult = await pool.query('SELECT * FROM duels WHERE id=$1', [duelId]);
    const duel = duelResult.rows[0];
    if (!duel) { const e = new Error('対決が見つかりません'); e.status = 404; throw e; }
    if (duel.opponent_id !== id) { const e = new Error('権限がありません'); e.status = 403; throw e; }
    const newStatus = accept ? 'accepted' : 'declined';
    await pool.query('UPDATE duels SET status=$1 WHERE id=$2', [newStatus, duelId]);
    res.json({ ok: true, status: newStatus });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  }
});

app.get('/api/duels/list', async (req, res) => {
  try {
    const id = requireAuth(req);
    const result = await pool.query(
      `SELECT * FROM duels WHERE challenger_id=$1 OR opponent_id=$1 ORDER BY created_at DESC LIMIT 30`,
      [id]
    );
    res.json({ duels: result.rows });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  }
});

app.post('/api/duels/:id/submit-score', async (req, res) => {
  try {
    const id = requireAuth(req);
    const { score } = req.body;
    const duelId = req.params.id;
    const duelResult = await pool.query('SELECT * FROM duels WHERE id=$1', [duelId]);
    const duel = duelResult.rows[0];
    if (!duel) { const e = new Error('対決が見つかりません'); e.status = 404; throw e; }
    if (duel.challenger_id !== id && duel.opponent_id !== id) { const e = new Error('権限がありません'); e.status = 403; throw e; }
    if (duel.status !== 'accepted' && duel.status !== 'completed') { const e = new Error('この対決はまだ受諾されていません'); e.status = 400; throw e; }
    const column = duel.challenger_id === id ? 'challenger_score' : 'opponent_score';
    await pool.query(`UPDATE duels SET ${column} = $1 WHERE id = $2`, [score, duelId]);
    const updated = await pool.query('SELECT * FROM duels WHERE id=$1', [duelId]);
    const d = updated.rows[0];
    if (d.challenger_score !== null && d.opponent_score !== null && d.status !== 'completed') {
      await pool.query(`UPDATE duels SET status='completed' WHERE id=$1`, [duelId]);
      d.status = 'completed';
    }
    res.json({ duel: d });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  }
});

// ===================== 🆕 DM API（フレンドのみ） =====================
app.get('/api/dm/messages/:friendId', async (req, res) => {
  try {
    const id = requireAuth(req);
    const { friendId } = req.params;
    if (!(await areFriends(id, friendId))) return res.status(403).json({ error: 'フレンドのみDMできます' });
    const result = await pool.query(
      `SELECT id, from_id, to_id, message, timestamp FROM dm_messages
       WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1)
       ORDER BY timestamp DESC LIMIT 100`,
      [id, friendId]
    );
    await pool.query(`UPDATE dm_messages SET is_read = TRUE WHERE from_id=$1 AND to_id=$2 AND is_read=FALSE`, [friendId, id]);
    res.json(result.rows.reverse());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  }
});

app.post('/api/dm/send', async (req, res) => {
  try {
    const id = requireAuth(req);
    const { toId, message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'メッセージを入力してください' });
    if (message.length > 300) return res.status(400).json({ error: 'メッセージは300文字以内にしてください' });
    if (!(await areFriends(id, toId))) return res.status(403).json({ error: 'フレンドのみDMできます' });
    const result = await pool.query(
      `INSERT INTO dm_messages (from_id, to_id, message) VALUES ($1,$2,$3) RETURNING id, from_id, to_id, message, timestamp`,
      [id, toId, message.trim()]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  }
});

// 未読数・メンション数のサマリー（バッジ表示用）
app.get('/api/dm/unread-summary', async (req, res) => {
  try {
    const id = requireAuth(req);
    const result = await pool.query(
      `SELECT from_id, message FROM dm_messages WHERE to_id=$1 AND is_read=FALSE`,
      [id]
    );
    const total = result.rows.length;
    const mentionRegex = new RegExp('@' + id + '\\b', 'i');
    const mentions = result.rows.filter(r => mentionRegex.test(r.message)).length;
    const perFriend = {};
    result.rows.forEach(r => { perFriend[r.from_id] = (perFriend[r.from_id] || 0) + 1; });
    res.json({ total, mentions, perFriend });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'サーバーエラー' });
  }
});

// ===================== 管理者コマンド =====================
app.post('/api/admin/command', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    if (id !== 'admin') return res.status(403).json({ error: '管理者権限がありません' });

    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'コマンドを入力してください' });

    const parts = command.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    let result = '';

    switch (cmd) {
      case '/setcoins': {
        // 使用法: /setcoins <ユーザーID> <amount>
        if (args.length < 2) throw new Error('使用法: /setcoins <ユーザーID> <amount>');
        const targetId = args[0];
        const amount = parseInt(args[1]);
        if (isNaN(amount) || amount < 0) throw new Error('正しいコイン数を指定してください');
        const targetUser = await pool.query('SELECT id FROM users WHERE id = $1', [targetId]);
        if (targetUser.rows.length === 0) throw new Error(`ユーザー ${targetId} は見つかりません`);
        await pool.query('UPDATE users SET coins = $1 WHERE id = $2', [amount, targetId]);
        result = `✅ ${targetId} のコインを ${amount} に設定しました。`;
        break;
      }
      case '/addcoins': {
        // 使用法: /addcoins <ユーザーID> <amount> (元のコイン数に加算する)
        if (args.length < 2) throw new Error('使用法: /addcoins <ユーザーID> <amount>');
        const targetId = args[0];
        const amount = parseInt(args[1]);
        if (isNaN(amount)) throw new Error('正しいコイン数を指定してください');
        const targetUser = await pool.query('SELECT coins FROM users WHERE id = $1', [targetId]);
        if (targetUser.rows.length === 0) throw new Error(`ユーザー ${targetId} は見つかりません`);
        const newTotal = Math.max(0, (targetUser.rows[0].coins || 0) + amount);
        await pool.query('UPDATE users SET coins = $1 WHERE id = $2', [newTotal, targetId]);
        result = `✅ ${targetId} のコインに ${amount} を加算しました（合計: ${newTotal}）。`;
        break;
      }
      case '/setscore': {
        // 使用法: /setscore <ユーザーID> <mode> <score>
        if (args.length < 3) throw new Error('使用法: /setscore <ユーザーID> <mode> <score>');
        const targetId = args[0];
        const mode = args[1];
        const score = parseInt(args[2]);
        const validModes = ['soft', 'baked', 'hard', 'extreme', 'tetris', 'timeattack'];
        if (!validModes.includes(mode)) throw new Error(`モードは ${validModes.join(', ')} のいずれかです`);
        if (isNaN(score) || score < 0) throw new Error('正しいスコアを指定してください');
        const userResult = await pool.query('SELECT best_scores FROM users WHERE id = $1', [targetId]);
        if (userResult.rows.length === 0) throw new Error(`ユーザー ${targetId} は見つかりません`);
        let bestScores = userResult.rows[0]?.best_scores || {};
        bestScores[mode] = score;
        const regularModes = ['soft', 'baked', 'hard', 'extreme'];
        const regularScores = regularModes.map(m => bestScores[m]).filter(v => typeof v === 'number');
        const maxScore = regularScores.length > 0 ? Math.max(...regularScores) : 0;
        await pool.query(
          'UPDATE users SET best_scores = $1, best_score = $2 WHERE id = $3',
          [JSON.stringify(bestScores), maxScore, targetId]
        );
        result = `✅ ${targetId} の ${mode}モードのベストスコアを ${score} に設定しました。`;
        break;
      }
      case '/safety': {
        if (args.length === 0) {
          const settingResult = await pool.query('SELECT admin_settings FROM users WHERE id = $1', [id]);
          const settings = settingResult.rows[0]?.admin_settings || { safetyMode: false };
          result = `現在のセーフティモード: ${settings.safetyMode ? 'ON' : 'OFF'}`;
          break;
        }
        const mode = args[0].toLowerCase();
        if (mode !== 'on' && mode !== 'off') throw new Error('on または off を指定してください');
        const safetyMode = mode === 'on';
        const settingResult = await pool.query('SELECT admin_settings FROM users WHERE id = $1', [id]);
        let settings = settingResult.rows[0]?.admin_settings || { disabledBlocks: [], safetyMode: false };
        settings.safetyMode = safetyMode;
        await pool.query('UPDATE users SET admin_settings = $1 WHERE id = $2', [JSON.stringify(settings), id]);
        result = `✅ 強制セーフティモードを ${mode} に設定しました。`;
        break;
      }
      case '/resetquests': {
        await pool.query('UPDATE users SET quest_progress = $1', [JSON.stringify({})]);
        result = '✅ 全ユーザーのクエスト進捗をリセットしました。';
        break;
      }
      case '/setplaytime': {
        const time = parseInt(args[0]);
        if (isNaN(time) || time < 0) throw new Error('正しいプレイ時間（秒）を指定してください');
        await pool.query('UPDATE users SET play_time = $1 WHERE id = $2', [time, id]);
        result = `✅ プレイ時間を ${time}秒 に設定しました。`;
        break;
      }
      case '/ban': {
        const targetId = args[0];
        if (!targetId) throw new Error('使用法: /ban <ユーザーID>');
        await pool.query('UPDATE users SET banned = true WHERE id = $1', [targetId]);
        result = `✅ ${targetId} をBANしました。`;
        break;
      }
      case '/unban': {
        const targetId = args[0];
        if (!targetId) throw new Error('使用法: /unban <ユーザーID>');
        await pool.query('UPDATE users SET banned = false WHERE id = $1', [targetId]);
        result = `✅ ${targetId} のBANを解除しました。`;
        break;
      }
      case '/resetuser': {
        const targetId = args[0];
        if (!targetId) throw new Error('使用法: /resetuser <ユーザーID>');
        await pool.query(
          `UPDATE users SET 
            best_score = 0, best_scores = '{}', coins = 0, 
            skins = '["default"]', quest_progress = '{}', play_time = 0
          WHERE id = $1`,
          [targetId]
        );
        result = `✅ ${targetId} のデータをリセットしました。`;
        break;
      }
      case '/listusers': {
        const users = await pool.query('SELECT id, best_score, coins, play_time FROM users ORDER BY best_score DESC LIMIT 20');
        result = '📊 ユーザー一覧 (TOP20):\n' + users.rows.map(u => `${u.id}: ${u.best_score}点, ${u.coins}コイン, ${u.play_time}秒`).join('\n');
        break;
      }
      case '/search': {
        const targetId = args[0];
        if (!targetId) throw new Error('使用法: /search <ユーザーID>');
        const user = await pool.query('SELECT * FROM users WHERE id = $1', [targetId]);
        if (user.rows.length === 0) throw new Error(`ユーザー ${targetId} は見つかりません`);
        const u = user.rows[0];
        result = `🔍 ユーザー情報:\nID: ${u.id}\n🏆 ベストスコア: ${u.best_score}\n🪙 コイン: ${u.coins}\n⏱️ プレイ時間: ${u.play_time || 0}秒\n🚫 BAN: ${u.banned ? 'BAN中' : 'なし'}\n📅 作成日: ${new Date(u.created_at).toLocaleString('ja-JP')}\n📅 最終ログイン: ${u.last_login ? new Date(u.last_login).toLocaleString('ja-JP') : 'なし'}`;
        break;
      }
      case '/announce': {
        const message = args.join(' ');
        if (!message) throw new Error('使用法: /announce <メッセージ>');
        await pool.query('INSERT INTO announcements (message) VALUES ($1)', [message]);
        result = `📢 全ユーザーにお知らせを配信しました:\n「${message}」`;
        break;
      }
      case '/stats': {
        const totalUsers = await pool.query('SELECT COUNT(*) FROM users');
        const totalScore = await pool.query('SELECT SUM(best_score) FROM users');
        const totalCoins = await pool.query('SELECT SUM(coins) FROM users');
        const totalPlayTime = await pool.query('SELECT SUM(play_time) FROM users');
        result = `📊 サーバー統計:\n👤 総ユーザー数: ${totalUsers.rows[0].count}\n🏆 総スコア: ${totalScore.rows[0].sum || 0}\n🪙 総コイン: ${totalCoins.rows[0].sum || 0}\n⏱️ 総プレイ時間: ${totalPlayTime.rows[0].sum || 0}秒`;
        break;
      }
      case '/eventadd': {
        // 使用法: /eventadd <時(0-23,日本時間)> <mode> <順位> <コイン>
        if (args.length < 4) throw new Error('使用法: /eventadd <時(0-23,日本時間)> <mode> <順位> <コイン>');
        const hourJst = parseInt(args[0]);
        const evMode = args[1];
        const rankPos = parseInt(args[2]);
        const rewardCoins = parseInt(args[3]);
        const validModes2 = ['soft', 'baked', 'hard', 'extreme', 'tetris', 'timeattack'];
        if (isNaN(hourJst) || hourJst < 0 || hourJst > 23) throw new Error('時間は0〜23で指定してください（日本時間）');
        if (!validModes2.includes(evMode)) throw new Error(`モードは ${validModes2.join(', ')} のいずれかです`);
        if (isNaN(rankPos) || rankPos < 1) throw new Error('順位は1以上で指定してください');
        if (isNaN(rewardCoins)) throw new Error('コイン数を指定してください');
        const evResult = await pool.query(
          `INSERT INTO scheduled_events (hour_jst, ranking_mode, rank_position, reward_coins) VALUES ($1,$2,$3,$4) RETURNING *`,
          [hourJst, evMode, rankPos, rewardCoins]
        );
        result = `✅ イベントを追加しました（ID: ${evResult.rows[0].id}）: 毎日${hourJst}時(日本時間)に「${evMode}」ランキング${rankPos}位のユーザーへ${rewardCoins}コインを自動配布します。`;
        break;
      }
      case '/eventlist': {
        const evList = await pool.query('SELECT * FROM scheduled_events ORDER BY hour_jst');
        if (evList.rows.length === 0) { result = '登録されているイベントはありません。'; break; }
        result = '📅 登録済みイベント一覧:\n' + evList.rows.map(e =>
          `ID${e.id}: 毎日${e.hour_jst}時(JST) 「${e.ranking_mode}」${e.rank_position}位 → ${e.reward_coins}コイン`
        ).join('\n');
        break;
      }
      case '/eventremove': {
        if (args.length < 1) throw new Error('使用法: /eventremove <ID>');
        const delResult = await pool.query('DELETE FROM scheduled_events WHERE id=$1 RETURNING *', [args[0]]);
        if (delResult.rows.length === 0) throw new Error(`イベントID ${args[0]} は見つかりません`);
        result = `✅ イベントID ${args[0]} を削除しました。`;
        break;
      }
      case '/help':
      default:
        result = `📋 使用可能なコマンド:
  /setcoins <ユーザーID> <amount> - 指定ユーザーのコインを設定
  /addcoins <ユーザーID> <amount> - 指定ユーザーのコインに加算（元のコイン+amount）
  /setscore <ユーザーID> <mode> <score> - 指定ユーザーのモード別スコア設定 (soft, baked, hard, extreme, tetris, timeattack)
  /safety [on|off] - 強制セーフティモード（引数なしで状態表示）
  /announce <メッセージ> - 全ユーザーにお知らせを配信
  /eventadd <時(0-23,JST)> <mode> <順位> <コイン> - 毎日その時刻にランキング順位者へコインを自動配布するイベントを追加
  /eventlist - 登録済みイベント一覧を表示
  /eventremove <ID> - イベントを削除
  /resetquests - 全ユーザーのクエスト進捗リセット
  /setplaytime <seconds> - プレイ時間を設定
  /ban <ID> - ユーザーをBAN
  /unban <ID> - BAN解除
  /resetuser <ID> - ユーザーデータリセット
  /listusers - ユーザー一覧表示
  /search <ID> - ユーザー情報検索
  /stats - サーバー統計情報
  /help - このヘルプ`;
        break;
    }

    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===================== 管理者API（ブロック設定用） =====================
app.get('/api/admin/block-settings', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    if (id !== 'admin') return res.status(403).json({ error: '管理者権限がありません' });
    const result = await pool.query('SELECT admin_settings FROM users WHERE id = $1', [id]);
    const settings = result.rows[0]?.admin_settings || { disabledBlocks: [], safetyMode: false };
    res.json(settings);
  } catch (err) {
    res.status(401).json({ error: '認証エラー' });
  }
});

app.post('/api/admin/block-toggle', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    if (id !== 'admin') return res.status(403).json({ error: '管理者権限がありません' });
    const { blockIndex, enabled } = req.body;
    const result = await pool.query('SELECT admin_settings FROM users WHERE id = $1', [id]);
    let settings = result.rows[0]?.admin_settings || { disabledBlocks: [], safetyMode: false };
    if (enabled) {
      settings.disabledBlocks = settings.disabledBlocks.filter(i => i !== blockIndex);
    } else {
      if (!settings.disabledBlocks.includes(blockIndex)) {
        settings.disabledBlocks.push(blockIndex);
      }
    }
    await pool.query('UPDATE users SET admin_settings = $1 WHERE id = $2', [JSON.stringify(settings), id]);
    res.json({ success: true, settings });
  } catch (err) {
    res.status(401).json({ error: '認証エラー' });
  }
});

// ===================== 🆕 チャットAPI =====================
app.get('/api/chat/messages', async (req, res) => {
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

app.post('/api/chat/send', async (req, res) => {
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

// ===================== 🆕 プロフィールAPI =====================
app.get('/api/user/profile/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query(
      'SELECT id, best_score, coins, play_time, created_at FROM users WHERE id = $1',
      [userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'ユーザーが見つかりません' });
    }
    const user = result.rows[0];
    res.json({
      userId: user.id,
      bestScore: user.best_score,
      coins: user.coins,
      playTime: user.play_time || 0,
      joinedAt: user.created_at
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'プロフィール取得エラー' });
  }
});

const PORT = process.env.PORT || 3000;

// DATABASE_URL が設定されていない場合、pool.query は全て失敗するので
// 起動時にすぐ気づけるよう明示的にチェックしておく
if (!process.env.DATABASE_URL) {
  console.error('❌ 環境変数 DATABASE_URL が設定されていません。RenderのEnvironmentタブで設定してください。');
}

initDb()
  .then(() => {
    console.log('✅ データベース初期化完了');
  })
  .catch(err => {
    // テーブル作成に失敗しても、原因（大抵はDATABASE_URLかSSL設定）が
    // ログに残るようにしつつ、プロセス自体は落とさない
    console.error('❌ データベース初期化エラー:', err.message);
  })
  .finally(() => {
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  });
