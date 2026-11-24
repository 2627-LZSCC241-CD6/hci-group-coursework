// One Step at a Time: sequential substeps, conditional SVG areas and logs.
// All UI text and comments are intentionally in English.
const IMAGES_DIR = "images/";
const COMPLETION_IMAGE = "full_case.jpg"; // Final photo inside images/; change this filename.
const DEFAULT_IMAGE = "full_case.jpg";
const $ = id => document.getElementById(id);
const instructionEl = $("instruction"), feedbackEl = $("feedback");
const clickAreasEl = $("clickAreas"), machineImg = $("machine"), overlayEl = $("overlay");
const startBtn = $("startBtn"), backBtn = $("backBtn"), pauseBtn = $("pauseBtn");
const exportBtn = $("exportBtn"), warningEl = $("errorWarning");
let steps = [], procedureTitle = "";
let currentStep = 0, currentSubstep = 0;
let isRunning = false, isPaused = false, imageReady = false;
let errors = 0, clickedZones = new Set();
let sessions = [], session = null, sessionStart = 0;
let warningTimer, imageRequest = 0;


const SECONDARY_CONFIG = Object.freeze({
  initialValue: 50, increasePerClick: 10, decreasePerSecond: 4,
  safeMin: 40, safeMax: 60, outsideLimitMs: 5000,
  freezeDuringHazard: true
});
const hazardDialog = $("hazardDialog"), doneBtn = $("hazardDone");
let hazardOpen = false, hazardShownAt = 0, previousFocus = null;
let secondaryValue = SECONDARY_CONFIG.initialValue;
let secondaryClock = 0, outside = null, lastTick = performance.now(), spaceHeld = false;
function secondaryActive() {
  return isRunning && !isPaused && !(hazardOpen && SECONDARY_CONFIG.freezeDuringHazard);
}
function secondaryContext() {
  return { stepIndex: currentStep, stepId: steps[currentStep].id, substepIndex: currentSubstep };
}
function checkSecondary() {
  const unsafe = secondaryValue < SECONDARY_CONFIG.safeMin || secondaryValue > SECONDARY_CONFIG.safeMax;
  if (unsafe && !outside) {
    outside = { startedAtActiveMs: secondaryClock, startContext: secondaryContext(), reported: false };
    logEvent("secondary_outside_enter", { value: secondaryValue, startContext: outside.startContext });
  }
  if (!outside) return;
  const duration = secondaryClock - outside.startedAtActiveMs;
  if (!outside.reported && duration >= SECONDARY_CONFIG.outsideLimitMs) {
    outside.reported = true;
    logEvent("secondary_outside_limit", { value: secondaryValue, durationActiveMs: Math.round(duration), startContext: outside.startContext });
  }
  if (!unsafe) {
    logEvent("secondary_safe_return", { value: secondaryValue, durationActiveMs: Math.round(duration), startContext: outside.startContext });
    outside = null;
  }
}
function advanceSecondary(now = performance.now()) {
  const dt = Math.max(0, now - lastTick); lastTick = now;
  if (!secondaryActive()) return;
  // Split at the lower safe boundary so out-of-range timing starts at the crossing.
  if (!outside && secondaryValue >= SECONDARY_CONFIG.safeMin) {
    const untilCross = (secondaryValue - SECONDARY_CONFIG.safeMin) / SECONDARY_CONFIG.decreasePerSecond * 1000;
    if (dt > untilCross) {
      secondaryClock += untilCross;
      secondaryValue = SECONDARY_CONFIG.safeMin - 1e-9;
      checkSecondary();
      secondaryClock += dt - untilCross;
      secondaryValue = Math.max(0, secondaryValue - SECONDARY_CONFIG.decreasePerSecond * (dt - untilCross) / 1000);
      checkSecondary(); return;
    }
  }
  secondaryClock += dt;
  secondaryValue = Math.max(0, secondaryValue - SECONDARY_CONFIG.decreasePerSecond * dt / 1000);
  checkSecondary();
}
function renderSecondary() {
  $("secondaryValue").textContent = secondaryValue.toFixed(1);
  $("secondaryPointer").style.bottom = `${secondaryValue}%`;
  $("secondaryMeter").setAttribute("aria-valuenow", secondaryValue.toFixed(1));
  $("secondaryPanel").classList.toggle("unsafe", secondaryValue < 40 || secondaryValue > 60);
  $("secondaryBtn").disabled = !isRunning || isPaused || hazardOpen;
  $("secondaryStatus").textContent = !isRunning ? "Stopped" : isPaused ? "Paused" : hazardOpen ?
    (SECONDARY_CONFIG.freezeDuringHazard ? "Frozen during warning" : "Running during warning") : "Active";
}
function resetSecondary() {
  secondaryValue = SECONDARY_CONFIG.initialValue; secondaryClock = 0; outside = null;
  lastTick = performance.now(); renderSecondary();
}
function boostSecondary() {
  advanceSecondary();
  if (!isRunning || isPaused || hazardOpen) return;
  const before = secondaryValue;
  secondaryValue = Math.min(100, secondaryValue + SECONDARY_CONFIG.increasePerClick);
  logEvent("secondary_press", { input: "Space", before, value: secondaryValue });
  checkSecondary(); renderSecondary();
  $("secondaryBtn").classList.add("pressed");
}
function showHazard(a) {
  advanceSecondary(); hazardOpen = true; hazardShownAt = performance.now();
  previousFocus = document.activeElement;
  $("hazardText").textContent = a.hazardText || a.text;
  $("workspace").inert = true;
  hazardDialog.showModal(); doneBtn.focus();
  logEvent("hazard_shown", { text: a.hazardText || a.text });
  renderSecondary();
}
doneBtn.addEventListener("click", () => {
  advanceSecondary();
  logEvent("hazard_acknowledged", { responseMs: Math.round(performance.now() - hazardShownAt) });
  hazardOpen = false; hazardDialog.close(); $("workspace").inert = false;
  lastTick = performance.now(); renderSecondary();
  if (previousFocus && previousFocus.isConnected) previousFocus.focus();
});
hazardDialog.addEventListener("cancel", e => e.preventDefault());
document.addEventListener("keydown", e => {
  if (e.code !== "Space") return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.repeat || spaceHeld) return;
  spaceHeld = true; boostSecondary();
}, true);
document.addEventListener("keyup", e => {
  if (e.code !== "Space") return;
  e.preventDefault(); e.stopImmediatePropagation(); spaceHeld = false;
  $("secondaryBtn").classList.remove("pressed");
}, true);
$("secondaryBtn").addEventListener("click", e => e.preventDefault());
window.addEventListener("blur", () => {
  spaceHeld = false; $("secondaryBtn").classList.remove("pressed");
});
function secondaryFrame(now) {
  advanceSecondary(now); renderSecondary(); requestAnimationFrame(secondaryFrame);
}
requestAnimationFrame(secondaryFrame);


