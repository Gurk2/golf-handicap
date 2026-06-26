import Dexie from "dexie";

export const db = new Dexie("GolfHandicap");

function replaceKnockGreen(record) {
  if (!record?.course || !/\bknock\b/i.test(record.course)) return false;

  let changed = false;
  const nextCourse = record.course.replace(/\bgreen\b/gi, "Yellow");
  if (nextCourse !== record.course) {
    record.course = nextCourse;
    changed = true;
  }

  if (typeof record.tee === "string" && /\bgreen\b/i.test(record.tee)) {
    record.tee = record.tee.replace(/\bgreen\b/gi, "Yellow");
    changed = true;
  }

  return changed;
}

function addKnockPar(record) {
  if (!record?.course || !/\bknock\b/i.test(record.course) || record.par) return false;
  record.par = Number(record.rating) < 50 ? 35 : 70;
  return true;
}

function hasTeeColor(record) {
  const label = `${record.course} ${record.tee ?? ""}`;
  return /\b(black|blue|bronze|gold|green|grey|gray|orange|purple|red|silver|white|yellow)\b/i.test(label);
}

function isNineHoleCourse(record) {
  return Number(record?.rating) < 50 ||
    /\b9\b|nine/i.test(record?.holes ?? "") ||
    /\b9\s*hole\b|nine\s*hole/i.test(record?.course ?? "");
}

function shouldRemoveUncoloredCourse(record) {
  if (!record?.course || hasTeeColor(record)) return false;
  if (/\bmalone\b/i.test(record.course)) return true;
  return /\bclandeboye\b/i.test(record.course) && isNineHoleCourse(record);
}

function isHolywoodRating699(record) {
  return /\bholywood\b/i.test(record?.course ?? "") && Number(record?.rating) === 69.9;
}

function shouldRemoveCourse(record) {
  return shouldRemoveUncoloredCourse(record) || isHolywoodRating699(record);
}

function courseTeeLabel(record) {
  if (!record) return "";
  const base = record.course ?? "";
  return `${base}${record.tee ? ` - ${record.tee}` : ""}${record.holes ? ` - ${record.holes}` : ""}`;
}

function isAvaCourse(record) {
  return /\bava\b/i.test(courseTeeLabel(record));
}

function isAvaNineHoleGreenTee(record) {
  return isAvaCourse(record) && hasTeeColor(record) && /\bgreen\b/i.test(courseTeeLabel(record)) && isNineHoleCourse(record);
}

function applyAvaNineHoleGreenTee(round, course) {
  const label = courseTeeLabel(course);
  const roundIsNineHole = isNineHoleCourse(round) || Number(round?.score) < 70;
  if (!isAvaCourse(round) || !roundIsNineHole || round.course === label) return false;
  round.course = label;
  round.rating = course.rating;
  round.slope = course.slope;
  if (course.par === undefined) delete round.par;
  else round.par = course.par;
  return true;
}

db.version(1).stores({
  rounds: "++id, date, course",
});

db.version(2).stores({
  rounds: "++id, date, course",
  settings: "key",
});

db.version(3).stores({
  rounds: "++id, date, course",
  settings: "key",
  courses: "++id, course",
});

db.version(4).stores({
  rounds: "++id, date, course",
  settings: "key",
  courses: "++id, course",
}).upgrade((tx) =>
  Promise.all([
    tx.table("rounds").toCollection().modify(replaceKnockGreen),
    tx.table("courses").toCollection().modify(replaceKnockGreen),
  ])
);

db.version(5).stores({
  rounds: "++id, date, course",
  settings: "key",
  courses: "++id, course",
}).upgrade((tx) =>
  Promise.all([
    tx.table("rounds").toCollection().modify(addKnockPar),
    tx.table("courses").toCollection().modify(addKnockPar),
  ])
);

db.version(6).stores({
  rounds: "++id, date, course",
  settings: "key",
  courses: "++id, course",
}).upgrade((tx) =>
  tx.table("courses").where("course").startsWithIgnoreCase("malone").filter(shouldRemoveUncoloredCourse).delete()
);

db.version(8).stores({
  rounds: "++id, date, course",
  settings: "key",
  courses: "++id, course",
}).upgrade((tx) =>
  tx.table("courses").filter(shouldRemoveUncoloredCourse).delete()
);

db.version(9).stores({
  rounds: "++id, date, course",
  settings: "key",
  courses: "++id, course",
}).upgrade((tx) =>
  tx.table("courses").filter(shouldRemoveUncoloredCourse).delete()
);

db.version(10).stores({
  rounds: "++id, date, course",
  settings: "key",
  courses: "++id, course",
}).upgrade((tx) =>
  tx.table("courses").filter(shouldRemoveCourse).delete()
);

db.version(11).stores({
  rounds: "++id, date, course",
  settings: "key",
  courses: "++id, course",
}).upgrade(async (tx) => {
  const avaNineHoleGreen = await tx.table("courses").filter(isAvaNineHoleGreenTee).first();
  if (!avaNineHoleGreen) return;
  await tx.table("rounds").toCollection().modify((round) => applyAvaNineHoleGreenTee(round, avaNineHoleGreen));
});
