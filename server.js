import express from "express";
import { exec } from "child_process";
import fs from "fs";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import https from "https";

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Supabase
const supabase = createClient(
  "https://cpkmtwhnzyzveuuwabvm.supabase.co",
  "sb_publishable_Cb65mwDpMhlFwwaqpxGjNA_ynvMHEfB"
);

// 🔧 Safe filename
function safeName(name) {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/\[.*?\]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .trim();
}

// 🔽 Download image
function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filepath);
    https.get(url, (res) => {
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", reject);
  });
}

//
// 🔍 FAST SEARCH
//
app.get("/search", (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);

  exec(
    `yt-dlp "ytsearch8:${q}" --flat-playlist --print "%(title)s|||%(id)s"`,
    { timeout: 10000 }, // ⏱ prevent long hanging
    (err, stdout) => {
      if (err || !stdout) {
        return res.json([]); // don't crash UI
      }

      const results = stdout
        .split("\n")
        .filter(Boolean)
        .map(line => {
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

//
// ▶️ STREAM AUDIO (FAST + RELIABLE)
//
app.get("/stream", (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "No URL" });
  }

  exec(
    `yt-dlp -f bestaudio --no-playlist -g "${url}"`,
    { timeout: 15000 },
    (err, stdout) => {
      if (err || !stdout) {
        return res.status(500).json({ error: "Stream failed" });
      }

      res.json({ stream: stdout.trim() });
    }
  );
});

//
// 🎵 UPLOAD SONG
//
app.post("/upload-youtube", async (req, res) => {
  const { url } = req.body;

  if (!url) return res.status(400).json({ error: "No URL provided" });

  try {
    const cleanUrl = url.split("&")[0];

    let videoTitle = "Untitled Song";
    let thumbnailUrl = "";

    // 🎵 Title
    await new Promise((resolve) => {
      exec(`yt-dlp --get-title "${cleanUrl}"`, (err, stdout) => {
        if (!err && stdout) videoTitle = stdout.trim();
        resolve();
      });
    });

    // 🖼 Thumbnail
    await new Promise((resolve) => {
      exec(`yt-dlp --get-thumbnail "${cleanUrl}"`, (err, stdout) => {
        if (!err && stdout) thumbnailUrl = stdout.trim();
        resolve();
      });
    });

    const baseName = safeName(videoTitle) + "-" + Date.now();
    const audioFilename = `${baseName}.mp3`;
    const imageFilename = `${baseName}.jpg`;

    console.log("Processing:", baseName);

    // 🎵 Download MP3
    await new Promise((resolve, reject) => {
      exec(
        `yt-dlp -x --audio-format mp3 --no-playlist -o "${audioFilename}" "${cleanUrl}"`,
        { timeout: 60000 },
        (error) => {
          if (error) reject(error);
          else resolve();
        }
      );
    });

    if (!fs.existsSync(audioFilename)) {
      throw new Error("MP3 not created");
    }

    // 🖼 Upload thumbnail
    let coverPath = null;

    if (thumbnailUrl) {
      await downloadImage(thumbnailUrl, imageFilename);

      if (fs.existsSync(imageFilename)) {
        const imageBuffer = fs.readFileSync(imageFilename);

        const { error } = await supabase.storage
          .from("music")
          .upload(`covers/${imageFilename}`, imageBuffer, {
            contentType: "image/jpeg"
          });

        if (!error) coverPath = `covers/${imageFilename}`;

        fs.unlinkSync(imageFilename);
      }
    }

    // ☁ Upload audio
    const audioBuffer = fs.readFileSync(audioFilename);
    const audioPath = `songs/${audioFilename}`;

    const { error: uploadError } = await supabase.storage
      .from("music")
      .upload(audioPath, audioBuffer, {
        contentType: "audio/mpeg"
      });

    if (uploadError) throw uploadError;

    // 💾 Insert DB
    await supabase.from("songs").insert({
      title: videoTitle,
      artist: "Avinash Thakur",
      album: "MyTunes",
      audio_path: audioPath,
      cover_path: coverPath,
      duration_ms: 0
    });

    fs.unlinkSync(audioFilename);

    res.json({ success: true });

  } catch (err) {
    console.error("ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

//
// 🟢 START SERVER
//
app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});