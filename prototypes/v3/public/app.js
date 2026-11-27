// One Step at a Time v2: two conditions (Manual / Interactive guide) sharing
// one hardware simulation. All UI text and comments are intentionally in English.
let IMAGES_DIR = "images/";
let COMPLETION_IMAGE = "power_removed.jpg"; // Final photo inside images/; change this filename.
let DEFAULT_IMAGE = "full_case.jpg";

// Error pop-up texts. Manual keeps a generic message; the guide explains.
const MANUAL_ERROR_TEXT = "Wrong part. Try again.";
const GUIDE_MISS_TEXT = (a) => `Nothing to do there. Find the ${partName(a)} highlighted on the left.`;
const GUIDE_WRONG_TEXT = (clicked, a) => `This is the ${partName(clicked)}. For this step, use the ${partName(a)} highlighted on the left.`;

const $ = id => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";
const instructionEl = $("instruction"), feedbackEl = $("feedback");
const clickAreasEl = $("clickAreas"), machineImg = $("machine"), overlayEl = $("overlay");
const guideImg = $("guideImg"), guideOverlay = $("guideOverlay"), guideAreasEl = $("guideAreas");
const startBtn = $("startBtn"), backBtn = $("backBtn"), pauseBtn = $("pauseBtn");
const endBtn = $("endBtn"), menuBtn = $("menuBtn");
const exportBtn = $("exportBtn"), warningEl = $("errorWarning");
const tabButtons = [$("tabManual"), $("tabGuide")];

let mode = "manual"; // "manual" | "guide"; fixed for the duration of a run.
let steps = [], procedureTitle = "";
let currentStep = 0, currentSubstep = 0;
let isRunning = false, isPaused = false, imageReady = false;
let errors = 0, clickedZones = new Set();
let sessions = [], session = null, sessionStart = 0;
let warningTimer, imageRequest = 0;
let procedureId = "", procedureRequest = 0;
const procedureCatalog = {};

function partName(a) {
  return a.partName || (a.target ? a.target.replace(/-/g, " ") : "correct part");
}


const SECONDARY_CONFIG = Object.freeze({
  initialValue: 50, increasePerClick: 10, decreasePerSecond: 12,
  safeMin: 40, safeMax: 60, outsideLimitMs: 5000,
  freezeDuringHazard: true,
  meltdownAt: 0
});
const hazardDialog = $("hazardDialog"), doneBtn = $("hazardDone");
let meltdownActive = false;
const meltdownDialog = $("meltdownDialog");
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
function advanceSecondaryCore(now = performance.now()) {
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
function advanceSecondary(now = performance.now()) {
  advanceSecondaryCore(now);
  checkMeltdown();
}
function checkMeltdown() {
  if (meltdownActive || !isRunning || secondaryValue > SECONDARY_CONFIG.meltdownAt) return;
  meltdownActive = true;
  logEvent("secondary_meltdown", { value: secondaryValue, secondaryActiveMs: Math.round(secondaryClock), startContext: secondaryContext() });
  closeSession("meltdown");
  isRunning = false; isPaused = false; imageReady = false;
  ++imageRequest; pauseBtn.textContent = "Pause";
  if (hazardOpen) { hazardOpen = false; hazardDialog.close(); $("workspace").inert = false; }
  hideWarning(); clickedZones.clear(); clickAreasEl.replaceChildren(); guideAreasEl.replaceChildren();
  feedbackEl.textContent = "System meltdown. The run was stopped.";
  renderTabs(); renderSecondary();
  meltdownDialog.showModal();
  $("meltdownMenuBtn").focus();
}
$("meltdownMenuBtn").addEventListener("click", () => {
  meltdownDialog.close();
  meltdownActive = false;
  returnToMenu();
});
meltdownDialog.addEventListener("cancel", e => e.preventDefault());
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
  secondaryValue = SECONDARY_CONFIG.initialValue; secondaryClock = 0; outside = null; meltdownActive = false;
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
  advanceSecondary();
  if (!isRunning) return;
  hazardOpen = true; hazardShownAt = performance.now();
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


// ---------- Tabs ----------
// Switching is only allowed while no run is active, so one log session
// always belongs to exactly one condition.
function setMode(next) {
  if (isRunning || next === mode) return;
  mode = next;
  document.body.classList.toggle("mode-manual", mode === "manual");
  document.body.classList.toggle("mode-guide", mode === "guide");
  tabButtons.forEach(b => b.setAttribute("aria-selected", String(b.dataset.mode === mode)));
  resetLeftSide();
  renderTabs(); fitScenes();
}
function renderTabs() {
  endBtn.disabled = !isRunning;
  menuBtn.disabled = isRunning;
  backBtn.disabled = mode === "manual" || !isRunning || isPaused || (currentStep === 0 && currentSubstep === 0);
  tabButtons.forEach(b => { b.disabled = isRunning; });
  $("tabHint").textContent = isRunning ? "Tabs are locked during a run. Finish or use End run to switch." : "";
}
tabButtons.forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));

