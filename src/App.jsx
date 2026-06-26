import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { db } from "./db";
import { useLiveQuery } from "dexie-react-hooks";

function isNineHole(score) {
  return Number(score) < 70;
}

function differential(score, rating, slope, pcc = 0, forceNineHole = null) {
  if (score === null || score === undefined || score === "") return null;
  const s = Number(score), r = Number(rating), sl = Number(slope), p = Number(pcc || 0);
  if (isNaN(s) || isNaN(r) || isNaN(sl)) return null;
  // 9-hole differentials are doubled to produce an 18-hole equivalent (WHS)
  const d = ((s - r - p) * 113) / sl;
  return (forceNineHole ?? isNineHole(s)) ? d * 2 : d;
}

const r1 = (v) => Math.round(v * 10) / 10;

const officialHandicapHistory = [
  { date: "2025-06-06", value: 13.6 },
  { date: "2025-07-25", value: 13.4 },
  { date: "2025-10-31", value: 12.9 },
  { date: "2026-04-17", value: 12.9 },
  { date: "2026-05-01", value: 12.9 },
  { date: "2026-05-08", value: 12.7 },
  { date: "2026-05-15", value: 12.9 },
  { date: "2026-05-25", value: 12.9 },
  { date: "2026-06-19", value: 13.2 },
];

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
  return Number(course?.rating) < 50 ||
    /\b9\b|nine/i.test(course?.holes ?? "") ||
    /\b9\s*hole\b|nine\s*hole/i.test(course?.course ?? "");
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

function updateMatchingCourseRecord(record, originalCourse, nextCourse) {
  if (!originalCourse || coursePresetKey(record) !== coursePresetKey(originalCourse)) return false;
  record.course = nextCourse.course;
  record.rating = nextCourse.rating;
  record.slope = nextCourse.slope;
  if (nextCourse.par === undefined) delete record.par;
  else record.par = nextCourse.par;
  return true;
}

