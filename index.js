const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const puppeteer = require('puppeteer');
const axios = require('axios');
const { URL } = require('url');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const os = require('os');
// const ytdl = require('ytdl-core-fixed');
ffmpeg.setFfmpegPath(ffmpegPath);

ffmpeg.setFfmpegPath(ffmpegPath);

const tempDir = os.tmpdir();


const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Create temp directory for processing
// const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

// Helper: Identify platform
const detectPlatform = (videoUrl) => {
  try {
    const url = new URL(videoUrl);
    if (url.hostname.includes('youtube.com') || url.hostname.includes('youtu.be')) return 'youtube';
    if (url.hostname.includes('instagram.com')) return 'instagram';
    if (url.hostname.includes('tiktok.com')) return 'tiktok';
    if (url.hostname.includes('facebook.com')) return 'facebook';
    return 'unsupported';
  } catch {
    return 'invalid';
  }
};

// Helper: Clean filename
const cleanFileName = (filename) => {
  return filename.replace(/[^\w\s.-]/gi, '').replace(/\s+/g, '_').substring(0, 100);
};

// YouTube Downloader
app.get('/api/download/youtube', async (req, res) => {
  const { url, quality = 'highest', format = 'mp4' } = req.query;
  try {
    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const info = await ytdl.getInfo(url);
    const title = info.videoDetails.title.replace(/[^a-zA-Z0-9-_ ]/g, '');
    const fileName = `${title}.${format}`;

    if (format === 'mp3') {
      const tempDir = os.tmpdir();
      const tempAudio = path.join(tempDir, `${Date.now()}_${title}.webm`);
      const tempMp3 = path.join(tempDir, `${Date.now()}_${title}.mp3`);

      const audioStream = ytdl(url, { filter: 'audioonly', quality: 'highestaudio' });
      const writeStream = fs.createWriteStream(tempAudio);
      audioStream.pipe(writeStream);

      writeStream.on('finish', () => {
        ffmpeg(tempAudio)
          .toFormat('mp3')
          .on('end', () => {
            res.header('Content-Disposition', `attachment; filename="${fileName}"`);
            res.header('Content-Type', 'audio/mpeg');

            const fileStream = fs.createReadStream(tempMp3);
            fileStream.pipe(res);

            fileStream.on('close', () => {
              fs.unlink(tempAudio, () => {});
              fs.unlink(tempMp3, () => {});
            });
          })
          .on('error', (error) => {
            console.error('FFmpeg error:', error);
            res.status(500).json({ error: 'Audio conversion failed' });
          })
          .save(tempMp3);
      });

      writeStream.on('error', (err) => {
        console.error('Write stream error:', err);
        res.status(500).json({ error: 'Failed to download audio' });
      });
    } else {
      const videoOnly = info.formats.find(f => f.qualityLabel === quality && f.hasVideo && !f.hasAudio);
      const audioOnly = ytdl.filterFormats(info.formats, 'audioonly')[0];

      if (!videoOnly || !audioOnly) {
        return res.status(404).json({ error: 'Requested quality not available' });
      }

      const tempDir = os.tmpdir();
      const videoPath = path.join(tempDir, `${Date.now()}_${title}_video.mp4`);
      const audioPath = path.join(tempDir, `${Date.now()}_${title}_audio.webm`);
      const outputPath = path.join(tempDir, `${Date.now()}_${fileName}`);

      const download = (stream, filePath) => {
        return new Promise((resolve, reject) => {
          const writeStream = fs.createWriteStream(filePath);
          stream.pipe(writeStream);
          writeStream.on('finish', resolve);
          writeStream.on('error', reject);
        });
      };

      await Promise.all([
        download(ytdl(url, { quality: videoOnly.itag }), videoPath),
        download(ytdl(url, { quality: audioOnly.itag }), audioPath)
      ]);

      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .videoCodec('copy')
        .audioCodec('aac')
        .format(format)
        .on('end', () => {
          res.header('Content-Disposition', `attachment; filename="${fileName}"`);
          res.header('Content-Type', `video/${format}`);

          const stream = fs.createReadStream(outputPath);
          stream.pipe(res);

          stream.on('close', () => {
            fs.unlink(videoPath, () => {});
            fs.unlink(audioPath, () => {});
            fs.unlink(outputPath, () => {});
          });
        })
        .on('error', (error) => {
          console.error('FFmpeg error:', error);
          res.status(500).json({ error: 'Failed to merge video and audio' });
        })
        .save(outputPath);
    }
  } catch (error) {
    console.error('YouTube download error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to download YouTube video', details: error.message });
    }
  }
});