// Before Start: no instructions, no highlights, neutral photos.
function resetLeftSide() {
  document.body.classList.remove("guide-photo-visible");
  taskListStarted = false; completedSteps.clear(); renderTaskList();
  $("manualList").hidden = true; $("manualPlaceholder").hidden = false;
  guideAreasEl.replaceChildren();
  instructionEl.textContent = "Press Start to begin.";
  if (!isRunning) {
    setPhoto(guideImg, guideOverlay, IMAGES_DIR + DEFAULT_IMAGE);
    setPhoto(machineImg, overlayEl, IMAGES_DIR + DEFAULT_IMAGE);
    clickAreasEl.replaceChildren();
    if (steps.length) feedbackEl.textContent = `${procedureTitle} — ready to start.`;
  }
}

// ---------- Manual (static text, no progress state) ----------
function renderManual() {
  const list = $("manualList");
  list.replaceChildren();
  steps.forEach(step => {
    const item = document.createElement("li");
    const title = document.createElement("span");
    title.textContent = step.title || step.substeps[0].text;
    item.appendChild(title);
    if (step.substeps.length > 1) {
      // Sequential substeps are listed so the required order is stated in the text.
      const sub = document.createElement("ol");
      step.substeps.forEach(a => {
        const li = document.createElement("li");
        li.textContent = a.text;
        sub.appendChild(li);
      });
      item.appendChild(sub);
    }
    step.substeps.filter(a => a.hazard).forEach(a => {
      // Hazards are plain text here: no dialog in the Manual condition.
      const w = document.createElement("span");
      w.className = "manual-warning";
      w.textContent = `Warning: ${a.hazardText || a.text}`;
      item.appendChild(w);
    });
    list.appendChild(item);
  });
  $("manualPlaceholder").hidden = true;
  list.hidden = false;
  list.parentElement.scrollTop = 0;
}

