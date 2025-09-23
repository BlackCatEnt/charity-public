import { spawn } from 'child_process';
import WebSocket from 'ws';

// Start ffmpeg to capture VB-Cable audio input (adjust device index/name if needed)
const ffmpeg = spawn('ffmpeg', [
  '-f', 'dshow',
  '-i', 'audio="CABLE Output (VB-Audio Virtual Cable)"',
  '-ac', '1',
  '-ar', '16000',
  '-f', 's16le',
  'pipe:1'
]);

// Pipe into Whisper ASR (Python or node wrapper)
ffmpeg.stdout.on('data', chunk => {
  // TODO: send chunk to Whisper worker process
});

ffmpeg.stderr.on('data', data => {
  console.error('ffmpeg:', data.toString());
});

ffmpeg.on('close', code => {
  console.log('ffmpeg exited', code);
});
