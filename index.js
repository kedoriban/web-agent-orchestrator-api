require("dotenv").config();

const express = require("express");
const cors = require("cors");
const archiver = require("archiver");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { execSync } = require("child_process");
const fetch = require("node-fetch");

const app = express();
const PORT = 3000;
const HUB_REPO_PATH = "C:\\web-agent-studio\\sites\\votresite-hub";

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

async function upsertGithubFile({ owner, repo, token, filePath, content, message }) {
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}`;

  // Get existing file to retrieve sha
  const getRes = await fetch(apiBase, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "votresite-hub-publisher",
    },
  });

  let sha = undefined;
  if (getRes.status === 200) {
    const json = await getRes.json();
    sha = json.sha;
  }

  const putRes = await fetch(apiBase, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "votresite-hub-publisher",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      sha,
      branch: "main",
    }),
  });

  if (!putRes.ok) {
    const errText = await putRes.text();
    throw new Error(`GitHub upsert failed (${putRes.status}): ${errText}`);
  }

  return putRes.json();
}

function slugify(input) {
  return (input || "")
    .toString()
    .normalize("NFD") // sépare accents
    .replace(/[\u0300-\u036f]/g, "") // supprime accents
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-") // tout le reste -> tiret
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
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
    const { bot_field } = req.body || {};
    if (bot_field && String(bot_field).trim().length > 0) {
      return res.json({ ok: true, ignored: true });
}

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

app.post("/publish-slug", async (req, res) => {
  try {
    const { slug, projectName, html, css, js } = req.body || {};

    if (!slug || typeof slug !== "string") {
      return res.status(400).json({ ok: false, error: "slug requis" });
    }
    if (!html || typeof html !== "string") {
      return res.status(400).json({ ok: false, error: "html requis" });
    }

    const safeSlug = slug
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

    if (!safeSlug) {
      return res.status(400).json({ ok: false, error: "slug invalide" });
    }

    // Crée le dossier /<slug> dans le hub
    const slugDir = path.join(HUB_REPO_PATH, safeSlug);
    const stylesDir = path.join(slugDir, "styles");
    const jsDir = path.join(slugDir, "js");

    fs.mkdirSync(stylesDir, { recursive: true });
    fs.mkdirSync(jsDir, { recursive: true });

    // Écrit les fichiers
    fs.writeFileSync(path.join(slugDir, "index.html"), html, "utf8");

    if (typeof css === "string" && css.trim()) {
      fs.writeFileSync(path.join(stylesDir, "main.css"), css, "utf8");
    }

    if (typeof js === "string" && js.trim()) {
      fs.writeFileSync(path.join(jsDir, "main.js"), js, "utf8");
    }

    // README optionnel
    const readme = `# ${projectName || safeSlug}

Déployé automatiquement dans votresite-hub/${safeSlug}

URL:
- https://votresite.be/${safeSlug}/
`;
    fs.writeFileSync(path.join(slugDir, "README.txt"), readme, "utf8");

    // Git add/commit/push
    const commitMsg = `Publish ${safeSlug}`;
    execSync(`git add .`, { cwd: HUB_REPO_PATH, stdio: "inherit" });
    execSync(`git commit -m "${commitMsg}"`, { cwd: HUB_REPO_PATH, stdio: "inherit" });
    execSync(`git push`, { cwd: HUB_REPO_PATH, stdio: "inherit" });

    return res.json({
      ok: true,
      slug: safeSlug,
      publishedUrl: `https://votresite.be/${safeSlug}/`,
    });
  } catch (err) {
    console.error("publish-slug error:", err);
    return res.status(500).json({ ok: false, error: "publish failed" });
  }
});

app.post("/publish-slug-github", async (req, res) => {
  try {
    const { slug, projectName, html, css, js } = req.body || {};

    if (!slug || typeof slug !== "string") {
      return res.status(400).json({ ok: false, error: "slug requis" });
    }
    if (!html || typeof html !== "string") {
      return res.status(400).json({ ok: false, error: "html requis" });
    }

    const safeSlug = slugify(slug);

    if (!safeSlug) {
      return res.status(400).json({ ok: false, error: "slug invalide" });
    }

    const owner = process.env.HUB_REPO_OWNER;
    const repo = process.env.HUB_REPO_NAME;
    const token = process.env.GITHUB_TOKEN;

    if (!owner || !repo || !token) {
      return res.status(500).json({ ok: false, error: "GitHub env missing" });
    }

    const baseMsg = `Publish ${safeSlug}`;
    const files = [
      {
        path: `${safeSlug}/index.html`,
        content: html,
      },
      {
        path: `${safeSlug}/README.txt`,
        content: `# ${projectName || safeSlug}

Publié automatiquement sur https://votresite.be/${safeSlug}/
`,
      },
    ];

    if (typeof css === "string" && css.trim()) {
      files.push({ path: `${safeSlug}/styles/main.css`, content: css });
    }
    if (typeof js === "string" && js.trim()) {
      files.push({ path: `${safeSlug}/js/main.js`, content: js });
    }

    for (const f of files) {
      await upsertGithubFile({
        owner,
        repo,
        token,
        filePath: f.path,
        content: f.content,
        message: `${baseMsg} (${f.path})`,
      });
    }

    return res.json({
      ok: true,
      slug: safeSlug,
      publishedUrl: `https://votresite.be/${safeSlug}/`,
    });
  } catch (err) {
    console.error("publish-slug-github error:", err);
    return res.status(500).json({ ok: false, error: err.message || "publish failed" });
  }
});

