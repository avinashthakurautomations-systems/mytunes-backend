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

        file.on("finish", () => {
          file.close(resolve);
        });
      })
      .on("error", (error) => {
        reject(error);
      });
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

  console.log("SEARCH request:", q);

  exec(
    `yt-dlp "ytsearch10:${q}" --flat-playlist --print "%(title)s|||%(id)s"`,
    (err, stdout, stderr) => {
      if (err) {
        console.error("SEARCH failed:", stderr || err.message);
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

      console.log("SEARCH success:", results.length, "results");
      res.json(results);
    }
  );
});

app.get("/stream", (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing URL" });

  console.log("STREAM request:", url);

  exec(`yt-dlp -f bestaudio -g "${url}"`, (err, stdout, stderr) => {
    if (err || !stdout) {
      console.error("STREAM failed:", stderr || err?.message);
      return res.status(500).json({ error: "Stream failed" });
    }

    console.log("STREAM success");
    res.json({ stream: stdout.trim() });
  });
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
    await new Promise((resolve) => {
      exec(`yt-dlp --get-title "${cleanUrl}"`, (err, stdout, stderr) => {
        if (err) {
          console.error("Title fetch error:", stderr || err.message);
        }
        if (!err && stdout) {
          videoTitle = stdout.trim();
        }
        resolve();
      });
    });
    console.log("4. Title:", videoTitle);

    console.log("5. Getting thumbnail...");
    await new Promise((resolve) => {
      exec(`yt-dlp --get-thumbnail "${cleanUrl}"`, (err, stdout, stderr) => {
        if (err) {
          console.error("Thumbnail fetch error:", stderr || err.message);
        }
        if (!err && stdout) {
          thumbnailUrl = stdout.trim();
        }
        resolve();
      });
    });
    console.log("6. Thumbnail URL:", thumbnailUrl || "No thumbnail");

    const baseName = `${safeName(videoTitle)}-${Date.now()}`;
    audioFilename = `${baseName}.mp3`;
    imageFilename = `${baseName}.jpg`;

    console.log("7. Downloading MP3:", audioFilename);
    await new Promise((resolve, reject) => {
      exec(
        `yt-dlp --no-playlist -x --audio-format mp3 -o "${audioFilename}" "${cleanUrl}"`,
        (error, _stdout, stderr) => {
          if (error) {
            console.error("MP3 download error:", stderr || error.message);
            reject(new Error(stderr || error.message));
          } else {
            console.log("8. MP3 download complete");
            resolve();
          }
        }
      );
    });

    if (!fs.existsSync(audioFilename)) {
      throw new Error("MP3 not created");
    }

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
      } else {
        console.log("10. Thumbnail file was not created");
      }
    } else {
      console.log("9. Skipping thumbnail download");
    }

    console.log("12. Reading audio file...");
    const audioBuffer = fs.readFileSync(audioFilename);
    const audioPath = `songs/${audioFilename}`;

    console.log("13. Uploading audio to Supabase...");
    const { error: uploadError } = await supabase.storage
      .from("music")
      .upload(audioPath, audioBuffer, {
        contentType: "audio/mpeg",
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
    console.error("UPLOAD error:", err);
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