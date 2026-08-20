import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { db } from "./db";
import { useLiveQuery } from "dexie-react-hooks";

function isNineHoleScore(score) {
  return Number(score) < 70;
}

function estimatedExpectedNineHoleDifferential(handicapIndex) {
  const index = Number(handicapIndex);
  if (isNaN(index)) return null;

  // WHS does not publish its expected-score lookup. This estimate is calibrated
  // to the official USGA example (HI 14.0 -> 8.5 expected) and a Golf Ireland
  // result (HI 12.2 -> approximately 7.48 expected).
  return ((17 / 30) * index) + (17 / 30);
}

function differential(score, rating, slope, pcc = 0, forceNineHole = null, handicapIndex = null) {
  if (score === null || score === undefined || score === "") return null;
  const s = Number(score), r = Number(rating), sl = Number(slope), p = Number(pcc || 0);
  if (isNaN(s) || isNaN(r) || isNaN(sl)) return null;
  const nineHoles = forceNineHole ?? isNineHoleScore(s);
  const playedDifferential = ((s - r - (nineHoles ? 0.5 * p : p)) * 113) / sl;
  if (!nineHoles) return playedDifferential;

  const expectedDifferential = estimatedExpectedNineHoleDifferential(handicapIndex);
  return expectedDifferential === null ? null : playedDifferential + expectedDifferential;
}

function scoreDifferentialForRound(round) {
  const officialDifferential = Number(round?.scoreDifferential);
  if (!isNaN(officialDifferential)) return officialDifferential;

  // Never reconstruct a synced round's differential from its gross score.
  // Golf Ireland's value includes its authoritative adjusted-score, PCC and
  // 9-hole processing. Local calculation is only for explicitly manual rounds.
  if (round?.source !== "manual") return null;
  return differential(round.score, round.rating, round.slope, round.pcc, isNineHoleRound(round), round.handicapIndex);
}

const r1 = (v) => Math.round(v * 10) / 10;
const golfIrelandSettingsKey = "golfIreland";
const golfIrelandSyncEndpoint = import.meta.env.VITE_GOLF_IRELAND_SYNC_URL ?? "";
const courseRatingCountries = [
  ["NIR", "Northern Ireland"],
  ["IRL", "Ireland"],
  ["ENG", "England"],
  ["SCO", "Scotland"],
  ["WAL", "Wales"],
  ["USA", "United States"],
];

function endpointSibling(path) {
  if (!golfIrelandSyncEndpoint) return "";
  try {
    return new URL(path, golfIrelandSyncEndpoint).toString();
  } catch {
    return "";
  }
}

const courseRatingSearchEndpoint = endpointSibling("/course-rating/search");
const courseRatingTeesEndpoint = endpointSibling("/course-rating/tees");

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

function handicapWithEsr(diffs, exceptionalDiffs = [], handicapIndexAtPlay = null) {
  if (diffs.length < 8) {
    return { index: null, indexBeforeEsr: null, esrReduction: 0 };
  }

  const indexBeforeEsr = handicap(diffs);
  const esrReduction = handicapIndexAtPlay === null
    ? 0
    : exceptionalDiffs.reduce(
        (total, diff) => total + exceptionalScoreReduction(diff, handicapIndexAtPlay),
        0
      );

  return {
    index: r1(indexBeforeEsr - esrReduction),
    indexBeforeEsr,
    esrReduction,
  };
}

function scoreForDifferential(diff, rating, slope, pcc = 0, isNineHoleRound = false, handicapIndex = null) {
  const d = Number(diff), r = Number(rating), sl = Number(slope), p = Number(pcc || 0);
  if (isNaN(d) || isNaN(r) || isNaN(sl)) return null;
  const expectedDifferential = isNineHoleRound
    ? estimatedExpectedNineHoleDifferential(handicapIndex)
    : 0;
  if (expectedDifferential === null) return null;
  const playedDifferential = d - expectedDifferential;
  return (playedDifferential * sl) / 113 + r + (isNineHoleRound ? 0.5 * p : p);
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

function courseSelectLabel(course) {
  const parts = courseParts(course);
  return [parts.course, parts.tee, course?.holes].filter(Boolean).join(", ");
}

function manualCourseLabel(course) {
  return [course?.course, course?.tee, course?.holes].filter(Boolean).join(" - ");
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

function monthYear(value) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  if (isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
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
        source: "golfIrelandRound",
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

// Retained as a standalone chart primitive for potential reuse.
// eslint-disable-next-line no-unused-vars
function LineChart({ points }) {
  const [hoveredPoint, setHoveredPoint] = useState(null);

  if (points.length < 2) return (
    <div className="flex items-center justify-center h-24 text-sm" style={{ color: "var(--text)" }}>
      Need at least two Golf Ireland handicap index points
    </div>
  );

  const values = points.map((point) => Number(point.value));
  const max = Math.max(...values);
  const min = Math.min(...values);
  const chartMax = Math.ceil((max + 0.3) * 2) / 2;
  const chartMin = Math.floor((min - 0.3) * 2) / 2;
  const range = chartMax - chartMin || 1;
  const width = 760;
  const height = 240;
  const padX = 58;
  const padRight = 26;
  const padTop = 34;
  const padBottom = 58;
  const evenIndexes = (count, maxLabels) => {
    if (count <= maxLabels) return Array.from({ length: count }, (_, i) => i);
    return [...new Set(Array.from({ length: maxLabels }, (_, i) => Math.round((i * (count - 1)) / (maxLabels - 1))))];
  };
  const pointLabelIndexes = evenIndexes(points.length, 5);
  const shouldLabelPoint = (i) => pointLabelIndexes.includes(i);
  const ticks = [chartMin, chartMin + range / 2, chartMax].map(r1);
  const allDates = points
    .map((point) => new Date(`${point.date}T00:00:00`).getTime())
    .filter(Number.isFinite);
  const minDate = Math.min(...allDates);
  const maxDate = Math.max(...allDates);
  const dateRange = maxDate - minDate || 1;
  const xForDate = (date) => {
    const timestamp = new Date(`${date}T00:00:00`).getTime();
    return padX + ((timestamp - minDate) / dateRange) * (width - padX - padRight);
  };
  const yForValue = (value) =>
    padTop + (1 - (Number(value) - chartMin) / range) * (height - padTop - padBottom);
  const pts = points.map((point) => {
    const x = xForDate(point.date);
    const y = yForValue(point.value);
    return [x, y];
  });

  const polyline = pts.map((p) => p.join(",")).join(" ");
  const baseY = height - padBottom;
  const area = `${pts[0][0]},${baseY} ${polyline} ${pts[pts.length - 1][0]},${baseY}`;
  const hoveredCoords = hoveredPoint?.coords ?? null;
  const tooltipX = hoveredCoords ? Math.min(width - 132, Math.max(64, hoveredCoords[0] - 54)) : 0;
  const tooltipY = hoveredCoords ? Math.max(12, hoveredCoords[1] - 58) : 0;
  const dateLabelIndexes = evenIndexes([...new Set(points.map((point) => point.date))].length, 5);
  const dateLabels = [...new Set(points.map((point) => point.date))]
    .sort()
    .filter((_, i) => dateLabelIndexes.includes(i));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height: 220, display: "block" }} role="img" aria-label="Handicap progression chart">
      <defs>
        <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22c55e" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#22c55e" stopOpacity="0" />
        </linearGradient>
      </defs>
      {ticks.map((tick) => {
        const y = padTop + (1 - (tick - chartMin) / range) * (height - padTop - padBottom);
        return (
          <g key={tick}>
            <line x1={padX} y1={y} x2={width - padRight} y2={y} stroke="var(--table-border)" strokeWidth="1" />
            <text x={padX - 12} y={y + 4} textAnchor="end" style={{ fill: "var(--text)", fontSize: 11, fontWeight: 700 }}>
              {tick.toFixed(1)}
            </text>
          </g>
        );
      })}
      <polygon fill="url(#chartGrad)" points={area} />
      <line x1={padX} y1={baseY} x2={width - padRight} y2={baseY} stroke="var(--table-border)" strokeWidth="1" />
      <polyline fill="none" stroke="#22c55e" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" points={polyline} />
      {pts.map(([x, y], i) => (
        <g
          key={`${points[i].date}-${i}`}
          onMouseEnter={() => setHoveredPoint({ ...points[i], series: "Handicap", coords: [x, y] })}
          onMouseLeave={() => setHoveredPoint(null)}
          onFocus={() => setHoveredPoint({ ...points[i], series: "Handicap", coords: [x, y] })}
          onBlur={() => setHoveredPoint(null)}
          tabIndex={0}
          style={{ outline: "none", cursor: "default" }}
        >
          <circle cx={x} cy={y} r="10" fill="transparent" />
          <circle cx={x} cy={y} r={hoveredPoint?.series === "Handicap" && hoveredPoint?.date === points[i].date ? "6" : "4"} fill="#22c55e" stroke="var(--card-bg)" strokeWidth="2" />
          {shouldLabelPoint(i) && (
            <text x={x} y={Math.max(18, y - 11)} textAnchor="middle" style={{ fill: "var(--text-h)", fontSize: 12, fontWeight: 800 }}>
              {points[i].value.toFixed(1)}
            </text>
          )}
        </g>
      ))}
      {dateLabels.map((date, i) => (
        <text
          key={`date-${date}`}
          x={xForDate(date)}
          y={height - 24}
          textAnchor={i === 0 ? "start" : i === dateLabels.length - 1 ? "end" : "middle"}
          style={{ fill: "var(--text)", fontSize: 11, fontWeight: 700 }}
        >
          {shortDate(date)}
        </text>
      ))}
      {hoveredPoint && hoveredCoords && (
        <g pointerEvents="none">
          <line x1={hoveredCoords[0]} y1={tooltipY + 44} x2={hoveredCoords[0]} y2={hoveredCoords[1] - 8} stroke="#166534" strokeWidth="1" strokeDasharray="3 3" opacity="0.55" />
          <rect x={tooltipX} y={tooltipY} width="116" height="44" rx="7" fill="var(--card-bg)" stroke="#86efac" strokeWidth="1" />
          <text x={tooltipX + 10} y={tooltipY + 17} style={{ fill: "var(--text)", fontSize: 11, fontWeight: 700 }}>
            {shortDate(hoveredPoint.date)}
          </text>
          <text x={tooltipX + 10} y={tooltipY + 34} style={{ fill: "var(--text-h)", fontSize: 13, fontWeight: 800 }}>
            {hoveredPoint.series} {Number(hoveredPoint.value).toFixed(1)}
          </text>
        </g>
      )}
    </svg>
  );
}

