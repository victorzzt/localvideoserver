/**
 * Thumbnail queue scheduler running in a dedicated Web Worker.
 *
 * A Worker cannot create HTMLVideoElement, so it owns ordering, concurrency,
 * pause/resume, and lifecycle while asking the page to execute each DOM-bound
 * frame capture. At most four `run` messages can be outstanding at once.
 */

const CONCURRENCY = 4;
let paused = false;
let sealed = false;
let finished = false;
let priorityTransition = false;
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
  let hasOldActiveTask = false;
  for (const [id] of active) {
    if (!priorityIds.has(id)) {
      hasOldActiveTask = true;
      requestCancellation(id);
    }
  }
  if (hasOldActiveTask) priorityTransition = true;
}

/** Keep dispatch stopped until every connection from the old scope has settled. */
function updatePriorityTransition() {
  if (!priorityTransition) return;
  const hasOldActiveTask = [...active.keys()].some((id) => !priorityIds.has(id));
  if (!hasOldActiveTask) priorityTransition = false;
}

/** Dispatch work until the configured connection/decode limit is reached. */
function pump() {
  if (paused || priorityTransition || finished) return;

  while (active.size < CONCURRENCY && pending.length > 0) {
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
  updatePriorityTransition();
  pump();
}

self.addEventListener("message", (event) => {
  const message = event.data || {};

  switch (message.type) {
    case "init":
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
      const oldActiveIds = [...active.keys()].filter((id) => !priorityIds.has(id));
      priorityTransition = oldActiveIds.length > 0;
      for (const id of oldActiveIds) {
        requestCancellation(id);
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
      updatePriorityTransition();
      pump();
      break;

    case "cancelled":
      handleCancelled(message.id);
      break;
  }
});
