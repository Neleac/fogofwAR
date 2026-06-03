const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const sourceDir = path.join(root, "src");
const outDir = path.join(root, "dist");
const vercelProjectPath = path.join(outDir, ".vercel", "project.json");
const files = [
  "index.html",
  "styles.css",
  "map.js",
  "favicon.png",
  "manifest.webmanifest"
];

let vercelProject = null;
if (fs.existsSync(vercelProjectPath)) {
  vercelProject = fs.readFileSync(vercelProjectPath, "utf8");
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const file of files) {
  fs.copyFileSync(path.join(sourceDir, file), path.join(outDir, file));
}

if (vercelProject) {
  fs.mkdirSync(path.dirname(vercelProjectPath), { recursive: true });
  fs.writeFileSync(vercelProjectPath, vercelProject);
}

console.log(`Built ${files.length} static files to dist/`);
