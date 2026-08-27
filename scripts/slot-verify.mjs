/**
 * Slot verify: the pre-deadline check that what is serving at the judged URL
 * is exactly the intended build and comes up clean. Read-only.
 *
 *   node scripts/slot-verify.mjs            # claude slot vs local dist
 *   URL=... DIST=... node scripts/slot-verify.mjs
 *
 * Verifies: (1) the live page references exactly one bundle and it is the one
 * in local dist/assets; (2) the live bundle's bytes hash-match the local file;
 * (3) the page boots to a ready menu with zero page errors and the canvas at
 * the mandated 1280x720 design resolution.
 */
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import fs from "node:fs";

const URL = process.env.URL ?? "https://app.electricity.studio/glow/claude/";
const log = (m) => console.log(`[verify] ${m}`);
let failed = false;
const bad = (m) => {
  console.error(`[verify] FAIL: ${m}`);
  failed = true;
};

const html = await (await fetch(URL, { cache: "no-store" })).text();
const refs = [...html.matchAll(/assets\/(index-[\w-]+\.js)/g)].map((m) => m[1]);
const uniq = [...new Set(refs)];
if (uniq.length !== 1) bad(`expected exactly one bundle ref, saw: ${uniq.join(", ") || "none"}`);
const bundle = uniq[0];
log(`live page references ${bundle}`);

const localPath = `dist/assets/${bundle}`;
if (!fs.existsSync(localPath)) {
  bad(`local ${localPath} does not exist - live slot is NOT serving this checkout's build`);
} else {
  const live = Buffer.from(await (await fetch(`${URL}assets/${bundle}`, { cache: "no-store" })).arrayBuffer());
  const liveHash = createHash("sha256").update(live).digest("hex");
  const localHash = createHash("sha256").update(fs.readFileSync(localPath)).digest("hex");
  if (liveHash !== localHash) bad(`bundle hash mismatch: live ${liveHash} != local ${localHash}`);
  else log(`bundle hash match: ${liveHash.slice(0, 16)}…`);
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector("body[data-game-ready='true']", { timeout: 60_000 }).catch(() => bad("menu never became ready"));
const size = await page.evaluate(() => {
  const c = document.querySelector("canvas");
  return c ? { w: c.width, h: c.height } : null;
});
if (!size || size.w !== 1280 || size.h !== 720) bad(`canvas is ${size ? `${size.w}x${size.h}` : "missing"}, expected 1280x720`);
else log("canvas at 1280x720, menu ready");
if (pageErrors.length > 0) bad(`page errors: ${pageErrors.join(" | ")}`);
else log("zero page errors");
await browser.close();

if (failed) {
  process.exitCode = 1;
  console.error("[verify] SLOT VERIFY FAILED");
} else {
  log("SLOT VERIFIED CLEAN");
}
