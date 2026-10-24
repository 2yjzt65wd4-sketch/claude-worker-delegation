import { test } from "node:test";
import assert from "node:assert/strict";
import { createBudget } from "../lib/budget.js";

const budget = (spent, extra = {}) =>
  createBudget({ limit: 3, reservePerJob: 0.05, spentToday: () => spent, ...extra });

test("des tâches parallèles ne dépassent pas le plafond", () => {
  const b = budget(2.9);
  const granted = [];
  for (let i = 0; i < 4; i++) {
    try { granted.push(b.reserve()); } catch { /* plafond atteint */ }
  }
  assert.equal(granted.length, 2);
});

test("libérer une réservation rend la place", () => {
  const b = budget(2.95);
  const release = b.reserve();
  assert.throws(() => b.reserve(), /budget/);
  release();
  assert.doesNotThrow(() => b.reserve());
});

test("libérer deux fois ne crée pas de crédit fantôme", () => {
  const b = budget(2.95);
  const release = b.reserve();
  release();
  release();
  b.reserve();
  assert.throws(() => b.reserve(), /budget/);
});

test("refuse tout quand le plafond est déjà atteint", () => {
  assert.throws(() => budget(3).reserve(), /budget/);
  assert.throws(() => budget(2.99).reserve(), /budget/);
});

test("le message dit combien est dépensé et réservé, sans rien d'autre", () => {
  const b = budget(2.96);
  assert.throws(() => b.reserve(), /\$2\.9600 spent/);
});
