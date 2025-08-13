const express = require('express');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const mime = require('mime-types');
const { fileTypeFromBuffer } = require('file-type');
const fs = require('fs');
const os = require('os');
const { promisify } = require('util');
const crypto = require('crypto');
require('dotenv').config();

// Optional CloudConvert integration
let CloudConvert = null;
if (process.env.CLOUDCONVERT_API_KEY) {
  try {
    CloudConvert = require('cloudconvert');
  } catch (_) {
    CloudConvert = null;
  }
}

// Configure ffmpeg
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// Security & performance middleware
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(compression());
app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic rate limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
});
app.use('/api/', apiLimiter);

// Multer in-memory storage
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 200 } }); // 200MB

// Helpers
function createTempFilePath(extension) {
  const random = crypto.randomBytes(8).toString('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-'));
  return path.join(dir, `${random}.${extension.replace(/^\./, '')}`);
}

async function bufferToTempFile(buffer, extension) {
  const tmpPath = createTempFilePath(extension);
  await fs.promises.writeFile(tmpPath, buffer);
  return tmpPath;
}

function streamFile(response, filePath, downloadName, contentType) {
  response.setHeader('Content-Type', contentType || 'application/octet-stream');
  response.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  const readStream = fs.createReadStream(filePath);
  readStream.pipe(response);
  readStream.on('close', () => {
    // Clean up temp dir
    fs.promises.rm(path.dirname(filePath), { recursive: true, force: true }).catch(() => {});
  });
}

async function convertImageBuffer(inputBuffer, targetFormat, options = {}) {
  const { width, height, quality } = options;
  let transformer = sharp(inputBuffer);
  if (width || height) {
    transformer = transformer.resize({ width: width ? parseInt(width, 10) : undefined, height: height ? parseInt(height, 10) : undefined, fit: sharp.fit.inside, withoutEnlargement: true });
  }
  switch (targetFormat) {
    case 'jpg':
    case 'jpeg':
      if (quality) {
        transformer = transformer.jpeg({ quality: parseInt(quality, 10) });
      } else {
        transformer = transformer.jpeg();
      }
      break;
    case 'png':
      transformer = transformer.png();
      break;
    case 'webp':
      transformer = transformer.webp({ quality: quality ? parseInt(quality, 10) : 90 });
      break;
    case 'avif':
      transformer = transformer.avif({ quality: quality ? parseInt(quality, 10) : 50 });
      break;
    default:
      throw new Error(`Unsupported image format: ${targetFormat}`);
  }
  return transformer.toBuffer();
}

async function convertWithFfmpeg(inputBuffer, sourceExt, targetExt, ffmpegOptions = []) {
  const inputPath = await bufferToTempFile(inputBuffer, sourceExt || 'bin');
  const outputPath = createTempFilePath(targetExt || 'out');
  await new Promise((resolve, reject) => {
    let command = ffmpeg(inputPath)
      .outputOptions(ffmpegOptions)
      .toFormat(targetExt.replace(/^\./, ''))
      .on('error', reject)
      .on('end', resolve)
      .save(outputPath);
  });
  return outputPath;
}

async function zipSingleFileBuffer(inputBuffer, filenameInsideZip = 'file') {
  const zip = new AdmZip();
  zip.addFile(filenameInsideZip, inputBuffer);
  const zipped = zip.toBuffer();
  const outPath = createTempFilePath('zip');
  await fs.promises.writeFile(outPath, zipped);
  return outPath;
}

async function runCloudConvert(inputBuffer, inputExt, targetExt) {
  if (!CloudConvert) {
    throw new Error('CloudConvert not configured');
  }
  const cloudConvert = new CloudConvert(process.env.CLOUDCONVERT_API_KEY);
  const job = await cloudConvert.jobs.create({
    tasks: {
      upload: { operation: 'import/upload' },
      convert: { operation: 'convert', input: 'upload', output_format: targetExt.replace(/^\./, '') },
      export: { operation: 'export/url', input: 'convert' },
    },
  });
  const uploadTask = job.tasks.find((t) => t.name === 'upload');
  await cloudConvert.tasks.upload(uploadTask, inputBuffer, `input.${inputExt.replace(/^\./, '')}`);
  const completed = await cloudConvert.jobs.wait(job.id);
  const exportTask = completed.tasks.find((t) => t.operation === 'export/url' && t.status === 'finished');
  const file = exportTask.result.files[0];
  const res = await fetch(file.url);
  const outBuffer = Buffer.from(await res.arrayBuffer());
  const tmpOut = createTempFilePath(targetExt);
  await fs.promises.writeFile(tmpOut, outBuffer);
  return tmpOut;
}