// Checklist state describes the current attempt, not historical log events.
let taskListStarted = false;
const completedSteps = new Set();
function resetTaskList() {
  taskListStarted = true;
  completedSteps.clear();
  renderTaskList();
}
function invalidateTaskListFrom(index) {
  for (const done of completedSteps) {
    if (done >= index) completedSteps.delete(done);
  }
}
function renderTaskList() {
  const panel = $("taskListPanel"), list = $("taskList");
  panel.hidden = !taskListStarted;
  if (!taskListStarted) return;
  list.replaceChildren();
  steps.forEach((step, index) => {
    const item = document.createElement("li");
    const done = completedSteps.has(index);
    const active = isRunning && index === currentStep;
    item.className = `task-item${done ? " completed" : ""}${active ? " current" : ""}`;
    if (active) item.setAttribute("aria-current", "step");
    const mark = document.createElement("span");
    mark.className = "task-mark";
    mark.textContent = done ? "✓" : String(index + 1);
    mark.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = step.title || step.substeps[0].text || `Step ${index + 1}`;
    const status = document.createElement("span");
    status.className = "sr-only";
    status.textContent = done ? "Completed: " : active ? "Current: " : "Not completed: ";
    item.append(mark, status, text);
    list.appendChild(item);
  });
  $("taskListProgress").textContent = `Completed: ${completedSteps.size} / ${steps.length} · Remaining: ${steps.length - completedSteps.size}`;
}