function DifferentialBarChart({ points }) {
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const [showBestAverage, setShowBestAverage] = useState(false);
  const visiblePoints = points.slice(-20);

  if (visiblePoints.length === 0) return (
    <div className="flex items-center justify-center h-24 text-sm" style={{ color: "var(--text)" }}>
      No score differentials available
    </div>
  );

  const width = 760;
  const height = 240;
  const padX = 48;
  const padRight = 24;
  const padTop = 28;
  const padBottom = 54;
  const values = visiblePoints.map((point) => Number(point.value));
  const allValues = points.map((point) => Number(point.value));
  const rollingAverages = points
    .map((_, i) => {
      if (i < 4) return null;
      return allValues.slice(i - 4, i + 1).reduce((sum, value) => sum + value, 0) / 5;
    });
  const trendValues = rollingAverages.filter((value) => value !== null);
  const scaleValues = [...values, ...trendValues];
  const chartMin = Math.min(0, Math.floor(Math.min(...scaleValues) - 1));
  const chartMax = Math.max(1, Math.ceil(Math.max(...scaleValues) + 1));
  const range = chartMax - chartMin || 1;
  const plotHeight = height - padTop - padBottom;
  const plotWidth = width - padX - padRight;
  const slotWidth = plotWidth / visiblePoints.length;
  const barWidth = Math.max(5, Math.min(24, slotWidth * 0.62));
  const visibleStartIndex = points.length - visiblePoints.length;
  const xForVisibleIndex = (i) => padX + i * slotWidth + slotWidth / 2;
  const yForValue = (value) => padTop + (1 - (value - chartMin) / range) * plotHeight;
  const baseY = yForValue(0);
  const rollingAveragePoints = points
    .map((_, i) => {
      const average = rollingAverages[i];
      if (average === null || i < visibleStartIndex) return null;
      return {
        x: xForVisibleIndex(i - visibleStartIndex),
        y: yForValue(average),
        value: average,
        startDate: points[i - 4].date,
        endDate: points[i].date,
      };
    })
    .filter(Boolean);
  const rollingAveragePath = rollingAveragePoints.map((point) => `${point.x},${point.y}`).join(" ");
  const bestRollingAveragePoint = rollingAveragePoints.reduce(
    (best, point) => !best || point.value < best.value ? point : best,
    null
  );
  const tickValues = [chartMin, r1(chartMin + range / 2), chartMax];
  const dateLabelIndexes = new Set(
    visiblePoints.length <= 5
      ? visiblePoints.map((_, i) => i)
      : Array.from({ length: 5 }, (_, i) => Math.round((i * (visiblePoints.length - 1)) / 4))
  );
  const hoveredPoint = hoveredIndex === null ? null : visiblePoints[hoveredIndex];

  return (
    <>
      {rollingAveragePoints.length >= 2 && (
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 2, fontSize: 11, color: "var(--text)", fontWeight: 700 }}>
          <span aria-hidden="true" style={{ display: "inline-block", width: 20, borderTop: "3px solid #1e3a8a" }} />
          5-round average · includes prior scores
        </div>
      )}
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height: 220, display: "block" }} role="img" aria-label="Latest 20 score differentials with five-round rolling average across all rounds">
      {tickValues.map((tick) => {
        const y = yForValue(tick);
        return (
          <g key={tick}>
            <line x1={padX} y1={y} x2={width - padRight} y2={y} stroke="var(--table-border)" strokeWidth="1" />
            <text x={padX - 10} y={y + 4} textAnchor="end" style={{ fill: "var(--text)", fontSize: 11, fontWeight: 700 }}>
              {tick.toFixed(1)}
            </text>
          </g>
        );
      })}
      {visiblePoints.map((point, i) => {
        const x = xForVisibleIndex(i) - barWidth / 2;
        const valueY = yForValue(point.value);
        const y = Math.min(valueY, baseY);
        const barHeight = Math.max(2, Math.abs(baseY - valueY));
        const isHovered = hoveredIndex === i;
        return (
          <g
            key={`${point.date}-${i}`}
            onMouseEnter={() => setHoveredIndex(i)}
            onMouseLeave={() => setHoveredIndex(null)}
            onFocus={() => setHoveredIndex(i)}
            onBlur={() => setHoveredIndex(null)}
            tabIndex={0}
            style={{ outline: "none", cursor: "default" }}
          >
            <rect x={padX + i * slotWidth} y={padTop} width={slotWidth} height={plotHeight} fill="transparent" />
            <rect x={x} y={y} width={barWidth} height={barHeight} rx="3" fill={isHovered ? "#2563eb" : "#60a5fa"} />
          </g>
        );
      })}
      {rollingAveragePoints.length >= 2 && (
        <>
          <polyline
            points={rollingAveragePath}
            fill="none"
            stroke="#1e3a8a"
            strokeWidth="3"
            strokeLinejoin="round"
            strokeLinecap="round"
            pointerEvents="none"
          />
          {rollingAveragePoints.map((point, i) => (
            <circle
              key={`rolling-average-${i}`}
              cx={point.x}
              cy={point.y}
              r="3"
              fill="#1e3a8a"
              stroke="var(--card-bg)"
              strokeWidth="1.5"
              pointerEvents="none"
            />
          ))}
          {bestRollingAveragePoint && (() => {
            const point = bestRollingAveragePoint;
            const diamondSize = 7;
            const labelX = Math.min(width - padRight - 4, Math.max(padX + 4, point.x));
            const labelY = point.y < padTop + 28 ? point.y + 25 : point.y - 14;
            return (
              <g
                style={{ cursor: "help", outline: "none" }}
                tabIndex={0}
                onMouseEnter={() => setShowBestAverage(true)}
                onMouseLeave={() => setShowBestAverage(false)}
                onFocus={() => setShowBestAverage(true)}
                onBlur={() => setShowBestAverage(false)}
              >
                <polygon
                  points={`${point.x},${point.y - diamondSize} ${point.x + diamondSize},${point.y} ${point.x},${point.y + diamondSize} ${point.x - diamondSize},${point.y}`}
                  fill="#f59e0b"
                  stroke="var(--card-bg)"
                  strokeWidth="2"
                />
                <text
                  x={labelX}
                  y={labelY}
                  textAnchor={labelX === padX + 4 ? "start" : labelX === width - padRight - 4 ? "end" : "middle"}
                  style={{ fill: "#b45309", fontSize: 11, fontWeight: 800 }}
                >
                  Best 5-round run · {point.value.toFixed(1)}
                </text>
              </g>
            );
          })()}
          {showBestAverage && bestRollingAveragePoint && (() => {
            const point = bestRollingAveragePoint;
            const tooltipWidth = 142;
            const tooltipX = Math.min(width - padRight - tooltipWidth, Math.max(padX, point.x - tooltipWidth / 2));
            const tooltipY = point.y < padTop + 58 ? point.y + 13 : point.y - 57;
            return (
              <g pointerEvents="none">
                <rect x={tooltipX} y={tooltipY} width={tooltipWidth} height="44" rx="7" fill="var(--card-bg)" stroke="#f59e0b" strokeWidth="1" />
                <text x={tooltipX + 10} y={tooltipY + 17} style={{ fill: "var(--text)", fontSize: 11, fontWeight: 700 }}>
                  {shortDate(point.startDate)} – {shortDate(point.endDate)}
                </text>
                <text x={tooltipX + 10} y={tooltipY + 34} style={{ fill: "var(--text-h)", fontSize: 13, fontWeight: 800 }}>
                  5-round average {point.value.toFixed(1)}
                </text>
              </g>
            );
          })()}
        </>
      )}
      {visiblePoints.map((point, i) => dateLabelIndexes.has(i) && (
        <text
          key={`differential-date-${point.date}-${i}`}
          x={xForVisibleIndex(i)}
          y={height - 22}
          textAnchor={i === 0 ? "start" : i === visiblePoints.length - 1 ? "end" : "middle"}
          style={{ fill: "var(--text)", fontSize: 11, fontWeight: 700 }}
        >
          {shortDate(point.date)}
        </text>
      ))}
      {hoveredPoint && (() => {
        const x = xForVisibleIndex(hoveredIndex);
        const tooltipX = Math.min(width - 132, Math.max(52, x - 58));
        return (
          <g pointerEvents="none">
            <rect x={tooltipX} y={8} width="120" height="44" rx="7" fill="var(--card-bg)" stroke="#93c5fd" strokeWidth="1" />
            <text x={tooltipX + 10} y={25} style={{ fill: "var(--text)", fontSize: 11, fontWeight: 700 }}>
              {shortDate(hoveredPoint.date)}
            </text>
            <text x={tooltipX + 10} y={42} style={{ fill: "var(--text-h)", fontSize: 13, fontWeight: 800 }}>
              Differential {Number(hoveredPoint.value).toFixed(1)}
            </text>
          </g>
        );
      })()}
      </svg>
    </>
  );
}

