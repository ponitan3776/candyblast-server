const router = require('express').Router();
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// ===================== 管理者コマンド =====================
router.post('/admin/command', async (req, res) => {
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
        if (args.length < 2) throw new Error('使用法: /setscore <mode> <score>');
        const mode = args[0];
        const score = parseInt(args[1]);
        const validModes = ['soft', 'baked', 'hard', 'extreme'];
        if (!validModes.includes(mode)) throw new Error(`モードは ${validModes.join(', ')} のいずれかです`);
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
        result = `✅ ${mode}モードのベストスコアを ${score} に設定しました。`;
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

// ===================== ブロック設定取得 =====================
router.get('/admin/block-settings', async (req, res) => {
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

// ===================== ブロック切り替え =====================
router.post('/admin/block-toggle', async (req, res) => {
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

module.exports = router;