// API: single file convert
app.post('/api/convert', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Missing file' });
    }
    const originalName = req.file.originalname || 'file';
    const targetFormatRaw = (req.body.targetFormat || '').toLowerCase();
    if (!targetFormatRaw) {
      return res.status(400).json({ error: 'Missing targetFormat' });
    }
    const targetFormat = targetFormatRaw.replace(/^\./, '');

    const typeInfo = await fileTypeFromBuffer(req.file.buffer);
    const sourceMime = typeInfo?.mime || req.file.mimetype || 'application/octet-stream';
    const sourceExt = (typeInfo?.ext || mime.extension(sourceMime) || path.extname(originalName).replace('.', '') || 'bin').toLowerCase();

    // Decide conversion path
    const imageTargets = ['jpg', 'jpeg', 'png', 'webp', 'avif'];
    const audioTargets = ['mp3', 'aac', 'wav', 'ogg', 'flac', 'm4a'];
    const videoTargets = ['mp4', 'webm', 'ogv', 'mkv', 'mov'];

    let outputPath = null;

    if (sourceMime.startsWith('image/') && imageTargets.includes(targetFormat)) {
      const width = req.body.width ? parseInt(req.body.width, 10) : undefined;
      const height = req.body.height ? parseInt(req.body.height, 10) : undefined;
      const quality = req.body.quality ? parseInt(req.body.quality, 10) : undefined;
      const outBuffer = await convertImageBuffer(req.file.buffer, targetFormat, { width, height, quality });
      outputPath = createTempFilePath(targetFormat);
      await fs.promises.writeFile(outputPath, outBuffer);
    } else if ((sourceMime.startsWith('audio/') || sourceMime.startsWith('video/')) && (audioTargets.includes(targetFormat) || videoTargets.includes(targetFormat))) {
      const ffmpegOpts = [];
      if (audioTargets.includes(targetFormat)) {
        ffmpegOpts.push('-vn'); // disable video if any
        if (req.body.audioBitrate) ffmpegOpts.push('-b:a', `${parseInt(req.body.audioBitrate, 10)}k`);
      }
      if (videoTargets.includes(targetFormat)) {
        if (req.body.videoBitrate) ffmpegOpts.push('-b:v', `${parseInt(req.body.videoBitrate, 10)}k`);
        if (req.body.fps) ffmpegOpts.push('-r', `${parseInt(req.body.fps, 10)}`);
        if (req.body.scaleWidth || req.body.scaleHeight) {
          const sw = parseInt(req.body.scaleWidth || '0', 10);
          const sh = parseInt(req.body.scaleHeight || '0', 10);
          if (sw > 0 && sh > 0) {
            ffmpegOpts.push('-vf', `scale=${sw}:${sh}`);
          }
        }
      }
      outputPath = await convertWithFfmpeg(req.file.buffer, sourceExt, targetFormat, ffmpegOpts);
    } else if (targetFormat === 'zip') {
      outputPath = await zipSingleFileBuffer(req.file.buffer, originalName);
    } else if (CloudConvert) {
      outputPath = await runCloudConvert(req.file.buffer, sourceExt, targetFormat);
    } else {
      return res.status(501).json({ error: `Conversion from ${sourceExt} to ${targetFormat} not supported locally. Set CLOUDCONVERT_API_KEY to enable universal conversions.` });
    }

    const downloadName = `${path.basename(originalName, path.extname(originalName))}.${targetFormat}`;
    const outType = mime.lookup(targetFormat) || 'application/octet-stream';
    streamFile(res, outputPath, downloadName, outType);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Conversion failed', detail: err.message });
  }
});

