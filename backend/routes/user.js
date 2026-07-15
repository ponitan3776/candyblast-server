const router = require('express').Router();
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// ===================== データ同期（POST） =====================
router.post('/sync', async (req, res) => {
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

// ===================== データ取得（GET） =====================
router.get('/sync', async (req, res) => {
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

// ===================== アカウント削除 =====================
router.delete('/account/delete', async (req, res) => {
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

// ===================== クエスト進捗取得 =====================
router.get('/quests/progress', async (req, res) => {
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

// ===================== クエスト進捗更新 =====================
router.post('/quests/update', async (req, res) => {
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

// ===================== クエスト報酬受け取り =====================
router.post('/quests/claim', async (req, res) => {
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

// ===================== プロフィール取得 =====================
router.get('/user/profile/:userId', async (req, res) => {
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

module.exports = router;