// Normalize once so rendering does not need separate legacy/new branches.
function normalizeSteps(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new Error("steps must be a non-empty array.");
  return raw.map((step, i) => {
    const actions = step.substeps === undefined ? [step] : step.substeps;
    if (!Array.isArray(actions) || !actions.length) throw new Error(`Step ${i + 1}: empty substeps.`);
    return { id: step.id ?? i + 1, title: step.title || step.text || "",
      substeps: actions.map((a, j) => {
        if (!a || typeof a.text !== "string" || !a.text.trim()) throw new Error(`Step ${i + 1}/${j + 1}: missing text.`);
        const polygons = a.polygons || (a.polygon ? [a.polygon] : null);
        if (!Array.isArray(polygons) || !polygons.length || polygons.some(p => typeof p !== "string" || !p.trim())) {
          throw new Error(`Step ${i + 1}/${j + 1}: invalid polygons.`);
        }
        if (a.currentOnly !== undefined && typeof a.currentOnly !== "boolean") throw new Error("currentOnly must be true or false.");
        if (a.image !== undefined && (typeof a.image !== "string" || !a.image.trim())) throw new Error("image must be a filename.");
        if (a.hazard !== undefined && typeof a.hazard !== "boolean") throw new Error("hazard must be true or false.");
        if (a.hazardText !== undefined && (typeof a.hazardText !== "string" || !a.hazardText.trim())) throw new Error("hazardText must be non-empty text.");
        return { ...a, polygons, currentOnly: a.currentOnly === true };
      })
    };
  });
}
function currentAction() { return steps[currentStep].substeps[currentSubstep]; }

// Timestamps include pauses and loading. Separate events allow their subtraction.
// All indices are zero-based; stepId preserves the procedure's own identifier.
function logEvent(event, details = {}) {
  if (!session || session.status !== "running") return;
  session.events.push({ event, elapsedMs: Math.round(performance.now() - sessionStart),
    stepIndex: currentStep, stepId: steps[currentStep].id,
    substepIndex: currentSubstep, ...details });
}
function closeSession(status) {
  advanceSecondary();
  if (!session || session.status !== "running") return;
  logEvent(status === "completed" ? "procedure_complete" : "procedure_restart", { errors });
  session.status = status;
  session.endedAt = new Date().toISOString();
  session.durationMs = Math.round(performance.now() - sessionStart);
  session.errors = errors;
  session.secondary = { value: secondaryValue, activeMs: Math.round(secondaryClock), openOutsideEpisode: outside ? { ...outside, durationActiveMs: Math.round(secondaryClock - outside.startedAtActiveMs) } : null };
}

function hideWarning() {
  clearTimeout(warningTimer);
  warningEl.hidden = true;
  warningEl.textContent = "";
}
// One non-modal toast; subsequent errors replace it and reset its timeout.
function showWarning(message) {
  clearTimeout(warningTimer);
  warningEl.textContent = message;
  warningEl.hidden = false;
  warningTimer = setTimeout(hideWarning, 3000);
}

async function loadProcedure() {
  startBtn.disabled = true;
  try {
    const response = await fetch("raw.json");
    if (!response.ok) throw new Error(`Could not load raw.json (${response.status}).`);
    const data = await response.json();
    steps = normalizeSteps(data.steps);
    procedureTitle = data.title || "Procedure";
    preloadImages();
    feedbackEl.textContent = `${procedureTitle} — ready to start.`;
    startBtn.disabled = false;
  } catch (error) {
    console.error(error);
    instructionEl.textContent = "Could not load the procedure.";
    feedbackEl.textContent = error.message;
  }
}
function preloadImages() {
  const urls = new Set(steps.flatMap(s => s.substeps.map(a => IMAGES_DIR + (a.image || DEFAULT_IMAGE))));
  urls.forEach(url => { const img = new Image(); img.src = url; });
}

