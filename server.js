import express from "express";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import cors from "cors";
import https from "https";
import { createClient } from "@supabase/supabase-js";

const app = express();

const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || "";
const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://cpkmtwhnzyzveuuwabvm.supabase.co";
const SUPABASE_KEY =
  process.env.SUPABASE_KEY || "sb_publishable_Cb65mwDpMhlFwwaqpxGjNA_ynvMHEfB";

const allowedOrigins = [
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  FRONTEND_URL
].filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`CORS blocked for origin: ${origin}`));
    }
  })
);

app.use(express.json());

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function safeName(name) {
  return (name || "untitled-song")
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/\[.*?\]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

function cleanupFile(filepath) {
  try {
    if (filepath && fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
  } catch (err) {
    console.error("Cleanup error:", err.message);
  }
}

function runCommand(command, timeout = 20000) {
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        timeout,
        maxBuffer: 1024 * 1024 * 20
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
        } else {
          resolve((stdout || "").trim());
        }
      }
    );
  });
}

function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filepath);

    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlink(filepath, () => {
            downloadImage(res.headers.location, filepath).then(resolve).catch(reject);
          });
          return;
        }

        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(filepath, () => {});
          reject(new Error(`Image download failed with status ${res.statusCode}`));
          return;
        }

        res.pipe(file);

        file.on("finish", () => {
          file.close(resolve);
        });
      })
      .on("error", (err) => {
        file.close();
        fs.unlink(filepath, () => {});
        reject(err);
      });
  });
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "MyTunes backend is running"
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "ok",
    port: PORT
  });
});

//
// 🔍 SEARCH
//
app.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim();

  if (!q) {
    return res.json([]);
  }

  try {
    const stdout = await runCommand(
      `yt-dlp "ytsearch8:${q.replace(/"/g, '\\"')}" --flat-playlist --print "%(title)s|||%(id)s"`,
      15000
    );

    const results = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [title, id] = line.split("|||");

        if (!title || !id) return null;

        return {
          title: title.trim(),
          url: `https://www.youtube.com/watch?v=${id.trim()}`,
          thumbnail: `https://img.youtube.com/vi/${id.trim()}/hqdefault.jpg`,
          id: id.trim()
        };
      })
      .filter(Boolean);

    res.json(results);
  } catch (err) {
    console.error("SEARCH ERROR:", err.message);
    res.json([]);
  }
});

//
// ▶️ STREAM AUDIO URL
//
app.get("/stream", async (req, res) => {
  const url = String(req.query.url || "").trim();

  if (!url) {
    return res.status(400).json({ error: "No URL provided" });
  }

  try {
    const stdout = await runCommand(
      `yt-dlp -f bestaudio --no-playlist -g "${url.replace(/"/g, '\\"')}"`,
      20000
    );

    if (!stdout) {
      return res.status(500).json({ error: "Stream failed" });
    }

    res.json({ stream: stdout.split("\n")[0].trim() });
  } catch (err) {
    console.error("STREAM ERROR:", err.message);
    res.status(500).json({ error: "Stream failed" });
  }
});

//
// 🎵 UPLOAD SONG
//
app.post("/upload-youtube", async (req, res) => {
  const url = String(req.body?.url || "").trim();

  if (!url) {
    return res.status(400).json({ error: "No URL provided" });
  }

  let audioFilepath = "";
  let imageFilepath = "";

  try {
    const cleanUrl = url.split("&")[0];

    let videoTitle = "Untitled Song";
    let thumbnailUrl = "";

    try {
      const titleOut = await runCommand(
        `yt-dlp --get-title "${cleanUrl.replace(/"/g, '\\"')}"`,
        20000
      );
      if (titleOut) videoTitle = titleOut.split("\n")[0].trim();
    } catch (err) {
      console.error("TITLE ERROR:", err.message);
    }

    try {
      const thumbOut = await runCommand(
        `yt-dlp --get-thumbnail "${cleanUrl.replace(/"/g, '\\"')}"`,
        20000
      );
      if (thumbOut) thumbnailUrl = thumbOut.split("\n")[0].trim();
    } catch (err) {
      console.error("THUMBNAIL ERROR:", err.message);
    }

    const baseName = `${safeName(videoTitle)}-${Date.now()}`;
    const audioFilename = `${baseName}.mp3`;
    const imageFilename = `${baseName}.jpg`;

    audioFilepath = path.join(os.tmpdir(), audioFilename);
    imageFilepath = path.join(os.tmpdir(), imageFilename);

    console.log("Processing:", baseName);

    await runCommand(
      `yt-dlp -x --audio-format mp3 --no-playlist -o "${audioFilepath}" "${cleanUrl.replace(/"/g, '\\"')}"`,
      180000
    );

    if (!fs.existsSync(audioFilepath)) {
      throw new Error("MP3 not created");
    }

    let coverPath = null;

    if (thumbnailUrl) {
      try {
        await downloadImage(thumbnailUrl, imageFilepath);

        if (fs.existsSync(imageFilepath)) {
          const imageBuffer = fs.readFileSync(imageFilepath);

          const { error: coverError } = await supabase.storage
            .from("music")
            .upload(`covers/${imageFilename}`, imageBuffer, {
              contentType: "image/jpeg",
              upsert: false
            });

          if (!coverError) {
            coverPath = `covers/${imageFilename}`;
          } else {
            console.error("COVER UPLOAD ERROR:", coverError.message);
          }
        }
      } catch (err) {
        console.error("IMAGE ERROR:", err.message);
      } finally {
        cleanupFile(imageFilepath);
      }
    }

    const audioBuffer = fs.readFileSync(audioFilepath);
    const audioPath = `songs/${audioFilename}`;

    const { error: uploadError } = await supabase.storage
      .from("music")
      .upload(audioPath, audioBuffer, {
        contentType: "audio/mpeg",
        upsert: false
      });

    if (uploadError) {
      throw new Error(uploadError.message);
    }

    const { error: insertError } = await supabase.from("songs").insert({
      title: videoTitle,
      artist: "Avinash Thakur",
      album: "MyTunes",
      audio_path: audioPath,
      cover_path: coverPath,
      duration_ms: 0
    });

    if (insertError) {
      throw new Error(insertError.message);
    }

    cleanupFile(audioFilepath);

    res.json({
      success: true,
      title: videoTitle,
      audio_path: audioPath,
      cover_path: coverPath
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err.message);

    cleanupFile(audioFilepath);
    cleanupFile(imageFilepath);

    res.status(500).json({
      error: err.message || "Upload failed"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});