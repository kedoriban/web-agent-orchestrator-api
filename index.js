const express = require("express");
const cors = require("cors");
const archiver = require("archiver");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "orchestrator-api",
    message: "API is running",
  });
});

app.get("/build-test-zip", (req, res) => {
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", "attachment; filename=test-site.zip");

  const archive = archiver("zip", { zlib: { level: 9 } });

  archive.on("error", (err) => {
    console.error("Archive error:", err);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: "ZIP generation failed" });
    }
  });

  archive.pipe(res);

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Test ZIP Builder</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f7fb; color: #1f2937; }
    .card { background: #fff; padding: 24px; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.08); max-width: 560px; text-align: center; }
    h1 { margin-top: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>ZIP généré par l'API</h1>
    <p>Ton orchestrator Node.js fonctionne.</p>
    <p>Prochaine étape : générer le ZIP à partir d'un brief JSON.</p>
  </div>
</body>
</html>`;

  archive.append(html, { name: "index.html" });
  archive.finalize();
});

/**
 * POST /build-site-zip
 * Body JSON attendu (minimal):
 * {
 *   "projectName": "Mon site",
 *   "html": "<!DOCTYPE html>...",
 *   "css": "body { ... }",
 *   "js": "console.log('hello')"
 * }
 */
app.post("/build-site-zip", (req, res) => {
  const { projectName, html, css, js } = req.body || {};

  if (!html || typeof html !== "string") {
    return res.status(400).json({
      ok: false,
      error: "Le champ 'html' est requis (string).",
    });
  }

  const safeName = (projectName || "site-web")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=${safeName || "site-web"}.zip`
  );

  const archive = archiver("zip", { zlib: { level: 9 } });

  archive.on("error", (err) => {
    console.error("Archive error:", err);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: "ZIP generation failed" });
    }
  });

  archive.pipe(res);

  // Structure simple et éditable
  archive.append(html, { name: "index.html" });

  if (typeof css === "string" && css.trim()) {
    archive.append(css, { name: "styles/main.css" });
  }

  if (typeof js === "string" && js.trim()) {
    archive.append(js, { name: "js/main.js" });
  }

  // Petit README utile (optionnel mais pratique)
  const readme = `# ${projectName || "Site web"}

Ce ZIP a été généré par l'orchestrator API.

Structure:
- index.html
- styles/main.css (si fourni)
- js/main.js (si fourni)

Déploiement rapide (Netlify):
1. Dézipper
2. Vérifier que index.html est à la racine
3. Glisser-déposer le dossier sur Netlify (Manual deploy)
`;

  archive.append(readme, { name: "README.txt" });

  archive.finalize();
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});