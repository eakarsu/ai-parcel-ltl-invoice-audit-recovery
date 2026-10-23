import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseTaskPriority, parseTaskStatus } from "../tasks.mjs";

test("task priority falls back to NORMAL", () => {
  assert.equal(parseTaskPriority("HIGH"), "HIGH");
  assert.equal(parseTaskPriority("LOW"), "LOW");
  assert.equal(parseTaskPriority("urgent"), "NORMAL");
  assert.equal(parseTaskPriority(undefined), "NORMAL");
});

test("task status validates strictly", () => {
  assert.equal(parseTaskStatus("DONE"), "DONE");
  assert.equal(parseTaskStatus("DELETED"), null);
  assert.equal(parseTaskStatus(""), null);
});

test("tasks are mounted behind auth and backed by a real table", () => {
  const server = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.ok(server.includes("mountTasks("), "server must mount tasks");
  const mountAt = server.indexOf("mountTasks(");
  const authMarkers = ["app.use('/api', auth)", "api.use(auth)", "mountTasks(app, { pool, audit, auth })", "mountTasks(app,{pool,audit,auth})"];
  const guarded =
    server.includes("mountTasks(app, { pool, audit, auth })") ||
    server.includes("mountTasks(app,{pool,audit,auth})") ||
    authMarkers.some((m) => server.includes(m) && server.indexOf(m) < mountAt);
  assert.ok(guarded, "tasks must sit behind auth");
  const sql = fs.readFileSync(new URL("../migrations/002_tasks.sql", import.meta.url), "utf8");
  assert.ok(sql.includes("staff_tasks"), "migration must create staff_tasks");
});
