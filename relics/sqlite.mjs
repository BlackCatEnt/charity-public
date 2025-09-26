import Database from 'better-sqlite3';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export function openSqlite(path='soul/memory/memory.db'){
  return new Database(path, { fileMustExist: false });
}

export function ensureSchema(db){
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      hall TEXT NOT NULL,
      roomId TEXT NOT NULL,
      role TEXT NOT NULL,     -- 'user' | 'assistant'
      userId TEXT,            -- user id or null for assistant
      userName TEXT,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS embeddings (
      message_id INTEGER PRIMARY KEY,
      dim INTEGER NOT NULL,
      vec TEXT NOT NULL,      -- JSON float array (normalized)
      FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_room_ts ON messages(hall, roomId, ts);
    CREATE INDEX IF NOT EXISTS idx_messages_user_ts ON messages(userId, ts);
  `);
}