app.get("/slug-files", async (req, res) => {
  try {
    const slug = slugify(req.query.slug || "");
    if (!slug) return res.status(400).json({ ok: false, error: "slug requis" });

    const owner = process.env.HUB_REPO_OWNER;
    const repo = process.env.HUB_REPO_NAME;
    const token = process.env.GITHUB_TOKEN;
    if (!owner || !repo || !token) {
      return res.status(500).json({ ok: false, error: "GitHub env missing" });
    }

    // Liste des fichiers qu’on veut (simple et suffisant)
    const wanted = [
      `${slug}/index.html`,
      `${slug}/styles/main.css`,
      `${slug}/js/main.js`,
    ];

    async function getGithubContent(filePath) {
      const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}`;

      const r = await fetch(apiUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "votresite-hub-reader",
        },
      });

      if (r.status === 404) return { path: filePath, exists: false };
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`GitHub GET failed (${r.status}): ${t}`);
      }

      const j = await r.json();
      const content = j.content ? Buffer.from(j.content, "base64").toString("utf8") : "";
      return { path: filePath, exists: true, content };
    }

    const files = [];
    for (const p of wanted) files.push(await getGithubContent(p));

    return res.json({ ok: true, slug, files });
  } catch (err) {
    console.error("slug-files error:", err);
    return res.status(500).json({ ok: false, error: err.message || "read failed" });
  }
});

app.post("/patch-slug-github", async (req, res) => {
  try {
    const { slug, html, css, js } = req.body || {};

    const safeSlug = slugify(slug);
    if (!safeSlug) return res.status(400).json({ ok: false, error: "slug requis" });

    const owner = process.env.HUB_REPO_OWNER;
    const repo = process.env.HUB_REPO_NAME;
    const token = process.env.GITHUB_TOKEN;
    if (!owner || !repo || !token) {
      return res.status(500).json({ ok: false, error: "GitHub env missing" });
    }

    // Au moins un des 3 doit être fourni
    const hasAny =
      (typeof html === "string" && html.trim()) ||
      (typeof css === "string" && css.trim()) ||
      (typeof js === "string" && js.trim());

    if (!hasAny) {
      return res.status(400).json({ ok: false, error: "Aucun contenu à patcher" });
    }

    const baseMsg = `Patch ${safeSlug}`;

    // Réutilise upsertGithubFile déjà présent (PUT contents + sha)
    const ops = [];

    if (typeof html === "string" && html.trim()) {
      ops.push(
        upsertGithubFile({
          owner,
          repo,
          token,
          filePath: `${safeSlug}/index.html`,
          content: html,
          message: `${baseMsg} (index.html)`,
        })
      );
    }

    if (typeof css === "string" && css.trim()) {
      ops.push(
        upsertGithubFile({
          owner,
          repo,
          token,
          filePath: `${safeSlug}/styles/main.css`,
          content: css,
          message: `${baseMsg} (main.css)`,
        })
      );
    }

    if (typeof js === "string" && js.trim()) {
      ops.push(
        upsertGithubFile({
          owner,
          repo,
          token,
          filePath: `${safeSlug}/js/main.js`,
          content: js,
          message: `${baseMsg} (main.js)`,
        })
      );
    }

    await Promise.all(ops);

    return res.json({
      ok: true,
      slug: safeSlug,
      publishedUrl: `https://votresite.be/${safeSlug}/`,
      patched: {
        html: !!(typeof html === "string" && html.trim()),
        css: !!(typeof css === "string" && css.trim()),
        js: !!(typeof js === "string" && js.trim()),
      },
    });
  } catch (err) {
    console.error("patch-slug-github error:", err);
    return res.status(500).json({ ok: false, error: err.message || "patch failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});