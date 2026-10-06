// Only terminal records are eligible. Removing history never deletes outputs.
export function pruneCompletedTasks(tasks, maximum = 2000) {
  if (!Number.isSafeInteger(maximum) || maximum < 1) maximum = 2000;
  const terminal = [...tasks.values()].filter((task) => ["completed", "failed", "cancelled"].includes(task.status));
  terminal.sort((a, b) => String(a.updatedAt || a.createdAt).localeCompare(String(b.updatedAt || b.createdAt)));
  for (const task of terminal.slice(0, Math.max(0, terminal.length - maximum))) tasks.delete(task.taskId);
}