function clearCourseTags(course) {
  return { ...course, tee: "", holes: "" };
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

function LineChart({ points }) {
  if (points.length < 2) return (
    <div className="flex items-center justify-center h-24 text-sm" style={{ color: "var(--text)" }}>
      Need 8+ rounds to show progression
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

function StatCard({ label, value, sub, accent }) {
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
        {label}
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

function InputField({ label, wrapperStyle, ...props }) {
  return (
    <div className="flex flex-col gap-1" style={wrapperStyle}>
      {label && <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text)" }}>{label}</label>}
      <input
        {...props}
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
  const [input, setInput] = useState({ date: todayISO(), course: "", score: "", rating: "", slope: "", pcc: 0 });
  const [editingIndex, setEditingIndex] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [target, setTarget] = useState(8);
  const [planner, setPlanner] = useState({ course: "", rating: 71.2, slope: 127, pcc: 0 });
  const [newCourse, setNewCourse] = useState({ course: "", rating: "", slope: "", par: "" });
  const [editingCourseId, setEditingCourseId] = useState(null);
  const [editingCourseKey, setEditingCourseKey] = useState("");
  const [editingCourseOriginal, setEditingCourseOriginal] = useState(null);
  const [courseHandicapCourse, setCourseHandicapCourse] = useState({ course: "", rating: "", slope: 113, pcc: 0 });
  const [showExcludedRounds, setShowExcludedRounds] = useState(false);

  const queriedRounds = useLiveQuery(() => db.rounds.orderBy("date").toArray(), []);
  const queriedCourses = useLiveQuery(() => db.courses.orderBy("course").toArray(), []);
  const rounds = useMemo(() => queriedRounds ?? [], [queriedRounds]);
  const savedCourses = useMemo(() => queriedCourses ?? [], [queriedCourses]);

  useEffect(() => {
    db.settings.get("targetHandicap").then((setting) => {
      if (setting && setting.value !== undefined) setTarget(Number(setting.value));
    });
  }, []);

  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || rounds.length === 0) return;
    seeded.current = true;
    const last = rounds[rounds.length - 1];
    setInput((prev) => ({ ...prev, course: last.course, rating: last.rating, slope: last.slope, pcc: last.pcc ?? 0 }));
    setPlanner({ course: last.course, rating: last.rating, slope: last.slope, pcc: last.pcc ?? 0 });
  }, [rounds]);

  // One-time migration from the old localStorage store
  useEffect(() => {
    const old = localStorage.getItem("rounds_final");
    if (!old) return;
    db.rounds.count().then((n) => {
      if (n === 0) db.rounds.bulkAdd(JSON.parse(old));
    });
    localStorage.removeItem("rounds_final");
  }, []);

  // WHS uses the most recent 20 rounds; pair each with its id so we can mark rows
  const clampedWithDiff = useMemo(() =>
    clamp20(rounds).map((r) => ({ id: r.id, d: differential(r.score, r.rating, r.slope, r.pcc) })).filter(({ d }) => d !== null),
    [rounds]
  );
  const diffs = useMemo(() => clampedWithDiff.map(({ d }) => d), [clampedWithDiff]);

  const hcp = diffs.length >= 8 ? handicap(diffs) : null;
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

  const deleteRound = async (index) => {
    const r = displayedRounds[index];
    await db.rounds.delete(r.id);
  };

  const startEdit = (index) => {
    setEditingIndex(index);
    setEditForm({ ...displayedRounds[index] });
  };

  const saveEdit = async () => {
    const { id, ...fields } = editForm;
    await db.rounds.update(id, { ...fields, score: +fields.score, rating: +fields.rating, slope: +fields.slope, pcc: +fields.pcc || 0 });
    setEditingIndex(null);
  };

  const hcpHist = useMemo(() => {
    const history = [...officialHandicapHistory];
    const lastOfficialDate = officialHandicapHistory[officialHandicapHistory.length - 1].date;
    const baseDiffs = clamp20(rounds
      .filter((round) => round.date <= lastOfficialDate)
      .map((round) => differential(round.score, round.rating, round.slope, round.pcc))
      .filter((d) => d !== null));
    const futureDiffs = rounds
      .filter((round) => round.date > lastOfficialDate)
      .map((round) => ({
        date: round.date,
        d: differential(round.score, round.rating, round.slope, round.pcc),
      }))
      .filter(({ d }) => d !== null);

    if (futureDiffs.length === 0) return history;

    let rollingDiffs = [...baseDiffs];
    futureDiffs.forEach(({ date, d }) => {
      rollingDiffs = clamp20([...rollingDiffs, d]);
      if (rollingDiffs.length >= 8) history.push({ date, value: handicap(rollingDiffs) });
    });

    return history;
  }, [rounds]);

  const add = async () => {
    if (!input.score || !input.rating || !input.slope) return;
    const newRound = { date: input.date, course: input.course, score: +input.score, rating: +input.rating, slope: +input.slope, pcc: +input.pcc || 0 };
    await db.rounds.add(newRound);
    setInput({ date: todayISO(), course: newRound.course, score: "", rating: newRound.rating, slope: newRound.slope, pcc: newRound.pcc });
  };

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

  const reqDiff = target !== "" && !isNaN(Number(target)) ? Number(target) : null;

  const coursePresets = useMemo(() => {
    const byKey = new Map();
    rounds.forEach((r) => {
      if (!r.course || !r.rating || !r.slope) return;
      if (shouldHideCourse(r)) return;
      byKey.set(`${r.course}-${r.rating}-${r.slope}`, {
        course: r.course,
        rating: r.rating,
        slope: r.slope,
        par: r.par,
        pcc: r.pcc ?? 0,
      });
    });
    savedCourses.forEach((c) => {
      if (!c.course || !c.rating || !c.slope) return;
      if (shouldHideCourse(c)) return;
      byKey.set(`${courseTeeLabel(c)}-${c.rating}-${c.slope}`, {
        ...c,
        course: c.course,
        rating: c.rating,
        slope: c.slope,
        par: c.par,
        pcc: c.pcc ?? 0,
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
  }, [rounds, savedCourses]);

  const editCourse = (courseId) => {
    if (!courseId) {
      setEditingCourseId(null);
      setEditingCourseKey("");
      setEditingCourseOriginal(null);
      setNewCourse({ course: "", rating: "", slope: "", par: "" });
      return;
    }
    const course = coursePresets.find((preset) => coursePresetKey(preset) === courseId);
    if (!course) return;
    setEditingCourseId(course.id ?? null);
    setEditingCourseKey(coursePresetKey(course));
    setEditingCourseOriginal({ ...course, par: course.par ?? undefined });
    setNewCourse({ course: course.course, rating: course.rating, slope: course.slope, par: coursePar(course) ?? "" });
  };

  const saveCourse = async () => {
    if (!newCourse.course || !newCourse.rating || !newCourse.slope) return;
    const course = {
      course: newCourse.course,
      rating: +newCourse.rating,
      slope: +newCourse.slope,
      par: newCourse.par === "" ? undefined : +newCourse.par,
    };
    if (editingCourseKey) {
      await db.rounds.toCollection().modify((round) => updateMatchingCourseRecord(round, editingCourseOriginal, course));
    }
    if (editingCourseId !== null) {
      await db.courses.update(editingCourseId, course);
    } else if (!editingCourseKey) {
      await db.courses.add({ ...course, pcc: 0 });
    }
    setInput((prev) => ({ ...prev, course: course.course, rating: course.rating, slope: course.slope, pcc: prev.pcc ?? 0 }));
    setPlanner((prev) => ({ ...prev, ...course }));
    setEditingCourseId(null);
    setEditingCourseKey("");
    setEditingCourseOriginal(null);
    setNewCourse({ course: "", rating: "", slope: "", par: "" });
  };

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
    if (reqDiff === null) return [];
    const plannerIsNineHole = Number(planner.rating) < 50 ||
      /\b9\b|nine/i.test(planner.holes ?? "") ||
      /\b9\s*hole\b|nine\s*hole/i.test(planner.course ?? "");
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
  }, [reqDiff, planner.course, planner.holes, planner.rating, planner.slope, planner.pcc, diffs, hcp]);

  const courseTeeInputWidth = useMemo(() => {
    const labels = coursePresets.map(courseTeeLabel);
    const longest = Math.max("Course / tee".length, ...labels.map((label) => label.length));
    return `${Math.max(34, longest + 4)}ch`;
  }, [coursePresets]);
  const courseFieldStyle = useMemo(() => ({
    minWidth: courseTeeInputWidth,
    width: `max(100%, ${courseTeeInputWidth})`,
  }), [courseTeeInputWidth]);

  const gapEstimate = () => {
    if (!hcp || reqDiff === null) return null;
    let arr = [...diffs];
    for (let i = 0; i < 20; i++) {
      arr = [...arr.slice(1), reqDiff];
      if (handicap(arr) <= reqDiff) return i + 1;
    }
    return null;
  };

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

          {/* Stat cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
            <StatCard
              label="Handicap Index"
              value={hcp ?? "—"}
              sub={diffs.length < 8 ? `${diffs.length} of 8 rounds entered` : `${diffs.length} rounds`}
              accent
            />
            <StatCard
              label="Cut Line"
              value={cutLine != null ? cutLine.toFixed(1) : "—"}
              sub="Best 8 differential threshold"
            />
            <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)", borderRadius: 16, padding: "20px 22px", display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text)" }}>
                Course Handicap
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
                Target Index
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

          {/* Add course */}
          <div className="rounded-xl p-5" style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 16 }}>
              <div>
                <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-h)", margin: "0 0 2px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  {editingCourseKey ? "Update Course" : "Add Course"}
                </h2>
                <p style={{ fontSize: 12, color: "var(--text)", margin: 0 }}>
                  Courses appear in the round log and target planner.
                </p>
              </div>
              {coursePresets.length > 0 && (
                <span style={{ fontSize: 12, color: "var(--text)", whiteSpace: "nowrap", paddingTop: 1 }}>
                  {coursePresets.length} available
                </span>
              )}
            </div>
            {coursePresets.length > 0 && (
              <div style={{ maxWidth: 420, marginBottom: 12 }}>
                <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text)", display: "block", marginBottom: 4 }}>Edit course</label>
                <select
                  value={editingCourseKey}
                  onChange={(e) => editCourse(e.target.value)}
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
                  <option value="">New course</option>
                  {coursePresets.map((course) => (
                    <option key={coursePresetKey(course)} value={coursePresetKey(course)}>
                      {courseTeeLabel(course)} ({course.rating}/{course.slope})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 2fr) repeat(3, minmax(90px, 1fr)) auto", gap: 10, alignItems: "end" }}>
              <InputField label="Name" placeholder="Course / tee name" value={newCourse.course} onChange={(e) => setNewCourse({ ...newCourse, course: e.target.value })} />
              <InputField label="Rating" type="number" step="0.1" placeholder="71.2" value={newCourse.rating} onChange={(e) => setNewCourse({ ...newCourse, rating: e.target.value })} />
              <InputField label="Slope" type="number" placeholder="127" value={newCourse.slope} onChange={(e) => setNewCourse({ ...newCourse, slope: e.target.value })} />
              <InputField label="Par" type="number" placeholder="70" value={newCourse.par} onChange={(e) => setNewCourse({ ...newCourse, par: e.target.value })} />
              <button onClick={saveCourse} style={{ ...btnStyle("#f0fdf4", "#16a34a"), height: 38, padding: "0 14px" }}>
                {editingCourseKey ? "Update Course" : "Save Course"}
              </button>
            </div>
            {editingCourseKey && (
              <button onClick={() => editCourse("")} style={{ ...btnStyle("#f1f5f9", "var(--text-h)"), marginTop: 10 }}>
                Cancel Edit
              </button>
            )}
          </div>

          {/* Add round */}
          <div className="rounded-xl p-5" style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
              <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-h)", margin: 0, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Log a Round
              </h2>
              <div style={{ width: 220 }}>
                <CoursePresetSelect
                  presets={coursePresets}
                  selectedCourse={input}
                  placeholder="Use saved course"
                  onSelect={(preset) => setInput({ ...input, course: courseTeeLabel(preset), rating: preset.rating, slope: preset.slope, pcc: preset.pcc ?? 0 })}
                />
              </div>
            </div>
            <div style={{ overflowX: "auto", paddingBottom: 2, marginBottom: 10 }}>
              <InputField
                label="Course"
                placeholder="Course name"
                value={input.course}
                wrapperStyle={courseFieldStyle}
                onChange={(e) => setInput({ ...input, course: e.target.value })}
              />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10 }}>
              <InputField label="Date" type="date" value={input.date} onChange={(e) => setInput({ ...input, date: e.target.value })} />
              <InputField label="Score" type="number" placeholder="e.g. 82" value={input.score} onChange={(e) => setInput({ ...input, score: e.target.value })} />
              <InputField label="Rating" type="number" placeholder="e.g. 71.2" value={input.rating} onChange={(e) => setInput({ ...input, rating: e.target.value })} />
              <InputField label="Slope" type="number" placeholder="e.g. 127" value={input.slope} onChange={(e) => setInput({ ...input, slope: e.target.value })} />
              <InputField label="PCC" type="number" placeholder="0" value={input.pcc} onChange={(e) => setInput({ ...input, pcc: e.target.value })} />
            </div>
            <button
              onClick={add}
              style={{
                marginTop: 14,
                padding: "9px 22px",
                borderRadius: 8,
                background: "linear-gradient(135deg, #15803d, #16a34a)",
                color: "#fff",
                fontWeight: 600,
                fontSize: 14,
                border: "none",
                cursor: "pointer",
                boxShadow: "0 2px 8px rgba(21,128,61,0.35)",
              }}
            >
              + Add Round
            </button>
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
                    <col style={{ width: 80 }} />
                    <col style={{ width: 90 }} />
                    <col style={{ width: 80 }} />
                    <col style={{ width: 70 }} />
                    <col style={{ width: 210 }} />
                    <col style={{ width: 150 }} />
                  </colgroup>
                  <thead>
                    <tr style={{ background: "rgba(0,0,0,0.03)" }}>
                      {["Date", "Course", "Score", "Rating", "Slope", "PCC", "Differential", "Actions"].map((h) => (
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
                      const d = differential(r.score, r.rating, r.slope, r.pcc);
                      const isCounting = countingIds.has(r.id);
                      const isNewest = index === 0;
                      const isEditing = editingIndex === index;
                      const isExcluded = index >= 20;
                      if (isExcluded && !showExcludedRounds) return null;

                      return (
                        <Fragment key={r.id}>
                          {index === 20 && (
                            <tr>
                              <td colSpan={8} style={{ padding: "9px 16px", background: "rgba(100,116,139,0.12)", color: "var(--text)", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", borderBottom: "1px solid var(--table-border)" }}>
                                Excluded from handicap calculation - older than most recent 20 rounds
                              </td>
                            </tr>
                          )}
                        <tr key={r.id} style={{ background: isCounting && !isExcluded ? "var(--row-good)" : "transparent", borderBottom: "1px solid var(--table-border)", opacity: isExcluded ? 0.58 : 1 }}>
                          <td style={{ padding: "10px 16px", color: "var(--text-h)", whiteSpace: "nowrap" }}>
                            {isEditing
                              ? <input type="date" value={editForm.date} onChange={(e) => setEditForm({ ...editForm, date: e.target.value })} style={{ background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", color: "var(--text-h)", fontSize: 13, width: 130 }} />
                              : r.date || "—"}
                          </td>
                          <td style={{ padding: "10px 16px", color: "var(--text-h)", fontWeight: 500, whiteSpace: "nowrap" }}>
                            {isEditing
                              ? <input value={editForm.course} onChange={(e) => setEditForm({ ...editForm, course: e.target.value })} style={{ background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", color: "var(--text-h)", fontSize: 13, width: courseTeeInputWidth }} />
                              : r.course || "—"}
                          </td>
                          <td style={{ padding: "10px 16px", color: "var(--text-h)", whiteSpace: "nowrap" }}>
                            {isEditing
                              ? <input type="number" value={editForm.score} onChange={(e) => setEditForm({ ...editForm, score: e.target.value })} style={{ background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", color: "var(--text-h)", fontSize: 13, width: 70 }} />
                              : r.score}
                          </td>
                          <td style={{ padding: "10px 16px", color: "var(--text)", whiteSpace: "nowrap" }}>
                            {isEditing
                              ? <input type="number" value={editForm.rating} onChange={(e) => setEditForm({ ...editForm, rating: e.target.value })} style={{ background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", color: "var(--text-h)", fontSize: 13, width: 70 }} />
                              : r.rating}
                          </td>
                          <td style={{ padding: "10px 16px", color: "var(--text)", whiteSpace: "nowrap" }}>
                            {isEditing
                              ? <input type="number" value={editForm.slope} onChange={(e) => setEditForm({ ...editForm, slope: e.target.value })} style={{ background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", color: "var(--text-h)", fontSize: 13, width: 70 }} />
                              : r.slope}
                          </td>
                          <td style={{ padding: "10px 16px", color: "var(--text)", whiteSpace: "nowrap" }}>
                            {isEditing
                              ? <input type="number" value={editForm.pcc} onChange={(e) => setEditForm({ ...editForm, pcc: e.target.value })} style={{ background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", color: "var(--text-h)", fontSize: 13, width: 60 }} />
                              : (r.pcc || 0)}
                          </td>
                          <td style={{ padding: "10px 16px", whiteSpace: "nowrap" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span style={{
                                fontWeight: 600,
                                color: d !== null ? (d < (cutLine ?? Infinity) ? "#16a34a" : "var(--text-h)") : "var(--text)",
                              }}>
                                {d !== null ? d.toFixed(1) : "—"}
                              </span>
                              {isNineHole(r.score) && (
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
                          <td style={{ padding: "10px 16px", whiteSpace: "nowrap" }}>
                            {!isEditing && (
                              <>
                                <button onClick={() => startEdit(index)} style={neutralButtonStyle}>Edit</button>
                                <button onClick={() => deleteRound(index)} style={{ ...btnStyle("#fef2f2", "#dc2626"), marginLeft: 6 }}>Delete</button>
                              </>
                            )}
                            {isEditing && (
                              <>
                                <button onClick={saveEdit} style={btnStyle("#f0fdf4", "#16a34a")}>Save</button>
                                <button onClick={() => setEditingIndex(null)} style={{ ...neutralButtonStyle, marginLeft: 6 }}>Cancel</button>
                              </>
                            )}
                          </td>
                        </tr>
                        </Fragment>
                      );
                    })}
                    {displayedRounds.length > 20 && !showExcludedRounds && (
                      <tr>
                        <td colSpan={8} style={{ padding: "10px 16px", background: "rgba(100,116,139,0.08)", borderTop: "1px solid var(--table-border)" }}>
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
                        <td colSpan={8} style={{ padding: "10px 16px", background: "rgba(100,116,139,0.08)", borderTop: "1px solid var(--table-border)" }}>
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

          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16, alignItems: "start" }}>
            {/* Target round planner */}
            <div className="rounded-xl p-5" style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 16 }}>
                <div>
                  <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-h)", margin: "0 0 2px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    Target Round Planner
                  </h2>
                  <p style={{ fontSize: 12, color: "var(--text)", margin: 0 }}>
                    Scores needed to post useful differentials at a course/tee.
                  </p>
                </div>
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
              <div style={{ overflowX: "auto", paddingBottom: 2, marginBottom: 10 }}>
                <InputField
                  label="Course / tee"
                  placeholder="e.g. Home Club - White"
                  value={courseTeeLabel(planner)}
                  wrapperStyle={courseFieldStyle}
                  onChange={(e) => setPlanner(clearCourseTags({ ...planner, course: e.target.value }))}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginBottom: 16 }}>
                <InputField label="Rating" type="number" step="0.1" value={planner.rating} onChange={(e) => setPlanner({ ...planner, rating: e.target.value })} />
                <InputField label="Slope" type="number" value={planner.slope} onChange={(e) => setPlanner({ ...planner, slope: e.target.value })} />
                <InputField label="PCC" type="number" value={planner.pcc} onChange={(e) => setPlanner({ ...planner, pcc: e.target.value })} />
              </div>

              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "rgba(0,0,0,0.03)" }}>
                      {["Outcome", "Score", "Actual diff", "Counts", "ESR", "Index after ESR", "Change"].map((h) => (
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
              <div>
                <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-h)", margin: "0 0 2px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Handicap Progression
                </h2>
                <p style={{ fontSize: 12, color: "var(--text)", margin: 0 }}>Official index since joining Knock on 06 Jun 2025</p>
              </div>
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
