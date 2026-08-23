/**
 * Thumbnail queue scheduler running in a dedicated Web Worker.
 *
 * A Worker cannot create HTMLVideoElement, so it owns ordering, concurrency,
 * pause/resume, and lifecycle while asking the page to execute each DOM-bound
 * frame capture. At most four `run` messages can be outstanding at once.
 */

let concurrency = 4;
let paused = false;
let sealed = false;
let finished = false;
const pending = [];
const active = new Map();
let priorityIds = new Set();
const cancellationRequested = new Set();

/** Stable-sort pending tasks so the current directory is dispatched first. */
function sortPendingByPriority() {
  pending.sort((left, right) => Number(priorityIds.has(right.id)) - Number(priorityIds.has(left.id)));
}

function requestCancellation(id) {
  if (cancellationRequested.has(id)) return;
  cancellationRequested.add(id);
  self.postMessage({ type: "cancel", id });
}

/** Free occupied slots when newly queued current-folder work is waiting. */
function preemptForPriority() {
  if (!pending.some((task) => priorityIds.has(task.id))) return;
  for (const [id] of active) {
    if (!priorityIds.has(id)) requestCancellation(id);
  }
}

/** Dispatch work until the configured connection/decode limit is reached. */
function pump() {
  if (paused || finished) return;

  while (active.size < concurrency && pending.length > 0) {
    const task = pending.shift();
    active.set(task.id, task);
    self.postMessage({ type: "run", id: task.id, url: task.url });
  }

  finishIfDrained();
}

/** Close this Worker only after the page has submitted and finished every task. */
function finishIfDrained() {
  if (!sealed || paused || pending.length > 0 || active.size > 0 || finished) return;
  finished = true;
  self.postMessage({ type: "drained" });
  self.close();
}

/** Requeue active jobs after the page confirms their media requests were aborted. */
function handleCancelled(id) {
  const task = active.get(id);
  if (!task) return;
  active.delete(id);
  cancellationRequested.delete(id);
  pending.push(task);
  sortPendingByPriority();
  pump();
}

self.addEventListener("message", (event) => {
  const message = event.data || {};

  switch (message.type) {
    case "init":
      concurrency = Math.max(1, Math.min(4, Number(message.concurrency) || 4));
      pump();
      break;

    case "enqueue":
      if (!finished) {
        pending.push({ id: message.id, url: message.url });
        if (message.priority) priorityIds.add(message.id);
        sortPendingByPriority();
        preemptForPriority();
      }
      pump();
      break;

    case "prioritize": {
      priorityIds = new Set(message.ids || []);
      sortPendingByPriority();
      const hasWaitingPriority = pending.some((task) => priorityIds.has(task.id));
      if (hasWaitingPriority) {
        for (const [id] of active) {
          if (!priorityIds.has(id)) requestCancellation(id);
        }
      }
      pump();
      break;
    }

    case "seal":
      sealed = true;
      pump();
      break;

    case "pause":
      paused = true;
      for (const id of active.keys()) requestCancellation(id);
      break;

    case "resume":
      paused = false;
      pump();
      break;

    case "complete":
    case "failed":
      active.delete(message.id);
      priorityIds.delete(message.id);
      cancellationRequested.delete(message.id);
      pump();
      break;

    case "cancelled":
      handleCancelled(message.id);
      break;
  }
});
