import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { db } from "./db";
import { useLiveQuery } from "dexie-react-hooks";

function isNineHoleScore(score) {
  return Number(score) < 70;
}

function differential(score, rating, slope, pcc = 0, forceNineHole = null) {
  if (score === null || score === undefined || score === "") return null;
  const s = Number(score), r = Number(rating), sl = Number(slope), p = Number(pcc || 0);
  if (isNaN(s) || isNaN(r) || isNaN(sl)) return null;
  // 9-hole differentials are doubled to produce an 18-hole equivalent (WHS)
  const d = ((s - r - p) * 113) / sl;
  return (forceNineHole ?? isNineHoleScore(s)) ? d * 2 : d;
}

function scoreDifferentialForRound(round) {
  const apiDifferential = Number(round?.scoreDifferential);
  if (!isNaN(apiDifferential)) return apiDifferential;
  return differential(round?.score, round?.rating, round?.slope, round?.pcc, isNineHoleRound(round));
}

const r1 = (v) => Math.round(v * 10) / 10;
const golfIrelandSettingsKey = "golfIreland";
const golfIrelandSyncEndpoint = import.meta.env.VITE_GOLF_IRELAND_SYNC_URL ?? "";

function handicap(diffs) {
  const best = [...diffs].sort((a, b) => a - b).slice(0, 8);
  return r1(best.reduce((a, b) => a + b, 0) / 8);
}

function exceptionalScoreReduction(scoreDiff, handicapIndex) {
  const diff = Number(scoreDiff), index = Number(handicapIndex);
  if (isNaN(diff) || isNaN(index)) return 0;
  if (diff <= index - 10) return 2;
  if (diff <= index - 7) return 1;
  return 0;
}

function scoreForDifferential(diff, rating, slope, pcc = 0, isNineHoleRound = false) {
  const d = Number(diff), r = Number(rating), sl = Number(slope), p = Number(pcc || 0);
  if (isNaN(d) || isNaN(r) || isNaN(sl)) return null;
  const courseDiff = isNineHoleRound ? d / 2 : d;
  return (courseDiff * sl) / 113 + r + p;
}

function courseTeeLabel(course) {
  if (!course) return "";
  const base = course.course ?? "";
  const tee = course.tee;
  return `${base}${tee ? ` - ${tee}` : ""}${course.holes ? ` - ${course.holes}` : ""}`;
}

function courseParts(round) {
  if (!round) return { course: "", tee: "" };
  if (round.tee) return { course: round.course ?? "", tee: round.tee };
  const parts = String(round.course ?? "").split(" - ");
  if (parts.length < 2) return { course: round.course ?? "", tee: "" };
  return { course: parts[0], tee: parts.slice(1).join(" - ") };
}

function hasTeeColour(course) {
  return /\b(black|blue|bronze|gold|green|grey|gray|orange|purple|red|silver|white|yellow)\b/i.test(courseTeeLabel(course));
}

function shouldHideUncolouredCourse(course) {
  if (!course?.course || hasTeeColour(course)) return false;
  if (/\bmalone\b/i.test(course.course)) return true;
  return /\bclandeboye\b/i.test(course.course) && isNineHoleCourse(course);
}

function isHolywoodRating699(course) {
  return /\bholywood\b/i.test(course?.course ?? "") && Number(course?.rating) === 69.9;
}

function shouldHideCourse(course) {
  return shouldHideUncolouredCourse(course) || isHolywoodRating699(course);
}

function coursePresetKey(course) {
  return `${courseTeeLabel(course).trim().toLowerCase()}-${Number(course.rating)}-${Number(course.slope)}`;
}

function isNineHoleCourse(course) {
  return /\b9\b|nine/i.test(course?.holes ?? "") ||
    /\b9\s*hole\b|nine\s*hole/i.test(course?.course ?? "");
}

function isNineHoleRound(round) {
  return isNineHoleCourse(round) || isNineHoleScore(round?.score);
}

function coursePar(course) {
  const par = Number(course?.par);
  if (!isNaN(par) && par > 0) return par;
  if (/\bknock\b/i.test(course?.course ?? "")) return isNineHoleCourse(course) ? 35 : 70;
  return null;
}

function courseHandicapFor(index, course) {
  const hi = Number(index), rating = Number(course?.rating), slope = Number(course?.slope), par = coursePar(course);
  if (isNaN(hi) || isNaN(slope)) return null;
  const ratingAdjustment = !isNaN(rating) && par !== null ? rating - par : 0;
  return Math.round((hi * slope) / 113 + ratingAdjustment);
}

