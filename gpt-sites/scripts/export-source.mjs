import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
const root = process.cwd();
const files = {};
const directories = new Set(["app", "components", "db", "drizzle", "lib", "server", "scripts", "public", "build", "vendor", "hooks", "legacy-source"]);
const rootFiles = new Set(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "cloudflare-env.d.ts", "vite.config.ts", "next.config.ts", "postcss.config.mjs", "eslint.config.mjs", "drizzle.config.ts", "components.json", "README.md", "REQUIREMENTS.md", "MIGRATION.md", "RESEARCH.md", "VERIFICATION.md", ".gitignore"]);
function walk(directory, prefix) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name.startsWith(".") || entry.name === "source-snapshot.json") continue;
    const relative = prefix + entry.name;
    if (entry.isDirectory()) walk(join(directory, entry.name), relative + "/");
    else if (/\.(tsx?|m?js|json|webmanifest|css|svg|png|webp|woff2?|md|sql|html|py|txt|sh|yml|yaml)$/i.test(entry.name)) files[relative] = readFileSync(join(directory, entry.name));
  }
}
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (entry.isDirectory() && directories.has(entry.name)) walk(join(root, entry.name), entry.name + "/");
  if (entry.isFile() && rootFiles.has(entry.name)) files[entry.name] = readFileSync(join(root, entry.name));
}
files[".openai/hosting.json"] = readFileSync(join(root, ".openai/hosting.json"));
const archive = zipSync(files, { level: 6 });
writeFileSync(join(root, "server/source-snapshot.json"), JSON.stringify({ generatedAt: new Date().toISOString(), files: Object.keys(files).length, archive: Buffer.from(archive).toString("base64") }));
console.log("Prepared downloadable source:", Object.keys(files).length, "files,", archive.byteLength, "bytes; no runtime secrets.");
