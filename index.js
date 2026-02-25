require("dotenv").config();

const express = require("express");
const cors = require("cors");
const archiver = require("archiver");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = 3000;

const allowedOrigins = [
  "https://jeveuxunjob.eu",
  "https://www.jeveuxunjob.eu",
];

app.use(
  cors({
    origin: function (origin, callback) {
      // autoriser les appels sans origin (ex: curl, tests serveur)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
  })
);
app.use(express.json({ limit: "10mb" }));

// --- Supabase (server-side only) ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseServiceKey) {
  console.warn(
    "⚠️ Supabase env vars missing: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"
  );
}

const supabase = createClient(supabaseUrl || "", supabaseServiceKey || "");

// --- Health ---
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "orchestrator-api",
    message: "API is running",
  });
});

// --- Helpers ---
function sanitizeProjectName(projectName) {
  return (projectName || "site-web")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildSiteFilesFromBody(body) {
  const { projectName, html, css, js } = body || {};

  if (!html || typeof html !== "string") {
    const err = new Error("Le champ 'html' est requis (string).");
    err.statusCode = 400;
    throw err;
  }

  const safeName = sanitizeProjectName(projectName);

  const files = [
    { name: "index.html", content: html },
    {
      name: "README.txt",
      content: `# ${projectName || "Site web"}

Ce ZIP a été généré par l'orchestrator API.

Structure:
- index.html
- styles/main.css (si fourni)
- js/main.js (si fourni)

Déploiement rapide (Netlify):
1. Dézipper
2. Vérifier que index.html est à la racine
3. Glisser-déposer le dossier sur Netlify (Manual deploy)
`,
    },
  ];

  if (typeof css === "string" && css.trim()) {
    files.push({ name: "styles/main.css", content: css });
  }

  if (typeof js === "string" && js.trim()) {
    files.push({ name: "js/main.js", content: js });
  }

  return {
    safeName: safeName || "site-web",
    files,
  };
}

function generateZipBuffer(files) {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const chunks = [];

    archive.on("warning", (err) => {
      console.warn("Archive warning:", err);
    });

    archive.on("error", (err) => {
      reject(err);
    });

    archive.on("data", (chunk) => {
      chunks.push(chunk);
    });

    archive.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    for (const file of files) {
      archive.append(file.content, { name: file.name });
    }

    archive.finalize();
  });
}

// --- ZIP endpoints ---

// Endpoint binaire (tests locaux / scripts)
app.post("/build-site-zip", async (req, res) => {
  try {
    const { safeName, files } = buildSiteFilesFromBody(req.body);
    const zipBuffer = await generateZipBuffer(files);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename=${safeName}.zip`);
    res.send(zipBuffer);
  } catch (err) {
    console.error("build-site-zip error:", err);
    res.status(err.statusCode || 500).json({
      ok: false,
      error: err.message || "ZIP generation failed",
    });
  }
});

// Endpoint GPT-friendly (réponse JSON allégée)
app.post("/build-site-zip-json", async (req, res) => {
  try {
    const { safeName, files } = buildSiteFilesFromBody(req.body);
    const zipBuffer = await generateZipBuffer(files);

    const zipBase64 = zipBuffer.toString("base64");
    const zipBase64Preview = zipBase64.slice(0, 500);

    res.json({
      ok: true,
      fileName: `${safeName}.zip`,
      mimeType: "application/zip",
      fileCount: files.length,
      filesIncluded: files.map((f) => f.name),
      zipSizeBytes: zipBuffer.length,
      zipBase64Preview,
      note: "ZIP généré côté API. Base64 complet omis pour éviter une réponse trop volumineuse dans GPT Actions.",
    });
  } catch (err) {
    console.error("build-site-zip-json error:", err);
    res.status(err.statusCode || 500).json({
      ok: false,
      error: err.message || "ZIP generation failed",
    });
  }
});

// Sauvegarde un vrai ZIP dans ../site-output
app.post("/build-site-save", async (req, res) => {
  try {
    const { safeName, files } = buildSiteFilesFromBody(req.body);
    const zipBuffer = await generateZipBuffer(files);

    const outputDir = path.resolve(__dirname, "../site-output");
    fs.mkdirSync(outputDir, { recursive: true });

    const fileName = `${safeName}.zip`;
    const filePath = path.join(outputDir, fileName);

    fs.writeFileSync(filePath, zipBuffer);

    res.json({
      ok: true,
      fileName,
      savedTo: filePath,
      fileCount: files.length,
      filesIncluded: files.map((f) => f.name),
      zipSizeBytes: zipBuffer.length,
    });
  } catch (err) {
    console.error("build-site-save error:", err);
    res.status(err.statusCode || 500).json({
      ok: false,
      error: err.message || "ZIP save failed",
    });
  }
});

// --- Leads endpoint (Supabase insert) ---
app.post("/lead", async (req, res) => {
  try {
    const {
      source,
      page_url,
      full_name,
      email,
      phone,
      company,
      subject,
      message,
    } = req.body || {};

    if (!supabaseUrl || !supabaseServiceKey) {
      return res.status(500).json({
        ok: false,
        error: "Supabase non configuré (variables d'environnement manquantes).",
      });
    }

    // validation minimale
    if (!email || typeof email !== "string") {
      return res.status(400).json({ ok: false, error: "email requis" });
    }
    if (!message || typeof message !== "string") {
      return res.status(400).json({ ok: false, error: "message requis" });
    }

    const { data, error } = await supabase
      .from("leads")
      .insert([
        {
          source: source || "website",
          page_url: page_url || null,
          full_name: full_name || null,
          email,
          phone: phone || null,
          company: company || null,
          subject: subject || null,
          message,
          status: "new",
        },
      ])
      .select("id, created_at");

    if (error) {
      console.error("Supabase insert error:", error);
    return res.status(500).json({
      ok: false,
      error: "insert failed",
      supabase: {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      },
    });
}

    return res.json({ ok: true, lead: data?.[0] || null });
  } catch (err) {
    console.error("POST /lead error:", err);
    return res.status(500).json({ ok: false, error: "server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});