const neutralButtonStyle = {
  ...btnStyle("#f8fafc", "#0f172a"),
  border: "1px solid #cbd5e1",
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function shortDate(value) {
  if (!value || value === "Start") return value || "";
  const date = new Date(`${value}T00:00:00`);
  if (isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
}

function clamp20(arr) {
  return arr.length <= 20 ? arr : arr.slice(arr.length - 20);
}

function normalizeDate(value, fallback = todayISO()) {
  if (!value) return fallback;

  const raw = String(value).replace(/<[^>]*>/g, "").trim();
  if (!raw) return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const aspNetDate = raw.match(/\/Date\((-?\d+)(?:[+-]\d+)?\)\//i);
  if (aspNetDate) {
    const date = new Date(Number(aspNetDate[1]));
    return isNaN(date.getTime()) ? fallback : date.toISOString().slice(0, 10);
  }

  const dayFirstParts = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/);
  if (dayFirstParts) {
    const [, day, month, year] = dayFirstParts;
    const fullYear = year.length === 2 ? `20${year}` : year;
    return `${fullYear}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const unixTimestamp = raw.match(/^\d{10,13}$/);
  if (unixTimestamp) {
    const numeric = Number(raw);
    const date = new Date(raw.length === 10 ? numeric * 1000 : numeric);
    return isNaN(date.getTime()) ? fallback : date.toISOString().slice(0, 10);
  }

  const date = new Date(raw);
  if (!isNaN(date.getTime())) return date.toISOString().slice(0, 10);

  return fallback;
}

function valueForKey(record, key) {
  if (!record || typeof record !== "object") return undefined;
  if (key.includes(".")) {
    return key.split(".").reduce((current, part) => valueForKey(current, part), record);
  }
  if (record[key] !== undefined) return record[key];
  const lowerKey = key.toLowerCase();
  const match = Object.keys(record).find((candidate) => candidate.toLowerCase() === lowerKey);
  return match ? record[match] : undefined;
}

function firstValue(record, keys) {
  for (const key of keys) {
    const value = valueForKey(record, key);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function firstDateValue(record, keys) {
  const explicit = firstValue(record, keys);
  if (explicit) return explicit;
  if (!record || typeof record !== "object") return "";
  const dateKey = Object.keys(record).find((key) => /date|played/i.test(key) && record[key] !== undefined && record[key] !== null && record[key] !== "");
  return dateKey ? record[dateKey] : "";
}

function cleanNumber(value) {
  if (value === undefined || value === null || value === "") return NaN;
  if (typeof value === "number") return value;
  const normalized = String(value).replace(/<[^>]*>/g, "").match(/-?\d+(\.\d+)?/);
  return normalized ? Number(normalized[0]) : NaN;
}

function cleanText(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/<[^>]*>/g, "").trim();
}

function normalizeGolfIrelandRound(record) {
  const marker = record?.marker ?? {};
  const courseInfo = record?.course ?? record?.Course ?? record?.courseInfo ?? record?.CourseInfo ?? {};
  const teeInfo = record?.tee ?? record?.Tee ?? record?.marker ?? record?.Marker ?? {};
  const scoreValue = firstValue(record, [
    "score",
    "Score",
    "adjustedGrossScore",
    "AdjustedGrossScore",
    "adjustedGross",
    "AdjustedGross",
    "grossScore",
    "GrossScore",
    "gross",
    "Gross",
    "ags",
    "AGS",
    "scoreSubmitted",
    "ScoreSubmitted",
    "strokes",
    "Strokes",
  ]);
  const numericScore = cleanNumber(scoreValue);
  const scoreMarker = cleanText(scoreValue);
  const scoreDifferential = cleanNumber(firstValue(record, [
    "scoreDifferentialPostPCC",
    "ScoreDifferentialPostPCC",
    "scoreDifferentialPrePCC",
    "ScoreDifferentialPrePCC",
    "scoreDifferential",
    "ScoreDifferential",
    "differential",
    "Differential",
    "hcDiff",
    "HCDiff",
    "handicapDifferential",
    "HandicapDifferential",
    "sd",
    "SD",
  ]));
  const rating = cleanNumber(firstValue(record, [
    "rating",
    "Rating",
    "courseRating",
    "CourseRating",
    "course_rating",
    "cr",
    "CR",
    "sss",
    "SSS",
    "tee.courseRating",
    "marker.courseRating",
    "course.courseRating",
  ]) || marker.courseRating || teeInfo.courseRating || courseInfo.courseRating);
  const slope = cleanNumber(firstValue(record, [
    "slope",
    "Slope",
    "slopeRating",
    "SlopeRating",
    "slope_rating",
    "tee.slopeRating",
    "marker.slope",
    "marker.slopeRating",
    "course.slope",
    "course.slopeRating",
  ]) || marker.slope || marker.slopeRating || teeInfo.slope || teeInfo.slopeRating || courseInfo.slope || courseInfo.slopeRating);
  if (isNaN(numericScore) && isNaN(scoreDifferential)) return null;
  if (isNaN(scoreDifferential) && (isNaN(rating) || isNaN(slope))) return null;

  const holesValue = String(firstValue(record, ["holes", "Holes", "roundHoles", "RoundHoles", "noOfHoles", "NoOfHoles", "numberOfHoles", "NumberOfHoles"])).toLowerCase();
  const holesPlayed = cleanNumber(firstValue(record, ["holesPlayed", "HolesPlayed", "noOfHoles", "NoOfHoles", "numberOfHoles", "NumberOfHoles"]));
  const isNineHoleGolfIrelandRound = Boolean(record?.IsNineHole ?? record?.isNineHole ?? marker.isNineHole);
  const holes = isNineHoleGolfIrelandRound || holesPlayed === 9 || holesValue.includes("9") || (!isNaN(numericScore) && numericScore < 70) ? "9 holes" : "18 holes";
  const courseName = firstValue(record, [
    "courseName",
    "CourseName",
    "venue",
    "Venue",
    "club",
    "Club",
    "clubName",
    "ClubName",
    "golfClubName",
    "GolfClubName",
    "course.name",
    "Course.Name",
    "course",
    "Course",
  ]) || marker.course || courseInfo.name || courseInfo.courseName || "Golf Ireland score";
  const markerNameValue = firstValue(record, [
    "marker",
    "Marker",
    "markerName",
    "MarkerName",
    "tee",
    "Tee",
    "teeName",
    "TeeName",
    "teeColour",
    "TeeColour",
    "teeColor",
    "TeeColor",
  ]) || marker.name || teeInfo.name;
  const tee = cleanText(markerNameValue);
  const course = cleanText(courseName) || "Golf Ireland score";
  const playedAt = firstDateValue(record, [
    "playedAtLocal",
    "PlayedAtLocal",
    "playedAtUTC",
    "PlayedAtUTC",
    "playedAt",
    "PlayedAt",
    "date",
    "Date",
    "dateString",
    "DateString",
    "playedOn",
    "PlayedOn",
    "playedDate",
    "PlayedDate",
    "playedDateString",
    "PlayedDateString",
    "datePlayed",
    "DatePlayed",
    "datePlayedString",
    "DatePlayedString",
    "roundDate",
    "RoundDate",
    "roundDateString",
    "RoundDateString",
    "scoreDate",
    "ScoreDate",
    "scoreDateString",
    "ScoreDateString",
    "competitionDate",
    "CompetitionDate",
    "competitionDateString",
    "CompetitionDateString",
    "SubmittedDate",
    "submittedDate",
  ]);
  const normalizedPlayedAt = normalizeDate(playedAt, "");
  const displayScore = isNaN(numericScore) ? scoreMarker || (record?.HideAdjustedGrossScores ? "*" : "—") : numericScore;
  const sourceId = String(firstValue(record, ["scoreUID", "ScoreUID", "id", "Id", "scoreId", "ScoreId", "roundId", "RoundId", "competitionId", "CompetitionId"]) || `${normalizedPlayedAt}-${course}-${displayScore}-${rating}-${slope}`);

  return {
    date: normalizedPlayedAt,
    course,
    tee,
    holes,
    score: displayScore,
    rating: isNaN(rating) ? undefined : rating,
    slope: isNaN(slope) ? undefined : slope,
    pcc: cleanNumber(firstValue(record, ["pcc", "Pcc", "PCC", "playingConditionsCalculation", "PlayingConditionsCalculation"])) || 0,
    courseHandicap: cleanNumber(firstValue(record, ["courseHandicap", "CourseHandicap"])) || undefined,
    handicapIndex: cleanNumber(firstValue(record, ["handicapIndex", "HandicapIndex"])) || undefined,
    scoreDifferential: isNaN(scoreDifferential) ? undefined : scoreDifferential,
    source: "golfIreland",
    sourceId,
  };
}

function syncSampleMessage(rawScores) {
  const sample = Array.isArray(rawScores) ? rawScores[0] : rawScores;
  if (!sample || typeof sample !== "object") return "No complete Golf Ireland scores were returned.";
  return `No complete Golf Ireland scores were returned. First row fields: ${Object.keys(sample).slice(0, 20).join(", ") || "none"}.`;
}

function extractArrayFromPayload(payload, paths) {
  for (const path of paths) {
    const value = path.split(".").reduce((current, part) => current?.[part], payload);
    if (Array.isArray(value)) return value;
  }
  return [];
}

function handicapHistoryFromRounds(rounds) {
  return rounds
    .map((round) => {
      const value = Number(round.handicapIndex);
      if (!round.date || isNaN(value)) return null;
      return {
        date: round.date,
        value: r1(value),
        source: "golfIreland",
        displayIndex: round.handicapIndex,
      };
    })
    .filter(Boolean);
}

function roundImportKey(round) {
  return round.sourceId
    ? `${round.source}:${round.sourceId}`
    : `${round.date}-${round.course}-${round.score}-${round.rating}-${round.slope}`;
}

function LineChart({ points }) {
  if (points.length < 2) return (
    <div className="flex items-center justify-center h-24 text-sm" style={{ color: "var(--text)" }}>
      Need at least two Golf Ireland handicap index points
    </div>
  );

  const values = points.map((point) => point.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const width = 720;
  const height = 180;
  const padX = 40;
  const padTop = 30;
  const padBottom = 46;

  const pts = values.map((v, i) => {
    const x = padX + (i / (values.length - 1)) * (width - padX * 2);
    const y = padTop + (1 - (v - min) / range) * (height - padTop - padBottom);
    return [x, y];
  });

  const polyline = pts.map((p) => p.join(",")).join(" ");
  const baseY = height - padBottom;
  const area = `${pts[0][0]},${baseY} ${polyline} ${pts[pts.length - 1][0]},${baseY}`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height: 168, display: "block" }} role="img" aria-label="Handicap progression chart">
      <defs>
        <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22c55e" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#22c55e" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon fill="url(#chartGrad)" points={area} />
      <line x1={padX} y1={baseY} x2={width - padX} y2={baseY} stroke="var(--table-border)" strokeWidth="1" />
      <polyline fill="none" stroke="#22c55e" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" points={polyline} />
      {pts.map(([x, y], i) => (
        <g key={`${points[i].date}-${i}`}>
          <circle cx={x} cy={y} r="4" fill="#22c55e" stroke="var(--card-bg)" strokeWidth="2" />
          <text x={x} y={Math.max(14, y - 10)} textAnchor="middle" style={{ fill: "var(--text-h)", fontSize: 13, fontWeight: 800 }}>
            {points[i].value.toFixed(1)}
          </text>
          <text x={x} y={height - 18} textAnchor="middle" style={{ fill: "var(--text)", fontSize: 11, fontWeight: 600 }}>
            {shortDate(points[i].date)}
          </text>
        </g>
      ))}
    </svg>
  );
}

function HelpTip({ text, align = "left" }) {
  return (
    <span className="help-tip" style={{ "--tip-left": align === "right" ? "auto" : "0", "--tip-right": align === "right" ? "0" : "auto" }}>
      <button type="button" aria-label={text} title={text}>?</button>
      <span role="tooltip">{text}</span>
    </span>
  );
}

function LabelWithHelp({ children, help, align }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {children}
      {help && <HelpTip text={help} align={align} />}
    </span>
  );
}

function SectionIntro({ title, children, help }) {
  return (
    <div>
      <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-h)", margin: "0 0 2px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
        <LabelWithHelp help={help}>{title}</LabelWithHelp>
      </h2>
      {children && (
        <p style={{ fontSize: 12, color: "var(--text)", margin: 0 }}>
          {children}
        </p>
      )}
    </div>
  );
}

function StatCard({ label, value, sub, accent, help }) {
  return (
    <div style={{
      background: accent ? "linear-gradient(135deg, #166534 0%, #15803d 100%)" : "var(--card-bg)",
      border: accent ? "none" : "1px solid var(--border)",
      boxShadow: "var(--shadow)",
      borderRadius: 16,
      padding: "20px 22px",
      display: "flex",
      flexDirection: "column",
      gap: 6,
    }}>
      <span style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: accent ? "rgba(255,255,255,0.65)" : "var(--text)",
      }}>
        <LabelWithHelp help={help}>{label}</LabelWithHelp>
      </span>
      <span style={{
        fontSize: 36,
        fontWeight: 700,
        letterSpacing: "-0.03em",
        lineHeight: 1.1,
        color: accent ? "#fff" : "var(--text-h)",
      }}>
        {value ?? "—"}
      </span>
      {sub && (
        <span style={{
          fontSize: 12,
          color: accent ? "rgba(255,255,255,0.55)" : "var(--text)",
          marginTop: 2,
        }}>
          {sub}
        </span>
      )}
    </div>
  );
}

function InputField({ label, help, wrapperStyle, ...props }) {
  return (
    <div className="flex flex-col gap-1" style={wrapperStyle}>
      {label && (
        <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text)" }}>
          <LabelWithHelp help={help}>{label}</LabelWithHelp>
        </label>
      )}
      <input
        {...props}
        title={props.title ?? help}
        className="rounded-lg px-3 py-2 text-sm w-full outline-none transition-all"
        style={{
          background: "var(--input-bg)",
          border: "1px solid var(--border)",
          color: "var(--text-h)",
        }}
        onFocus={(e) => { e.target.style.borderColor = "#22c55e"; e.target.style.boxShadow = "0 0 0 3px rgba(34,197,94,0.15)"; }}
        onBlur={(e) => { e.target.style.borderColor = "var(--border)"; e.target.style.boxShadow = "none"; }}
      />
    </div>
  );
}

export default function App() {
  const [target, setTarget] = useState(8);
  const [planner, setPlanner] = useState({ course: "", rating: "", slope: "", pcc: 0 });
  const [courseHandicapCourse, setCourseHandicapCourse] = useState({ course: "", rating: "", slope: 113, pcc: 0 });
  const [showExcludedRounds, setShowExcludedRounds] = useState(false);
  const [golfIrelandSettings, setGolfIrelandSettings] = useState({ login: "", password: "" });
  const [syncState, setSyncState] = useState({ status: "idle", message: "" });

  const queriedRounds = useLiveQuery(() => db.rounds.orderBy("date").toArray(), []);
  const queriedHandicapHistory = useLiveQuery(() => db.handicapHistory.orderBy("date").toArray(), []);
  const rounds = useMemo(() => queriedRounds ?? [], [queriedRounds]);
  const syncedHandicapHistory = useMemo(() => queriedHandicapHistory ?? [], [queriedHandicapHistory]);

  useEffect(() => {
    db.settings.get("targetHandicap").then((setting) => {
      if (setting && setting.value !== undefined) setTarget(Number(setting.value));
    });
    db.settings.get(golfIrelandSettingsKey).then((setting) => {
      if (setting?.value) {
        setGolfIrelandSettings({
          login: setting.value.login ?? "",
          password: setting.value.password ?? "",
        });
      }
    });
  }, []);

  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || rounds.length === 0) return;
    seeded.current = true;
    const last = rounds[rounds.length - 1];
    setPlanner({ course: last.course, holes: last.holes ?? "", par: last.par ?? "", rating: last.rating, slope: last.slope, pcc: last.pcc ?? 0 });
  }, [rounds]);

  // WHS uses the most recent 20 rounds; pair each with its id so we can mark rows
  const clampedWithDiff = useMemo(() =>
    clamp20(rounds).map((r) => ({ id: r.id, d: scoreDifferentialForRound(r) })).filter(({ d }) => d !== null),
    [rounds]
  );
  const diffs = useMemo(() => clampedWithDiff.map(({ d }) => d), [clampedWithDiff]);

  const apiHandicapIndex = useMemo(() => {
    const latest = syncedHandicapHistory[syncedHandicapHistory.length - 1];
    const value = Number(latest?.value);
    return isNaN(value) ? null : value;
  }, [syncedHandicapHistory]);
  const calculatedHcp = diffs.length >= 8 ? handicap(diffs) : null;
  const hcp = apiHandicapIndex ?? calculatedHcp;
  const cutLine = useMemo(() => {
    if (!hcp) return null;
    const sorted = [...clampedWithDiff].sort((a, b) => a.d - b.d).slice(0, 8);
    return Math.max(...sorted.map(({ d }) => d));
  }, [hcp, clampedWithDiff]);
  const countingIds = useMemo(() => {
    if (!hcp) return new Set();
    return new Set([...clampedWithDiff].sort((a, b) => a.d - b.d).slice(0, 8).map(({ id }) => id));
  }, [hcp, clampedWithDiff]);

  const displayedRounds = [...rounds].reverse();

  const hcpHist = syncedHandicapHistory;

  const updateTarget = async (value) => {
    const nextTarget = value === "" ? "" : Number(value);
    setTarget(nextTarget);
    if (nextTarget === "") {
      await db.settings.delete("targetHandicap");
      return;
    }
    if (nextTarget !== "" && !isNaN(nextTarget)) {
      await db.settings.put({ key: "targetHandicap", value: nextTarget });
    }
  };

  const saveGolfIrelandSettings = async () => {
    await db.settings.put({ key: golfIrelandSettingsKey, value: golfIrelandSettings });
    setSyncState({ status: "saved", message: "Golf Ireland login settings saved locally in this browser." });
  };

  const syncFromGolfIreland = async () => {
    const login = golfIrelandSettings.login.trim();
    const password = golfIrelandSettings.password;
    if (!login || !password) {
      setSyncState({ status: "error", message: "Enter your Golf Ireland username and password first." });
      return;
    }
    if (!golfIrelandSyncEndpoint) {
      setSyncState({
        status: "error",
        message: "Set VITE_GOLF_IRELAND_SYNC_URL to your private username/password sync endpoint before syncing.",
      });
      return;
    }

    setSyncState({ status: "syncing", message: "Contacting Golf Ireland sync endpoint..." });
    try {
      const response = await fetch(golfIrelandSyncEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          login,
          password,
          pageUrl: "https://www.golfireland.ie/my-scores",
          scoresUrl: "https://www.golfireland.ie/api/Score/GetMyScores",
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Sync endpoint returned ${response.status}${detail ? `: ${detail}` : ""}`);
      }

      const payload = await response.json();
      const rawScores = Array.isArray(payload) ? payload : extractArrayFromPayload(payload, [
        "scores",
        "Scores",
        "rounds",
        "Rounds",
        "data",
        "Data",
        "aaData",
        "AaData",
        "items",
        "Items",
        "result",
        "Result",
        "handicapRecord.scores",
        "handicapRecord.Scores",
        "raw.scores",
        "raw.Scores",
        "raw.rounds",
        "raw.Rounds",
        "raw.data",
        "raw.Data",
        "raw.aaData",
        "raw.AaData",
        "raw.items",
        "raw.Items",
        "raw.result",
        "raw.Result",
      ]);
      const importedRounds = rawScores.map(normalizeGolfIrelandRound).filter(Boolean);
      const importedHandicapHistory = (payload.handicapHistory ?? payload.handicapIndexes ?? payload.history ?? [])
        .map((entry) => {
          const value = Number(firstValue(entry, ["value", "index", "handicapIndex", "handicap", "hi"]));
          if (isNaN(value)) return null;
          return {
            date: normalizeDate(firstValue(entry, ["date", "effectiveDate", "revisionDate", "updatedOn"])),
            value: r1(value),
            source: "golfIreland",
            displayIndex: entry.displayIndex,
          };
        })
        .filter(Boolean);
      importedHandicapHistory.push(...handicapHistoryFromRounds(importedRounds));

      const currentHandicap = payload.handicap ?? payload.handicapRecord?.handicap;
      if (currentHandicap?.index !== undefined && currentHandicap?.index !== null) {
        importedHandicapHistory.push({
          date: todayISO(),
          value: r1(Number(currentHandicap.index)),
          source: "golfIreland",
          displayIndex: currentHandicap.displayIndex,
        });
      }

      if (importedRounds.length === 0) {
        setSyncState({ status: "error", message: syncSampleMessage(rawScores) });
        return;
      }

      const uniqueRounds = [...new Map(importedRounds.map((round) => [roundImportKey(round), round])).values()];
      const uniqueHistory = [...new Map(importedHandicapHistory.map((entry) => [entry.date, entry])).values()];
      await db.transaction("rw", db.rounds, db.courses, db.handicapHistory, async () => {
        await Promise.all([db.rounds.clear(), db.courses.clear(), db.handicapHistory.clear()]);
        if (uniqueRounds.length > 0) await db.rounds.bulkAdd(uniqueRounds);
        if (uniqueHistory.length > 0) await db.handicapHistory.bulkAdd(uniqueHistory);
      });

      setSyncState({
        status: "success",
        message: `Synced ${uniqueRounds.length} Golf Ireland round${uniqueRounds.length === 1 ? "" : "s"}${uniqueHistory.length ? ` and ${uniqueHistory.length} official handicap index point${uniqueHistory.length === 1 ? "" : "s"}` : ""}. Local cache was replaced.`,
      });
    } catch (error) {
      setSyncState({ status: "error", message: error instanceof Error ? error.message : "Golf Ireland sync failed." });
    }
  };

  const reqDiff = target !== "" && !isNaN(Number(target)) ? Number(target) : null;

  const coursePresets = useMemo(() => {
    const byKey = new Map();
    rounds.forEach((r) => {
      if (!r.course || !r.rating || !r.slope) return;
      if (shouldHideCourse(r)) return;
      byKey.set(coursePresetKey(r), {
        course: r.course,
        holes: r.holes ?? "",
        rating: r.rating,
        slope: r.slope,
        par: r.par,
        pcc: r.pcc ?? 0,
      });
    });
    const presets = [...byKey.values()].reverse();

    const uniqueByLabel = new Map();
    presets.forEach((preset) => {
      const key = coursePresetKey(preset);
      if (!uniqueByLabel.has(key)) uniqueByLabel.set(key, preset);
    });

    return [...uniqueByLabel.values()].sort((a, b) => {
      const aLabel = courseTeeLabel(a).toLowerCase();
      const bLabel = courseTeeLabel(b).toLowerCase();
      const aIsHome = aLabel.includes("knock");
      const bIsHome = bLabel.includes("knock");
      if (aIsHome !== bIsHome) return aIsHome ? -1 : 1;
      return aLabel.localeCompare(bLabel);
    });
  }, [rounds]);

  const courseHandicapCourseSeeded = useRef(false);
  useEffect(() => {
    if (courseHandicapCourseSeeded.current || coursePresets.length === 0) return;
    courseHandicapCourseSeeded.current = true;
    const knockWhite = coursePresets.find((preset) => {
      const label = courseTeeLabel(preset).toLowerCase();
      return label.includes("knock") && label.includes("white");
    });
    setCourseHandicapCourse(knockWhite ?? coursePresets[0]);
  }, [coursePresets]);

  const courseHandicap = hcp ? courseHandicapFor(hcp, courseHandicapCourse) : null;

  const plannerRows = useMemo(() => {
    if (!planner.course || !planner.rating || !planner.slope) return [];
    if (reqDiff === null) return [];
    const plannerIsNineHole = isNineHoleCourse(planner);
    const targetExact = scoreForDifferential(reqDiff, planner.rating, planner.slope, planner.pcc, plannerIsNineHole);
    if (targetExact === null) return [];

    const projectScore = (score) => {
      const safeScore = Math.max(1, score);
      const actualDiff = differential(safeScore, planner.rating, planner.slope, planner.pcc, plannerIsNineHole);
      const nextWithMarker = actualDiff !== null
        ? clamp20([...diffs.map((d) => ({ d, isNew: false })), { d: actualDiff, isNew: true }])
        : [];
      const bestAfter = nextWithMarker.length >= 8
        ? [...nextWithMarker].sort((a, b) => a.d - b.d).slice(0, 8)
        : [];
      const projectedHcp = bestAfter.length >= 8 ? r1(bestAfter.reduce((sum, item) => sum + item.d, 0) / 8) : null;
      const counts = bestAfter.some((item) => item.isNew);
      const esrReduction = hcp !== null ? exceptionalScoreReduction(actualDiff, hcp) : 0;
      const projectedHcpWithEsr = projectedHcp !== null ? r1(projectedHcp - esrReduction) : null;
      const change = hcp !== null && projectedHcpWithEsr !== null ? r1(projectedHcpWithEsr - hcp) : null;
      return {
        score: safeScore,
        actualDiff,
        projectedHcp,
        projectedHcpWithEsr,
        esrReduction,
        counts,
        change,
      };
    };

    const targetScore = Math.floor(targetExact);
    const esrOneScore = hcp !== null
      ? Math.floor(scoreForDifferential(hcp - 7, planner.rating, planner.slope, planner.pcc, plannerIsNineHole) ?? NaN)
      : null;
    const esrTwoScore = hcp !== null
      ? Math.floor(scoreForDifferential(hcp - 10, planner.rating, planner.slope, planner.pcc, plannerIsNineHole) ?? NaN)
      : null;

    const rows = [];
    const scores = new Set();
    const addRow = (score, outcome) => {
      if (score === null || isNaN(Number(score)) || scores.has(score)) return;
      scores.add(score);
      rows.push({ ...projectScore(score), outcome, targetScore });
    };
    const labelsByOffset = new Map([
      [-2, "Accelerator"],
      [-1, "Accelerator"],
      [0, "Target"],
      [1, "Useful"],
      [2, "Useful"],
      [3, "Useful"],
    ]);

    for (let offset = -2; offset <= 3; offset++) {
      const score = targetScore + offset;
      const row = projectScore(score);
      addRow(score, row.counts && row.change > 0 ? "Increase" : labelsByOffset.get(offset));
    }

    addRow(esrTwoScore, "ESR -2.0");
    addRow(esrOneScore, "ESR -1.0");

    for (let score = targetScore + 4; score <= targetScore + 40; score++) {
      const row = projectScore(score);
      if (!row.counts) {
        addRow(score, "Cut line");
        break;
      }
      addRow(score, row.change > 0 ? "Increase" : "Useful");
    }

    return rows.sort((a, b) => a.score - b.score);
  }, [reqDiff, planner, diffs, hcp]);

  const courseTeeInputWidth = useMemo(() => {
    const labels = coursePresets.map(courseTeeLabel);
    const longest = Math.max("Course / tee".length, ...labels.map((label) => label.length));
    return `${Math.max(34, longest + 4)}ch`;
  }, [coursePresets]);

  const gapEstimate = () => {
    if (!hcp || reqDiff === null) return null;
    let arr = [...diffs];
    for (let i = 0; i < 20; i++) {
      arr = [...arr.slice(1), reqDiff];
      if (handicap(arr) <= reqDiff) return i + 1;
    }
    return null;
  };

  const roundHeaders = ["Date", "Course", "Tee", "Holes", "Score", "Rating", "Slope", "PCC", "Differential"];
  const plannerHeaders = ["Outcome", "Score", "Actual diff", "Counts", "ESR", "Index after ESR", "Change"];

  return (
    <>
      <style>{`
        :root {
          --card-bg: #ffffff;
          --input-bg: #f8fafc;
          --row-new: rgba(59,130,246,0.07);
          --row-good: rgba(34,197,94,0.07);
          --row-ok: rgba(234,179,8,0.07);
          --row-bad: rgba(239,68,68,0.07);
          --table-border: rgba(0,0,0,0.06);
        }
        @media (prefers-color-scheme: dark) {
          :root {
            --card-bg: #1e1f27;
            --input-bg: #16171d;
            --row-new: rgba(59,130,246,0.12);
            --row-good: rgba(34,197,94,0.1);
            --row-ok: rgba(234,179,8,0.1);
            --row-bad: rgba(239,68,68,0.1);
            --table-border: rgba(255,255,255,0.07);
          }
        }
        .help-tip {
          display: inline-flex;
          position: relative;
          vertical-align: middle;
          z-index: 3;
        }
        .help-tip > button {
          width: 18px;
          height: 18px;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: var(--input-bg);
          color: var(--text);
          cursor: help;
          font-size: 11px;
          font-weight: 800;
          line-height: 1;
          padding: 0;
        }
        .help-tip > span {
          position: absolute;
          top: 24px;
          left: var(--tip-left);
          right: var(--tip-right);
          width: min(280px, 72vw);
          background: var(--text-h);
          color: var(--card-bg);
          border-radius: 8px;
          box-shadow: var(--shadow);
          font-size: 12px;
          font-weight: 500;
          letter-spacing: 0;
          line-height: 1.35;
          opacity: 0;
          padding: 9px 10px;
          pointer-events: none;
          text-transform: none;
          transform: translateY(-3px);
          transition: opacity 0.15s ease, transform 0.15s ease;
          white-space: normal;
        }
        .help-tip:hover > span,
        .help-tip:focus-within > span {
          opacity: 1;
          transform: translateY(0);
        }
      `}</style>

      <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
        {/* Header */}
        <div style={{ background: "linear-gradient(135deg, #052e16 0%, #14532d 60%, #166534 100%)", padding: "32px 24px 28px" }}>
          <div style={{ maxWidth: 1400, margin: "0 auto" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                <circle cx="16" cy="16" r="15" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" />
                <circle cx="16" cy="16" r="7" fill="white" fillOpacity="0.9" />
                <circle cx="14" cy="14" r="1" fill="rgba(0,0,0,0.3)" />
                <circle cx="17" cy="15" r="0.8" fill="rgba(0,0,0,0.3)" />
                <circle cx="15" cy="17" r="0.8" fill="rgba(0,0,0,0.3)" />
              </svg>
              <div>
                <h1 style={{ fontSize: 26, fontWeight: 700, color: "#fff", margin: 0, letterSpacing: "-0.5px" }}>
                  Handicap Dashboard
                </h1>
                <p style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", margin: 0 }}>WHS World Handicap System</p>
              </div>
            </div>
          </div>
        </div>

        <div style={{ width: "min(100% - 32px, 1400px)", margin: "0 auto", padding: "28px 0", display: "flex", flexDirection: "column", gap: 24 }}>
          <div className="rounded-xl p-5" style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
            <SectionIntro title="Quick Start" help="Golf Ireland is the source of truth. IndexedDB only caches synced scores and settings in this browser.">
              Save your Golf Ireland settings, sync your scores, then use the dashboard and planner to inspect the imported history.
            </SectionIntro>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10, marginTop: 14 }}>
              {[
                ["1", "Save settings", "Enter your Golf Ireland username and password."],
                ["2", "Sync history", "Imported rounds replace the local cache for scores, courses and handicap history."],
                ["3", "Read the planner", "Target rows use synced course data to show useful scores and exceptional score reductions."],
              ].map(([step, title, copy]) => (
                <div key={step} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, display: "grid", gridTemplateColumns: "28px 1fr", gap: 10, alignItems: "start" }}>
                  <span style={{ width: 24, height: 24, borderRadius: 999, background: "#dcfce7", color: "#166534", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800 }}>{step}</span>
                  <span>
                    <strong style={{ display: "block", color: "var(--text-h)", fontSize: 13 }}>{title}</strong>
                    <span style={{ display: "block", color: "var(--text)", fontSize: 12, lineHeight: 1.4 }}>{copy}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Stat cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
            <StatCard
              label="Handicap Index"
              value={hcp ?? "—"}
              sub={diffs.length < 8 ? `${diffs.length} of 8 rounds entered` : `${diffs.length} rounds`}
              accent
              help="Calculated from the best 8 score differentials in your most recent 20 rounds once at least 8 rounds exist."
            />
            <StatCard
              label="Cut Line"
              value={cutLine != null ? cutLine.toFixed(1) : "—"}
              sub="Best 8 differential threshold"
              help="The highest differential currently counting. A new differential below this usually improves the index."
            />
            <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)", borderRadius: 16, padding: "20px 22px", display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text)" }}>
                <LabelWithHelp help="Your playing number for the selected course/tee, using index, slope, rating and par when available.">
                  Course Handicap
                </LabelWithHelp>
              </span>
              <span style={{ fontSize: 36, fontWeight: 700, lineHeight: 1.1, color: "var(--text-h)" }}>
                {courseHandicap ?? "—"}
              </span>
              <CoursePresetSelect presets={coursePresets} selectedCourse={courseHandicapCourse} placeholder="Choose course" onSelect={(preset) => setCourseHandicapCourse(preset)} />
              <span style={{ fontSize: 12, color: "var(--text)" }}>
                {courseHandicap ? `Based on ${courseTeeLabel(courseHandicapCourse)} / slope ${courseHandicapCourse.slope}${coursePar(courseHandicapCourse) ? ` / par ${coursePar(courseHandicapCourse)}` : ""}` : "Enter more rounds"}
              </span>
            </div>
            <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)", borderRadius: 16, padding: "20px 22px", display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text)" }}>
                <LabelWithHelp help="The handicap index you want to plan towards. This value is saved in this browser.">
                  Target Index
                </LabelWithHelp>
              </span>
              <input
                type="number"
                step="0.1"
                value={target}
                onChange={(e) => updateTarget(e.target.value)}
                style={{
                  width: "100%",
                  background: "var(--input-bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "5px 10px",
                  fontSize: 32,
                  fontWeight: 700,
                  lineHeight: 1.1,
                  color: "var(--text-h)",
                  outline: "none",
                }}
                onFocus={(e) => { e.target.style.borderColor = "#22c55e"; e.target.style.boxShadow = "0 0 0 3px rgba(34,197,94,0.15)"; }}
                onBlur={(e) => { e.target.style.borderColor = "var(--border)"; e.target.style.boxShadow = "none"; }}
              />
              <span style={{ fontSize: 12, color: "var(--text)" }}>
                {gapEstimate() ? `~${gapEstimate()} rounds to go` : hcp ? "More than 20 rounds away" : "Add rounds first"}
              </span>
            </div>
          </div>

          {/* Golf Ireland sync */}
          <div className="rounded-xl p-5" style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 16 }}>
              <SectionIntro title="Sync From Golf Ireland">
                Pull your Golf Ireland scores into the local cache.
              </SectionIntro>
              <span style={{
                fontSize: 12,
                color: golfIrelandSyncEndpoint ? "#16a34a" : "var(--text)",
                whiteSpace: "nowrap",
                paddingTop: 1,
                fontWeight: 700,
              }}>
                {golfIrelandSyncEndpoint ? "Endpoint configured" : "Endpoint needed"}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, alignItems: "end" }}>
              <InputField
                label="Username"
                placeholder="Golf Ireland username"
                value={golfIrelandSettings.login}
                onChange={(e) => setGolfIrelandSettings({ ...golfIrelandSettings, login: e.target.value })}
              />
              <InputField
                label="Password"
                type="password"
                placeholder="Golf Ireland password"
                value={golfIrelandSettings.password}
                onChange={(e) => setGolfIrelandSettings({ ...golfIrelandSettings, password: e.target.value })}
              />
              <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "flex-start", flexWrap: "wrap" }}>
                <button onClick={saveGolfIrelandSettings} style={{ ...neutralButtonStyle, height: 38, padding: "0 14px", width: "auto", flex: "0 0 auto" }}>
                  Save Settings
                </button>
                <button
                  onClick={syncFromGolfIreland}
                  disabled={syncState.status === "syncing"}
                  style={{
                    ...btnStyle(syncState.status === "syncing" ? "#e2e8f0" : "#eff6ff", syncState.status === "syncing" ? "#64748b" : "#1d4ed8"),
                    height: 38,
                    padding: "0 14px",
                    width: "auto",
                    flex: "0 0 auto",
                    cursor: syncState.status === "syncing" ? "wait" : "pointer",
                  }}
                >
                  {syncState.status === "syncing" ? "Syncing..." : "Sync Scores"}
                </button>
              </div>
            </div>
            {syncState.message && (
              <p style={{
                fontSize: 12,
                color: syncState.status === "error" ? "#dc2626" : syncState.status === "success" || syncState.status === "saved" ? "#16a34a" : "var(--text)",
                marginTop: 10,
              }}>
                {syncState.message}
              </p>
            )}
          </div>

          {/* Rounds table */}
          {rounds.length > 0 && (
            <div className="rounded-xl overflow-hidden" style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
              <div style={{ padding: "16px 20px 14px", borderBottom: "1px solid var(--border)" }}>
                <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-h)", margin: 0, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Round History
                </h2>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "max-content", minWidth: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <colgroup>
                    <col style={{ width: 120 }} />
                    <col style={{ width: courseTeeInputWidth }} />
                    <col style={{ width: 110 }} />
                    <col style={{ width: 95 }} />
                    <col style={{ width: 80 }} />
                    <col style={{ width: 90 }} />
                    <col style={{ width: 80 }} />
                    <col style={{ width: 70 }} />
                    <col style={{ width: 210 }} />
                  </colgroup>
                  <thead>
                    <tr style={{ background: "rgba(0,0,0,0.03)" }}>
                      {roundHeaders.map((h) => (
                        <th key={h} style={{
                          padding: "10px 16px",
                          textAlign: "left",
                          fontWeight: 600,
                          color: "var(--text)",
                          fontSize: 11,
                          textTransform: "uppercase",
                          letterSpacing: "0.07em",
                          borderBottom: "1px solid var(--table-border)",
                          whiteSpace: "nowrap",
                        }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayedRounds.map((r, index) => {
                      const d = scoreDifferentialForRound(r);
                      const isCounting = countingIds.has(r.id);
                      const isNewest = index === 0;
                      const isExcluded = index >= 20;
                      const displayCourse = courseParts(r);
                      if (isExcluded && !showExcludedRounds) return null;

                      return (
                        <Fragment key={r.id}>
                          {index === 20 && (
                            <tr>
                              <td colSpan={9} style={{ padding: "9px 16px", background: "rgba(100,116,139,0.12)", color: "var(--text)", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", borderBottom: "1px solid var(--table-border)" }}>
                                Excluded from handicap calculation - older than most recent 20 rounds
                              </td>
                            </tr>
                          )}
                        <tr key={r.id} style={{ background: isCounting && !isExcluded ? "var(--row-good)" : "transparent", borderBottom: "1px solid var(--table-border)", opacity: isExcluded ? 0.58 : 1 }}>
                          <td style={{ padding: "10px 16px", color: "var(--text-h)", whiteSpace: "nowrap" }}>
                            {r.date || "—"}
                          </td>
                          <td style={{ padding: "10px 16px", color: "var(--text-h)", fontWeight: 500, whiteSpace: "nowrap" }}>
                            {displayCourse.course || "—"}
                          </td>
                          <td style={{ padding: "10px 16px", color: "var(--text-h)", whiteSpace: "nowrap" }}>
                            {displayCourse.tee || "—"}
                          </td>
                          <td style={{ padding: "10px 16px", color: "var(--text)", whiteSpace: "nowrap" }}>
                            {r.holes || "—"}
                          </td>
                          <td style={{ padding: "10px 16px", color: "var(--text-h)", whiteSpace: "nowrap" }}>
                            {r.score}
                          </td>
                          <td style={{ padding: "10px 16px", color: "var(--text)", whiteSpace: "nowrap" }}>
                            {r.rating}
                          </td>
                          <td style={{ padding: "10px 16px", color: "var(--text)", whiteSpace: "nowrap" }}>
                            {r.slope}
                          </td>
                          <td style={{ padding: "10px 16px", color: "var(--text)", whiteSpace: "nowrap" }}>
                            {r.pcc || 0}
                          </td>
                          <td style={{ padding: "10px 16px", whiteSpace: "nowrap" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span style={{
                                fontWeight: 600,
                                color: d !== null ? (d < (cutLine ?? Infinity) ? "#16a34a" : "var(--text-h)") : "var(--text)",
                              }}>
                                {d !== null ? d.toFixed(1) : "—"}
                              </span>
                              {isNineHoleRound(r) && (
                                <span style={{ fontSize: 10, fontWeight: 700, background: "#7c3aed", color: "#fff", borderRadius: 999, padding: "2px 7px", letterSpacing: "0.05em" }}>9H</span>
                              )}
                              {isCounting && (
                                <span style={{ fontSize: 10, fontWeight: 700, background: "#166534", color: "#fff", borderRadius: 999, padding: "2px 7px", letterSpacing: "0.05em" }}>COUNTS</span>
                              )}
                              {isNewest && (
                                <span style={{ fontSize: 10, fontWeight: 700, background: "#1d4ed8", color: "#fff", borderRadius: 999, padding: "2px 7px", letterSpacing: "0.05em" }}>NEW</span>
                              )}
                              {isExcluded && (
                                <span style={{ fontSize: 10, fontWeight: 700, background: "#64748b", color: "#fff", borderRadius: 999, padding: "2px 7px", letterSpacing: "0.05em" }}>EXCLUDED</span>
                              )}
                            </div>
                          </td>
                        </tr>
                        </Fragment>
                      );
                    })}
                    {displayedRounds.length > 20 && !showExcludedRounds && (
                      <tr>
                        <td colSpan={9} style={{ padding: "10px 16px", background: "rgba(100,116,139,0.08)", borderTop: "1px solid var(--table-border)" }}>
                          <button
                            onClick={() => setShowExcludedRounds(true)}
                            style={{ ...neutralButtonStyle, display: "inline-flex", alignItems: "center", gap: 7 }}
                            title="Show older rounds"
                          >
                            <span aria-hidden="true" style={{ fontSize: 13 }}>▸</span>
                            Show {displayedRounds.length - 20} excluded rounds
                          </button>
                        </td>
                      </tr>
                    )}
                    {displayedRounds.length > 20 && showExcludedRounds && (
                      <tr>
                        <td colSpan={9} style={{ padding: "10px 16px", background: "rgba(100,116,139,0.08)", borderTop: "1px solid var(--table-border)" }}>
                          <button
                            onClick={() => setShowExcludedRounds(false)}
                            style={{ ...neutralButtonStyle, display: "inline-flex", alignItems: "center", gap: 7 }}
                            title="Hide older rounds"
                          >
                            <span aria-hidden="true" style={{ fontSize: 13 }}>▾</span>
                            Hide excluded rounds
                          </button>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {rounds.length === 0 && (
            <div className="rounded-xl p-5" style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
              <SectionIntro title="No Synced Rounds Yet">
                Configure Golf Ireland sync above, then import your score history.
              </SectionIntro>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16, alignItems: "start" }}>
            {/* Target round planner */}
            <div className="rounded-xl p-5" style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 16 }}>
                <SectionIntro title="Target Round Planner">
                  Scores needed to post useful differentials at a course/tee.
                </SectionIntro>
                <div style={{ width: 220 }}>
                  <CoursePresetSelect presets={coursePresets} selectedCourse={planner} placeholder="Choose course" onSelect={(preset) => setPlanner(preset)} />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginBottom: 10 }}>
                <InputField
                  label="Target handicap"
                  type="number"
                  step="0.1"
                  value={target}
                  onChange={(e) => updateTarget(e.target.value)}
                />
              </div>
              <p style={{ fontSize: 12, color: "var(--text)", margin: "0 0 16px" }}>
                {courseTeeLabel(planner)
                  ? `${courseTeeLabel(planner)} / rating ${planner.rating} / slope ${planner.slope} / PCC ${planner.pcc ?? 0}`
                  : "Sync from Golf Ireland to populate course options."}
              </p>

              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "rgba(0,0,0,0.03)" }}>
                      {plannerHeaders.map((h) => (
                        <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontWeight: 600, color: "var(--text)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid var(--table-border)", whiteSpace: "nowrap" }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {plannerRows.map((row) => {
                      const outcome = row.outcome;
                      const isCutLine = outcome === "Cut line";
                      const isTarget = outcome === "Target";
                      const isEsr = row.esrReduction > 0 || outcome.startsWith("ESR");
                      return (
                        <tr key={row.score} style={{
                          background: isTarget ? "rgba(59,130,246,0.12)" : isEsr ? "rgba(20,184,166,0.12)" : isCutLine ? "rgba(100,116,139,0.08)" : "transparent",
                          borderBottom: "1px solid var(--table-border)",
                          outline: isTarget ? "2px solid rgba(59,130,246,0.35)" : "none",
                          outlineOffset: isTarget ? "-2px" : 0,
                          borderTop: isCutLine ? "14px solid var(--card-bg)" : "none",
                        }}>
                          <td style={{ padding: "10px 14px", color: isCutLine ? "var(--text)" : isTarget ? "#1d4ed8" : isEsr ? "#0f766e" : "var(--text-h)", fontWeight: isTarget || isEsr ? 800 : 600, whiteSpace: "nowrap" }}>
                            {outcome}
                          </td>
                          <td style={{ padding: "10px 14px", color: isCutLine ? "var(--text)" : isTarget ? "#1d4ed8" : isEsr ? "#0f766e" : "var(--text-h)", fontSize: isTarget || isEsr ? 24 : 20, fontWeight: 800, whiteSpace: "nowrap" }}>
                            {row.score !== null ? row.score : "—"}
                          </td>
                          <td style={{ padding: "10px 14px", color: "var(--text-h)", whiteSpace: "nowrap" }}>
                            {row.actualDiff !== null ? row.actualDiff.toFixed(1) : "—"}
                          </td>
                          <td style={{ padding: "10px 14px", color: row.counts ? "#16a34a" : "var(--text)", fontWeight: 600, whiteSpace: "nowrap" }}>
                            {row.counts ? "Yes" : "No"}
                          </td>
                          <td style={{ padding: "10px 14px", color: row.esrReduction ? "#0f766e" : "var(--text)", fontWeight: 700, whiteSpace: "nowrap" }}>
                            {row.esrReduction ? `-${row.esrReduction.toFixed(1)}` : "—"}
                          </td>
                          <td style={{ padding: "10px 14px", color: isEsr ? "#0f766e" : "var(--text-h)", fontWeight: 700, whiteSpace: "nowrap" }}>
                            {row.projectedHcpWithEsr !== null ? row.projectedHcpWithEsr.toFixed(1) : "—"}
                            {row.esrReduction > 0 && row.projectedHcp !== null && (
                              <span style={{ marginLeft: 8, color: "var(--text)", fontSize: 11, fontWeight: 600 }}>
                                normal {row.projectedHcp.toFixed(1)}
                              </span>
                            )}
                          </td>
                          <td style={{ padding: "10px 14px", color: row.change < 0 ? "#16a34a" : row.change > 0 ? "#dc2626" : "var(--text)", fontWeight: 600, whiteSpace: "nowrap" }}>
                            {row.change !== null ? `${row.change > 0 ? "+" : ""}${row.change.toFixed(1)}` : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Progression chart */}
          <div className="rounded-xl p-5" style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
            <div style={{ marginBottom: 12 }}>
              <SectionIntro title="Handicap Progression">
                Official Golf Ireland handicap index history
              </SectionIntro>
            </div>
            <LineChart points={hcpHist} />
            {hcpHist.length >= 2 && (
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 11, color: "var(--text)" }}>
                <span>Start: {hcpHist[0].value.toFixed(1)}</span>
                <span>Now: {hcpHist[hcpHist.length - 1].value.toFixed(1)}</span>
              </div>
            )}
          </div>

        </div>
      </div>
    </>
  );
}

function CoursePresetSelect({ presets, selectedCourse, placeholder = "Choose course", onSelect }) {
  if (presets.length === 0) return null;
  const selectedIndex = selectedCourse
    ? presets.findIndex((preset) =>
      (preset.course === selectedCourse.course || courseTeeLabel(preset) === selectedCourse.course) &&
      Number(preset.rating) === Number(selectedCourse.rating) &&
      Number(preset.slope) === Number(selectedCourse.slope)
    )
    : -1;

  return (
    <select
      value={selectedIndex >= 0 ? String(selectedIndex) : ""}
      title={placeholder}
      aria-label={placeholder}
      onChange={(e) => {
        const preset = presets[Number(e.target.value)];
        if (preset) onSelect(preset);
      }}
      style={{
        width: "100%",
        background: "var(--input-bg)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "7px 10px",
        color: "var(--text-h)",
        fontSize: 13,
        outline: "none",
      }}
    >
      <option value="">{placeholder}</option>
      {presets.map((preset, index) => (
        <option key={`${preset.course}-${preset.rating}-${preset.slope}-${index}`} value={index}>
          {courseTeeLabel(preset)} ({preset.rating}/{preset.slope})
        </option>
      ))}
    </select>
  );
}

function btnStyle(bg, color) {
  return {
    background: bg,
    color,
    border: "none",
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  };
}
