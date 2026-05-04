import { useEffect, useMemo, useRef, useState } from "react";
import { db } from "./db";
import { useLiveQuery } from "dexie-react-hooks";

function isNineHole(score) {
  return Number(score) < 70;
}

function differential(score, rating, slope, pcc = 0) {
  if (score === null || score === undefined || score === "") return null;
  const s = Number(score), r = Number(rating), sl = Number(slope), p = Number(pcc || 0);
  if (isNaN(s) || isNaN(r) || isNaN(sl)) return null;
  // 9-hole differentials are doubled to produce an 18-hole equivalent (WHS)
  const d = ((s - r - p) * 113) / sl;
  return isNineHole(s) ? d * 2 : d;
}

const r1 = (v) => Math.round(v * 10) / 10;

function best8Idx(diffs) {
  return diffs.map((d, i) => ({ d, i })).sort((a, b) => a.d - b.d).slice(0, 8).map((x) => x.i);
}

function handicap(diffs) {
  const best = [...diffs].sort((a, b) => a - b).slice(0, 8);
  return r1(best.reduce((a, b) => a + b, 0) / 8);
}

function clamp20(arr) {
  return arr.length <= 20 ? arr : arr.slice(arr.length - 20);
}

function LineChart({ values }) {
  if (values.length < 2) return (
    <div className="flex items-center justify-center h-32 text-sm" style={{ color: "var(--text)" }}>
      Need 8+ rounds to show progression
    </div>
  );

  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const pad = 8;

  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (100 - pad * 2);
    const y = pad + (1 - (v - min) / range) * (100 - pad * 2);
    return [x, y];
  });

  const polyline = pts.map((p) => p.join(",")).join(" ");
  const area = `${pts[0][0]},${100 - pad} ${polyline} ${pts[pts.length - 1][0]},${100 - pad}`;

  return (
    <svg viewBox="0 0 100 100" className="w-full h-36" preserveAspectRatio="none">
      <defs>
        <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22c55e" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#22c55e" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon fill="url(#chartGrad)" points={area} />
      <polyline fill="none" stroke="#22c55e" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" points={polyline} />
      {pts.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="1.5" fill="#22c55e" />
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

function InputField({ label, ...props }) {
  return (
    <div className="flex flex-col gap-1">
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
  const [input, setInput] = useState({ date: "", course: "", score: "", rating: "", slope: "", pcc: 0 });
  const [editingIndex, setEditingIndex] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [prev, setPrev] = useState({ score: 82, rating: 71.2, slope: 127, pcc: 0 });
  const [target, setTarget] = useState(9);
  const [seedHcp, setSeedHcp] = useState(() => {
    const s = localStorage.getItem("seedHcp");
    return s !== null ? Number(s) : "";
  });

  useEffect(() => {
    if (seedHcp !== "") localStorage.setItem("seedHcp", seedHcp);
    else localStorage.removeItem("seedHcp");
  }, [seedHcp]);

  const rounds = useLiveQuery(() => db.rounds.orderBy("date").toArray(), []) ?? [];

  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || rounds.length === 0) return;
    seeded.current = true;
    const last = rounds[rounds.length - 1];
    setInput((prev) => ({ ...prev, course: last.course, rating: last.rating, slope: last.slope, pcc: last.pcc ?? 0 }));
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

  const saveEdit = async (index) => {
    const { id, ...fields } = editForm;
    await db.rounds.update(id, { ...fields, score: +fields.score, rating: +fields.rating, slope: +fields.slope, pcc: +fields.pcc || 0 });
    setEditingIndex(null);
  };

  const hcpHist = useMemo(() => {
    let temp = [], out = [];
    diffs.forEach((d) => { temp.push(d); if (temp.length >= 8) out.push(handicap(temp)); });
    const seed = seedHcp !== "" ? Number(seedHcp) : null;
    return seed !== null && !isNaN(seed) ? [seed, ...out] : out;
  }, [diffs, seedHcp]);

  const add = async () => {
    if (!input.score || !input.rating || !input.slope) return;
    const newRound = { date: input.date, course: input.course, score: +input.score, rating: +input.rating, slope: +input.slope, pcc: +input.pcc || 0 };
    await db.rounds.add(newRound);
    setInput({ date: "", course: newRound.course, score: "", rating: newRound.rating, slope: newRound.slope, pcc: newRound.pcc });
  };

  const prevDiff = differential(prev.score, prev.rating, prev.slope, prev.pcc);
  const prevCounts = cutLine !== null && prevDiff !== null ? prevDiff < cutLine : false;
  const playing = hcp ? Math.round((hcp * (prev.slope || 113)) / 113) : null;

  const newHcp = useMemo(() => {
    if (prevDiff === null) return null;
    const next = clamp20([...diffs, prevDiff]);
    return next.length >= 8 ? handicap(next) : null;
  }, [diffs, prevDiff]);

  const hcpDelta = hcp !== null && newHcp !== null ? r1(newHcp - hcp) : null;
  const stableford = (score) => {
    if (!playing) return null;
    return Math.round(36 + (prev.rating + playing - score));
  };

  const reqDiff = target;
  const reqScore = (rating, slope) => (reqDiff * slope) / 113 + rating;

  const gapEstimate = () => {
    if (!hcp) return null;
    let arr = [...diffs];
    for (let i = 0; i < 20; i++) {
      arr = [...arr.slice(1), reqDiff];
      if (handicap(arr) <= target) return i + 1;
    }
    return null;
  };

  const rowColor = (d, isNewest) => {
    if (isNewest) return "var(--row-new)";
    if (cutLine === null || d === null) return "transparent";
    if (d < cutLine - 1) return "var(--row-good)";
    if (d < cutLine + 0.5) return "var(--row-ok)";
    return "var(--row-bad)";
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
          <div style={{ maxWidth: 900, margin: "0 auto" }}>
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

        <div style={{ maxWidth: 900, margin: "0 auto", padding: "28px 20px", display: "flex", flexDirection: "column", gap: 24 }}>

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
            <StatCard
              label="Playing Handicap"
              value={playing ?? "—"}
              sub={playing ? `Based on slope ${prev.slope}` : "Enter more rounds"}
            />
            <StatCard
              label="Target Index"
              value={target}
              sub={gapEstimate() ? `~${gapEstimate()} rounds to go` : hcp ? "More than 20 rounds away" : "Add rounds first"}
            />
          </div>

          {/* Add round */}
          <div className="rounded-xl p-5" style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-h)", margin: "0 0 16px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Log a Round
            </h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10 }}>
              <InputField label="Date" type="date" value={input.date} onChange={(e) => setInput({ ...input, date: e.target.value })} />
              <InputField label="Course" placeholder="Course name" value={input.course} onChange={(e) => setInput({ ...input, course: e.target.value })} />
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
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "rgba(0,0,0,0.03)" }}>
                      {["Date", "Course", "Score", "Rating", "Slope", "PCC", "Differential", ""].map((h) => (
                        <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontWeight: 600, color: "var(--text)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid var(--table-border)" }}>
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

                      return (
                        <tr key={index} style={{ background: rowColor(d, isNewest), borderBottom: "1px solid var(--table-border)", transition: "background 0.15s" }}>
                          <td style={{ padding: "10px 16px", color: "var(--text-h)" }}>
                            {isEditing
                              ? <input type="date" value={editForm.date} onChange={(e) => setEditForm({ ...editForm, date: e.target.value })} style={{ background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", color: "var(--text-h)", fontSize: 13, width: 130 }} />
                              : r.date || "—"}
                          </td>
                          <td style={{ padding: "10px 16px", color: "var(--text-h)", fontWeight: 500 }}>
                            {isEditing
                              ? <input value={editForm.course} onChange={(e) => setEditForm({ ...editForm, course: e.target.value })} style={{ background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", color: "var(--text-h)", fontSize: 13, width: 140 }} />
                              : r.course || "—"}
                          </td>
                          <td style={{ padding: "10px 16px", color: "var(--text-h)" }}>
                            {isEditing
                              ? <input type="number" value={editForm.score} onChange={(e) => setEditForm({ ...editForm, score: e.target.value })} style={{ background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", color: "var(--text-h)", fontSize: 13, width: 70 }} />
                              : r.score}
                          </td>
                          <td style={{ padding: "10px 16px", color: "var(--text)" }}>
                            {isEditing
                              ? <input type="number" value={editForm.rating} onChange={(e) => setEditForm({ ...editForm, rating: e.target.value })} style={{ background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", color: "var(--text-h)", fontSize: 13, width: 70 }} />
                              : r.rating}
                          </td>
                          <td style={{ padding: "10px 16px", color: "var(--text)" }}>
                            {isEditing
                              ? <input type="number" value={editForm.slope} onChange={(e) => setEditForm({ ...editForm, slope: e.target.value })} style={{ background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", color: "var(--text-h)", fontSize: 13, width: 70 }} />
                              : r.slope}
                          </td>
                          <td style={{ padding: "10px 16px", color: "var(--text)" }}>
                            {isEditing
                              ? <input type="number" value={editForm.pcc} onChange={(e) => setEditForm({ ...editForm, pcc: e.target.value })} style={{ background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", color: "var(--text-h)", fontSize: 13, width: 60 }} />
                              : (r.pcc || 0)}
                          </td>
                          <td style={{ padding: "10px 16px" }}>
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
                            </div>
                          </td>
                          <td style={{ padding: "10px 16px", whiteSpace: "nowrap" }}>
                            {!isEditing && (
                              <>
                                <button onClick={() => startEdit(index)} style={btnStyle("#f1f5f9", "var(--text-h)")}>Edit</button>
                                <button onClick={() => deleteRound(index)} style={{ ...btnStyle("#fef2f2", "#dc2626"), marginLeft: 6 }}>Delete</button>
                              </>
                            )}
                            {isEditing && (
                              <>
                                <button onClick={() => saveEdit(index)} style={btnStyle("#f0fdf4", "#16a34a")}>Save</button>
                                <button onClick={() => setEditingIndex(null)} style={{ ...btnStyle("#f1f5f9", "var(--text-h)"), marginLeft: 6 }}>Cancel</button>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {/* Next round preview */}
            <div className="rounded-xl p-5" style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
              <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-h)", margin: "0 0 16px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Next Round Preview
              </h2>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
                <InputField label="Score" type="number" value={prev.score} onChange={(e) => setPrev({ ...prev, score: +e.target.value })} />
                <InputField label="Rating" type="number" value={prev.rating} onChange={(e) => setPrev({ ...prev, rating: +e.target.value })} />
                <InputField label="Slope" type="number" value={prev.slope} onChange={(e) => setPrev({ ...prev, slope: +e.target.value })} />
                <InputField label="PCC" type="number" value={prev.pcc} onChange={(e) => setPrev({ ...prev, pcc: +e.target.value })} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <Row label="Differential" value={prevDiff !== null ? prevDiff.toFixed(1) : "—"} />
                <Row label="Counts towards HCP" value={prevCounts ? "Yes" : "No"} highlight={prevCounts} />
                <Row label="Stableford pts" value={stableford(prev.score) ?? "—"} />
                <Row
                  label="New handicap index"
                  value={newHcp !== null ? newHcp.toFixed(1) : "—"}
                  highlight={hcpDelta !== null && hcpDelta < 0}
                />
                {hcpDelta !== null && (
                  <Row
                    label="Change"
                    value={`${hcpDelta > 0 ? "+" : ""}${hcpDelta.toFixed(1)}`}
                    highlight={hcpDelta < 0}
                    negative={hcpDelta > 0}
                  />
                )}
              </div>
            </div>

            {/* Target */}
            <div className="rounded-xl p-5" style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
              <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-h)", margin: "0 0 16px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Target
              </h2>
              <div style={{ marginBottom: 16 }}>
                <InputField label="Target handicap" type="number" value={target} onChange={(e) => setTarget(+e.target.value)} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <Row label="Required differential" value={reqDiff} />
                <Row label="Score needed (71.2 / 127)" value={reqScore(71.2, 127).toFixed(0)} />
                <Row label="Rounds needed" value={gapEstimate() ? `~${gapEstimate()}` : hcp ? ">20" : "—"} />
              </div>
            </div>
          </div>

          {/* Progression chart */}
          <div className="rounded-xl p-5" style={{ background: "var(--card-bg)", border: "1px solid var(--border)", boxShadow: "var(--shadow)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 }}>
              <div>
                <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-h)", margin: "0 0 2px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Handicap Progression
                </h2>
                <p style={{ fontSize: 12, color: "var(--text)", margin: 0 }}>Rolling handicap index over time</p>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                <label style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text)" }}>Starting index</label>
                <input
                  type="number"
                  step="0.1"
                  placeholder="e.g. 11.7"
                  value={seedHcp}
                  onChange={(e) => setSeedHcp(e.target.value === "" ? "" : e.target.value)}
                  style={{ width: 90, background: "var(--input-bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "5px 10px", fontSize: 13, color: "var(--text-h)", textAlign: "right", outline: "none" }}
                  onFocus={(e) => { e.target.style.borderColor = "#22c55e"; e.target.style.boxShadow = "0 0 0 3px rgba(34,197,94,0.15)"; }}
                  onBlur={(e) => { e.target.style.borderColor = "var(--border)"; e.target.style.boxShadow = "none"; }}
                />
              </div>
            </div>
            <LineChart values={hcpHist} />
            {hcpHist.length >= 2 && (
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 11, color: "var(--text)" }}>
                <span>Start: {hcpHist[0]}</span>
                <span>Now: {hcpHist[hcpHist.length - 1]}</span>
              </div>
            )}
          </div>

        </div>
      </div>
    </>
  );
}

function Row({ label, value, highlight, negative }) {
  const color = highlight ? "#16a34a" : negative ? "#dc2626" : "var(--text-h)";
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--table-border)" }}>
      <span style={{ fontSize: 13, color: "var(--text)" }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color }}>{value}</span>
    </div>
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
