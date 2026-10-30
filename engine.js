// Minesweeper engine.
// Deterministic board generation, a logic solver, no-guess verification, and 3BV scoring.
// Pure functions with no DOM access so the same code runs in the browser and in Node tests.

export const DIFFICULTIES = {
  beginner: { cols: 9, rows: 9, mines: 10, label: "Beginner" },
  intermediate: { cols: 16, rows: 16, mines: 40, label: "Intermediate" },
  expert: { cols: 30, rows: 16, mines: 99, label: "Expert" },
};

// FNV-1a. Turns a readable seed ("daily-2026-10-31") into a 32-bit integer.
export function hashSeed(input) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Small, fast, seedable PRNG. Same seed always produces the same board.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tableCache = new Map();

export function neighborTable(cols, rows) {
  const key = `${cols}x${rows}`;
  const cached = tableCache.get(key);
  if (cached) return cached;
  const table = new Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const list = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < cols && ny >= 0 && ny < rows) list.push(ny * cols + nx);
        }
      }
      table[y * cols + x] = list;
    }
  }
  tableCache.set(key, table);
  return table;
}

export function computeNumbers(cols, rows, mines) {
  const NEI = neighborTable(cols, rows);
  const numbers = new Int8Array(cols * rows);
  for (let i = 0; i < numbers.length; i++) {
    if (mines[i]) {
      numbers[i] = -1;
      continue;
    }
    let count = 0;
    for (const j of NEI[i]) if (mines[j]) count++;
    numbers[i] = count;
  }
  return numbers;
}

// 3BV is the minimum number of left clicks needed to clear a board:
// one per connected zero-region, plus one for every number not touching a zero.
export function compute3BV(cols, rows, numbers) {
  const NEI = neighborTable(cols, rows);
  const n = cols * rows;
  const marked = new Uint8Array(n);
  let bv = 0;
  for (let i = 0; i < n; i++) {
    if (numbers[i] !== 0 || marked[i]) continue;
    bv++;
    const stack = [i];
    marked[i] = 1;
    while (stack.length) {
      const cell = stack.pop();
      for (const j of NEI[cell]) {
        if (marked[j]) continue;
        marked[j] = 1;
        if (numbers[j] === 0) stack.push(j);
      }
    }
  }
  for (let i = 0; i < n; i++) if (numbers[i] > 0 && !marked[i]) bv++;
  return bv;
}

export function openingState(cols, rows, numbers, firstIndex) {
  const NEI = neighborTable(cols, rows);
  const revealed = new Uint8Array(cols * rows);
  const flagged = new Uint8Array(cols * rows);
  const stack = [firstIndex, ...NEI[firstIndex]];
  while (stack.length) {
    const i = stack.pop();
    if (revealed[i] || numbers[i] === -1) continue;
    revealed[i] = 1;
    if (numbers[i] === 0) {
      for (const j of NEI[i]) if (!revealed[j] && numbers[j] !== -1) stack.push(j);
    }
  }
  return { revealed, flagged };
}

// Enumerate every mine layout consistent with the visible numbers in one
// connected frontier component. Returns per-cell mine/safe counts.
function enumerateComponent(count, constraints, maxNodes, maxSolutions) {
  const assign = new Int8Array(count).fill(-1);
  const mine = new Int32Array(count);
  const safe = new Int32Array(count);
  let solutions = 0;
  let nodes = 0;
  let aborted = false;

  function walk() {
    if (aborted) return;
    if (++nodes > maxNodes) {
      aborted = true;
      return;
    }
    let best = -1;
    let bestUnassigned = Infinity;
    for (let k = 0; k < constraints.length; k++) {
      const constraint = constraints[k];
      let unassigned = 0;
      let placed = 0;
      for (const ci of constraint.cells) {
        if (assign[ci] === 1) placed++;
        else if (assign[ci] === -1) unassigned++;
      }
      if (unassigned === 0) {
        if (placed !== constraint.need) return;
      } else {
        const remaining = constraint.need - placed;
        if (remaining < 0 || remaining > unassigned) return;
        if (unassigned < bestUnassigned) {
          bestUnassigned = unassigned;
          best = k;
        }
      }
    }
    if (best === -1) {
      solutions++;
      for (let i = 0; i < count; i++) {
        if (assign[i] === 1) mine[i]++;
        else safe[i]++;
      }
      if (solutions >= maxSolutions) aborted = true;
      return;
    }
    const constraint = constraints[best];
    const unassigned = [];
    let placed = 0;
    for (const ci of constraint.cells) {
      if (assign[ci] === 1) placed++;
      else if (assign[ci] === -1) unassigned.push(ci);
    }
    const need = constraint.need - placed;
    const chosen = [];
    function choose(start, left) {
      if (aborted) return;
      if (left === 0) {
        for (const ci of unassigned) assign[ci] = 0;
        for (const ci of chosen) assign[ci] = 1;
        walk();
        for (const ci of unassigned) assign[ci] = -1;
        for (const ci of chosen) assign[ci] = -1;
        return;
      }
      for (let i = start; i <= unassigned.length - left; i++) {
        chosen.push(unassigned[i]);
        choose(i + 1, left - 1);
        chosen.pop();
        if (aborted) return;
      }
    }
    choose(0, need);
  }

  walk();
  return { solutions, mine, safe, aborted };
}