// Non-current currentOnly areas are not created at all. Ordinary areas
// keep the original behavior; current targets are placed above them.
function createClickAreas() {
  clickAreasEl.replaceChildren();
  const activeAreas = [];
  steps.forEach((step, si) => step.substeps.forEach((a, ui) => {
    const active = si === currentStep && ui === currentSubstep;
    if (a.currentOnly && !active) return;
    a.polygons.forEach((points, zi) => {
      const area = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      area.setAttribute("points", points);
      area.setAttribute("class", "click-area");
      area.setAttribute("aria-label", `${a.target || a.text} (zone ${zi + 1})`);
      area.dataset.step = si; area.dataset.substep = ui; area.dataset.zone = zi;
      area.addEventListener("click", () => handleAreaClick(si, ui, zi));
      if (active) activeAreas.push(area); else clickAreasEl.appendChild(area);
    });
  }));
  activeAreas.forEach(a => clickAreasEl.appendChild(a));
  refreshAreaStyles();
}
function refreshAreaStyles() {
  Array.from(clickAreasEl.children).forEach(area => {
    const active = Number(area.dataset.step) === currentStep && Number(area.dataset.substep) === currentSubstep;
    const done = clickedZones.has(Number(area.dataset.zone));
    area.classList.toggle("target", active && !done);
    area.classList.toggle("done", active && done);
  });
}
function updateFeedback() {
  if (isPaused) { feedbackEl.textContent = "Paused."; return; }
  const a = currentAction(), count = steps[currentStep].substeps.length;
  const sub = count > 1 ? ` · Substep ${currentSubstep + 1} of ${count}` : "";
  const progress = a.polygons.length > 1 ? ` · Clicked ${clickedZones.size}/${a.polygons.length}` : "";
  feedbackEl.textContent = `Step ${currentStep + 1} of ${steps.length}${sub}${progress} · Errors: ${errors}`;
}

// Wait for each action's own image before enabling zones. A request token
// discards late responses after Back or Restart. Failed images never leave
// clickable polygons on an unrelated old photo.
function showAction(si, ui) {
  advanceSecondary();
  currentStep = si; currentSubstep = ui;
  invalidateTaskListFrom(si);
  renderTaskList();
  clickedZones = new Set(); imageReady = false;
  hideWarning(); clickAreasEl.replaceChildren();
  const request = ++imageRequest, a = currentAction();
  instructionEl.textContent = a.text;
  instructionEl.classList.remove("hazard");
  feedbackEl.textContent = isPaused ? "Paused." : "Loading image...";
  logEvent("substep_enter", { image: a.image || DEFAULT_IMAGE });
  const image = new Image();
  image.onload = () => {
    if (request !== imageRequest || !isRunning) return;
    machineImg.src = image.src;
    overlayEl.setAttribute("viewBox", `0 0 ${image.naturalWidth} ${image.naturalHeight}`);
    imageReady = true;
    createClickAreas(); updateFeedback();
    logEvent("substep_ready", { image: a.image || DEFAULT_IMAGE });
    if (a.hazard) showHazard(a);
  };
  image.onerror = () => {
    if (request !== imageRequest || !isRunning) return;
    feedbackEl.textContent = `Could not load ${a.image || DEFAULT_IMAGE}. Check images/ and restart.`;
    logEvent("image_error", { image: a.image || DEFAULT_IMAGE });
  };
  image.src = IMAGES_DIR + (a.image || DEFAULT_IMAGE);
}
function nextAction() {
  if (currentSubstep + 1 < steps[currentStep].substeps.length) showAction(currentStep, currentSubstep + 1);
  else if (currentStep + 1 < steps.length) showAction(currentStep + 1, 0);
  else finishProcedure();
}
function handleAreaClick(si, ui, zi) {
  if (!isRunning || isPaused || hazardOpen || !imageReady) return;
  const details = { clickedStepIndex: si, clickedSubstepIndex: ui, zoneIndex: zi };
  if (si !== currentStep || ui !== currentSubstep) {
    errors += 1;
    logEvent("wrong_click", { ...details, errors });
    feedbackEl.textContent = `Wrong part. Try again. Errors: ${errors}`;
    showWarning("Wrong part. Try again.");
    return;
  }
  if (clickedZones.has(zi)) { logEvent("repeat_click", details); return; }
  clickedZones.add(zi); logEvent("correct_click", details);
  refreshAreaStyles(); updateFeedback();
  if (clickedZones.size === currentAction().polygons.length) {
    logEvent("substep_complete");
    if (currentSubstep === steps[currentStep].substeps.length - 1) {
      completedSteps.add(currentStep);
      renderTaskList();
      logEvent("step_complete");
    }
    nextAction();
  }
}
function finishProcedure() {
  closeSession("completed");
  isRunning = false; isPaused = false; imageReady = false;
  renderTaskList();
  pauseBtn.textContent = "Pause";
  hideWarning(); clickAreasEl.replaceChildren();
  instructionEl.textContent = "Procedure complete!";
  instructionEl.classList.remove("hazard");
  const summary = `Total errors: ${errors}. Use Export log to save results.`;
  feedbackEl.textContent = summary;

  // Load the final state separately from interactive substeps.
  const request = ++imageRequest;
  const image = new Image();
  image.onload = () => {
    if (request !== imageRequest || isRunning) return;
    machineImg.src = image.src;
    overlayEl.setAttribute("viewBox", `0 0 ${image.naturalWidth} ${image.naturalHeight}`);
    feedbackEl.textContent = summary;
  };
  image.onerror = () => {
    if (request !== imageRequest || isRunning) return;
    feedbackEl.textContent = `${summary} Could not load final image: ${IMAGES_DIR + COMPLETION_IMAGE}`;
    console.error("Could not load final image:", IMAGES_DIR + COMPLETION_IMAGE);
  };
  image.src = IMAGES_DIR + COMPLETION_IMAGE;
}

