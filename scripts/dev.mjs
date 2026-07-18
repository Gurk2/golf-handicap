import { spawn } from "node:child_process";
import process from "node:process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const viteArgs = process.argv.slice(2);
const children = [];
let shuttingDown = false;

function start(name, command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    ...options,
  });

  children.push({ name, child });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;

    shuttingDown = true;
    const reason = signal ? `${name} stopped with ${signal}` : `${name} exited with code ${code ?? 0}`;
    console.error(`\n${reason}. Stopping the app.`);
    stopChildren(child);
    process.exit(code ?? 1);
  });

  return child;
}

function stopChildren(except) {
  for (const { child } of children) {
    if (child === except || child.killed) continue;
    child.kill("SIGTERM");
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopChildren();
    process.exit(0);
  });
}

start("sync server", npm, ["start"], { cwd: new URL("../sync-server", import.meta.url) });
start("frontend", npm, ["run", "dev:frontend", "--", ...viteArgs]);
