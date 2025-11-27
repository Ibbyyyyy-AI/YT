// index.js
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { ytDlp } = require('yt-dlp-exec'); // uses yt-dlp binary automatically
const app = express();

app.use(cors()); // allow calls from your frontend
app.use(express.json());

// very small rate limit to avoid abuse (adjust on Railway if needed)
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // max 30 requests / minute per IP
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// simple root
app.get('/', (req, res) => {
  res.send({ ok: true, message: 'IBI YT helper running' });
});

/*
  Endpoint: /info
  Query: ?url=<youtube-url>
  Returns: title, thumbnail, formats (array with itag/format/width/height/bitrate), subtitles list
*/
app.get('/info', async (req, res) => {
  const url = req.query.url;
  if(!url) return res.status(400).json({ error: 'Missing url' });

  try {
    // yt-dlp -j returns JSON metadata
    const info = await ytDlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      preferFreeFormats: true,
      // limit the amount of data returned for speed
      // skip downloading subtitles here; we will list available subtitles
      // you can add more options as needed
    });

    // build a simple formats list we will send to the frontend
    const formats = (info.formats || []).filter(f => f.filesize || f.filesize_approx || f.url).map(f => ({
      itag: f.format_id || f.format,
      ext: f.ext,
      width: f.width || null,
      height: f.height || null,
      acodec: f.acodec,
      vcodec: f.vcodec,
      filesize: f.filesize || f.filesize_approx || 0,
      filesizeHuman: f.filesize ? Math.round(f.filesize/1024) + ' KB' : (f.filesize_approx ? Math.round(f.filesize_approx/1024) + ' KB' : null),
      note: f.format_note || f.format
    }));

    // subtitle languages available (if any)
    const subtitles = info.subtitles || {}; // object keyed by language
    const automatic_captions = info.automatic_captions || {};

    res.json({
      id: info.id,
      title: info.title,
      uploader: info.uploader,
      length: info.duration,
      thumbnail: info.thumbnail,
      formats,
      subtitles: Object.keys(subtitles || {}),
      auto_subtitles: Object.keys(automatic_captions || {}),
      raw: {
        view_count: info.view_count || 0
      }
    });
  } catch (err) {
    console.error('info error', err);
    res.status(500).json({ error: 'Failed to fetch video info', details: (err && err.message) || err });
  }
});

/*
  Endpoint: /download
  Query:
    url=<youtube-url>
    format=<format_id> (optional)  - use the itag/format id from /info
  Streams the chosen format directly to the user.
*/
app.get('/download', async (req, res) => {
  const url = req.query.url;
  const format = req.query.format; // format id or ytdlp format string
  if(!url) return res.status(400).send('Missing url');

  try {
    // Set response headers so browser downloads
    res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');

    // Build yt-dlp args. If format specified, pass -f <format>.
    const opts = {
      output: '-', // stream to stdout
      // If format provided: pass it through
      ...(format ? { format } : {}),
      // no warnings to keep stdout clean
      noWarnings: true,
      preferFreeFormats: true,
      // make sure we get binary stream
      // youtube-dl-exec returns a child process stream
    };

    const child = ytDlp.raw(url, opts);

    // pipe yt-dlp stdout to the HTTP response
    child.stdout.pipe(res);

    child.on('error', (err) => {
      console.error('download child error', err);
      if(!res.headersSent) res.status(500).send('Download failed');
    });

    child.on('close', (code) => {
      // finished
    });

  } catch (err) {
    console.error('download error', err);
    res.status(500).send('Error starting download');
  }
});

/*
  Endpoint: /subtitles
  Query:
    url=<youtube-url>
    lang=<lang-code> (e.g. en) - optional; if not provided we can try to return all or default
    format=srt|vtt (optional, default srt)
*/
app.get('/subtitles', async (req, res) => {
  const url = req.query.url;
  const lang = req.query.lang; // optional
  const outFmt = (req.query.format || 'srt').toLowerCase();
  if(!url) return res.status(400).json({ error: 'Missing url' });

  try {
    // Build args to download subtitles to stdout
    // yt-dlp --write-sub --sub-lang en --skip-download --sub-format srt -o -
    const opts = {
      skipDownload: true,
      writeSub: true,
      // Accept automatic captions if requested? We'll try normal subtitles first
      subLang: lang,
      subFormat: outFmt,
      // output to stdout
      output: '-'
    };

    // If no lang given, yt-dlp will download all subtitles; but piping multiple could be messy.
    // Instead we'll fetch JSON metadata and if subtitles exist we'll try to request a single lang.
    const info = await ytDlp(url, { dumpJson: true, noWarnings: true }).catch(()=>null);

    // choose a language if not provided
    let chosenLang = lang;
    if(!chosenLang) {
      if(info && info.subtitles) {
        const keys = Object.keys(info.subtitles);
        if(keys.length) chosenLang = keys[0];
      } else if(info && info.automatic_captions) {
        const keys = Object.keys(info.automatic_captions);
        if(keys.length) chosenLang = keys[0];
      }
    }

    // If still no chosenLang, return 404
    if(!chosenLang) return res.status(404).json({ error: 'No subtitles found' });

    // Prepare command: use raw to stream download of subtitles
    const ytdlpArgs = [
      url,
      '--skip-download',
      '--sub-lang', chosenLang,
      '--write-subs',
      '--sub-format', outFmt,
      '-o', '-' // send to stdout if possible
    ];

    // Use raw to spawn process
    const child = ytDlp.raw(ytdlpArgs, { stdio: ['ignore', 'pipe', 'inherit'] });

    res.setHeader('Content-Disposition', `attachment; filename="subs.${outFmt}"`);
    // pipe stdout to response
    child.stdout.pipe(res);

    child.on('error', (e) => {
      console.error('subtitles child error', e);
      if(!res.headersSent) res.status(500).send('Failed to get subtitles');
    });

  } catch (err) {
    console.error('subtitles error', err);
    res.status(500).json({ error: 'Failed to fetch subtitles', details: err.message || err });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`IBI yt helper listening on ${PORT}`));
