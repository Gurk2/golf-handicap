import Dexie from "dexie";

export const db = new Dexie("GolfHandicap");

db.version(1).stores({
  rounds: "++id, date, course",
});