startBtn.addEventListener("click", () => {
  if (!steps.length || hazardOpen) return;
  if (isRunning) closeSession("restarted");
  currentStep = 0; currentSubstep = 0; errors = 0;
  isRunning = true; isPaused = false; pauseBtn.textContent = "Pause";
  sessionStart = performance.now();
  session = { sessionId: `${Date.now()}-${sessions.length + 1}`, startedAt: new Date().toISOString(), status: "running", events: [] };
  sessions.push(session); exportBtn.disabled = false;
  resetSecondary();
  resetTaskList();
  logEvent("procedure_start", { secondaryConfig: SECONDARY_CONFIG }); showAction(0, 0);
});
// Revisited actions intentionally start with fresh click progress.
backBtn.addEventListener("click", () => {
  if (!isRunning || isPaused || hazardOpen || (currentStep === 0 && currentSubstep === 0)) return;
  logEvent("back");
  if (currentSubstep > 0) showAction(currentStep, currentSubstep - 1);
  else { const previous = currentStep - 1; showAction(previous, steps[previous].substeps.length - 1); }
});
pauseBtn.addEventListener("click", () => {
  if (!isRunning || hazardOpen) return;
  advanceSecondary();
  isPaused = !isPaused;
  pauseBtn.textContent = isPaused ? "Resume" : "Pause";
  logEvent(isPaused ? "pause" : "resume"); hideWarning();
  if (imageReady || isPaused) updateFeedback();
  else feedbackEl.textContent = "Image not ready. Wait for loading or check image errors.";
});
exportBtn.addEventListener("click", () => {
  if (!sessions.length) return;
  advanceSecondary();
  logEvent("log_export", { secondaryValue, secondaryActiveMs: Math.round(secondaryClock) });
  const payload = { schemaVersion: 2, prototypeVersion: "4-task-list", secondaryConfig: SECONDARY_CONFIG,
    exportedAt: new Date().toISOString(), procedure: { title: procedureTitle, steps },
    timing: "elapsedMs includes pauses/loading; secondary active time excludes Pause and frozen hazards; includes loading and background time; indices are zero-based", sessions };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = `procedure-log-${Date.now()}.json`;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
// No persistence is implied: export before refreshing or closing this tab.
window.addEventListener("beforeunload", event => {
  if (!sessions.length) return;
  event.preventDefault(); event.returnValue = "";
});
loadProcedure();

function fitScene() {
  const ratio = machineImg.naturalWidth / machineImg.naturalHeight || 1;
  const main = document.querySelector("main");
  const reserved = document.querySelector(".instruction-panel").offsetHeight + document.querySelector(".controls").offsetHeight + 96;
  const availableHeight = Math.max(160, window.innerHeight - reserved);
  main.style.setProperty("--scene-width", `${Math.min(700, availableHeight * ratio)}px`);
}
machineImg.addEventListener("load", fitScene);
window.addEventListener("resize", fitScene);
new ResizeObserver(fitScene).observe(document.querySelector(".instruction-panel"));
fitScene();
