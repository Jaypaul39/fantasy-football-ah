/**
 * resize-icons.mjs
 * Downloads the app logo and resizes it to 192x192 and 512x512 for PWA icons.
 * Run once: node src/frontend/scripts/resize-icons.mjs
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { get } from "node:https";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, "../public");

const LOGO_URL = "https://i.imgur.com/0q5bTLj.png";

function downloadFile(url, dest) {
  return new Promise((res, rej) => {
    const file = createWriteStream(dest);
    const request = (u) =>
      get(u, (resp) => {
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
          file.close();
          request(resp.headers.location);
          return;
        }
        if (resp.statusCode !== 200) {
          rej(new Error(`HTTP ${resp.statusCode} downloading ${u}`));
          return;
        }
        resp.pipe(file);
        file.on("finish", () => file.close(res));
      }).on("error", rej);
    request(url);
  });
}

async function main() {
  let sharp;
  try {
    const mod = await import("sharp");
    sharp = mod.default;
  } catch (e) {
    console.error("sharp not available:", e.message);
    process.exit(1);
  }

  mkdirSync(publicDir, { recursive: true });

  const tmpFile = resolve(publicDir, "_logo-source-tmp.png");
  console.log("Downloading logo from", LOGO_URL);
  await downloadFile(LOGO_URL, tmpFile);
  console.log("Downloaded to", tmpFile);

  const out192 = resolve(publicDir, "icon-192.png");
  const out512 = resolve(publicDir, "icon-512.png");

  console.log("Resizing to 192x192 ->", out192);
  await sharp(tmpFile).resize(192, 192, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).toFile(out192);

  console.log("Resizing to 512x512 ->", out512);
  await sharp(tmpFile).resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).toFile(out512);

  // Clean up temp file
  const { unlinkSync } = await import("node:fs");
  try { unlinkSync(tmpFile); } catch {}

  console.log("Done! Icons written:");
  console.log(" ", out192);
  console.log(" ", out512);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
