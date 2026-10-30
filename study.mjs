// Measures how often a standard Minesweeper board can be cleared by logic
// alone, using the same engine and solver the site ships.
//
// Usage: node scripts/no-guess-study.mjs [samplesPerLevel]
// Writes study.json and prints a summary table.
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DIFFICULTIES,
  generateBoard,
  solvePosition,
} from "./engine.js";

const SAMPLES = Math.max(20, Number.parseInt(process.argv[2] ?? "400", 10) || 400);
const LEVELS = ["beginner", "intermediate", "expert"];

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[index];
}

const report = {
  generatedAt: new Date().toISOString(),
  samplesPerLevel: SAMPLES,
  method:
    "Each board is generated with the site's seeded generator from a fixed seed, opened at the centre exactly as the game does, then passed to the same constraint solver. A board counts as logic-only when the solver clears it without guessing.",
  levels: {},
};

for (const level of LEVELS) {
  const { cols, rows, mines } = DIFFICULTIES[level];
  const firstIndex = Math.floor((rows >> 1) * cols + (cols >> 1));
  const started = Date.now();
  let solved = 0;
  const bv = [];
  const attempts = [];

  for (let i = 0; i < SAMPLES; i++) {
    const board = generateBoard({ cols, rows, mines, seed: `study-${level}-${i}`, firstIndex });
    const result = solvePosition({
      cols,
      rows,
      numbers: board.numbers,
      mineCount: mines,
      revealed: board.opening.revealed,
      flagged: board.opening.flagged,
    });
    if (result.solved) solved++;
    bv.push(board.bv);
    attempts.push(board.attempts);
  }

  report.levels[level] = {
    cols,
    rows,
    mines,
    samples: SAMPLES,
    solvedByLogic: solved,
    logicOnlyRate: Number((solved / SAMPLES).toFixed(4)),
    bvMean: Number((bv.reduce((sum, value) => sum + value, 0) / bv.length).toFixed(2)),
    bvMedian: percentile(bv, 50),
    bvMin: Math.min(...bv),
    bvMax: Math.max(...bv),
    elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
  };
  const entry = report.levels[level];
  console.log(
    `${level.padEnd(13)} ${entry.solvedByLogic}/${SAMPLES} solvable by logic ` +
      `(${(entry.logicOnlyRate * 100).toFixed(1)}%) · 3BV median ${entry.bvMedian} · ${entry.elapsedSeconds}s`,
  );
}

await mkdir(resolve("."), { recursive: true });
await writeFile(resolve("study.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log("wrote study.json");
