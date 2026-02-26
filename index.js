require("dotenv").config();

const express = require("express");
const cors = require("cors");
const archiver = require("archiver");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch"); // v2
const { execSync } = require("child_process"); // (si tu l'utilises encore pour autre chose)

const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  cors({
    origin: function (origin, callback) {
      const allowed = ["https://jeveuxunjob.eu", "https://www.jeveuxunjob.eu"];
      if (!origin) return callback(null, true);
      if (allowed.includes(origin)) return callback(null, true);
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
  res.json({ ok: true, service: "orchestrator-api", message: "API is running" });
});

// --- Helpers ---
function slugify(input) {
  return (input || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

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

  return { safeName: safeName || "site-web", files };
}

function generateZipBuffer(files) {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const chunks = [];

    archive.on("warning", (err) => console.warn("Archive warning:", err));
    archive.on("error", (err) => reject(err));
    archive.on("data", (chunk) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));

    for (const file of files) archive.append(file.content, { name: file.name });
    archive.finalize();
  });
}

// --- GitHub helpers (robuste 409) ---
async function upsertGithubFile({ owner, repo, token, filePath, content, message }) {
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
    filePath
  ).replace(/%2F/g, "/")}`;

  const headersGet = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "votresite-hub-publisher",
  };

  const headersPut = {
    ...headersGet,
    "Content-Type": "application/json",
  };

  for (let attempt = 1; attempt <= 5; attempt++) {
    // 1) GET sha (si existe)
    let sha = undefined;
    const getRes = await fetch(apiBase, { method: "GET", headers: headersGet });

    if (getRes.status === 200) {
      const json = await getRes.json();
      sha = json.sha;
    } else if (getRes.status !== 404) {
      const t = await getRes.text();
      throw new Error(`GitHub GET failed (${getRes.status}): ${t}`);
    }

    // 2) PUT with sha (if exists)
    const putRes = await fetch(apiBase, {
      method: "PUT",
      headers: headersPut,
      body: JSON.stringify({
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
        sha,
        branch: "main",
      }),
    });

    if (putRes.ok) return putRes.json();

    // Conflict -> retry
    if (putRes.status === 409 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 150 * attempt));
      continue;
    }

    const errText = await putRes.text();
    throw new Error(`GitHub upsert failed (${putRes.status}): ${errText}`);
  }

  throw new Error("GitHub upsert failed after retries");
}

// --- Leads endpoint (Supabase insert) ---
app.post("/lead", async (req, res) => {
  try {
    const { source, page_url, full_name, email, phone, company, subject, message } =
      req.body || {};

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
      return res.status(500).json({ ok: false, error: "insert failed" });
    }

    return res.json({ ok: true, lead: data?.[0] || null });
  } catch (err) {
    console.error("POST /lead error:", err);
    return res.status(500).json({ ok: false, error: "server error" });
  }
});

// --- ZIP endpoints ---
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

// --- Hub publish (GitHub) ---
app.post("/publish-slug-github", async (req, res) => {
  try {
    const { slug, projectName, html, css, js } = req.body || {};
    const safeSlug = slugify(slug);

    if (!safeSlug) return res.status(400).json({ ok: false, error: "slug requis" });
    if (!html || typeof html !== "string")
      return res.status(400).json({ ok: false, error: "html requis" });

    const owner = process.env.HUB_REPO_OWNER;
    const repo = process.env.HUB_REPO_NAME;
    const token = process.env.GITHUB_TOKEN;
    if (!owner || !repo || !token)
      return res.status(500).json({ ok: false, error: "GitHub env missing" });

    const baseMsg = `Publish ${safeSlug}`;

    const files = [
      { path: `${safeSlug}/index.html`, content: html },
      {
        path: `${safeSlug}/README.txt`,
        content: `# ${projectName || safeSlug}

Publié automatiquement sur https://votresite.be/${safeSlug}/
`,
      },
    ];

    if (typeof css === "string" && css.trim())
      files.push({ path: `${safeSlug}/styles/main.css`, content: css });
    if (typeof js === "string" && js.trim())
      files.push({ path: `${safeSlug}/js/main.js`, content: js });

    // IMPORTANT: séquentiel (évite encore plus les 409)
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

    return res.json({ ok: true, slug: safeSlug, publishedUrl: `https://votresite.be/${safeSlug}/` });
  } catch (err) {
    console.error("publish-slug-github error:", err);
    return res.status(500).json({ ok: false, error: err.message || "publish failed" });
  }
});

