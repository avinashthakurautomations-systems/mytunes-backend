import express from "express";
import { exec } from "child_process";
import fs from "fs";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import https from "https";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const COOKIES_FILE_PATH = "/tmp/youtube-cookies.txt";

const STREAM_CACHE_TTL_MS = 10 * 60 * 1000;
const streamCache = new Map();
const pendingStreamRequests = new Map();

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_KEY environment variables");
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

if (process.env.YTDLP_COOKIES) {
  fs.writeFileSync(COOKIES_FILE_PATH, process.env.YTDLP_COOKIES, "utf8");
  console.log("YouTube cookies file created");
} else {
  console.log("YTDLP_COOKIES not set");
}

function safeName(name) {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/\[.*?\]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .trim();
}

function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filepath);

    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Image download failed with status ${res.statusCode}`));
          return;
        }

        res.pipe(file);

        file.on("finish", () => {
          file.close(resolve);
        });
      })
      .on("error", (error) => reject(error));
  });
}

function ytDlpCommonArgs() {
  const args = [
    "--no-playlist",
    "--remote-components", "ejs:github",
    "--extractor-args", "youtube:player_js_variant=tv",
    "--sleep-requests", "1",
    "--sleep-interval", "1",
    "--max-sleep-interval", "2",
    "--user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
  ];

  if (fs.existsSync(COOKIES_FILE_PATH)) {
    args.push("--cookies", COOKIES_FILE_PATH);
  }

  return args;
}

function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function buildCommand(args) {
  return `yt-dlp ${args.map(quote).join(" ")}`;
}

function execCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

function getCachedStream(url) {
  const entry = streamCache.get(url);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    streamCache.delete(url);
    return null;
  }

  return entry.stream;
}

function setCachedStream(url, stream) {
  streamCache.set(url, {
    stream,
    expiresAt: Date.now() + STREAM_CACHE_TTL_MS
  });
}

function cleanupExpiredStreamCache() {
  const now = Date.now();
  for (const [key, value] of streamCache.entries()) {
    if (value.expiresAt <= now) {
      streamCache.delete(key);
    }
  }
}

function findDownloadedAudioFile(baseName) {
  const files = fs.readdirSync(process.cwd());
  const matched = files.filter((file) => {
    if (!file.startsWith(`${baseName}.`)) return false;
    if (file.endsWith(".jpg") || file.endsWith(".jpeg") || file.endsWith(".png") || file.endsWith(".webp")) return false;
    return true;
  });

  if (matched.length === 0) return null;

  matched.sort((a, b) => {
    const aStat = fs.statSync(path.join(process.cwd(), a));
    const bStat = fs.statSync(path.join(process.cwd(), b));
    return bStat.mtimeMs - aStat.mtimeMs;
  });

  return matched[0];
}

function getContentTypeForExtension(filename) {
  const ext = path.extname(filename).lowercase?.() ?? path.extname(filename).toLowerCase();

  switch (ext) {
    case ".m4a":
      return "audio/mp4";
    case ".mp4":
      return "audio/mp4";
    case ".webm":
      return "audio/webm";
    case ".opus":
      return "audio/ogg";
    case ".ogg":
      return "audio/ogg";
    case ".mp3":
      return "audio/mpeg";
    case ".aac":
      return "audio/aac";
    case ".wav":
      return "audio/wav";
    case ".flac":
      return "audio/flac";
    default:
      return "application/octet-stream";
  }
}

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "mytunes-backend" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/playlist-tracks", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing playlist URL" });

  try {
    console.log("PLAYLIST request:", url);

    const command = buildCommand([
      ...ytDlpCommonArgs(),
      url,
      "--flat-playlist",
      "--print",
      "%(title)s|||%(id)s"
    ]);

    const stdout = await execCommand(command);

    const results = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [title, id] = line.split("|||");
        return {
          title,
          url: `https://www.youtube.com/watch?v=${id}`,
          thumbnail: `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
          id
        };
      });

    console.log("PLAYLIST success:", results.length, "tracks");
    res.json(results);
  } catch (err) {
    console.error("PLAYLIST failed:", err.message);
    res.status(500).json({ error: err.message || "Playlist fetch failed" });
  }
});

app.get("/stream", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing URL" });

  try {
    const cached = getCachedStream(url);
    if (cached) {
      console.log("STREAM cache hit");
      return res.json({ stream: cached });
    }

    if (pendingStreamRequests.has(url)) {
      console.log("STREAM pending request reused");
      const pendingStream = await pendingStreamRequests.get(url);
      return res.json({ stream: pendingStream });
    }

    console.log("STREAM request:", url);

    const promise = (async () => {
      const command = buildCommand([
        ...ytDlpCommonArgs(),
        "-f", "ba*/bestaudio*/b",
        "-g",
        url
      ]);

      const stdout = await execCommand(command);

      if (!stdout) {
        throw new Error("No stream URL returned");
      }

      setCachedStream(url, stdout);
      cleanupExpiredStreamCache();
      return stdout;
    })();

    pendingStreamRequests.set(url, promise);

    const stream = await promise;
    pendingStreamRequests.delete(url);

    console.log("STREAM success");
    res.json({ stream });
  } catch (err) {
    pendingStreamRequests.delete(url);
    console.error("STREAM failed:", err.message);
    res.status(500).json({ error: err.message || "Stream failed" });
  }
});

app.post("/upload-youtube", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "No URL provided" });
  }

  let audioFilename = null;
  let imageFilename = null;

  try {
    console.log("1. UPLOAD request received");

    const cleanUrl = String(url).split("&")[0];
    console.log("2. Clean URL:", cleanUrl);

    let videoTitle = "Untitled Song";
    let thumbnailUrl = "";

    console.log("3. Getting title...");
    try {
      const titleCommand = buildCommand([
        ...ytDlpCommonArgs(),
        "--get-title",
        cleanUrl
      ]);
      const stdout = await execCommand(titleCommand);
      if (stdout) videoTitle = stdout;
    } catch (err) {
      console.error("Title fetch error:", err.message);
    }
    console.log("4. Title:", videoTitle);

    console.log("5. Getting thumbnail...");
    try {
      const thumbCommand = buildCommand([
        ...ytDlpCommonArgs(),
        "--get-thumbnail",
        cleanUrl
      ]);
      const stdout = await execCommand(thumbCommand);
      if (stdout) thumbnailUrl = stdout;
    } catch (err) {
      console.error("Thumbnail fetch error:", err.message);
    }
    console.log("6. Thumbnail URL:", thumbnailUrl || "No thumbnail");

    const baseName = `${safeName(videoTitle)}-${Date.now()}`;
    const outputTemplate = `${baseName}.%(ext)s`;
    imageFilename = `${baseName}.jpg`;

    console.log("7. Downloading original audio format...");

    const downloadCommand = buildCommand([
      ...ytDlpCommonArgs(),
      "-f", "ba*/bestaudio*/b",
      "-o", outputTemplate,
      cleanUrl
    ]);

    await execCommand(downloadCommand);

    audioFilename = findDownloadedAudioFile(baseName);

    if (!audioFilename || !fs.existsSync(audioFilename)) {
      throw new Error("Audio file not created");
    }

    console.log("8. Audio download complete:", audioFilename);

    let coverPath = null;

    if (thumbnailUrl) {
      console.log("9. Downloading thumbnail...");
      await downloadImage(thumbnailUrl, imageFilename);

      if (fs.existsSync(imageFilename)) {
        console.log("10. Uploading thumbnail to Supabase...");
        const imageBuffer = fs.readFileSync(imageFilename);

        const { error } = await supabase.storage
          .from("music")
          .upload(`covers/${imageFilename}`, imageBuffer, {
            contentType: "image/jpeg",
            upsert: false
          });

        if (error) {
          console.error("11. Thumbnail upload failed:", error.message);
        } else {
          coverPath = `covers/${imageFilename}`;
          console.log("11. Thumbnail uploaded:", coverPath);
        }
      }
    } else {
      console.log("9. Skipping thumbnail download");
    }

    console.log("12. Reading audio file...");
    const audioBuffer = fs.readFileSync(audioFilename);
    const cleanAudioFileName = safeName(audioFilename);
    const audioPath = `songs/${Date.now()}_${cleanAudioFileName}`;
    const audioContentType = getContentTypeForExtension(audioFilename);

    console.log("13. Uploading audio to Supabase...");
    const { error: uploadError } = await supabase.storage
      .from("music")
      .upload(audioPath, audioBuffer, {
        contentType: audioContentType,
        upsert: false
      });

    if (uploadError) {
      console.error("14. Audio upload failed:", uploadError.message);
      throw uploadError;
    }

    console.log("14. Audio uploaded:", audioPath);

    console.log("15. Inserting row in songs table...");
    const { error: dbError } = await supabase.from("songs").insert({
      title: videoTitle,
      artist: "Avinash Thakur",
      album: "MyTunes",
      audio_path: audioPath,
      cover_path: coverPath,
      duration_ms: 0
    });

    if (dbError) {
      console.error("16. DB insert failed:", dbError.message);
      throw dbError;
    }

    console.log("16. DB row inserted successfully");
    console.log("17. Upload complete");

    res.json({ success: true });
  } catch (err) {
    console.error("UPLOAD error:", err.message);
    res.status(500).json({
      error: err.message || "Upload failed"
    });
  } finally {
    try {
      if (audioFilename && fs.existsSync(audioFilename)) {
        fs.unlinkSync(audioFilename);
        console.log("18. Deleted temp audio file");
      }
    } catch (e) {
      console.error("Temp audio cleanup failed:", e.message);
    }

    try {
      if (imageFilename && fs.existsSync(imageFilename)) {
        fs.unlinkSync(imageFilename);
        console.log("19. Deleted temp image file");
      }
    } catch (e) {
      console.error("Temp image cleanup failed:", e.message);
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});