// API: batch conversion -> zip
app.post('/api/batch', upload.array('files', 20), async (req, res) => {
  try {
    const files = req.files || [];
    const targetFormatRaw = (req.body.targetFormat || '').toLowerCase();
    const targetFormat = targetFormatRaw.replace(/^\./, '');
    if (files.length === 0) return res.status(400).json({ error: 'No files provided' });
    if (!targetFormat) return res.status(400).json({ error: 'Missing targetFormat' });

    // Create a zip archive streamed to response
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="converted_batch.zip"');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (e) => { throw e; });
    archive.pipe(res);

    for (const file of files) {
      const originalName = file.originalname;
      const typeInfo = await fileTypeFromBuffer(file.buffer);
      const sourceMime = typeInfo?.mime || file.mimetype || 'application/octet-stream';
      const sourceExt = (typeInfo?.ext || mime.extension(sourceMime) || path.extname(originalName).replace('.', '') || 'bin').toLowerCase();

      try {
        let outBuffer = null;
        if (sourceMime.startsWith('image/') && ['jpg','jpeg','png','webp','avif'].includes(targetFormat)) {
          outBuffer = await convertImageBuffer(file.buffer, targetFormat, {});
        } else if ((sourceMime.startsWith('audio/') || sourceMime.startsWith('video/')) && ['mp3','aac','wav','ogg','flac','m4a','mp4','webm','ogv','mkv','mov'].includes(targetFormat)) {
          const outPath = await convertWithFfmpeg(file.buffer, sourceExt, targetFormat, []);
          const buf = await fs.promises.readFile(outPath);
          outBuffer = buf;
          await fs.promises.rm(path.dirname(outPath), { recursive: true, force: true }).catch(() => {});
        } else if (CloudConvert) {
          const outPath = await runCloudConvert(file.buffer, sourceExt, targetFormat);
          const buf = await fs.promises.readFile(outPath);
          outBuffer = buf;
          await fs.promises.rm(path.dirname(outPath), { recursive: true, force: true }).catch(() => {});
        }

        if (outBuffer) {
          const downloadName = `${path.basename(originalName, path.extname(originalName))}.${targetFormat}`;
          archive.append(outBuffer, { name: downloadName });
        } else {
          // fallback: include original
          archive.append(file.buffer, { name: originalName });
        }
      } catch (e) {
        // On error for a single file, include original with error note
        archive.append(file.buffer, { name: `${path.basename(originalName, path.extname(originalName))}_FAILED_${originalName}` });
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Batch conversion failed', detail: err.message });
  }
});

// Healthcheck
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// robots.txt
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
});

// Dynamic sitemap.xml from .html files in workspace root
app.get('/sitemap.xml', async (req, res) => {
  try {
    const files = await fs.promises.readdir(__dirname);
    const htmlFiles = files.filter((f) => f.endsWith('.html'));
    const urls = htmlFiles.map((file) => {
      const loc = file === 'index.html' ? `${SITE_URL}/` : `${SITE_URL}/${file}`;
      return `<url><loc>${loc}</loc><changefreq>weekly</changefreq><priority>${file === 'index.html' ? '1.0' : '0.8'}</priority></url>`;
    });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`;
    res.type('application/xml').send(xml);
  } catch (e) {
    res.status(500).send('Error generating sitemap');
  }
});

// Dynamic index with SITE_URL injection
app.get('/', async (req, res) => {
  try {
    const indexPath = path.join(__dirname, 'index.html');
    let html = await fs.promises.readFile(indexPath, 'utf8');
    html = html.replace(/http:\/\/localhost:3000/g, SITE_URL);
    res.type('html').send(html);
  } catch (e) {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

// Serve static HTML/CSS/JS files from workspace root
app.use(express.static(path.join(__dirname), {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    // Cache static assets for a week
    if (/\.(css|js|png|jpg|jpeg|gif|svg|webp|ico|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Fallback to index.html for non-API routes
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at ${SITE_URL}`);
});