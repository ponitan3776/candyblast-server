const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// DB接続
const pool = require('./db/pool');

// テーブル作成（最初だけ）
// ... テーブル作成コード ...

// ルートをインポート
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const rankingRoutes = require('./routes/ranking');

// ルートをマウント
app.use('/api', authRoutes);
app.use('/api', userRoutes);
app.use('/api', rankingRoutes);

// チャットAPIと管理者APIは後で分割（今回はこのままでもOK）
// ... チャットAPI ...
// ... 管理者API ...

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
