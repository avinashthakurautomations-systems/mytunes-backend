import express from "express";
import { exec } from "child_process";
import fs from "fs";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import https from "https";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_KEY environment variables");
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

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
        file.on("finish", () => file.close(resolve));
      })
      .on("error", reject);
  });
}

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "mytunes-backend" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/search", (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);

  exec(
    `yt-dlp "ytsearch10:${q}" --flat-playlist --print "%(title)s|||%(id)s"`,
    (err, stdout, stderr) => {
      if (err) {
        console.error("Search failed:", stderr || err.message);
        return res.status(500).json({ error: "Search failed" });
      }

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

      res.json(results);
    }
  );
});

app.get("/stream", (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing URL" });

  exec(`yt-dlp -f bestaudio -g "${url}"`, (err, stdout, stderr) => {
    if (err || !stdout) {
      console.error("Stream failed:", stderr || err?.message);
      return res.status(500).json({ error: "Stream failed" });
    }

    res.json({ stream: stdout.trim() });
  });
});

app.post("/upload-youtube", async (req, res) => {
  const { url } = req.body;

  if (!url) return res.status(400).json({ error: "No URL provided" });

  let audioFilename = null;
  let imageFilename = null;

  try {
    const cleanUrl = String(url).split("&")[0];

    let videoTitle = "Untitled Song";
    let thumbnailUrl = "";

    await new Promise((resolve) => {
      exec(`yt-dlp --get-title "${cleanUrl}"`, (err, stdout) => {
        if (!err && stdout) videoTitle = stdout.trim();
        resolve();
      });
    });

    await new Promise((resolve) => {
      exec(`yt-dlp --get-thumbnail "${cleanUrl}"`, (err, stdout) => {
        if (!err && stdout) thumbnailUrl = stdout.trim();
        resolve();
      });
    });

    const baseName = `${safeName(videoTitle)}-${Date.now()}`;
    audioFilename = `${baseName}.mp3`;
    imageFilename = `${baseName}.jpg`;

    console.log("Processing:", baseName);

    await new Promise((resolve, reject) => {
      exec(
        `yt-dlp --no-playlist -x --audio-format mp3 -o "${audioFilename}" "${cleanUrl}"`,
        (error, _stdout, stderr) => {
          if (error) reject(new Error(stderr || error.message));
          else resolve();
        }
      );
    });

    if (!fs.existsSync(audioFilename)) {
      throw new Error("MP3 not created");
    }

    let coverPath = null;

    if (thumbnailUrl) {
      await downloadImage(thumbnailUrl, imageFilename);

      if (fs.existsSync(imageFilename)) {
        const imageBuffer = fs.readFileSync(imageFilename);

        const { error } = await supabase.storage
          .from("music")
          .upload(`covers/${imageFilename}`, imageBuffer, {
            contentType: "image/jpeg",
            upsert: false
          });

        if (error) {
          console.error("Cover upload failed:", error.message);
        } else {
          coverPath = `covers/${imageFilename}`;
        }
      }
    }

    const audioBuffer = fs.readFileSync(audioFilename);
    const audioPath = `songs/${audioFilename}`;

    const { error: uploadError } = await supabase.storage
      .from("music")
      .upload(audioPath, audioBuffer, {
        contentType: "audio/mpeg",
        upsert: false
      });

    if (uploadError) throw uploadError;

    const { error: dbError } = await supabase.from("songs").insert({
      title: videoTitle,
      artist: "Avinash Thakur",
      album: "MyTunes",
      audio_path: audioPath,
      cover_path: coverPath,
      duration_ms: 0
    });

    if (dbError) throw dbError;

    res.json({ success: true });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: err.message || "Upload failed" });
  } finally {
    try {
      if (audioFilename && fs.existsSync(audioFilename)) fs.unlinkSync(audioFilename);
    } catch {}
    try {
      if (imageFilename && fs.existsSync(imageFilename)) fs.unlinkSync(imageFilename);
    } catch {}
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});