// Checklist state describes the current attempt, not historical log events.
// It is only shown in the Interactive guide condition.
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
        if (a.partName !== undefined && (typeof a.partName !== "string" || !a.partName.trim())) throw new Error("partName must be non-empty text.");
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
  session.events.push({ event, mode, elapsedMs: Math.round(performance.now() - sessionStart),
    stepIndex: currentStep, stepId: steps[currentStep].id,
    substepIndex: currentSubstep, ...details });
}
function closeSession(status) {
  advanceSecondaryCore();
  if (!session || session.status !== "running") return;
  logEvent(({ completed: "procedure_complete", restarted: "procedure_restart", aborted: "procedure_abort", meltdown: "procedure_meltdown" })[status], { errors });
  session.status = status;
  session.endedAt = new Date().toISOString();
  session.durationMs = Math.round(performance.now() - sessionStart);
  session.errors = errors;
  session.errorsByKind = {
    wrongPart: session.events.filter(e => e.event === "wrong_click" && e.kind === "wrong_part").length,
    miss: session.events.filter(e => e.event === "wrong_click" && e.kind === "miss").length
  };
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

async function loadProcedure(url) {
  const request = ++procedureRequest;
  startBtn.disabled = true;
  $("menuStatus").textContent = "Loading procedure...";
  document.querySelectorAll("[data-procedure]").forEach(b => b.disabled = true);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load ${url} (${response.status}).`);
    const data = await response.json();
    if (request !== procedureRequest) return;
    const nextSteps = data.draft === true ? [] : normalizeSteps(data.steps);
    ++imageRequest;
    steps = nextSteps; procedureId = data.id || url;
    procedureTitle = data.title || "Procedure";
    IMAGES_DIR = data.imagesDir || "images/";
    if (!IMAGES_DIR.endsWith("/")) IMAGES_DIR += "/";
    DEFAULT_IMAGE = data.defaultImage || "full_case.jpg";
    COMPLETION_IMAGE = data.completionImage || DEFAULT_IMAGE;
    procedureCatalog[procedureId] = { ...data, source: url };
    currentStep = 0; currentSubstep = 0; errors = 0;
    isRunning = false; isPaused = false; imageReady = false;
    clickedZones.clear(); hideWarning(); resetLeftSide(); resetSecondary();
    $("manualList").replaceChildren();
    $("procedureHeading").textContent = procedureTitle;
    $("mainMenu").hidden = true; $("workspace").hidden = false;
    startBtn.disabled = !steps.length;
    if (!steps.length) {
      const message = data.draftMessage || "This procedure is not ready yet.";
      $("manualPlaceholder").textContent = message;
      $("guidePlaceholder").textContent = message;
      feedbackEl.textContent = message;
    } else {
      $("manualPlaceholder").textContent = "Press Start to show the instructions.";
      $("guidePlaceholder").textContent = "Press Start to show the instructions.";
      preloadImages();
    }
    renderTabs(); fitScenes();
    $("procedureHeading").focus();
    $("menuStatus").textContent = "";
  } catch (error) {
    if (request !== procedureRequest) return;
    console.error(error);
    $("menuStatus").textContent = error.message;
  } finally {
    if (request === procedureRequest) document.querySelectorAll("[data-procedure]").forEach(b => b.disabled = false);
  }
}
function returnToMenu() {
  if (isRunning || hazardOpen) return;
  ++imageRequest;
  hideWarning(); resetLeftSide();
  $("workspace").hidden = true; $("mainMenu").hidden = false;
  $("menuExportBtn").disabled = !sessions.length;
  $("menuHeading").focus();
}
menuBtn.addEventListener("click", returnToMenu);
document.querySelectorAll("[data-procedure]").forEach(button => {
  button.addEventListener("click", () => loadProcedure(button.dataset.procedure));
});
function preloadImages() {
  const urls = new Set(steps.flatMap(s => s.substeps.map(a => IMAGES_DIR + (a.image || DEFAULT_IMAGE))));
  urls.add(IMAGES_DIR + COMPLETION_IMAGE);
  urls.forEach(url => { const img = new Image(); img.src = url; });
}

// Puts the same loaded photo into a scene and matches the SVG coordinates.
function setPhoto(img, overlay, src, width, height) {
  img.src = src;
  if (width && height) overlay.setAttribute("viewBox", `0 0 ${width} ${height}`);
}

// ---------- Hardware side (right, clickable, never highlighted) ----------
// Order inside the SVG = stacking order:
// 1) a photo-sized miss area at the bottom, 2) areas of other steps,
// 3) areas of the current substep on top. Non-current currentOnly areas
// are not created at all.
function createClickAreas(width, height) {
  clickAreasEl.replaceChildren();
  const miss = document.createElementNS(SVG_NS, "rect");
  miss.setAttribute("x", 0); miss.setAttribute("y", 0);
  miss.setAttribute("width", width); miss.setAttribute("height", height);
  miss.setAttribute("class", "miss-area");
  miss.addEventListener("click", handleMissClick);
  clickAreasEl.appendChild(miss);

  const activeAreas = [];
  steps.forEach((step, si) => step.substeps.forEach((a, ui) => {
    const active = si === currentStep && ui === currentSubstep;
    if (a.currentOnly && !active) return;
    a.polygons.forEach((points, zi) => {
      const area = document.createElementNS(SVG_NS, "polygon");
      area.setAttribute("points", points);
      area.setAttribute("class", "click-area");
      area.dataset.step = si; area.dataset.substep = ui; area.dataset.zone = zi;
      area.addEventListener("click", () => handleAreaClick(si, ui, zi));
      if (active) activeAreas.push(area); else clickAreasEl.appendChild(area);
    });
  }));
  activeAreas.forEach(a => clickAreasEl.appendChild(a));
}

// ---------- Guide side (left, highlighted, never clickable) ----------
function createGuideAreas() {
  guideAreasEl.replaceChildren();
  currentAction().polygons.forEach((points, zi) => {
    const area = document.createElementNS(SVG_NS, "polygon");
    area.setAttribute("points", points);
    area.setAttribute("class", "guide-area");
    area.dataset.zone = zi;
    guideAreasEl.appendChild(area);
  });
  refreshGuideStyles();
}
function refreshGuideStyles() {
  Array.from(guideAreasEl.children).forEach(area => {
    const done = clickedZones.has(Number(area.dataset.zone));
    area.classList.toggle("target", !done);
    area.classList.toggle("done", done);
  });
}

// The Manual condition does not reveal the current position.
function updateFeedback() {
  if (isPaused) { feedbackEl.textContent = "Paused."; return; }
  if (mode === "manual") { feedbackEl.textContent = `Errors: ${errors}`; return; }
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
  if (!isRunning) return;
  currentStep = si; currentSubstep = ui;
  invalidateTaskListFrom(si);
  renderTaskList(); renderTabs();
  clickedZones = new Set(); imageReady = false;
  hideWarning(); clickAreasEl.replaceChildren(); guideAreasEl.replaceChildren();
  const request = ++imageRequest, a = currentAction();
  instructionEl.textContent = a.text;
  feedbackEl.textContent = isPaused ? "Paused." : "Loading image...";
  logEvent("substep_enter", { image: a.image || DEFAULT_IMAGE });
  const image = new Image();
  image.onload = () => {
    if (request !== imageRequest || !isRunning) return;
    const w = image.naturalWidth, h = image.naturalHeight;
    setPhoto(machineImg, overlayEl, image.src, w, h);
    setPhoto(guideImg, guideOverlay, image.src, w, h);
    imageReady = true;
    createClickAreas(w, h);
    if (mode === "guide") { createGuideAreas(); document.body.classList.add("guide-photo-visible"); }
    updateFeedback(); fitScenes();
    logEvent("substep_ready", { image: a.image || DEFAULT_IMAGE });
    if (a.hazard && mode === "guide") showHazard(a);
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
function canClick() { return isRunning && !isPaused && !hazardOpen && imageReady; }
function registerError(kind, details, guideMessage) {
  errors += 1;
  logEvent("wrong_click", { kind, ...details, errors });
  updateFeedback();
  showWarning(mode === "guide" ? guideMessage : MANUAL_ERROR_TEXT);
}
// Click on the photo outside every part area.
function handleMissClick(event) {
  if (!canClick()) return;
  const p = overlayEl.createSVGPoint(); p.x = event.clientX; p.y = event.clientY;
  const ctm = overlayEl.getScreenCTM();
  const pt = ctm ? p.matrixTransform(ctm.inverse()) : { x: null, y: null };
  registerError("miss", { x: pt.x === null ? null : Math.round(pt.x), y: pt.y === null ? null : Math.round(pt.y) },
    GUIDE_MISS_TEXT(currentAction()));
}
function handleAreaClick(si, ui, zi) {
  if (!canClick()) return;
  const details = { clickedStepIndex: si, clickedSubstepIndex: ui, zoneIndex: zi };
  if (si !== currentStep || ui !== currentSubstep) {
    const clicked = steps[si].substeps[ui];
    registerError("wrong_part", { ...details, clickedTarget: clicked.target || null },
      GUIDE_WRONG_TEXT(clicked, currentAction()));
    return;
  }
  if (clickedZones.has(zi)) { logEvent("repeat_click", details); return; }
  clickedZones.add(zi); logEvent("correct_click", details);
  refreshGuideStyles(); updateFeedback();
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
  renderTaskList(); renderTabs();
  pauseBtn.textContent = "Pause";
  hideWarning(); clickAreasEl.replaceChildren(); guideAreasEl.replaceChildren();
  instructionEl.textContent = "Procedure complete!";
  const summary = `Procedure complete! Total errors: ${errors}. Use Export log to save results.`;
  feedbackEl.textContent = summary;

  // Load the final state separately from interactive substeps.
  const request = ++imageRequest;
  const image = new Image();
  image.onload = () => {
    if (request !== imageRequest || isRunning) return;
    setPhoto(machineImg, overlayEl, image.src, image.naturalWidth, image.naturalHeight);
    setPhoto(guideImg, guideOverlay, image.src, image.naturalWidth, image.naturalHeight);
    fitScenes();
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
  document.body.classList.remove("guide-photo-visible");
  currentStep = 0; currentSubstep = 0; errors = 0;
  isRunning = true; isPaused = false; pauseBtn.textContent = "Pause";
  renderTabs();
  sessionStart = performance.now();
  session = { procedureId, sessionId: `${Date.now()}-${sessions.length + 1}`, mode, startedAt: new Date().toISOString(), status: "running", events: [] };
  sessions.push(session); exportBtn.disabled = false;
  resetSecondary();
  if (mode === "guide") resetTaskList();
  else renderManual();
  logEvent("procedure_start", { secondaryConfig: SECONDARY_CONFIG }); showAction(0, 0);
});
// Revisited actions intentionally start with fresh click progress.
backBtn.addEventListener("click", () => {
  if (mode === "manual" || !isRunning || isPaused || hazardOpen || (currentStep === 0 && currentSubstep === 0)) return;
  logEvent("back");
  if (currentSubstep > 0) showAction(currentStep, currentSubstep - 1);
  else { const previous = currentStep - 1; showAction(previous, steps[previous].substeps.length - 1); }
});
pauseBtn.addEventListener("click", () => {
  if (!isRunning || hazardOpen) return;
  advanceSecondary();
  if (!isRunning) return;
  isPaused = !isPaused;
  pauseBtn.textContent = isPaused ? "Resume" : "Pause";
  logEvent(isPaused ? "pause" : "resume"); hideWarning(); renderTabs();
  if (imageReady || isPaused) updateFeedback();
  else feedbackEl.textContent = "Image not ready. Wait for loading or check image errors.";
});
endBtn.addEventListener("click", () => {
  if (!isRunning || hazardOpen) return;
  advanceSecondary();
  if (!isRunning) return;
  const wasPaused = isPaused; isPaused = true;
  const openedAt = performance.now();
  logEvent("end_confirmation_open");
  const confirmed = window.confirm("End this run? You cannot resume it. The log will remain available for export.");
  lastTick = performance.now(); isPaused = wasPaused;
  logEvent("end_confirmation_close", { confirmed, durationMs: Math.round(lastTick - openedAt) });
  if (!confirmed) return;
  closeSession("aborted");
  isRunning = false; isPaused = false; imageReady = false;
  ++imageRequest; pauseBtn.textContent = "Pause";
  hideWarning(); clickedZones.clear(); resetLeftSide();
  renderTabs(); renderSecondary(); fitScenes();
  feedbackEl.textContent = "Run ended. Export the log, return to the menu, or start a new run.";
});

function exportLogs() {
  if (!sessions.length) return;
  advanceSecondary();
  logEvent("log_export", { secondaryValue, secondaryActiveMs: Math.round(secondaryClock) });
  const payload = { schemaVersion: 4, prototypeVersion: "9-meltdown", secondaryConfig: SECONDARY_CONFIG,
    exportedAt: new Date().toISOString(), procedures: procedureCatalog,
    timing: "elapsedMs includes pauses/loading; secondary active time excludes Pause and frozen hazards; includes loading and background time; indices are zero-based",
    errorKinds: "wrong_part = click on another part's area; miss = click on the photo outside every part area",
    sessions };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = `procedure-log-${Date.now()}.json`;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
exportBtn.addEventListener("click", exportLogs);
$("menuExportBtn").addEventListener("click", exportLogs);
// No persistence is implied: export before refreshing or closing this tab.
window.addEventListener("beforeunload", event => {
  if (!sessions.length) return;
  event.preventDefault(); event.returnValue = "";
});

// Measure both conditions before paint, including the reserved guide layout.
function fitScenes() {
  if ($("workspace").hidden) return;
  const body = document.body, panel = $("taskListPanel"), wasHidden = panel.hidden;
  const boxes = [];
  const measure = id => {
    const b = $(id);
    if (b.clientWidth > 4 && b.clientHeight > 4) boxes.push([b.clientWidth, b.clientHeight]);
  };
  try {
    body.classList.remove("mode-manual"); body.classList.add("mode-guide"); panel.hidden = false;
    measure("guideBox"); measure("hardwareBox");
    body.classList.remove("mode-guide"); body.classList.add("mode-manual"); measure("hardwareBox");
  } finally {
    panel.hidden = wasHidden;
    body.classList.toggle("mode-manual", mode === "manual");
    body.classList.toggle("mode-guide", mode === "guide");
  }
  if (!boxes.length) return;
  const v = overlayEl.viewBox.baseVal;
  const ratio = v.width && v.height ? v.width / v.height : 2016 / 2112;
  const w = Math.floor(Math.min(...boxes.map(([bw,bh]) => Math.min(bw - 4, (bh - 4) * ratio))));
  const h = Math.floor(w / ratio);
  if (w < 1 || h < 1) return;
  [$("hardwareScene"), $("guideScene")].forEach(scene => {
    if (scene.style.width !== `${w + 4}px`) scene.style.width = `${w + 4}px`;
    if (scene.style.height !== `${h + 4}px`) scene.style.height = `${h + 4}px`;
  });
}
machineImg.addEventListener("load", fitScenes);
guideImg.addEventListener("load", fitScenes);
window.addEventListener("resize", fitScenes);
const sceneObserver = new ResizeObserver(fitScenes);
sceneObserver.observe($("hardwareBox")); sceneObserver.observe($("guideBox"));

renderTabs();