function RecentFormInsight({ insight }) {
  if (!insight) return null;

  return (
    <aside className="recent-form-card" aria-label="Recent form summary">
      <div className="recent-form-eyebrow">
        <span aria-hidden="true">↘</span>
        Recent form
      </div>
      <div className="recent-form-heading">{insight.heading}</div>
      <p className="recent-form-copy">{insight.summary}</p>

      <div className="recent-form-stats">
        <div>
          <span>Recent 5</span>
          <strong>{insight.latestAverage.toFixed(1)}</strong>
        </div>
        <div>
          <span>Previous 5</span>
          <strong>{insight.previousAverage.toFixed(1)}</strong>
        </div>
        <div>
          <span>Earlier avg</span>
          <strong>{insight.earlierAverage.toFixed(1)}</strong>
        </div>
      </div>

      {insight.previousBest && (
        <p className="recent-form-context">
          The previous best five-round run ended in {monthYear(insight.previousBest.endDate)} at {insight.previousBest.average.toFixed(1)}.
        </p>
      )}
      <div className="recent-form-encouragement">{insight.encouragement}</div>
    </aside>
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

const fieldLabelStyle = {
  color: "var(--text)",
  fontSize: 11,
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

const fieldControlStyle = {
  background: "var(--input-bg)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text-h)",
  fontSize: 14,
  height: 40,
  outline: "none",
};

function InputField({ label, help, wrapperStyle, style, ...props }) {
  return (
    <div className="flex flex-col gap-1" style={wrapperStyle}>
      {label && (
        <label style={fieldLabelStyle}>
          <LabelWithHelp help={help}>{label}</LabelWithHelp>
        </label>
      )}
      <input
        {...props}
        title={props.title ?? help}
        className="rounded-lg px-3 py-2 text-sm w-full outline-none transition-all"
        style={{
          ...fieldControlStyle,
          padding: "0 12px",
          ...style,
        }}
        onFocus={(e) => { e.target.style.borderColor = "#22c55e"; e.target.style.boxShadow = "0 0 0 3px rgba(34,197,94,0.15)"; }}
        onBlur={(e) => { e.target.style.borderColor = "var(--border)"; e.target.style.boxShadow = "none"; }}
      />
    </div>
  );
}

function SyncButtonLabel({ syncing }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
      {syncing && <span className="sync-spinner" aria-hidden="true" />}
      {syncing ? "Syncing..." : "Sync Scores"}
    </span>
  );
}

export default function App() {
  const [target, setTarget] = useState(8);
  const [planner, setPlanner] = useState({ course: "", rating: "", slope: "", pcc: 0 });
  const [plannerMode, setPlannerMode] = useState("synced");
  const [manualPlanner, setManualPlanner] = useState({ course: "", tee: "", holes: "18 holes", rating: "", slope: "", pcc: 0 });
  const [courseLookup, setCourseLookup] = useState({ country: "NIR", query: "", status: "idle", message: "", courses: [], selectedCourseId: "", tees: [] });
  const [showManualRound, setShowManualRound] = useState(false);
  const [manualRound, setManualRound] = useState({ date: todayISO(), score: "" });
  const [manualRoundState, setManualRoundState] = useState({ status: "idle", message: "" });
  const [courseHandicapCourse, setCourseHandicapCourse] = useState({ course: "", rating: "", slope: 113, pcc: 0 });
  const [showExcludedRounds, setShowExcludedRounds] = useState(false);
  const [golfIrelandSettings, setGolfIrelandSettings] = useState({ login: "", password: "", displayName: "" });
  const [hasSavedGolfIrelandCredentials, setHasSavedGolfIrelandCredentials] = useState(false);
  const [showGolfIrelandCredentials, setShowGolfIrelandCredentials] = useState(true);
  const [syncState, setSyncState] = useState({ status: "idle", message: "" });
  const [lastRoundScenarioScore, setLastRoundScenarioScore] = useState("");

  const queriedRounds = useLiveQuery(() => db.rounds.orderBy("date").toArray(), []);
  const queriedHandicapHistory = useLiveQuery(() => db.handicapHistory.orderBy("date").toArray(), []);
  const rounds = useMemo(() => queriedRounds ?? [], [queriedRounds]);
  const syncedHandicapHistory = useMemo(() => queriedHandicapHistory ?? [], [queriedHandicapHistory]);
  const latestRound = rounds[rounds.length - 1] ?? null;

  useEffect(() => {
    db.settings.get("targetHandicap").then((setting) => {
      if (setting && setting.value !== undefined) setTarget(Number(setting.value));
    });
    db.settings.get(golfIrelandSettingsKey).then((setting) => {
      if (setting?.value) {
        setGolfIrelandSettings({
          login: setting.value.login ?? "",
          password: setting.value.password ?? "",
          displayName: setting.value.displayName ?? "",
        });
        const hasSavedCredentials = Boolean(setting.value.login && setting.value.password);
        setHasSavedGolfIrelandCredentials(hasSavedCredentials);
        setShowGolfIrelandCredentials(!hasSavedCredentials);
      }
    });
  }, []);

  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || rounds.length === 0) return;
    seeded.current = true;
    setPlanner({ course: latestRound.course, holes: latestRound.holes ?? "", par: latestRound.par ?? "", rating: latestRound.rating, slope: latestRound.slope, pcc: latestRound.pcc ?? 0 });
  }, [latestRound, rounds.length]);

  const scenarioSeededRoundId = useRef(null);
  useEffect(() => {
    if (!latestRound || scenarioSeededRoundId.current === latestRound.id) return;
    scenarioSeededRoundId.current = latestRound.id;
    setLastRoundScenarioScore(latestRound.score ?? "");
  }, [latestRound]);

  // WHS uses the most recent 20 rounds; pair each with its id so we can mark rows
  const clampedWithDiff = useMemo(() =>
    clamp20(rounds).map((r) => ({ id: r.id, d: scoreDifferentialForRound(r) })).filter(({ d }) => d !== null),
    [rounds]
  );
  const diffs = useMemo(() => clampedWithDiff.map(({ d }) => d), [clampedWithDiff]);

  const apiHandicapIndex = useMemo(() => {
    const latest = [...syncedHandicapHistory].reverse().find((entry) => entry.source === "golfIrelandCurrent");
    const value = Number(latest?.value);
    return isNaN(value) ? null : value;
  }, [syncedHandicapHistory]);
  const todaysRounds = useMemo(() => rounds.filter((round) => round.date === todayISO()), [rounds]);
  const hasRoundToday = todaysRounds.length > 0;
  const fallbackIndexAtPlay = Number(latestRound?.handicapIndex);
  const indexAtPlayToday = apiHandicapIndex ?? (!isNaN(fallbackIndexAtPlay) ? fallbackIndexAtPlay : null);
  const todaysExceptionalDifferentials = useMemo(() =>
    todaysRounds.map(scoreDifferentialForRound).filter((diff) => diff !== null),
    [todaysRounds]
  );
  const currentHandicapCalculation = useMemo(() =>
    handicapWithEsr(diffs, hasRoundToday ? todaysExceptionalDifferentials : [], indexAtPlayToday),
    [diffs, hasRoundToday, todaysExceptionalDifferentials, indexAtPlayToday]
  );
  const calculatedHcp = currentHandicapCalculation.index;
  // Golf Ireland revises the official index no later than the following day.
  // If today's score is already synced, calculate its effect locally; otherwise
  // the official synced index remains the source of truth.
  const hcp = hasRoundToday ? calculatedHcp ?? apiHandicapIndex : apiHandicapIndex ?? calculatedHcp;
  const rawCurrentHcp = diffs.length >= 8 ? handicap(diffs) : null;
  // Existing ESR/official adjustments belong to the differentials already in
  // the record. A future score starts without that adjustment, which lets the
  // safeguard dilute only as affected scores leave or stop counting.
  const existingDifferentialAdjustment = hcp !== null && rawCurrentHcp !== null
    ? r1(hcp - rawCurrentHcp)
    : 0;
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
  const allTimeRankedRounds = useMemo(() =>
    rounds
      .map((round) => ({ round, differential: scoreDifferentialForRound(round) }))
      .filter(({ differential }) => differential !== null)
      .sort((a, b) => a.differential - b.differential || String(b.round.date).localeCompare(String(a.round.date)))
      .map((entry, index) => ({ ...entry, rank: index + 1 })),
    [rounds]
  );
  const latestAllTimeRank = allTimeRankedRounds.find(({ round }) => round.id === latestRound?.id) ?? null;
  const leaderboardInsight = useMemo(() => {
    if (allTimeRankedRounds.length === 0 || !latestRound?.date) return null;

    const latestDate = new Date(`${latestRound.date}T00:00:00`);
    if (isNaN(latestDate.getTime())) return null;
    const twoWeeksAgo = new Date(latestDate);
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    const twoMonthsAgo = new Date(latestDate);
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

    const leaderboardSize = Math.min(10, allTimeRankedRounds.length);
    const bestRounds = allTimeRankedRounds.slice(0, leaderboardSize);
    const countSince = (startDate) => bestRounds.filter(({ round }) => {
        const roundDate = new Date(`${round.date}T00:00:00`);
        return !isNaN(roundDate.getTime()) && roundDate >= startDate && roundDate <= latestDate;
      }).length;
    const lastTwoWeeksCount = countSince(twoWeeksAgo);
    const recentBestCount = countSince(twoMonthsAgo);

    const rollingIndexThrough = (roundIndex) => {
      if (roundIndex < 0) return null;
      const windowDiffs = rounds
        .slice(Math.max(0, roundIndex - 19), roundIndex + 1)
        .map(scoreDifferentialForRound)
        .filter((diff) => diff !== null);
      return windowDiffs.length >= 8 ? handicap(windowDiffs) : null;
    };
    const recentRoundIndexes = rounds
      .map((_, index) => index)
      .slice(-4);
    const recentReductionResults = recentRoundIndexes
      .map((roundIndex) => {
        const before = rollingIndexThrough(roundIndex - 1);
        const after = rollingIndexThrough(roundIndex);
        return before !== null && after !== null ? after < before - 0.05 : null;
      })
      .filter((result) => result !== null);
    const recentReductionCount = recentReductionResults.filter(Boolean).length;
    const handicapImpactInsight = recentReductionResults.length >= 2 && recentReductionCount >= 2
      ? `${recentReductionCount} of your last ${recentReductionResults.length} rounds have reduced your handicap.`
      : "";

    const groupLabel = leaderboardSize === allTimeRankedRounds.length
      ? `${leaderboardSize} ranked round${leaderboardSize === 1 ? "" : "s"}`
      : `top ${leaderboardSize} rounds`;

    if (lastTwoWeeksCount >= 2) {
      return `${lastTwoWeeksCount} of your top ${leaderboardSize} rounds have come in the last two weeks. ${handicapImpactInsight ? `${handicapImpactInsight} Keep it going!` : "That's serious form — keep it going!"}`;
    }

    if (recentBestCount > 0) {
      return `${recentBestCount} of your ${groupLabel} ${recentBestCount === 1 ? "has" : "have"} come in the last two months. ${handicapImpactInsight ? `${handicapImpactInsight} ` : ""}Keep it going!`;
    }

    if (latestAllTimeRank) {
      return `Your latest round sits at #${latestAllTimeRank.rank} all time. Every new card is another chance to climb.`;
    }

    return null;
  }, [allTimeRankedRounds, latestAllTimeRank, latestRound, rounds]);
  const nextRoundDrop = useMemo(() => {
    const recentRounds = clamp20(rounds);
    if (recentRounds.length < 20) return null;
    const round = recentRounds[0];
    const diff = scoreDifferentialForRound(round);
    return {
      round,
      diff,
      counts: countingIds.has(round.id),
    };
  }, [rounds, countingIds]);

  const differentialHistory = useMemo(() =>
    rounds
      .map((round) => ({ date: round.date, value: scoreDifferentialForRound(round) }))
      .filter((point) => point.date && point.value !== null),
    [rounds]
  );
  const recentFormInsight = useMemo(() => {
    if (differentialHistory.length < 10) return null;
    const average = (points) => points.reduce((sum, point) => sum + Number(point.value), 0) / points.length;
    const latestFive = differentialHistory.slice(-5);
    const previousFive = differentialHistory.slice(-10, -5);
    const earlierRounds = differentialHistory.slice(0, -5);
    const historicalWindows = [];

    for (let endIndex = 4; endIndex <= differentialHistory.length - 6; endIndex += 1) {
      const window = differentialHistory.slice(endIndex - 4, endIndex + 1);
      historicalWindows.push({
        average: average(window),
        startDate: window[0].date,
        endDate: window[4].date,
      });
    }

    const latestAverage = average(latestFive);
    const previousAverage = average(previousFive);
    const earlierAverage = average(earlierRounds);
    const previousBest = historicalWindows.reduce(
      (best, window) => !best || window.average < best.average ? window : best,
      null
    );
    const versusPrevious = r1(latestAverage - previousAverage);
    const isRecord = previousBest && latestAverage < previousBest.average - 0.05;
    const isLevelRecord = previousBest && Math.abs(latestAverage - previousBest.average) <= 0.05;
    const improving = versusPrevious < -0.05;
    const steady = Math.abs(versusPrevious) <= 0.05;

    let heading = "Building a stronger run";
    if (isRecord) heading = "Your best five-round run yet";
    else if (isLevelRecord) heading = "Matching your best five-round run";
    else if (improving) heading = "Moving in the right direction";
    else if (steady) heading = "Holding steady";

    let summary = `Your recent five-round average is ${latestAverage.toFixed(1)}, `;
    if (improving) summary += `${Math.abs(versusPrevious).toFixed(1)} lower than the previous five.`;
    else if (steady) summary += "level with the previous five.";
    else summary += `${versusPrevious.toFixed(1)} higher than the previous five.`;

    let encouragement = "Keep grinding — the next good card can turn the line.";
    if (isRecord) encouragement = "That is real progress. Keep grinding!";
    else if (isLevelRecord) encouragement = "You are right on your best pace. Keep it going!";
    else if (improving) encouragement = "The work is showing. Keep grinding!";
    else if (steady) encouragement = "A solid base — one strong card can move it lower.";

    return {
      heading,
      summary,
      encouragement,
      latestAverage,
      previousAverage,
      earlierAverage,
      previousBest,
    };
  }, [differentialHistory]);
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

  const applyManualPlanner = (next) => {
    setManualPlanner(next);
    setPlanner(next);
  };

  const searchCourseRatings = async () => {
    const query = courseLookup.query.trim();
    if (!courseRatingSearchEndpoint) {
      setCourseLookup((current) => ({ ...current, status: "error", message: "Start the local sync server before looking up course ratings." }));
      return;
    }
    if (query.length < 3) {
      setCourseLookup((current) => ({ ...current, status: "error", message: "Enter at least 3 characters to search." }));
      return;
    }

    setCourseLookup((current) => ({ ...current, status: "loading", message: "Searching course ratings...", courses: [], selectedCourseId: "", tees: [] }));
    try {
      const params = new URLSearchParams({ name: query, country: courseLookup.country });
      const response = await fetch(`${courseRatingSearchEndpoint}?${params}`);
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      setCourseLookup((current) => ({
        ...current,
        status: "success",
        message: payload.courses?.length ? `${payload.courses.length} course match${payload.courses.length === 1 ? "" : "es"} found.` : "No course matches found.",
        courses: payload.courses ?? [],
        selectedCourseId: "",
        tees: [],
      }));
    } catch (error) {
      setCourseLookup((current) => ({ ...current, status: "error", message: error instanceof Error ? error.message : "Course lookup failed." }));
    }
  };

  const loadCourseTees = async (courseId) => {
    const selectedCourse = courseLookup.courses.find((course) => String(course.courseID) === String(courseId));
    if (!selectedCourse || !courseRatingTeesEndpoint) return;

    setCourseLookup((current) => ({ ...current, selectedCourseId: courseId, status: "loading", message: "Loading tees...", tees: [] }));
    try {
      const response = await fetch(`${courseRatingTeesEndpoint}?${new URLSearchParams({ courseId })}`);
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      setCourseLookup((current) => ({
        ...current,
        status: "success",
        message: payload.tees?.length ? `Choose one of ${payload.tees.length} tee rating${payload.tees.length === 1 ? "" : "s"}.` : "No tee ratings found for this course.",
        tees: payload.tees ?? [],
      }));
    } catch (error) {
      setCourseLookup((current) => ({ ...current, status: "error", message: error instanceof Error ? error.message : "Could not load course tees." }));
    }
  };

  const selectCourseTee = (teeIndex) => {
    const selectedCourse = courseLookup.courses.find((course) => String(course.courseID) === String(courseLookup.selectedCourseId));
    const selectedTee = courseLookup.tees[Number(teeIndex)];
    if (!selectedCourse || !selectedTee) return;

    applyManualPlanner({
      ...manualPlanner,
      course: selectedCourse.facilityName ?? selectedCourse.fullName ?? "",
      tee: selectedTee.tee,
      holes: selectedTee.holes,
      rating: selectedTee.rating,
      slope: selectedTee.slope,
      par: selectedTee.par,
      pcc: manualPlanner.pcc ?? 0,
    });
  };

  const addManualRound = async () => {
    const score = Number(manualRound.score);
    const rating = Number(manualPlanner.rating);
    const slope = Number(manualPlanner.slope);
    if (!manualRound.date || !Number.isFinite(score) || score <= 0 || !manualPlanner.course.trim() || !Number.isFinite(rating) || !Number.isFinite(slope) || slope <= 0) {
      setManualRoundState({ status: "error", message: "Enter a date, score, course, rating and valid slope." });
      return;
    }

    const existingMatch = rounds.find((round) => round.date === manualRound.date && Number(round.score) === score);
    if (existingMatch) {
      setManualRoundState({ status: "error", message: "A round with this date and score is already recorded." });
      return;
    }

    await db.rounds.add({
      date: manualRound.date,
      course: manualPlanner.course.trim(),
      tee: manualPlanner.tee?.trim() ?? "",
      holes: manualPlanner.holes || "18 holes",
      par: manualPlanner.par === "" || manualPlanner.par === undefined ? undefined : Number(manualPlanner.par),
      score,
      rating,
      slope,
      pcc: Number(manualPlanner.pcc) || 0,
      handicapIndex: hcp ?? undefined,
      source: "manual",
      sourceId: `manual-${manualRound.date}-${score}-${Date.now()}`,
    });
    setManualRound({ date: todayISO(), score: "" });
    setManualRoundState({ status: "success", message: "Manual round added. A matching Golf Ireland round will replace it on sync." });
  };

  const saveGolfIrelandSettings = async () => {
    const nextSettings = { ...golfIrelandSettings, displayName: "" };
    await db.settings.put({ key: golfIrelandSettingsKey, value: nextSettings });
    setGolfIrelandSettings(nextSettings);
    setHasSavedGolfIrelandCredentials(Boolean(golfIrelandSettings.login && golfIrelandSettings.password));
    setShowGolfIrelandCredentials(false);
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
      const displayName = cleanText(payload.profile?.displayName ?? payload.displayName ?? payload.name);
      const nextGolfIrelandSettings = {
        ...golfIrelandSettings,
        displayName: displayName || golfIrelandSettings.displayName,
      };
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
            source: "golfIrelandHistory",
            displayIndex: entry.displayIndex,
          };
        })
        .filter(Boolean);
      importedHandicapHistory.push(...handicapHistoryFromRounds(importedRounds));

      const currentHandicap = payload.handicap
        ?? payload.raw?.handicap
        ?? payload.handicapRecord?.handicap
        ?? payload.raw?.handicapRecord?.handicap;
      const currentHandicapIndex = Number(currentHandicap?.index);
      if (currentHandicap?.index !== undefined && currentHandicap?.index !== null && !isNaN(currentHandicapIndex)) {
        importedHandicapHistory.push({
          date: todayISO(),
          value: r1(currentHandicapIndex),
          source: "golfIrelandCurrent",
          displayIndex: currentHandicap.displayIndex,
        });
      }

      if (importedRounds.length === 0) {
        setSyncState({ status: "error", message: syncSampleMessage(rawScores) });
        return;
      }

      const uniqueRounds = [...new Map(importedRounds.map((round) => [roundImportKey(round), round])).values()];
      const manualRounds = await db.rounds.where("source").equals("manual").toArray();
      const golfIrelandMatchKeys = new Set(uniqueRounds.map((round) => `${round.date}|${Number(round.score)}`));
      const unmatchedManualRounds = manualRounds.filter((round) => !golfIrelandMatchKeys.has(`${round.date}|${Number(round.score)}`));
      const replacedManualCount = manualRounds.length - unmatchedManualRounds.length;
      const uniqueHistory = [...new Map(importedHandicapHistory.map((entry) => [entry.date, entry])).values()];
      await db.transaction("rw", db.rounds, db.courses, db.handicapHistory, async () => {
        await Promise.all([db.rounds.clear(), db.courses.clear(), db.handicapHistory.clear()]);
        if (uniqueRounds.length > 0) await db.rounds.bulkAdd(uniqueRounds);
        if (unmatchedManualRounds.length > 0) await db.rounds.bulkAdd(unmatchedManualRounds);
        if (uniqueHistory.length > 0) await db.handicapHistory.bulkAdd(uniqueHistory);
      });

      setSyncState({
        status: "success",
        message: `Synced ${uniqueRounds.length} Golf Ireland round${uniqueRounds.length === 1 ? "" : "s"}${uniqueHistory.length ? ` and ${uniqueHistory.length} official handicap history point${uniqueHistory.length === 1 ? "" : "s"}` : ""}.${replacedManualCount ? ` Replaced ${replacedManualCount} matching manual round${replacedManualCount === 1 ? "" : "s"}.` : ""}${unmatchedManualRounds.length ? ` Kept ${unmatchedManualRounds.length} unmatched manual round${unmatchedManualRounds.length === 1 ? "" : "s"}.` : ""}`,
      });
      setGolfIrelandSettings(nextGolfIrelandSettings);
      await db.settings.put({ key: golfIrelandSettingsKey, value: nextGolfIrelandSettings });
      setHasSavedGolfIrelandCredentials(true);
      setShowGolfIrelandCredentials(false);
    } catch (error) {
      setSyncState({ status: "error", message: error instanceof Error ? error.message : "Golf Ireland sync failed." });
    }
  };

  const reqDiff = target !== "" && !isNaN(Number(target)) ? Number(target) : null;
  const golfIrelandAuthenticated = syncState.status === "success";
  const golfIrelandCredentialsReady = Boolean(golfIrelandSettings.login && golfIrelandSettings.password);
  const shouldShowGolfIrelandCredentials = showGolfIrelandCredentials || !hasSavedGolfIrelandCredentials;
  const golfIrelandStatusLabel = !golfIrelandSyncEndpoint
    ? "Endpoint needed"
    : golfIrelandAuthenticated
      ? "Authenticated"
      : hasSavedGolfIrelandCredentials
        ? "Credentials saved"
        : "Ready";
  const golfIrelandStatusGood = golfIrelandSyncEndpoint && (golfIrelandAuthenticated || hasSavedGolfIrelandCredentials);
  const golfIrelandAccountLabel = golfIrelandSettings.displayName || (golfIrelandSettings.login
    ? `${golfIrelandSettings.login.slice(0, 3)}${golfIrelandSettings.login.length > 3 ? "..." : ""}`
    : "Not set");

  const coursePresets = useMemo(() => {
    const byKey = new Map();
    rounds.forEach((r) => {
      if (!r.course || !r.rating || !r.slope) return;
      if (shouldHideCourse(r)) return;
      byKey.set(coursePresetKey(r), {
        course: r.course,
        tee: r.tee ?? "",
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
      const aLabel = courseSelectLabel(a).toLowerCase();
      const bLabel = courseSelectLabel(b).toLowerCase();
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

  const lastRoundScenario = useMemo(() => {
    if (!latestRound) return null;

    const alternateScore = Number(lastRoundScenarioScore);
    const originalDiff = scoreDifferentialForRound(latestRound);
    const roundHandicapIndex = Number(latestRound.handicapIndex);
    const handicapIndexAtPlay = latestRound.date === todayISO()
      ? indexAtPlayToday
      : !isNaN(roundHandicapIndex)
        ? roundHandicapIndex
        : hcp;
    // When the score is unchanged, reuse Golf Ireland's synced differential so
    // the current and what-if paths are exactly identical. Only hypothetical
    // scores need a locally calculated differential.
    const scoreIsUnchanged = alternateScore === Number(latestRound.score);
    const alternateDiff = scoreIsUnchanged
      ? originalDiff
      : differential(
          alternateScore,
          latestRound.rating,
          latestRound.slope,
          latestRound.pcc,
          isNineHoleRound(latestRound),
          handicapIndexAtPlay
        );
    const latestRoundInWindow = clampedWithDiff.some(({ id }) => id === latestRound.id);

    if (!latestRoundInWindow || originalDiff === null || alternateDiff === null || diffs.length < 8) {
      return {
        canCalculate: false,
        originalScore: latestRound.score,
        alternateScore: lastRoundScenarioScore,
        originalDiff,
        alternateDiff,
        message: !latestRoundInWindow
          ? "The last round is not in the current 20-round handicap window."
          : diffs.length < 8
            ? "Need at least 8 complete differentials to calculate this."
            : "Need a valid score, rating and slope for the last round.",
      };
    }

    const scenarioDiffs = clampedWithDiff.map(({ id, d }) => id === latestRound.id ? alternateDiff : d);
    const scenarioExceptionalDiffs = latestRound.date === todayISO()
      ? todaysRounds.map((round) => round.id === latestRound.id ? alternateDiff : scoreDifferentialForRound(round)).filter((diff) => diff !== null)
      : [alternateDiff];
    let scenarioCalculation;
    if (latestRound.date === todayISO()) {
      scenarioCalculation = handicapWithEsr(scenarioDiffs, scenarioExceptionalDiffs, handicapIndexAtPlay);
    } else if (scoreIsUnchanged && hcp !== null) {
      // Once Golf Ireland has completed its overnight revision, its published
      // index is authoritative. Re-entering the real score must reproduce it
      // exactly and must not invent an ESR that Golf Ireland did not apply.
      scenarioCalculation = { index: hcp, indexBeforeEsr: hcp, esrReduction: 0 };
    } else {
      // Anchor a historical hypothetical to the official current index, then
      // apply only the change caused by replacing the latest differential.
      // This preserves any PCC, caps or prior official adjustments already in
      // Golf Ireland's published value.
      const actualRawIndex = handicap(diffs);
      const scenarioRawIndex = handicap(scenarioDiffs);
      const officialBaseline = hcp ?? actualRawIndex;
      const indexBeforeEsr = r1(officialBaseline + scenarioRawIndex - actualRawIndex);
      const esrReduction = handicapIndexAtPlay !== null
        ? exceptionalScoreReduction(alternateDiff, handicapIndexAtPlay)
        : 0;
      scenarioCalculation = {
        index: r1(indexBeforeEsr - esrReduction),
        indexBeforeEsr,
        esrReduction,
      };
    }
    const projectedHcp = scenarioCalculation.index;
    const change = hcp !== null && projectedHcp !== null ? r1(projectedHcp - hcp) : null;
    const originalCounts = countingIds.has(latestRound.id);
    const scenarioCountingIds = new Set(
      clampedWithDiff
        .map(({ id, d }) => ({ id, d: id === latestRound.id ? alternateDiff : d }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 8)
        .map(({ id }) => id)
    );

    return {
      canCalculate: true,
      originalScore: latestRound.score,
      alternateScore: lastRoundScenarioScore,
      originalDiff,
      alternateDiff,
      projectedHcp,
      projectedHcpBeforeEsr: scenarioCalculation.indexBeforeEsr,
      handicapIndexAtPlay,
      esrReduction: scenarioCalculation.esrReduction,
      change,
      originalCounts,
      alternateCounts: scenarioCountingIds.has(latestRound.id),
    };
  }, [latestRound, lastRoundScenarioScore, clampedWithDiff, diffs, hcp, countingIds, indexAtPlayToday, todaysRounds]);

  const plannerRows = useMemo(() => {
    if (!planner.course || !planner.rating || !planner.slope) return [];
    if (reqDiff === null) return [];
    const plannerIsNineHole = isNineHoleCourse(planner);
    const targetExact = scoreForDifferential(reqDiff, planner.rating, planner.slope, planner.pcc, plannerIsNineHole, hcp);
    if (targetExact === null) return [];

    const projectScore = (score) => {
      const safeScore = Math.max(1, score);
      const actualDiff = differential(safeScore, planner.rating, planner.slope, planner.pcc, plannerIsNineHole, hcp);
      const nextWithMarker = actualDiff !== null
        ? clamp20([
            ...diffs.map((d) => ({ d: d + existingDifferentialAdjustment, isNew: false })),
            { d: actualDiff, isNew: true },
          ])
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
      ? Math.floor(scoreForDifferential(hcp - 7, planner.rating, planner.slope, planner.pcc, plannerIsNineHole, hcp) ?? NaN)
      : null;
    const esrTwoScore = hcp !== null
      ? Math.floor(scoreForDifferential(hcp - 10, planner.rating, planner.slope, planner.pcc, plannerIsNineHole, hcp) ?? NaN)
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
  }, [reqDiff, planner, diffs, hcp, existingDifferentialAdjustment]);

  const courseTeeInputWidth = useMemo(() => {
    const labels = coursePresets.map(courseSelectLabel);
    const longest = Math.max("Course, tee, holes".length, ...labels.map((label) => label.length));
    return `${Math.max(34, longest + 4)}ch`;
  }, [coursePresets]);

  const roundHeaders = ["Date", "Course", "Tee", "Holes", "Score", "Rating", "Slope", "PCC", "Differential"];
  const plannerHeaders = ["Outcome", "Score", "Actual diff", "Counts", "ESR", "Index after next round", "Change"];

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
              Connect Golf Ireland once, sync your scoring record, then use the dashboard to plan the next useful round.
            </SectionIntro>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10, marginTop: 14 }}>
              {[
                ["1", "Authenticate with Golf Ireland", "Sign in once; the panel collapses to your authenticated account."],
                ["2", "Sync scores", "Import rounds, tee data, differentials and official handicap history."],
                ["3", "Plan the next card", "Use synced course data to spot scores that count, cut, or trigger ESR."],
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
              sub={hasRoundToday
                ? `Includes today's round${currentHandicapCalculation.esrReduction ? ` · ESR -${currentHandicapCalculation.esrReduction.toFixed(1)}` : ""}`
                : apiHandicapIndex !== null
                  ? "Official Golf Ireland index"
                  : diffs.length < 8
                    ? `${diffs.length} of 8 rounds entered`
                    : `${diffs.length} rounds`}
              accent
              help="Uses the official Golf Ireland index until a round dated today is synced. Today's pending update is calculated from the best 8 of the latest 20, including any applicable ESR."
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
            </div>
          </div>

          {/* Golf Ireland sync */}
          <div className="rounded-xl" style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)", overflow: "hidden" }}>
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              padding: "18px 20px 14px",
              borderBottom: "1px solid var(--border)",
            }}>
              <div>
                <h2 style={{ fontSize: 15, fontWeight: 800, color: "var(--text-h)", margin: "0 0 3px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Sync From Golf Ireland
                </h2>
                <p style={{ fontSize: 12, color: "var(--text)", margin: 0 }}>
                  Pull scores, tees, differentials and official handicap history, then recalculate the latest index.
                </p>
              </div>
              <span style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                fontSize: 12,
                color: golfIrelandStatusGood ? "#166534" : golfIrelandSyncEndpoint ? "#1d4ed8" : "#92400e",
                background: golfIrelandStatusGood ? "#f0fdf4" : golfIrelandSyncEndpoint ? "#eff6ff" : "#fffbeb",
                border: `1px solid ${golfIrelandStatusGood ? "#bbf7d0" : golfIrelandSyncEndpoint ? "#bfdbfe" : "#fde68a"}`,
                borderRadius: 999,
                whiteSpace: "nowrap",
                padding: "6px 10px",
                fontWeight: 800,
              }}>
                <span aria-hidden="true" style={{
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  background: golfIrelandStatusGood ? "#16a34a" : golfIrelandSyncEndpoint ? "#2563eb" : "#f59e0b",
                  display: "inline-block",
                }} />
                {golfIrelandStatusLabel}
              </span>
            </div>
            <div style={{ padding: 20 }}>
              {!shouldShowGolfIrelandCredentials && (
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 14,
                  flexWrap: "wrap",
                  background: "rgba(22,101,52,0.04)",
                  border: "1px solid #dcfce7",
                  borderRadius: 10,
                  padding: "12px 14px",
                }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 800, color: "var(--text-h)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                      Golf Ireland account
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text)", marginTop: 2 }}>
                      {golfIrelandAuthenticated ? "Authenticated" : "Credentials saved"} as {golfIrelandAccountLabel}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <button
                      onClick={() => setShowGolfIrelandCredentials(true)}
                      style={{ ...neutralButtonStyle, height: 36, padding: "0 12px", width: "auto", flex: "0 0 auto", whiteSpace: "nowrap", borderRadius: 8 }}
                    >
                      Change Login
                    </button>
                    <button
                      onClick={syncFromGolfIreland}
                      disabled={syncState.status === "syncing"}
                      style={{
                        ...btnStyle(syncState.status === "syncing" ? "#e2e8f0" : "#166534", syncState.status === "syncing" ? "#64748b" : "#fff"),
                        height: 36,
                        padding: "0 16px",
                        width: "auto",
                        flex: "0 0 auto",
                        whiteSpace: "nowrap",
                        borderRadius: 8,
                        boxShadow: syncState.status === "syncing" ? "none" : "0 2px 8px rgba(22,101,52,0.2)",
                        cursor: syncState.status === "syncing" ? "wait" : "pointer",
                      }}
                    >
                      <SyncButtonLabel syncing={syncState.status === "syncing"} />
                    </button>
                  </div>
                </div>
              )}
              {shouldShowGolfIrelandCredentials && (
                <div style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" }}>
                  <InputField
                    label="Username"
                    placeholder="Golf Ireland username"
                    value={golfIrelandSettings.login}
                    wrapperStyle={{ flex: "1 1 220px", minWidth: 180 }}
                    onChange={(e) => {
                      setGolfIrelandSettings({ ...golfIrelandSettings, login: e.target.value });
                    }}
                  />
                  <InputField
                    label="Password"
                    type="password"
                    placeholder="Golf Ireland password"
                    value={golfIrelandSettings.password}
                    wrapperStyle={{ flex: "1 1 220px", minWidth: 180 }}
                    onChange={(e) => {
                      setGolfIrelandSettings({ ...golfIrelandSettings, password: e.target.value });
                    }}
                  />
                  <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-start", flexWrap: "wrap" }}>
                    <button onClick={saveGolfIrelandSettings} disabled={!golfIrelandCredentialsReady} style={{
                      ...neutralButtonStyle,
                      height: 38,
                      padding: "0 14px",
                      width: "auto",
                      flex: "0 0 auto",
                      whiteSpace: "nowrap",
                      borderRadius: 8,
                      opacity: golfIrelandCredentialsReady ? 1 : 0.55,
                      cursor: golfIrelandCredentialsReady ? "pointer" : "not-allowed",
                    }}>
                      Save Settings
                    </button>
                    <button
                      onClick={syncFromGolfIreland}
                      disabled={syncState.status === "syncing" || !golfIrelandCredentialsReady}
                      style={{
                        ...btnStyle(syncState.status === "syncing" || !golfIrelandCredentialsReady ? "#e2e8f0" : "#166534", syncState.status === "syncing" || !golfIrelandCredentialsReady ? "#64748b" : "#fff"),
                        height: 38,
                        padding: "0 16px",
                        width: "auto",
                        flex: "0 0 auto",
                        whiteSpace: "nowrap",
                        borderRadius: 8,
                        boxShadow: syncState.status === "syncing" || !golfIrelandCredentialsReady ? "none" : "0 2px 8px rgba(22,101,52,0.2)",
                        cursor: syncState.status === "syncing" ? "wait" : golfIrelandCredentialsReady ? "pointer" : "not-allowed",
                      }}
                    >
                      <SyncButtonLabel syncing={syncState.status === "syncing"} />
                    </button>
                    {hasSavedGolfIrelandCredentials && (
                      <button
                        onClick={() => setShowGolfIrelandCredentials(false)}
                        style={{ ...neutralButtonStyle, height: 38, padding: "0 12px", width: "auto", flex: "0 0 auto", whiteSpace: "nowrap", borderRadius: 8 }}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
            {syncState.message && (
              <div style={{
                fontSize: 12,
                color: syncState.status === "error" ? "#991b1b" : syncState.status === "success" || syncState.status === "saved" ? "#166534" : "var(--text)",
                background: syncState.status === "error" ? "#fef2f2" : syncState.status === "success" || syncState.status === "saved" ? "#f0fdf4" : "rgba(100,116,139,0.08)",
                borderTop: "1px solid var(--border)",
                padding: "10px 20px",
                fontWeight: 600,
              }}>
                {syncState.message}
              </div>
            )}
          </div>

          <div className="rounded-xl" style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)", overflow: "hidden" }}>
            <button
              type="button"
              onClick={() => setShowManualRound((shown) => !shown)}
              aria-expanded={showManualRound}
              style={{ width: "100%", border: 0, background: "transparent", color: "var(--text-h)", padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", textAlign: "left" }}
            >
              <span>
                <strong style={{ display: "block", fontSize: 14, textTransform: "uppercase", letterSpacing: "0.06em" }}>Add a round manually</strong>
                <span style={{ display: "block", marginTop: 3, color: "var(--text)", fontSize: 12 }}>Use an official course and tee lookup, or enter the rating details yourself.</span>
              </span>
              <span aria-hidden="true" style={{ fontSize: 20 }}>{showManualRound ? "−" : "+"}</span>
            </button>

            {showManualRound && (
              <div style={{ borderTop: "1px solid var(--border)", padding: 20 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                  <select
                    aria-label="Manual round course country"
                    value={courseLookup.country}
                    onChange={(e) => setCourseLookup({ ...courseLookup, country: e.target.value, courses: [], selectedCourseId: "", tees: [], message: "" })}
                    style={{ ...fieldControlStyle, padding: "0 10px", flex: "0 1 150px" }}
                  >
                    {courseRatingCountries.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                  </select>
                  <input
                    aria-label="Manual round course search"
                    placeholder="Search course name"
                    value={courseLookup.query}
                    onChange={(e) => setCourseLookup({ ...courseLookup, query: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Enter") searchCourseRatings(); }}
                    style={{ ...fieldControlStyle, padding: "0 12px", flex: "1 1 240px", maxWidth: 380 }}
                  />
                  <button type="button" onClick={searchCourseRatings} disabled={courseLookup.status === "loading"} style={{ ...neutralButtonStyle, width: "auto", height: 40, padding: "0 16px", borderRadius: 8 }}>
                    {courseLookup.status === "loading" ? "Searching…" : "Look up course"}
                  </button>
                </div>

                {(courseLookup.courses.length > 0 || courseLookup.tees.length > 0 || courseLookup.message) && (
                  <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, marginBottom: 12, background: "rgba(100,116,139,0.06)" }}>
                    {courseLookup.message && <div style={{ fontSize: 12, color: courseLookup.status === "error" ? "#dc2626" : "var(--text)", marginBottom: courseLookup.courses.length || courseLookup.tees.length ? 8 : 0 }}>{courseLookup.message}</div>}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {courseLookup.courses.length > 0 && (
                        <select aria-label="Manual round course" value={courseLookup.selectedCourseId} onChange={(e) => loadCourseTees(e.target.value)} style={{ ...fieldControlStyle, padding: "0 10px", width: "min(100%, 380px)" }}>
                          <option value="">Choose course</option>
                          {courseLookup.courses.map((course) => <option key={course.courseID} value={course.courseID}>{course.fullName} - {course.city}{course.stateDisplay ? `, ${course.stateDisplay}` : ""}</option>)}
                        </select>
                      )}
                      {courseLookup.tees.length > 0 && (
                        <select aria-label="Manual round tee" value="" onChange={(e) => selectCourseTee(e.target.value)} style={{ ...fieldControlStyle, padding: "0 10px", width: "min(100%, 520px)" }}>
                          <option value="">Choose tee / holes / rating</option>
                          {courseLookup.tees.map((tee, index) => <option key={`${tee.tee}-${tee.gender}-${tee.rating}-${tee.slope}-${index}`} value={index}>{tee.tee}, {tee.gender}, {tee.holes}, rating {tee.rating}, slope {tee.slope}{tee.par ? `, par ${tee.par}` : ""}</option>)}
                        </select>
                      )}
                    </div>
                  </div>
                )}

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(125px, 1fr))", gap: 10 }}>
                  <InputField label="Date" type="date" value={manualRound.date} onChange={(e) => setManualRound({ ...manualRound, date: e.target.value })} />
                  <InputField label="Score" type="number" min="1" value={manualRound.score} onChange={(e) => setManualRound({ ...manualRound, score: e.target.value })} />
                  <InputField label="Course" value={manualPlanner.course} onChange={(e) => applyManualPlanner({ ...manualPlanner, course: e.target.value })} />
                  <InputField label="Tee" value={manualPlanner.tee} onChange={(e) => applyManualPlanner({ ...manualPlanner, tee: e.target.value })} />
                  <div className="flex flex-col gap-1">
                    <label style={fieldLabelStyle}>Holes</label>
                    <select value={manualPlanner.holes} onChange={(e) => applyManualPlanner({ ...manualPlanner, holes: e.target.value })} style={{ ...fieldControlStyle, padding: "0 10px" }}>
                      <option value="18 holes">18 holes</option><option value="9 holes">9 holes</option><option value="Front 9">Front 9</option><option value="Back 9">Back 9</option>
                    </select>
                  </div>
                  <InputField label="Rating" type="number" step="0.1" value={manualPlanner.rating} onChange={(e) => applyManualPlanner({ ...manualPlanner, rating: e.target.value })} />
                  <InputField label="Slope" type="number" value={manualPlanner.slope} onChange={(e) => applyManualPlanner({ ...manualPlanner, slope: e.target.value })} />
                  <InputField label="PCC" type="number" value={manualPlanner.pcc} onChange={(e) => applyManualPlanner({ ...manualPlanner, pcc: e.target.value })} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 14 }}>
                  <button type="button" onClick={addManualRound} style={{ ...btnStyle("#166534", "#fff"), width: "auto", height: 40, padding: "0 18px", borderRadius: 8 }}>Add round</button>
                  <span style={{ fontSize: 12, color: manualRoundState.status === "error" ? "#dc2626" : "#166534", fontWeight: 700 }}>{manualRoundState.message}</span>
                </div>
                <p style={{ marginTop: 10, color: "var(--text)", fontSize: 11 }}>On sync, an official Golf Ireland round with the same date and score automatically replaces this manual entry.</p>
              </div>
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
                              {r.source === "manual" && (
                                <span title="This entry will be replaced when Golf Ireland returns the same date and score" style={{ fontSize: 10, fontWeight: 700, background: "#b45309", color: "#fff", borderRadius: 999, padding: "2px 7px", letterSpacing: "0.05em" }}>MANUAL</span>
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

          {rounds.length > 0 && (
            <div className="rounded-xl p-5" style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
              <div style={{ marginBottom: 8 }}>
                <SectionIntro title="Score Differentials">
                  Bars and dates show your latest 20 rounds. The trend calculation also uses prior, excluded scores.
                </SectionIntro>
              </div>
              <div className="differential-insight-layout">
                <div style={{ minWidth: 0 }}>
                  <DifferentialBarChart points={differentialHistory} />
                  {differentialHistory.length > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 11, color: "var(--text)" }}>
                      <span>Latest: {Number(differentialHistory[differentialHistory.length - 1].value).toFixed(1)}</span>
                      <span>Best of latest 20: {Math.min(...differentialHistory.slice(-20).map((point) => Number(point.value))).toFixed(1)}</span>
                    </div>
                  )}
                </div>
                <RecentFormInsight insight={recentFormInsight} />
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
            {/* Last round scenario */}
            {latestRound && (
              <div className="rounded-xl p-5" style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
                <div style={{ marginBottom: 16 }}>
                  <SectionIntro title="Last Round What-If">
                    Recalculate your current index as though the latest synced score had been different.
                  </SectionIntro>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 12 }}>
                  <InputField
                    label="Actual score"
                    value={latestRound.score ?? ""}
                    readOnly
                  />
                  <InputField
                    label="What-if score"
                    type="number"
                    value={lastRoundScenarioScore}
                    onChange={(e) => setLastRoundScenarioScore(e.target.value)}
                  />
                  <InputField
                    label="Rating"
                    value={latestRound.rating ?? ""}
                    readOnly
                  />
                  <InputField
                    label="Slope"
                    value={latestRound.slope ?? ""}
                    readOnly
                  />
                  <InputField
                    label="PCC"
                    value={latestRound.pcc ?? 0}
                    readOnly
                  />
                </div>
                <p style={{ fontSize: 12, color: "var(--text)", margin: "0 0 14px" }}>
                  {manualCourseLabel(latestRound) || courseTeeLabel(latestRound) || "Latest round"} on {shortDate(latestRound.date)}
                </p>
                {isNineHoleRound(latestRound) && Number(lastRoundScenarioScore) !== Number(latestRound.score) && (
                  <p style={{ fontSize: 11, color: "var(--text)", margin: "-6px 0 14px" }}>
                    This 9-hole what-if combines the played-nine differential with an estimated WHS expected-nine value. The unchanged score continues to use Golf Ireland’s official differential.
                  </p>
                )}

                {lastRoundScenario?.canCalculate ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
                    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, background: "rgba(100,116,139,0.06)" }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Current index</div>
                      <div style={{ fontSize: 28, fontWeight: 800, color: "var(--text-h)", lineHeight: 1.15 }}>{hcp?.toFixed ? hcp.toFixed(1) : hcp}</div>
                    </div>
                    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, background: "rgba(34,197,94,0.07)" }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.06em" }}>What-if index</div>
                      <div style={{ fontSize: 28, fontWeight: 800, color: "var(--text-h)", lineHeight: 1.15 }}>{lastRoundScenario.projectedHcp.toFixed(1)}</div>
                      {lastRoundScenario.esrReduction > 0 && (
                        <div style={{ marginTop: 4, color: "#0f766e", fontSize: 11, fontWeight: 800 }}>
                          Includes ESR -{lastRoundScenario.esrReduction.toFixed(1)}
                          {lastRoundScenario.projectedHcpBeforeEsr !== null
                            ? ` (normal ${lastRoundScenario.projectedHcpBeforeEsr.toFixed(1)})`
                            : ""}
                        </div>
                      )}
                    </div>
                    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, background: "rgba(59,130,246,0.07)" }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Change</div>
                      <div style={{
                        fontSize: 28,
                        fontWeight: 800,
                        color: lastRoundScenario.change < 0 ? "#16a34a" : lastRoundScenario.change > 0 ? "#dc2626" : "var(--text-h)",
                        lineHeight: 1.15,
                      }}>
                        {lastRoundScenario.change !== null ? `${lastRoundScenario.change > 0 ? "+" : ""}${lastRoundScenario.change.toFixed(1)}` : "—"}
                      </div>
                    </div>
                    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, background: "rgba(100,116,139,0.06)" }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Differential</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-h)", marginTop: 5 }}>
                        {lastRoundScenario.originalDiff.toFixed(1)} to {lastRoundScenario.alternateDiff.toFixed(1)}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text)", marginTop: 4 }}>
                        {lastRoundScenario.alternateCounts ? "Would count" : "Would not count"} in best 8
                      </div>
                      {lastRoundScenario.handicapIndexAtPlay !== null && (
                        <div style={{ fontSize: 11, color: "var(--text)", marginTop: 4 }}>
                          ESR measured against {Number(lastRoundScenario.handicapIndexAtPlay).toFixed(1)}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, background: "rgba(100,116,139,0.06)", color: "var(--text)", fontSize: 13, fontWeight: 600 }}>
                    {lastRoundScenario?.message ?? "Sync rounds before using the last round what-if."}
                  </div>
                )}
              </div>
            )}

            {allTimeRankedRounds.length > 0 && (
              <div className="rounded-xl p-5" style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
                <div style={{ marginBottom: 12 }}>
                  <SectionIntro title="Best Rounds — All Time">
                    Every synced round ranked by score differential. Lower is better.
                  </SectionIntro>
                  {latestAllTimeRank && (
                    <div style={{ display: "inline-flex", alignItems: "baseline", gap: 6, marginTop: 9, borderRadius: 999, padding: "5px 10px", background: "#dcfce7", color: "#166534", fontSize: 11, fontWeight: 800 }}>
                      Latest round: #{latestAllTimeRank.rank} of {allTimeRankedRounds.length}
                      <span style={{ opacity: 0.8 }}>· {latestAllTimeRank.differential.toFixed(1)}</span>
                    </div>
                  )}
                  {leaderboardInsight && (
                    <div style={{
                      display: "grid",
                      gridTemplateColumns: "40px 1fr",
                      gap: 11,
                      alignItems: "center",
                      marginTop: 12,
                      border: "1px solid rgba(22,163,74,0.42)",
                      borderRadius: 13,
                      padding: "12px 14px",
                      background: "linear-gradient(135deg, rgba(220,252,231,0.98), rgba(187,247,208,0.68))",
                      boxShadow: "0 10px 28px -18px rgba(21,128,61,0.9)",
                    }}>
                      <div aria-hidden="true" style={{ width: 40, height: 40, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", background: "#16a34a", color: "white", fontSize: 21, boxShadow: "0 6px 14px -7px rgba(21,128,61,0.9)" }}>
                        ↗
                      </div>
                      <div>
                        <div style={{ color: "#166534", fontSize: 9, fontWeight: 950, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 2 }}>
                          Form insight
                        </div>
                        <div style={{ color: "#14532d", fontSize: 14, fontWeight: 850, lineHeight: 1.35, letterSpacing: "-0.01em" }}>
                          {leaderboardInsight}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <div style={{ maxHeight: 360, overflow: "auto", border: "1px solid var(--table-border)", borderRadius: 12 }}>
                  <table style={{ width: "100%", minWidth: 620, borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
                    <colgroup>
                      <col style={{ width: 72 }} />
                      <col style={{ width: 112 }} />
                      <col />
                      <col style={{ width: 82 }} />
                      <col style={{ width: 120 }} />
                    </colgroup>
                    <thead style={{ position: "sticky", top: 0, zIndex: 1, background: "var(--card-bg)", boxShadow: "0 1px 0 var(--table-border)" }}>
                      <tr>
                        {["Rank", "Date", "Course & tee", "Score", "Diff."].map((heading) => (
                          <th key={heading} style={{ padding: "10px 14px", textAlign: heading === "Course & tee" || heading === "Date" ? "left" : "right", color: "var(--text)", fontSize: 10, fontWeight: 850, letterSpacing: "0.08em", textTransform: "uppercase", whiteSpace: "nowrap" }}>
                            {heading}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {allTimeRankedRounds.map(({ round, differential, rank }, index) => {
                        const isLatest = round.id === latestRound?.id;
                        const parts = courseParts(round);
                        const courseName = parts.course || round.course || "Round";
                        const courseDetail = [parts.tee, round.holes].filter(Boolean).join(" · ");
                        return (
                          <tr
                            key={round.id ?? `${round.date}-${round.course}-${round.score}`}
                            style={{
                              background: isLatest
                                ? "rgba(34,197,94,0.14)"
                                : index % 2 === 1
                                  ? "rgba(100,116,139,0.045)"
                                  : "transparent",
                              outline: isLatest ? "2px solid rgba(34,197,94,0.5)" : "none",
                              outlineOffset: -2,
                            }}
                          >
                            <td style={{ padding: "11px 14px", textAlign: "right", borderBottom: "1px solid var(--table-border)" }}>
                              <span style={{ display: "inline-flex", minWidth: 32, height: 26, padding: "0 7px", alignItems: "center", justifyContent: "center", borderRadius: 8, background: rank <= 3 ? "#fef3c7" : "rgba(100,116,139,0.1)", color: rank <= 3 ? "#92400e" : isLatest ? "#15803d" : "var(--text-h)", fontWeight: 900 }}>
                                {rank}
                              </span>
                            </td>
                            <td style={{ padding: "11px 14px", borderBottom: "1px solid var(--table-border)", color: "var(--text)", fontWeight: 650, whiteSpace: "nowrap" }}>
                              {shortDate(round.date)}
                            </td>
                            <td style={{ padding: "11px 14px", borderBottom: "1px solid var(--table-border)", color: "var(--text-h)" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                                <span style={{ fontWeight: isLatest ? 850 : 700 }}>{courseName}</span>
                                {isLatest && (
                                  <span style={{ borderRadius: 999, padding: "2px 6px", background: "#dcfce7", color: "#166534", fontSize: 9, fontWeight: 900, letterSpacing: "0.05em", textTransform: "uppercase" }}>
                                    Latest
                                  </span>
                                )}
                              </div>
                              {courseDetail && <div style={{ marginTop: 3, color: "var(--text)", fontSize: 10 }}>{courseDetail}</div>}
                            </td>
                            <td style={{ padding: "11px 14px", textAlign: "right", borderBottom: "1px solid var(--table-border)", color: "var(--text-h)", fontSize: 14, fontWeight: 750, fontVariantNumeric: "tabular-nums" }}>
                              {round.score ?? "—"}
                            </td>
                            <td style={{ padding: "11px 14px", textAlign: "right", borderBottom: "1px solid var(--table-border)", fontVariantNumeric: "tabular-nums" }}>
                              <span style={{ display: "inline-block", minWidth: 52, borderRadius: 8, padding: "5px 8px", background: isLatest ? "#dcfce7" : "rgba(37,99,235,0.08)", color: isLatest ? "#15803d" : "#1d4ed8", fontSize: 16, fontWeight: 950 }}>
                                {differential.toFixed(1)}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Next round planner */}
            <div className="rounded-xl p-5" style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 16 }}>
                <SectionIntro title="Next Round Planner">
                  Scores needed on the next card, including the oldest round dropping from your current 20.
                </SectionIntro>
                <div style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 8, padding: 3, background: "var(--input-bg)" }}>
                  {[
                    ["synced", "Synced course"],
                    ["manual", "New course"],
                  ].map(([mode, label]) => (
                    <button
                      key={mode}
                      onClick={() => {
                        setPlannerMode(mode);
                        if (mode === "manual") setPlanner(manualPlanner);
                        if (mode === "synced" && coursePresets.length > 0) setPlanner(coursePresets[0]);
                      }}
                      style={{
                        ...btnStyle(plannerMode === mode ? "#166534" : "transparent", plannerMode === mode ? "#fff" : "var(--text-h)"),
                        height: 30,
                        borderRadius: 6,
                        padding: "0 11px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {plannerMode === "synced" && (
                <div style={{ maxWidth: 360, marginBottom: 12 }}>
                  <CoursePresetSelect
                    presets={coursePresets}
                    selectedCourse={planner}
                    placeholder="Choose synced course"
                    onSelect={(preset) => setPlanner(preset)}
                  />
                </div>
              )}

              {isNineHoleCourse(planner) && (
                <div style={{ marginBottom: 12, border: "1px solid rgba(37,99,235,0.24)", borderRadius: 9, padding: "9px 11px", background: "rgba(37,99,235,0.07)", color: "var(--text)", fontSize: 11, lineHeight: 1.45 }}>
                  9-hole projections use the WHS played-nine formula plus an estimated expected-nine differential based on your current index. Golf Ireland’s synced differential remains authoritative after the score is posted.
                </div>
              )}

              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
                gap: 10,
                marginBottom: 12,
              }}>
                <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, background: "rgba(100,116,139,0.06)" }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    Current 20
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: "var(--text-h)", lineHeight: 1.2, marginTop: 3 }}>
                    {Math.min(rounds.length, 20)} rounds
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text)", marginTop: 3 }}>
                    Each row below adds one new score.
                  </div>
                </div>
                <div style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: 12,
                  background: nextRoundDrop?.counts ? "rgba(239,68,68,0.07)" : "rgba(100,116,139,0.06)",
                }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    Dropping next
                  </div>
                  {nextRoundDrop ? (
                    <>
                      <div style={{ fontSize: 13, fontWeight: 800, color: "var(--text-h)", marginTop: 5 }}>
                        {shortDate(nextRoundDrop.round.date)} / {nextRoundDrop.round.score} / diff {nextRoundDrop.diff !== null ? nextRoundDrop.diff.toFixed(1) : "—"}
                      </div>
                      <div style={{ fontSize: 12, color: nextRoundDrop.counts ? "#dc2626" : "var(--text)", fontWeight: nextRoundDrop.counts ? 800 : 600, marginTop: 4 }}>
                        {nextRoundDrop.counts ? "Currently counting in your best 8" : "Not currently counting"}
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 13, fontWeight: 800, color: "var(--text-h)", marginTop: 5 }}>
                        No score drops yet
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text)", marginTop: 4 }}>
                        You need 20 scored rounds before the next one displaces an old card.
                      </div>
                    </>
                  )}
                </div>
              </div>

              {plannerMode === "manual" && (
                <>
                <div style={{ marginBottom: 12 }}>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text)", marginBottom: 6 }}>
                    Course lookup
                  </label>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <select
                      aria-label="Course lookup country"
                      value={courseLookup.country}
                      onChange={(e) => setCourseLookup({ ...courseLookup, country: e.target.value, courses: [], selectedCourseId: "", tees: [], message: "" })}
                      style={{
                        ...fieldControlStyle,
                        padding: "0 10px",
                        fontSize: 13,
                        flex: "0 1 150px",
                      }}
                    >
                      {courseRatingCountries.map(([code, name]) => (
                        <option key={code} value={code}>{name}</option>
                      ))}
                    </select>
                    <input
                      aria-label="Course lookup search"
                      placeholder="Search by course name"
                      value={courseLookup.query}
                      onChange={(e) => setCourseLookup({ ...courseLookup, query: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") searchCourseRatings();
                      }}
                      style={{
                        width: "100%",
                        ...fieldControlStyle,
                        padding: "0 12px",
                        flex: "0 1 320px",
                        maxWidth: 360,
                      }}
                      onFocus={(e) => { e.target.style.borderColor = "#22c55e"; e.target.style.boxShadow = "0 0 0 3px rgba(34,197,94,0.15)"; }}
                      onBlur={(e) => { e.target.style.borderColor = "var(--border)"; e.target.style.boxShadow = "none"; }}
                    />
                    <button
                      onClick={searchCourseRatings}
                      disabled={courseLookup.status === "loading"}
                      style={{
                        ...btnStyle(courseLookup.status === "loading" ? "#e2e8f0" : "#166534", courseLookup.status === "loading" ? "#64748b" : "#fff"),
                        height: 40,
                        borderRadius: 8,
                        padding: "0 16px",
                        whiteSpace: "nowrap",
                        cursor: courseLookup.status === "loading" ? "wait" : "pointer",
                        fontWeight: 800,
                        flex: "0 0 auto",
                      }}
                    >
                      {courseLookup.status === "loading" ? "Searching..." : "Search"}
                    </button>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text)", marginTop: 6 }}>
                    Find official ratings, slopes and 9-hole setups from the course rating database.
                  </div>
                </div>
                {(courseLookup.courses.length > 0 || courseLookup.tees.length > 0 || courseLookup.message) && (
                  <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, marginBottom: 12, background: "rgba(100,116,139,0.06)" }}>
                    {courseLookup.message && (
                      <div style={{ fontSize: 12, color: courseLookup.status === "error" ? "#dc2626" : "var(--text)", marginBottom: courseLookup.courses.length || courseLookup.tees.length ? 8 : 0 }}>
                        {courseLookup.message}
                      </div>
                    )}
                    {courseLookup.courses.length > 0 && (
                      <select
                        value={courseLookup.selectedCourseId}
                        onChange={(e) => loadCourseTees(e.target.value)}
                        style={{
                          ...fieldControlStyle,
                          width: "min(100%, 360px)",
                          padding: "0 10px",
                          marginBottom: courseLookup.tees.length ? 8 : 0,
                        }}
                      >
                        <option value="">Choose course</option>
                        {courseLookup.courses.map((course) => (
                          <option key={course.courseID} value={course.courseID}>
                            {course.fullName} - {course.city}{course.stateDisplay ? `, ${course.stateDisplay}` : ""}
                          </option>
                        ))}
                      </select>
                    )}
                    {courseLookup.tees.length > 0 && (
                      <select
                        value=""
                        onChange={(e) => selectCourseTee(e.target.value)}
                        style={{
                          ...fieldControlStyle,
                          width: "min(100%, 520px)",
                          padding: "0 10px",
                        }}
                      >
                        <option value="">Choose tee / holes / rating</option>
                        {courseLookup.tees.map((tee, index) => (
                          <option key={`${tee.tee}-${tee.gender}-${tee.rating}-${tee.slope}-${index}`} value={index}>
                            {tee.tee}, {tee.gender}, {tee.holes}, rating {tee.rating}, slope {tee.slope}{tee.par ? `, par ${tee.par}` : ""}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginBottom: 12 }}>
                  <InputField
                    label="Course"
                    placeholder="Course name"
                    value={manualPlanner.course}
                    onChange={(e) => {
                      const next = { ...manualPlanner, course: e.target.value };
                      applyManualPlanner(next);
                    }}
                  />
                  <InputField
                    label="Tee"
                    placeholder="e.g. White"
                    value={manualPlanner.tee}
                    onChange={(e) => {
                      const next = { ...manualPlanner, tee: e.target.value };
                      applyManualPlanner(next);
                    }}
                  />
                  <div className="flex flex-col gap-1">
                    <label style={fieldLabelStyle}>
                      Holes
                    </label>
                    <select
                      value={manualPlanner.holes}
                      onChange={(e) => {
                        const next = { ...manualPlanner, holes: e.target.value };
                        applyManualPlanner(next);
                      }}
                      style={{
                        ...fieldControlStyle,
                        padding: "0 10px",
                      }}
                    >
                      <option value="18 holes">18 holes</option>
                      <option value="9 holes">9 holes</option>
                      <option value="Front 9">Front 9</option>
                      <option value="Back 9">Back 9</option>
                    </select>
                  </div>
                  <InputField
                    label="Rating"
                    type="number"
                    step="0.1"
                    placeholder="71.2"
                    value={manualPlanner.rating}
                    onChange={(e) => {
                      const next = { ...manualPlanner, rating: e.target.value };
                      applyManualPlanner(next);
                    }}
                  />
                  <InputField
                    label="Slope"
                    type="number"
                    placeholder="127"
                    value={manualPlanner.slope}
                    onChange={(e) => {
                      const next = { ...manualPlanner, slope: e.target.value };
                      applyManualPlanner(next);
                    }}
                  />
                  <InputField
                    label="PCC"
                    type="number"
                    placeholder="0"
                    value={manualPlanner.pcc}
                    onChange={(e) => {
                      const next = { ...manualPlanner, pcc: e.target.value };
                      applyManualPlanner(next);
                    }}
                  />
                </div>
                </>
              )}

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
                {manualCourseLabel(planner)
                  ? `${manualCourseLabel(planner)} / rating ${planner.rating} / slope ${planner.slope} / PCC ${planner.pcc ?? 0}`
                  : plannerMode === "manual" ? "Enter course rating and slope to build next-round scores." : "Sync from Golf Ireland to populate course options."}
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

        </div>
      </div>
    </>
  );
}

function CoursePresetSelect({ presets, selectedCourse, placeholder = "Choose course", onSelect }) {
  if (presets.length === 0) return null;
  const selectedIndex = selectedCourse
    ? presets.findIndex((preset) =>
      (preset.course === selectedCourse.course || courseTeeLabel(preset) === selectedCourse.course || courseSelectLabel(preset) === selectedCourse.course) &&
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
          {courseSelectLabel(preset)} ({preset.rating}/{preset.slope})
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