// Solve a position the way a careful human would: repeated counting rules,
// then exhaustive checks on the remaining frontier.
export function solvePosition({
  cols,
  rows,
  numbers,
  mineCount,
  revealed: initialRevealed,
  flagged: initialFlagged,
  maxNodes = 250000,
  maxSolutions = 4000,
}) {
  const NEI = neighborTable(cols, rows);
  const n = cols * rows;
  const revealed = Uint8Array.from(initialRevealed);
  const flagged = Uint8Array.from(initialFlagged);
  const steps = [];

  const reveal = (start) => {
    const stack = [start];
    while (stack.length) {
      const i = stack.pop();
      if (revealed[i] || flagged[i] || numbers[i] === -1) continue;
      revealed[i] = 1;
      if (numbers[i] === 0) {
        for (const j of NEI[i]) if (!revealed[j] && !flagged[j] && numbers[j] !== -1) stack.push(j);
      }
    }
  };
  const flag = (i) => {
    if (!revealed[i]) flagged[i] = 1;
  };
  const isSolved = () => {
    for (let i = 0; i < n; i++) if (numbers[i] !== -1 && !revealed[i]) return false;
    return true;
  };

  function enumerateFrontier() {
    const constraints = [];
    for (let i = 0; i < n; i++) {
      if (!revealed[i] || numbers[i] <= 0) continue;
      const cells = [];
      let flags = 0;
      for (const j of NEI[i]) {
        if (revealed[j]) continue;
        if (flagged[j]) flags++;
        else cells.push(j);
      }
      if (!cells.length) continue;
      const need = numbers[i] - flags;
      if (need < 0 || need > cells.length) continue;
      constraints.push({ cells, need });
    }
    if (!constraints.length) return false;

    const byCell = new Map();
    constraints.forEach((constraint, ci) => {
      for (const cell of constraint.cells) {
        let list = byCell.get(cell);
        if (!list) byCell.set(cell, (list = []));
        list.push(ci);
      }
    });

    const visited = new Uint8Array(constraints.length);
    let applied = false;
    for (let start = 0; start < constraints.length; start++) {
      if (visited[start]) continue;
      const constraintIndexes = [];
      const cellSet = new Set();
      const stack = [start];
      visited[start] = 1;
      while (stack.length) {
        const ci = stack.pop();
        constraintIndexes.push(ci);
        for (const cell of constraints[ci].cells) {
          if (cellSet.has(cell)) continue;
          cellSet.add(cell);
          for (const cj of byCell.get(cell) || []) {
            if (!visited[cj]) {
              visited[cj] = 1;
              stack.push(cj);
            }
          }
        }
      }
      const cells = [...cellSet];
      const local = new Map(cells.map((cell, index) => [cell, index]));
      const localConstraints = constraintIndexes.map((ci) => ({
        cells: constraints[ci].cells.map((cell) => local.get(cell)),
        need: constraints[ci].need,
      }));
      const result = enumerateComponent(cells.length, localConstraints, maxNodes, maxSolutions);
      if (result.aborted || !result.solutions) continue;
      for (let i = 0; i < cells.length; i++) {
        if (result.mine[i] === result.solutions) {
          flag(cells[i]);
          applied = true;
        } else if (result.safe[i] === result.solutions) {
          reveal(cells[i]);
          applied = true;
        }
      }
    }
    return applied;
  }

  for (let round = 0; round < 500; round++) {
    let changed = false;

    for (let i = 0; i < n; i++) {
      if (!revealed[i] || numbers[i] <= 0) continue;
      const hidden = [];
      let flags = 0;
      for (const j of NEI[i]) {
        if (revealed[j]) continue;
        if (flagged[j]) flags++;
        else hidden.push(j);
      }
      if (!hidden.length) continue;
      const need = numbers[i] - flags;
      if (need === 0) {
        for (const j of hidden) reveal(j);
        steps.push({ type: "safe", cells: hidden.slice(), by: i });
        changed = true;
      } else if (need === hidden.length) {
        for (const j of hidden) flag(j);
        steps.push({ type: "mine", cells: hidden.slice(), by: i });
        changed = true;
      }
    }

    if (!changed) {
      let remainingMines = mineCount;
      let hiddenCount = 0;
      const hidden = [];
      for (let i = 0; i < n; i++) {
        if (flagged[i]) remainingMines--;
        if (!revealed[i] && !flagged[i]) {
          hiddenCount++;
          hidden.push(i);
        }
      }
      if (hiddenCount > 0 && remainingMines === 0) {
        for (const i of hidden) reveal(i);
        steps.push({ type: "safe", cells: hidden.slice(), by: -1 });
        changed = true;
      } else if (hiddenCount > 0 && remainingMines === hiddenCount) {
        for (const i of hidden) flag(i);
        steps.push({ type: "mine", cells: hidden.slice(), by: -1 });
        changed = true;
      }
    }

    if (!changed) {
      changed = enumerateFrontier();
      if (!changed) break;
    }
    if (isSolved()) break;
  }

  return { solved: isSolved(), revealed, flagged, steps };
}

