import cors from "cors";
import express from "express";
import { chromium } from "playwright";

const app = express();
const port = Number(process.env.PORT || 8787);
const allowedOrigin = process.env.APP_ORIGIN;

app.use(cors({
  origin(origin, callback) {
    if (!origin || !allowedOrigin || origin === allowedOrigin || /^http:\/\/localhost:\d+$/.test(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`Origin ${origin} is not allowed by CORS`));
  },
}));
app.use(express.json({ limit: "1mb" }));

function extractScores(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  const candidates = [
    payload.scores,
    payload.Scores,
    payload.rounds,
    payload.Rounds,
    payload.data,
    payload.Data,
    payload.aaData,
    payload.AaData,
    payload.result,
    payload.Result,
    payload.items,
    payload.Items,
    payload.data?.scores,
    payload.Data?.Scores,
    payload.data?.items,
    payload.Data?.Items,
    payload.result?.scores,
    payload.Result?.Scores,
    payload.result?.items,
    payload.Result?.Items,
  ];

  return candidates.find(Array.isArray) ?? [];
}

async function fillFirst(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      const tagName = await locator.evaluate((element) => element.tagName.toLowerCase());
      const inputType = await locator.evaluate((element) => element.getAttribute("type")?.toLowerCase() ?? "");
      if (tagName === "input" && ["button", "submit", "reset", "checkbox", "radio", "hidden"].includes(inputType)) {
        continue;
      }
      await locator.fill(value);
      return true;
    }
  }
  return false;
}

async function describeVisibleControls(page) {
  return page.locator("input, button").evaluateAll((elements) => elements
    .filter((element) => Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length))
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute("type") ?? "",
      id: element.id ?? "",
      name: element.getAttribute("name") ?? "",
      placeholder: element.getAttribute("placeholder") ?? "",
      value: element.getAttribute("value") ?? "",
      text: element.textContent?.trim() ?? "",
    })));
}

async function clickFirst(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      await locator.click();
      return true;
    }
  }
  return false;
}

async function loginIfNeeded(page, login, password) {
  const hasPassword = await page.locator('input[type="password"]:visible').count();
  if (!hasPassword) return;

  const filledLogin = await fillFirst(page, [
    'input[name="ctl45$tbMembershipNumber"]',
    'input[id="ctl45_tbMembershipNumber"]',
    'input[name*="MembershipNumber" i]',
    'input[id*="MembershipNumber" i]',
    'input[name*="membership" i]',
    'input[id*="membership" i]',
    'input[type="email"]',
    'input[name="email"]',
    'input[name="Email"]',
    'input[name="username"]',
    'input[name="Username"]',
    'input[name="UserName"]',
    'input[name="login"]',
    'input[name="Login"]',
    'input[type="text"][id*="email" i]',
    'input[type="email"][id*="email" i]',
    'input[type="text"][id*="user" i]',
    'input[type="text"][id*="login" i]',
    'input:not([type])[id*="email" i]',
    'input:not([type])[id*="user" i]',
    'input:not([type])[id*="login" i]',
    'input:visible:not([type="password"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="hidden"])',
  ], login);

  const filledPassword = await fillFirst(page, [
    'input[type="password"]:visible',
    'input[name="ctl45$tbPassword"]',
    'input[id="ctl45_tbPassword"]',
    'input[name="password"]',
    'input[name="Password"]',
    'input[id*="password" i]',
  ], password);

  if (!filledLogin || !filledPassword) {
    const controls = await describeVisibleControls(page);
    throw new Error(`Could not find Golf Ireland login fields. Visible controls: ${JSON.stringify(controls).slice(0, 1000)}`);
  }

  const clickedSubmit = await clickFirst(page, [
    'input[name="ctl45$btnLogin"]',
    'input[id="ctl45_btnLogin"]',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'a:has-text("Sign in")',
    'a:has-text("Log in")',
  ]);

  if (!clickedSubmit) {
    await page.keyboard.press("Enter");
  }

  await page.waitForLoadState("networkidle").catch(() => {});
}

async function getScoresFromBrowser(page, scoresUrl) {
  const endpointPath = new URL(scoresUrl).pathname.toLowerCase();

  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.toLowerCase() === endpointPath && response.request().method() === "POST";
  }, { timeout: 15000 }).catch(() => null);

  await page.reload({ waitUntil: "networkidle" }).catch(() => {});
  const capturedResponse = await responsePromise;
  if (capturedResponse?.ok()) return capturedResponse.json();

  return page.evaluate(async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: "{}",
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GetMyScores returned ${response.status}: ${text}`);
    }

    return response.json();
  }, scoresUrl);
}

app.post("/sync-golf-ireland", async (req, res) => {
  const {
    login,
    password,
    pageUrl = "https://www.golfireland.ie/my-scores",
    scoresUrl = "https://www.golfireland.ie/api/Score/GetMyScores",
  } = req.body ?? {};

  if (!login || !password) {
    return res.status(400).json({ error: "Missing login or password." });
  }

  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== "false",
  });

  try {
    const page = await browser.newPage();
    await page.goto(pageUrl, { waitUntil: "networkidle" });
    await loginIfNeeded(page, login, password);
    await page.goto(pageUrl, { waitUntil: "networkidle" });

    const payload = await getScoresFromBrowser(page, scoresUrl);
    const scores = extractScores(payload);

    res.json({
      scores,
      raw: payload,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Golf Ireland sync failed." });
  } finally {
    await browser.close();
  }
});

app.listen(port, () => {
  console.log(`Golf Ireland sync server running on http://localhost:${port}`);
});
