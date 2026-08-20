import cors from "cors";
import express from "express";
import { chromium } from "playwright";

const app = express();
const port = Number(process.env.PORT || 8787);
const allowedOrigin = process.env.APP_ORIGIN;
const courseRatingBaseUrl = "https://ncrdb.usga.org";

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

function cookiesFrom(response) {
  const setCookies = response.headers.getSetCookie?.() ?? response.headers.get("set-cookie")?.split(/, (?=[^;,]+=)/) ?? [];
  return setCookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

function stripHtml(value) {
  return String(value ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNineHoleRating(value, fallbackRating, fallbackSlope) {
  const [, visibleRating, visibleSlope] = String(value ?? "").match(/([\d.]+)\s*\/\s*([\d.]+)/) ?? [];
  return {
    rating: Number(visibleRating ?? fallbackRating),
    slope: Number(visibleSlope ?? fallbackSlope),
  };
}

async function getCourseRatingSession() {
  const response = await fetch(`${courseRatingBaseUrl}/`);
  const html = await response.text();
  const token = html.match(/name="__RequestVerificationToken" type="hidden" value="([^"]+)"/)?.[1];
  if (!response.ok || !token) throw new Error("Could not start course rating lookup session.");
  return { token, cookie: cookiesFrom(response) };
}

function parseCourseTeeRows(html) {
  const table = html.match(/<table[^>]+id="gvTee"[\s\S]*?<\/table>/i)?.[0] ?? "";
  const rows = [...table.matchAll(/<tr[^>]*align="center"[^>]*>([\s\S]*?)<\/tr>/gi)];

  return rows.flatMap(([, row]) => {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => stripHtml(match[1]));
    const par = Number(cells[2]);
    const rating = Number(cells[3]);
    const slope = Number(cells[5]);
    const frontNine = parseNineHoleRating(cells[8], cells[6], cells[12]);
    const backNine = parseNineHoleRating(cells[9], cells[7], cells[13]);
    if (!cells[0] || isNaN(rating) || isNaN(slope)) return [];

    const fullRound = {
      tee: cells[0],
      gender: cells[1],
      par: isNaN(par) ? undefined : par,
      rating,
      slope,
      holes: !isNaN(par) && par <= 36 ? "9 holes" : "18 holes",
      frontNine: cells[8] || undefined,
      backNine: cells[9] || undefined,
      length: cells[15] || undefined,
    };

    const nineHoleRounds =
      !isNaN(par) && par > 36
        ? [
            {
              tee: cells[0],
              gender: cells[1],
              rating: frontNine.rating,
              slope: frontNine.slope,
              holes: "Front 9",
              length: undefined,
            },
            {
              tee: cells[0],
              gender: cells[1],
              rating: backNine.rating,
              slope: backNine.slope,
              holes: "Back 9",
              length: undefined,
            },
          ].filter((tee) => !isNaN(tee.rating) && !isNaN(tee.slope))
        : [];

    return [fullRound, ...nineHoleRounds];
  });
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

async function getDisplayName(page) {
  const selectors = [
    ".member-profile",
    "#navbarMemberMenu",
    ".site-header__action.action--primary",
    ".mobile-user",
    ".my-name",
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      const text = (await locator.innerText()).replace(/\s+/g, " ").trim();
      const cleaned = text.replace(/^Welcome\s+/i, "").trim();
      if (cleaned && !/logout|my golf login/i.test(cleaned)) return cleaned;
    }
  }

  return "";
}

function parseCurrentHandicapIndex(bodyText) {
  const lines = bodyText
    .split(/\r?\n/)
    .map((line) => line.replace(/[®™]/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const validIndex = (value) => Number.isFinite(value) && value >= -10 && value <= 54;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/\blow\s+(?:handicap\s+)?index\b/i.test(line)) continue;
    const labelMatch = line.match(/^(?:your\s+)?(?:(?:current\s+)?handicap(?:\s+index)?|h\.?(?:andicap)?\s*i\.?(?:ndex)?)\b\s*[:—-]?\s*(.*)$/i);
    if (!labelMatch) continue;

    const sameLineValue = labelMatch[1].match(/[+−-]?\d+(?:\.\d+)?/)?.[0]?.replace("−", "-");
    if (sameLineValue !== undefined && validIndex(Number(sameLineValue))) return Number(sameLineValue);

    for (let offset = 1; offset <= 3 && index + offset < lines.length; offset += 1) {
      const candidate = lines[index + offset];
      if (/\b(?:low\s+)?(?:handicap\s+)?index\b/i.test(candidate)) break;
      const value = candidate.match(/^[+−-]?\d+(?:\.\d+)?$/)?.[0]?.replace("−", "-");
      if (value !== undefined && validIndex(Number(value))) return Number(value);
    }
  }

  return null;
}

async function handicapIndexOnCurrentPage(page) {
  for (const frame of page.frames()) {
    const bodyText = await frame.locator("body").innerText().catch(() => "");
    const index = parseCurrentHandicapIndex(bodyText);
    if (index !== null) return index;
  }
  return null;
}

async function getCurrentHandicapIndex(page) {
  const currentPageIndex = await handicapIndexOnCurrentPage(page);
  if (currentPageIndex !== null) return currentPageIndex;

  const overviewHref = await page.locator("a").evaluateAll((links) => {
    const normalized = links.map((link) => ({
      href: link.href,
      text: link.textContent?.replace(/\s+/g, " ").trim() ?? "",
    }));
    return normalized.find((link) => /my\s+golf\s+overview/i.test(link.text))?.href
      ?? normalized.find((link) => /\/(?:my-golf|my-golf-overview)\/?(?:[?#].*)?$/i.test(link.href))?.href
      ?? null;
  }).catch(() => null);

  const origin = new URL(page.url()).origin;
  const candidates = [
    overviewHref,
    `${origin}/my-golf`,
    `${origin}/my-golf-overview`,
  ].filter(Boolean);

  for (const url of [...new Set(candidates)]) {
    const response = await page.goto(url, { waitUntil: "networkidle" }).catch(() => null);
    if (!response?.ok()) continue;
    const index = await handicapIndexOnCurrentPage(page);
    if (index !== null) return index;
  }

  return null;
}

app.get("/course-rating/search", async (req, res) => {
  const name = String(req.query.name ?? "").trim();
  const country = String(req.query.country ?? "NIR").trim();
  const city = String(req.query.city ?? "").trim();
  const state = String(req.query.state ?? "(Select)").trim();

  if (name.length < 3 && city.length < 3) {
    return res.status(400).json({ error: "Enter at least 3 characters of a course name or city." });
  }

  try {
    const { token, cookie } = await getCourseRatingSession();
    const body = new URLSearchParams({
      clubName: name,
      clubCity: city,
      clubState: state || "(Select)",
      clubCountry: country || "(Select)",
    });
    const response = await fetch(`${courseRatingBaseUrl}/NCRListing?handler=LoadCourses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": cookie,
        "RequestVerificationToken": token,
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Course search returned ${response.status}: ${text.slice(0, 500)}`);
    }

    const courses = await response.json();
    res.json({ courses: courses.slice(0, 25) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Course rating search failed." });
  }
});

app.get("/course-rating/tees", async (req, res) => {
  const courseId = String(req.query.courseId ?? "").trim();
  if (!courseId) return res.status(400).json({ error: "Missing courseId." });

  try {
    const response = await fetch(`${courseRatingBaseUrl}/courseTeeInfo?CourseID=${encodeURIComponent(courseId)}`);
    const html = await response.text();
    if (!response.ok) throw new Error(`Course tee lookup returned ${response.status}.`);

    const tees = parseCourseTeeRows(html);
    res.json({ tees });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Course tee lookup failed." });
  }
});

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

    const displayName = await getDisplayName(page);
    const payload = await getScoresFromBrowser(page, scoresUrl);
    const scores = extractScores(payload);
    const handicapIndex = await getCurrentHandicapIndex(page);

    res.json({
      scores,
      handicap: handicapIndex === null ? undefined : {
        index: handicapIndex,
        source: "golfIrelandPage",
      },
      profile: {
        displayName,
      },
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
