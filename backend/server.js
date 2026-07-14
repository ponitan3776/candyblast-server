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

// ===================== テーブル作成 =====================
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

// ===================== カラム自動追加（play_time 含む） =====================
pool.query(`
  ALTER TABLE users ADD COLUMN IF NOT EXISTS best_scores JSONB DEFAULT '{}';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_settings JSONB DEFAULT '{"disabledBlocks":[],"safetyMode":false}';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS quest_progress JSONB DEFAULT '{}';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN DEFAULT FALSE;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS play_time INTEGER DEFAULT 0;
`).then(() => {
  console.log('✅ カラム追加完了（best_scores, admin_settings, quest_progress, banned, play_time）');
}).catch(err => {
  console.warn('⚠️ カラム追加（一部既存の可能性あり）:', err.message);
});

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

// ===================== ログイン（BANチェック・play_time返却） =====================
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

// ===================== データ同期（play_time 対応） =====================
app.post('/api/sync', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    const { bestScore, coins, skins, equippedSkin, quests, mode, size, playTime } = req.body;
    const updateFields = [];
    const values = [];
    let paramCount = 1;

    // 8x8 かつ mode 指定あり → best_scores にモード別保存
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

// ===================== ランキング取得（スコア・コイン・プレイ時間） =====================
app.get('/api/ranking', async (req, res) => {
  const mode = req.query.mode || 'soft';
  const type = req.query.type || 'score'; // score, coins, playtime

  try {
    let query, countQuery;
    if (type === 'coins') {
      query = `SELECT id, coins as value FROM users WHERE coins > 0 ORDER BY coins DESC LIMIT 10`;
      countQuery = `SELECT COUNT(*) FROM users WHERE coins > 0`;
    } else if (type === 'playtime') {
      query = `SELECT id, play_time as value FROM users WHERE play_time > 0 ORDER BY play_time DESC LIMIT 10`;
      countQuery = `SELECT COUNT(*) FROM users WHERE play_time > 0`;
    } else {
      // スコアランキング（モード別）
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

// ===================== 管理者コマンド（/setplaytime 追加） =====================
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
        const amount = parseInt(args[0]);
        if (isNaN(amount) || amount < 0) throw new Error('正しいコイン数を指定してください');
        await pool.query('UPDATE users SET coins = $1 WHERE id = $2', [amount, id]);
        const updated = await pool.query('SELECT coins FROM users WHERE id = $1', [id]);
        result = `✅ コインを ${amount} に設定しました。（現在: ${updated.rows[0].coins}）`;
        break;
      }
      case '/setscore': {
        if (args.length < 2) {
          throw new Error('使用法: /setscore <mode> <score> (例: /setscore soft 5000)');
        }
        const mode = args[0];
        const score = parseInt(args[1]);
        const validModes = ['soft', 'baked', 'hard', 'extreme'];
        if (!validModes.includes(mode)) {
          throw new Error(`モードは ${validModes.join(', ')} のいずれかです`);
        }
        if (isNaN(score) || score < 0) throw new Error('正しいスコアを指定してください');
        const userResult = await pool.query('SELECT best_scores FROM users WHERE id = $1', [id]);
        let bestScores = userResult.rows[0]?.best_scores || {};
        bestScores[mode] = score;
        const allScores = Object.values(bestScores).filter(v => typeof v === 'number');
        const maxScore = allScores.length > 0 ? Math.max(...allScores) : 0;
        await pool.query(
          'UPDATE users SET best_scores = $1, best_score = $2 WHERE id = $3',
          [JSON.stringify(bestScores), maxScore, id]
        );
        result = `✅ ${mode}モードのベストスコアを ${score} に設定しました。（現在の最高: ${maxScore}）`;
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
            best_score = 0, 
            best_scores = '{}', 
            coins = 0, 
            skins = '["default"]', 
            quest_progress = '{}',
            play_time = 0
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
      case '/stats': {
        const totalUsers = await pool.query('SELECT COUNT(*) FROM users');
        const totalScore = await pool.query('SELECT SUM(best_score) FROM users');
        const totalCoins = await pool.query('SELECT SUM(coins) FROM users');
        const totalPlayTime = await pool.query('SELECT SUM(play_time) FROM users');
        result = `📊 サーバー統計:\n👤 総ユーザー数: ${totalUsers.rows[0].count}\n🏆 総スコア: ${totalScore.rows[0].sum || 0}\n🪙 総コイン: ${totalCoins.rows[0].sum || 0}\n⏱️ 総プレイ時間: ${totalPlayTime.rows[0].sum || 0}秒`;
        break;
      }
      case '/help':
      default:
        result = `📋 使用可能なコマンド:
  /setcoins <amount> - コインを指定値に設定
  /setscore <mode> <score> - モード別スコア設定 (soft, baked, hard, extreme)
  /safety [on|off] - 強制セーフティモード（引数なしで状態表示）
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