export function generateRawBoard(cols, rows, mineCount, random, firstIndex) {
  const n = cols * rows;
  const NEI = neighborTable(cols, rows);
  const safeZone = new Set([firstIndex, ...NEI[firstIndex]]);
  const candidates = [];
  for (let i = 0; i < n; i++) if (!safeZone.has(i)) candidates.push(i);
  const mines = new Uint8Array(n);
  const take = Math.min(mineCount, candidates.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(random() * (candidates.length - i));
    const tmp = candidates[i];
    candidates[i] = candidates[j];
    candidates[j] = tmp;
    mines[candidates[i]] = 1;
  }
  return { mines, numbers: computeNumbers(cols, rows, mines) };
}

export function generateBoard({
  cols,
  rows,
  mines,
  seed,
  noGuess = false,
  firstIndex = Math.floor((rows >> 1) * cols + (cols >> 1)),
  maxAttempts = 400,
  timeBudgetMs = 3500,
}) {
  const random = mulberry32(hashSeed(seed));
  const started = Date.now();
  let best = null;
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts++;
    const board = generateRawBoard(cols, rows, mines, random, firstIndex);
    const opening = openingState(cols, rows, board.numbers, firstIndex);
    if (!noGuess) {
      return { ...board, opening, attempts, bv: compute3BV(cols, rows, board.numbers) };
    }
    const solved = solvePosition({
      cols,
      rows,
      numbers: board.numbers,
      mineCount: mines,
      revealed: opening.revealed,
      flagged: opening.flagged,
    });
    if (solved.solved) {
      return { ...board, opening, attempts, bv: compute3BV(cols, rows, board.numbers) };
    }
    best = board;
    if (Date.now() - started > timeBudgetMs) break;
  }
  const board = best || generateRawBoard(cols, rows, mines, random, firstIndex);
  const opening = openingState(cols, rows, board.numbers, firstIndex);
  return { ...board, opening, attempts, bv: compute3BV(cols, rows, board.numbers), noGuessFailed: noGuess };
}

// Count distinct mine layouts for a fixed set of hidden cells. Used by the
// pattern trainer tests to prove a drill has exactly one answer.
export function countSolutions({ cols, rows, numbers, hidden, maxSolutions = 10000 }) {
  const NEI = neighborTable(cols, rows);
  const n = cols * rows;
  const hiddenSet = new Set(hidden);
  const constraints = [];
  for (let i = 0; i < n; i++) {
    if (hiddenSet.has(i) || numbers[i] <= 0) continue;
    const cells = NEI[i].filter((j) => hiddenSet.has(j));
    if (!cells.length) continue;
    constraints.push({ cells, need: numbers[i] });
  }
  const local = new Map(hidden.map((cell, index) => [cell, index]));
  const constrained = new Uint8Array(hidden.length);
  for (const constraint of constraints) {
    for (const cell of constraint.cells) constrained[local.get(cell)] = 1;
  }
  const localConstraints = constraints.map((constraint) => ({
    cells: constraint.cells.map((cell) => local.get(cell)),
    need: constraint.need,
  }));
  const result = enumerateComponent(hidden.length, localConstraints, 2000000, maxSolutions);
  return { solutions: result.solutions, mine: result.mine, safe: result.safe, constrained, aborted: result.aborted };
}