// YouTube Info Route
app.get('/api/info/youtube', async (req, res) => {
  const { url } = req.query;

  try {
    if (!ytdl.validateURL(url)) {
        console.log("Invalid called");
        
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const info = await ytdl.getInfo(url);
    console.log(info,"info");
    
    const videoFormats = info.formats.filter(f => f.hasVideo && f.qualityLabel);
    const availableQualities = [...new Set(videoFormats.map(f => f.qualityLabel))];

    res.json({
      title: info.videoDetails.title,
      duration: info.videoDetails.lengthSeconds,
      thumbnail: info.videoDetails.thumbnails[0]?.url,
      availableQualities: availableQualities.sort((a, b) => {
        const getHeight = (quality) => parseInt(quality.match(/\d+/)?.[0] || '0');
        return getHeight(b) - getHeight(a);
      }),
      formats: ['mp4', 'mp3', 'webm']
    });
  } catch (error) {
    console.error('YouTube info error:', error);
    res.status(500).json({
      error: 'Failed to get video info',
      details: error.message
    });
  }
});

app.get('/api/download/instagram', async (req, res) => {
  const { url } = req.query;
  
  if (!url || !url.includes('instagram.com')) {
    return res.status(400).json({ error: 'Invalid Instagram URL' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({ 
      headless: true, 
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'] 
    });
    
    const page = await browser.newPage();
    
    // Set user agent to avoid detection
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    // Navigate to the Instagram post
    await page.goto(url, { waitUntil: 'networkidle2' });
    
    // Wait for video element
    await page.waitForSelector('video', { timeout: 10000 });
    
    // Extract video data directly from the page
    const videoBuffer = await page.evaluate(async () => {
      const video = document.querySelector('video');
      if (!video || !video.src) return null;
      
      try {
        // If it's a blob URL, we need to fetch it from within the browser context
        if (video.src.startsWith('blob:')) {
          const response = await fetch(video.src);
          const arrayBuffer = await response.arrayBuffer();
          return Array.from(new Uint8Array(arrayBuffer));
        }
        
        // If it's a regular URL, return the URL for server-side fetching
        return { url: video.src };
      } catch (error) {
        console.error('Error fetching video:', error);
        return null;
      }
    });
    
    await browser.close();
    
    if (!videoBuffer) {
      return res.status(404).json({ error: 'Video not found or could not be extracted' });
    }
    
    // If we got a buffer (blob URL case)
    if (Array.isArray(videoBuffer)) {
      const buffer = Buffer.from(videoBuffer);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'attachment; filename="instagram-video.mp4"');
      res.setHeader('Content-Length', buffer.length);
      res.send(buffer);
    }
    // If we got a regular URL
    else if (videoBuffer.url) {
      const response = await axios({
        url: videoBuffer.url,
        method: 'GET',
        responseType: 'stream',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      res.setHeader('Content-Disposition', 'attachment; filename="instagram-video.mp4"');
      response.data.pipe(res);
    }
    
  } catch (error) {
    if (browser) await browser.close();
    console.error('Instagram download error:', error);
    
    // Provide more specific error messages
    if (error.name === 'TimeoutError') {
      res.status(408).json({ error: 'Request timeout - video took too long to load' });
    } else if (error.message.includes('net::ERR_FAILED')) {
      res.status(404).json({ error: 'Instagram post not found or private' });
    } else {
      res.status(500).json({ error: 'Failed to fetch Instagram video' });
    }
  }
});

// Alternative approach using network response interception (more reliable)
app.get('/api/download/instagram-alt', async (req, res) => {
  const { url } = req.query;
  
  if (!url || !url.includes('instagram.com')) {
    return res.status(400).json({ error: 'Invalid Instagram URL' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({ 
      headless: true, 
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });
    
    const videoResponses = [];
    
    // Listen for responses instead of requests
    page.on('response', async (response) => {
      const url = response.url();
      const contentType = response.headers()['content-type'] || '';
      
      if ((url.includes('.mp4') || contentType.includes('video/mp4')) && 
          !url.startsWith('blob:') && 
          response.status() === 200) {
        videoResponses.push({
          url: url,
          headers: response.headers()
        });
      }
    });
    
    // Navigate to the Instagram URL
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    
    // Try to find and click play button if it exists
    try {
      await page.click('[aria-label="Play"], [data-testid="media-play-button"]', { timeout: 2000 });
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (e) {
      // Play button might not exist, continue
    }
    
    // Wait a bit more for video to load
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    await browser.close();
    
    if (videoResponses.length === 0) {
      return res.status(404).json({ error: 'No video found in this Instagram post' });
    }
    
    // Use the first video response found
    const videoResponse = videoResponses[0];
    
    const response = await axios({
      url: videoResponse.url,
      method: 'GET',
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.instagram.com/',
        'Accept': 'video/mp4,video/*;q=0.9,*/*;q=0.8'
      }
    });
    
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="instagram-video.mp4"');
    response.data.pipe(res);
    
  } catch (error) {
    if (browser) await browser.close();
    console.error('Instagram download error:', error);
    
    if (error.name === 'TimeoutError') {
      res.status(408).json({ error: 'Request timeout - Instagram post took too long to load' });
    } else if (error.code === 'ENOTFOUND' || error.response?.status === 404) {
      res.status(404).json({ error: 'Instagram post not found or may be private' });
    } else {
      res.status(500).json({ error: 'Failed to fetch Instagram video' });
    }
  }
});
// General route
app.get('/api/download', async (req, res) => {
  const { url } = req.query;
  const platform = detectPlatform(url);
  console.log('Detected platform:', platform);

  switch (platform) {
    case 'youtube':
      return app._router.handle(req, res, () => {}, '/api/download/youtube');
    case 'instagram':
      return app._router.handle(req, res, () => {}, '/api/download/instagram');
    case 'facebook':
    case 'tiktok':
      return res.status(501).json({ error: `${platform} support coming soon` });
    case 'unsupported':
      return res.status(400).json({ error: 'This platform is currently unsupported' });
    case 'invalid':
      return res.status(400).json({ error: 'Invalid URL provided' });
    default:
      return res.status(400).json({ error: 'Unknown platform error' });
  }
});


app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Get video info for any platform
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }
  
  const platform = detectPlatform(url);
  
  if (platform === 'youtube') {
    const youtubeReq = { ...req, url: '/api/info/youtube' };
    return app.handle(youtubeReq, res);
  }
  
  return res.status(400).json({ error: 'Info not available for this platform' });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'Server is running', 
    timestamp: new Date().toISOString(),
    supportedPlatforms: ['youtube', 'instagram'],
    supportedFormats: ['mp4', 'mp3', 'webm']
  });
});

// Clean up temp files on server start
process.on('SIGINT', () => {
  console.log('Cleaning up temp files...');
  if (fs.existsSync(tempDir)) {
    fs.readdir(tempDir, (err, files) => {
      if (!err) {
        files.forEach(file => {
          fs.unlinkSync(path.join(tempDir, file));
        });
      }
    });
  }
  process.exit();
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Supported endpoints:');
  console.log('- GET /api/info?url=VIDEO_URL - Get video information');
  console.log('- GET /api/download?url=VIDEO_URL&quality=QUALITY&format=FORMAT - Download video');
  console.log('- GET /health - Health check');
});