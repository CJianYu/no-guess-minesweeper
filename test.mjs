// Sanity checks for the engine. Run: node test.mjs
import {
  DIFFICULTIES,
  compute3BV,
  countSolutions,
  generateBoard,
  hashSeed,
  mulberry32,
  solvePosition,
} from "./engine.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const center = (cols, rows) => Math.floor((rows >> 1) * cols + (cols >> 1));

// Determinism.
const a = generateBoard({ ...DIFFICULTIES.beginner, seed: "deterministic", firstIndex: 40 });
const b = generateBoard({ ...DIFFICULTIES.beginner, seed: "deterministic", firstIndex: 40 });
check("same seed produces the same board", a.numbers.join(",") === b.numbers.join(","));
check("hashSeed is stable", hashSeed("daily-2026-10-31") === hashSeed("daily-2026-10-31"));
check("mulberry32 is deterministic", mulberry32(42)() === mulberry32(42)());

// Mine counts and first-click safety.
for (const [name, config] of Object.entries(DIFFICULTIES)) {
  const first = center(config.cols, config.rows);
  const board = generateBoard({ ...config, seed: `${name}-check`, firstIndex: first });
  const mines = [...board.numbers].filter((value) => value === -1).length;
  check(`${name}: exact mine count`, mines === config.mines, `${mines}/${config.mines}`);
  check(`${name}: first click is safe`, board.numbers[first] !== -1);
  check(`${name}: 3BV is positive`, compute3BV(config.cols, config.rows, board.numbers) > 0);
}

// No-guess boards must be solvable by deduction.
for (const [name, config] of Object.entries(DIFFICULTIES)) {
  let solved = 0;
  const rounds = 10;
  for (let i = 0; i < rounds; i++) {
    const board = generateBoard({ ...config, seed: `${name}-noguess-${i}`, noGuess: true, firstIndex: center(config.cols, config.rows) });
    if (board.noGuessFailed) continue;
    const result = solvePosition({
      cols: config.cols,
      rows: config.rows,
      numbers: board.numbers,
      mineCount: config.mines,
      revealed: board.opening.revealed,
      flagged: board.opening.flagged,
    });
    if (result.solved) solved++;
  }
  check(`${name}: all no-guess boards are solvable`, solved === rounds, `${solved}/${rounds}`);
}

// The solver must never reveal a mine.
const board = generateBoard({ ...DIFFICULTIES.intermediate, seed: "safety", firstIndex: center(16, 16) });
const result = solvePosition({
  cols: 16,
  rows: 16,
  numbers: board.numbers,
  mineCount: 40,
  revealed: board.opening.revealed,
  flagged: board.opening.flagged,
});
const openedMine = [...result.revealed].some((value, index) => value && board.numbers[index] === -1);
const flaggedSafe = [...result.flagged].some((value, index) => value && board.numbers[index] !== -1);
check("solver only reveals safe cells", !openedMine);
check("solver only flags mines", !flaggedSafe);

// countSolutions: the classic 1-2-1 edge has exactly one layout.
const numbers = Int8Array.from([0, 0, 0, 0, 0, 0, 1, 2, 1, 0]);
const counted = countSolutions({ cols: 5, rows: 2, numbers, hidden: [0, 1, 2, 3, 4] });
check("1-2-1 position has one layout", counted.solutions === 1);
check("1-2-1 forces two mines", [...counted.mine].filter((value) => value === counted.solutions).length === 2);

console.log(failures ? `\n${failures} check(s) failed` : "\nAll engine checks passed");
process.exit(failures ? 1 : 0);