// --- Hub read files ---
app.get("/slug-files", async (req, res) => {
  try {
    const slug = slugify(req.query.slug || "");
    if (!slug) return res.status(400).json({ ok: false, error: "slug requis" });

    const owner = process.env.HUB_REPO_OWNER;
    const repo = process.env.HUB_REPO_NAME;
    const token = process.env.GITHUB_TOKEN;
    if (!owner || !repo || !token)
      return res.status(500).json({ ok: false, error: "GitHub env missing" });

    const wanted = [`${slug}/index.html`, `${slug}/styles/main.css`, `${slug}/js/main.js`];

    async function getGithubContent(filePath) {
      const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
        filePath
      ).replace(/%2F/g, "/")}`;

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

// --- Hub patch (GitHub) ---
app.post("/patch-slug-github", async (req, res) => {
  try {
    const { slug, html, css, js } = req.body || {};
    const safeSlug = slugify(slug);
    if (!safeSlug) return res.status(400).json({ ok: false, error: "slug requis" });

    const owner = process.env.HUB_REPO_OWNER;
    const repo = process.env.HUB_REPO_NAME;
    const token = process.env.GITHUB_TOKEN;
    if (!owner || !repo || !token)
      return res.status(500).json({ ok: false, error: "GitHub env missing" });

    const hasAny =
      (typeof html === "string" && html.trim()) ||
      (typeof css === "string" && css.trim()) ||
      (typeof js === "string" && js.trim());

    if (!hasAny) return res.status(400).json({ ok: false, error: "Aucun contenu à patcher" });

    const baseMsg = `Patch ${safeSlug}`;

    // IMPORTANT: séquentiel + upsert avec retry 409
    if (typeof html === "string" && html.trim()) {
      await upsertGithubFile({
        owner,
        repo,
        token,
        filePath: `${safeSlug}/index.html`,
        content: html,
        message: `${baseMsg} (index.html)`,
      });
    }

    if (typeof css === "string" && css.trim()) {
      await upsertGithubFile({
        owner,
        repo,
        token,
        filePath: `${safeSlug}/styles/main.css`,
        content: css,
        message: `${baseMsg} (main.css)`,
      });
    }

    if (typeof js === "string" && js.trim()) {
      await upsertGithubFile({
        owner,
        repo,
        token,
        filePath: `${safeSlug}/js/main.js`,
        content: js,
        message: `${baseMsg} (main.js)`,
      });
    }

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

app.post("/patch-section-github", async (req, res) => {
  try {
    const { slug, section, htmlFragment } = req.body || {};

    const safeSlug = slugify(slug);
    if (!safeSlug) return res.status(400).json({ ok: false, error: "slug requis" });

    const sectionName = slugify(section).replace(/-/g, "");
    if (!sectionName) return res.status(400).json({ ok: false, error: "section requise" });

    if (!htmlFragment || typeof htmlFragment !== "string") {
      return res.status(400).json({ ok: false, error: "htmlFragment requis" });
    }

    const owner = process.env.HUB_REPO_OWNER;
    const repo = process.env.HUB_REPO_NAME;
    const token = process.env.GITHUB_TOKEN;
    if (!owner || !repo || !token) {
      return res.status(500).json({ ok: false, error: "GitHub env missing" });
    }

    // Lire index.html existant via GitHub
    const indexPath = `${safeSlug}/index.html`;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(indexPath).replace(/%2F/g, "/")}`;

    const getRes = await fetch(apiUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "votresite-hub-section-patcher",
      },
    });

    if (!getRes.ok) {
      const t = await getRes.text();
      throw new Error(`GitHub GET index.html failed (${getRes.status}): ${t}`);
    }

    const getJson = await getRes.json();
    const currentHtml = Buffer.from(getJson.content || "", "base64").toString("utf8");

    const startMarker = `<!-- SECTION:${sectionName}:start -->`;
    const endMarker = `<!-- SECTION:${sectionName}:end -->`;

    const startIdx = currentHtml.indexOf(startMarker);
    const endIdx = currentHtml.indexOf(endMarker);

    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
      return res.status(400).json({
        ok: false,
        error: `Section introuvable dans index.html: ${sectionName}`,
      });
    }

    const before = currentHtml.slice(0, startIdx + startMarker.length);
    const after = currentHtml.slice(endIdx);

    const nextHtml = `${before}\n${htmlFragment}\n${after}`;

    // Upsert index.html modifié (réutilise upsertGithubFile déjà présent)
    await upsertGithubFile({
      owner,
      repo,
      token,
      filePath: indexPath,
      content: nextHtml,
      message: `Patch section ${sectionName} (${safeSlug})`,
    });

    return res.json({
      ok: true,
      slug: safeSlug,
      section: sectionName,
      publishedUrl: `https://votresite.be/${safeSlug}/`,
    });
  } catch (err) {
    console.error("patch-section-github error:", err);
    return res.status(500).json({ ok: false, error: err.message || "patch section failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});