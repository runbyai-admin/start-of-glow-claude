import { expect, test } from "@playwright/test";

/**
 * The smoke test contestants extend.
 *
 * It answers the only question the owner asks at judging time: does the build
 * actually come up and respond to input? Add your own tests beside it - keep
 * this one passing, a build that fails it is not playable.
 */

function collectConsoleErrors(page: import("@playwright/test").Page): string[] {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    // "Failed to load resource" carries no URL, so bad responses are checked
    // through the response listener below instead.
    if (msg.type() === "error" && !/Failed to load resource/.test(msg.text())) {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));
  // The analytics beacon is fire-and-forget and only accepted from the
  // deployed origins, so its status off-production is not the game's problem.
  page.on("response", (res) => {
    if (res.status() >= 400 && !res.url().includes("/api/marketing/analytics/")) {
      consoleErrors.push(`${res.status()} ${res.url()}`);
    }
  });
  return consoleErrors;
}

test("the title screen comes up with the light pipeline running", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);

  await page.goto("/", { waitUntil: "domcontentloaded" });

  // The scene sets this once its first frame has been rendered.
  await page.waitForSelector("body[data-game-ready='true']", { timeout: 30_000 });
  await expect(page.locator("canvas")).toBeVisible();

  const state = await page.evaluate(() => window.__glow);
  expect(state?.ready).toBe(true);
  expect(state?.scene).toBe("menu");
  expect(state?.lightsActive).toBe(true);

  await page.screenshot({ path: "test-results/menu.png" });
  expect(consoleErrors, `console errors: ${consoleErrors.join(" | ")}`).toEqual([]);
});

test("starting the game loads level 1, and the light-being follows input and collects motes", async ({ page }) => {
  // Headless rendering on this host runs the Light2D level scene at ~5fps
  // (software rasterizer; a real browser with a GPU runs it at full rate),
  // so input processing is frame-bound, not wall-clock-bound. The moves
  // below pace themselves by the page's own frames, and the whole test gets
  // a budget sized for a slow-frame environment instead of a fast one - a
  // 120s budget proved marginal (one pass at 108s, one miss at 120s), so
  // this is deliberately not tight.
  test.setTimeout(180_000);
  const consoleErrors = collectConsoleErrors(page);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("body[data-game-ready='true']", { timeout: 30_000 });

  const canvas = page.locator("canvas");
  let box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  // Round 2: the menu is playable - walking into the beacon starts the game;
  // Enter is the immediate accessibility/test path this spec uses.
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__glow?.scene === "level", { timeout: 15_000 });

  box = await canvas.boundingBox();
  const { x, y, width, height } = box!;

  // Each step waits two rendered frames, then tops up to 90ms of wall time -
  // on a fast machine this is exactly the old 90ms pacing, on a slow one it
  // waits for the game to actually process the movement.
  const step = async (px: number, py: number): Promise<void> => {
    await page.mouse.move(px, py);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await page.waitForTimeout(90);
  };

  // First pass: the opening arc. Level 1 is hand-authored (see levels.ts)
  // and its first five motes line a rising arc from the start point with no
  // hazard anywhere near them - so "the wisp follows input and collects" is
  // provable deterministically here, no hazard-collision luck involved.
  // The camera follows the wisp, so world->screen needs the live scroll
  // offset (estimated from the published wisp position) - a fixed mapping
  // drifts rightward as the camera pans and would steer off the arc.
  const arc: Array<[number, number]> = [
    [250, 460],
    [330, 430],
    [430, 355],
    [545, 305],
    [665, 290],
    [780, 510],
  ];
  for (const [wx, wy] of arc) {
    for (let i = 0; i < 2; i += 1) {
      const glow = await page.evaluate(() => window.__glow);
      const scrollX = Math.min(Math.max((glow?.wispX ?? 0) - 640, 0), 1280);
      const sx = Math.min(Math.max(wx - scrollX, 12), 1268);
      await step(x + (sx * width) / 1280, y + (wy * height) / 720);
    }
  }

  const afterArc = await page.evaluate(() => window.__glow);
  expect(afterArc?.scene).toBe("level");
  expect(afterArc?.level).toBe(1);
  expect(afterArc?.collected, "tracing the opening arc must collect motes").toBeGreaterThan(0);
  expect(afterArc?.glowRadius).toBeGreaterThan(260);

  // Second pass: a broad wave across the rest of the viewport for coverage.
  // This crosses patrol lanes, so a hazard hit (which resets collection) is
  // possible by design - the assertions after it check state consistency,
  // not exact counts.
  for (let i = 0; i <= 24; i += 1) {
    const px = x + (width * i) / 24;
    const py = y + height * (0.25 + 0.5 * Math.abs(Math.sin(i / 3)));
    await step(px, py);
  }
  await page.mouse.click(x + width / 2, y + height / 2);
  await page.waitForTimeout(200);

  const state = await page.evaluate(() => window.__glow);
  expect(state?.scene).toBe("level");
  expect(state?.level).toBe(1);

  // Optional-collection wiring: level 1 opens its beacon at 10 of 14 motes
  // (see levels.ts), and the published beacon state must track that rule
  // whatever the sweep happened to collect.
  expect(state?.required).toBe(10);
  expect(state?.beaconOpen).toBe((state?.collected ?? 0) >= 10);
  expect((state?.collected ?? 0) + (state?.remaining ?? 0)).toBe(14);

  await page.screenshot({ path: "test-results/level-1-after-input.png" });
  expect(consoleErrors, `console errors: ${consoleErrors.join(" | ")}`).toEqual([]);
});
