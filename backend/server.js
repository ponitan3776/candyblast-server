const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// DB接続
const pool = require('./db/pool');

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

pool.query(`
  ALTER TABLE users ADD COLUMN IF NOT EXISTS best_scores JSONB DEFAULT '{}';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_settings JSONB DEFAULT '{"disabledBlocks":[],"safetyMode":false}';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS quest_progress JSONB DEFAULT '{}';
  ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN DEFAULT FALSE;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS play_time INTEGER DEFAULT 0;
`).then(() => {
  console.log('✅ カラム追加完了');
}).catch(err => {
  console.warn('⚠️ カラム追加:', err.message);
});

pool.query(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    message TEXT NOT NULL,
    timestamp TIMESTAMP DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON chat_messages(timestamp);
`).then(() => {
  console.log('✅ チャットテーブル作成完了');
}).catch(err => {
  console.warn('⚠️ チャットテーブル:', err.message);
});

// ===================== ルートをインポート =====================
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const rankingRoutes = require('./routes/ranking');

// ===================== ルートをマウント =====================
app.use('/api', authRoutes);
app.use('/api', userRoutes);
app.use('/api', rankingRoutes);

// ===================== 管理者API（まだ分割しない） =====================
// 今は server.js にそのまま残してもOK
// 後で admin.js に分割する

// ===================== チャットAPI（まだ分割しない） =====================
// 今は server.js にそのまま残してもOK
// 後で chat.js に分割する

// ===================== サーバー起動 =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
