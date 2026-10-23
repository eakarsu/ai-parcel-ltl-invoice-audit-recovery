// Staff tasks — durable follow-ups stored in PostgreSQL (staff_tasks).
// Mounted behind the existing JWT auth middleware in server.mjs.
export function parseTaskPriority(value) {
  return value === "LOW" || value === "HIGH" ? value : "NORMAL";
}
export function parseTaskStatus(value) {
  return value === "OPEN" || value === "DONE" || value === "CANCELLED" ? value : null;
}

export function mountTasks(app, { pool, audit, auth }) {
  if (typeof auth !== "function") throw new Error("mountTasks requires the auth middleware");
  const guard = auth;

  app.get("/api/tasks", guard, async (req, res) => {
    const status = parseTaskStatus(String(req.query.status || ""));
    const result = status
      ? await pool.query("SELECT * FROM staff_tasks WHERE status=$1 ORDER BY due_at ASC NULLS LAST, created_at DESC LIMIT 200", [status])
      : await pool.query("SELECT * FROM staff_tasks ORDER BY status ASC, due_at ASC NULLS LAST, created_at DESC LIMIT 200");
    res.json({ tasks: result.rows });
  });

  app.post("/api/tasks", guard, async (req, res) => {
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    if (!title) return res.status(422).json({ error: "title is required" });
    const dueAt = typeof req.body?.dueAt === "string" && !Number.isNaN(Date.parse(req.body.dueAt)) ? new Date(req.body.dueAt) : null;
    let assigneeId = null;
    if (req.body?.assigneeId != null) {
      const found = await pool.query("SELECT id FROM app_users WHERE id=$1", [req.body.assigneeId]);
      if (!found.rows[0]) return res.status(404).json({ error: "Assignee not found" });
      assigneeId = found.rows[0].id;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const created = await client.query(
        "INSERT INTO staff_tasks(title,description,priority,due_at,created_by,assignee_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
        [title.slice(0, 200), typeof req.body?.description === "string" ? req.body.description.slice(0, 2000) : null, parseTaskPriority(req.body?.priority), dueAt, req.user.id, assigneeId],
      );
      await audit(req.user.email, "TASK_CREATED", "StaffTask", String(created.rows[0].id), title.slice(0, 200));
      await client.query("COMMIT");
      res.status(201).json({ task: created.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  app.patch("/api/tasks/:id", guard, async (req, res) => {
    const status = req.body?.status === undefined ? undefined : parseTaskStatus(String(req.body.status));
    if (req.body?.status !== undefined && !status) return res.status(422).json({ error: "status must be OPEN, DONE, or CANCELLED" });
    const existing = await pool.query("SELECT * FROM staff_tasks WHERE id=$1", [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: "Task not found" });
    const completedAt = status === "DONE" ? new Date() : status ? null : existing.rows[0].completed_at;
    const assigneeId = req.body?.assigneeId === undefined ? existing.rows[0].assignee_id : req.body.assigneeId;
    const updated = await pool.query(
      "UPDATE staff_tasks SET status=$1, completed_at=$2, assignee_id=$3, updated_at=NOW() WHERE id=$4 RETURNING *",
      [status ?? existing.rows[0].status, completedAt, assigneeId, req.params.id],
    );
    await audit(req.user.email, "TASK_UPDATED", "StaffTask", String(req.params.id), String(status ?? "updated"));
    res.json({ task: updated.rows[0] });
  });
}
