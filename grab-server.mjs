// Chordify desktop audio grabber — an optional convenience, not a requirement.
//
// The browser can't fetch YouTube audio itself (no CORS on youtube.com /
// googlevideo.com, ciphered stream URLs), so ⚙ Process Song needs someone to
// hand it the bytes. On the PHONE that's the "Chordify Grab" shortcut, which
// runs yt-dlp in a-Shell on the phone itself — no server, nothing to pay for
// (see SETUP-PHONE.md). This file is the same trick for a DESKTOP, where you
// can just leave a process running and get auto-chart in one tap.
//
//   node grab-server.mjs     # listens on http://127.0.0.1:8934
//
// Needs yt-dlp on PATH (or in ~/.local/bin):  https://github.com/yt-dlp/yt-dlp
// The deployed https app may call http://127.0.0.1 — desktop browsers treat
// loopback as a secure-context exception, so no mixed-content block. (iOS
// Safari does NOT: WebKit bug 171934. That's why the phone uses the shortcut
// instead of a server on the phone.)

import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.PORT || 8934;

// Resolve the yt-dlp binary: PATH first, then ~/.local/bin.
async function findYtdlp() {
  for (const cand of ['yt-dlp', join(homedir(), '.local', 'bin', 'yt-dlp')]) {
    try {
      const version = await new Promise((res, rej) =>
        execFile(cand, ['--version'], (err, out) => err ? rej(err) : res(out.trim())));
      return { bin: cand, version };
    } catch { /* try next */ }
  }
  return { bin: null, version: null };
}
const ytdlp = await findYtdlp();
if (!ytdlp.bin) console.error('WARNING: yt-dlp not found — /grab will fail. Install: https://github.com/yt-dlp/yt-dlp');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET',
};

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ytdlp: ytdlp.version }));
    return;
  }

  if (url.pathname === '/grab') {
    const v = url.searchParams.get('v') || '';
    if (!/^[\w-]{11}$/.test(v)) {
      res.writeHead(400, { ...CORS, 'Content-Type': 'text/plain' });
      res.end('bad video id');
      return;
    }
    if (!ytdlp.bin) {
      res.writeHead(502, { ...CORS, 'Content-Type': 'text/plain' });
      res.end('yt-dlp not installed on the helper machine');
      return;
    }
    // m4a/AAC first: iOS Safari's decodeAudioData can't decode Opus/WebM.
    const child = spawn(ytdlp.bin, [
      '-f', 'bestaudio[ext=m4a]/bestaudio',
      '--no-playlist', '-o', '-',
      `https://www.youtube.com/watch?v=${v}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '', sentHeader = false;
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
    child.stdout.once('data', () => {
      sentHeader = true;
      res.writeHead(200, { ...CORS, 'Content-Type': 'audio/mp4' });
    });
    child.stdout.pipe(res, { end: false });
    child.on('close', code => {
      if (!sentHeader) {
        res.writeHead(502, { ...CORS, 'Content-Type': 'text/plain' });
        res.end('yt-dlp failed (' + code + '): ' + stderr.split('\n').filter(Boolean).pop());
      } else {
        res.end();
      }
    });
    req.on('close', () => child.kill('SIGKILL'));
    return;
  }

  res.writeHead(404, { ...CORS, 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Chordify grabber on http://127.0.0.1:${PORT}  (yt-dlp ${ytdlp.version || 'MISSING'})`);
  console.log('Leave this running; the app finds it automatically on this computer.');
});
