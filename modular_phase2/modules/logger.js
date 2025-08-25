import fs from 'fs';
import winston from 'winston';

export function createLogger() {
  try { fs.mkdirSync('./logs', { recursive: true }); } catch {}
  return winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.printf(({ level, message, timestamp }) => `${timestamp} [${level}] ${message}`)
    ),
    transports: [
      new winston.transports.File({ filename: './logs/bot.log' }),
      new winston.transports.Console()
    ]
  });
}
