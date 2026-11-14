// ---------------------------------------------------------------------------
// One Step at a Time — prototype 1
// Basic guided-maintenance logic: load a procedure from raw.json, highlight
// the target part(s), and advance one step at a time when the user clicks
// the correct zone(s) on the machine photo.
//
// IMAGE CONFIGURATION (how to choose which photo belongs to which step)
// ---------------------------------------------------------------------
// The prototype can use up to 7 photos of the machine, all placed in the
// images/ folder. Each step in raw.json picks its own photo via the
// optional "image" field:
//
//   { "text": "Open the case", "polygon": "...", "image": "pc2.jpg" }
//
// - "image" is a file name inside the images/ folder (e.g. "pc3.jpg").
// - If a step has NO "image" field, DEFAULT_IMAGE (below) is shown.
// - To change the fallback photo for all steps at once, edit DEFAULT_IMAGE.
// - IMPORTANT: polygon coordinates are interpreted in the pixel space of
//   THAT step's photo, so draw every step's clickable zones against its
//   own picture.
//
// MULTI-ZONE STEPS (several clicks within one step)
// ---------------------------------------------------
// A step can require clicking MORE THAN ONE part — for example both RAM
// clips, or all four screws that hold the motherboard. Use the "polygons"
// array in raw.json:
//
//   { "text": "Unscrew all four screws",
//     "polygons": ["12,40 60,40 60,88 12,88", "120,40 168,40 168,88 120,88",
//                  "12,300 60,300 60,348 12,348", "120,300 168,300 168,348 120,348"] }
//
// - The zones of one step can be clicked in ANY order.
// - The step is complete only when EVERY zone of the step has been
//   clicked; only then does the procedure move on to the next step.
// - Single-zone steps may keep the simple "polygon" field — it is treated
//   as a one-element "polygons" array, so old raw.json files keep working.
// ---------------------------------------------------------------------------

// --- Configuration ----------------------------------------------------------
const IMAGES_DIR = "images/";    // folder with the machine photos
const DEFAULT_IMAGE = "full_case.jpg"; // shown when a step has no "image" field

// --- DOM references ---------------------------------------------------------
const instructionEl = document.getElementById("instruction"); // current step text / hazard warning
const feedbackEl = document.getElementById("feedback");       // status line (step counter, errors, pause)
const clickAreasEl = document.getElementById("clickAreas");   // SVG group holding all clickable zones

const startBtn = document.getElementById("startBtn");
const backBtn = document.getElementById("backBtn");
const pauseBtn = document.getElementById("pauseBtn");

// --- Application state ------------------------------------------------------
let steps = [];        // procedure steps loaded from raw.json
let currentStep = 0;   // index of the step the user should perform right now
let isRunning = false; // true between Start and completion
let isPaused = false;
let errors = 0;        // wrong-part / out-of-order click counter
let clickedZones = new Set(); // indexes of the current step's zones already clicked

// Load the procedure data. All messages refer to raw.json, the single
// source of truth for this prototype.
async function loadProcedure() {
  try {
    const response = await fetch("raw.json");

    if (!response.ok) {
      throw new Error(`Could not load raw.json (${response.status})`);
    }

    const procedure = await response.json();
    const rawSteps = procedure.steps;

    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
      throw new Error("raw.json must contain a non-empty steps array.");
    }

    // Normalise the data: every step ends up with a "polygons" ARRAY,
    // no matter which format it was written in. "polygon" (a single
    // string) is shorthand for a one-element "polygons" array.
    steps = rawSteps.map((step, index) => {
      const polygons = step.polygons || (step.polygon ? [step.polygon] : null);
      if (!polygons) {
        throw new Error(`Step ${index + 1} has no "polygon" or "polygons" field.`);
      }
      return { ...step, polygons };
    });

    createClickAreas();
    preloadImages();
    feedbackEl.textContent = `${procedure.title} — ready to start.`;
  } catch (error) {
    console.error(error);
    instructionEl.textContent = "Could not load the procedure.";
    feedbackEl.textContent = "Check that raw.json is valid and contains a steps array.";
    startBtn.disabled = true;
  }
}

// Build one clickable SVG polygon per zone of every step, positioned over
// the part that the step targets. Polygons are expressed in image pixel
// coordinates. Each area remembers its step and zone number via data-*
// attributes, so the click handler knows exactly what was clicked.
function createClickAreas() {
  clickAreasEl.innerHTML = "";

  steps.forEach((step, stepIndex) => {
    step.polygons.forEach((points, zoneIndex) => {
      const area = document.createElementNS("http://www.w3.org/2000/svg", "polygon");

      area.setAttribute("points", points);
      area.setAttribute("class", "click-area");
      area.dataset.step = stepIndex; // which step this zone belongs to
      area.dataset.zone = zoneIndex; // zone number within that step
      area.setAttribute(
        "aria-label",
        step.target
          ? `${step.target} (zone ${zoneIndex + 1})`
          : `Step ${stepIndex + 1}, zone ${zoneIndex + 1}`
      );

      area.addEventListener("click", () => handleAreaClick(stepIndex, zoneIndex));
      clickAreasEl.appendChild(area);
    });
  });
}

// Download every photo used by the procedure in the background, so that
// switching to a step with a new picture never shows a blank/loading
// frame in the middle of the task.
function preloadImages() {
  const urls = new Set(
    steps.map((step) => IMAGES_DIR + (step.image || DEFAULT_IMAGE))
  );

  urls.forEach((url) => {
    const img = new Image(); // offscreen image; assigning src starts the download
    img.src = url;
  });
}

// Restyle all zones according to the current state:
// - zones of the current step that still need a click  -> class "target" (red)
// - zones of the current step that were already clicked -> class "done" (green)
// - zones of all other steps                            -> no class (invisible)
function refreshAreaStyles() {
  Array.from(clickAreasEl.children).forEach((area) => {
    const isCurrentStep = Number(area.dataset.step) === currentStep;
    const isClicked = clickedZones.has(Number(area.dataset.zone));

    area.classList.toggle("target", isCurrentStep && !isClicked);
    area.classList.toggle("done", isCurrentStep && isClicked);
  });
}

// Single place that renders the status line under the instruction, so the
// format is defined once and used everywhere. For multi-zone steps it also
// shows the click progress, e.g. "Clicked 2/4".
function updateFeedback() {
  const step = steps[currentStep];
  const progress =
    step && step.polygons.length > 1
      ? ` · Clicked ${clickedZones.size}/${step.polygons.length}`
      : "";

  feedbackEl.textContent =
    `Step ${currentStep + 1} of ${steps.length}${progress} · Errors: ${errors}`;
}

// Central pause handling: keeps isPaused and the button label in sync, so
// the reset logic lives in exactly one place. Feedback is only rewritten
// while the procedure is running (not during finish/reset).
function setPaused(paused) {
  isPaused = paused;
  pauseBtn.textContent = isPaused ? "Resume" : "Pause";

  if (isRunning) {
    if (isPaused) {
      feedbackEl.textContent = "Paused.";
    } else {
      updateFeedback();
    }
  }
}

// Render the given step: swap the machine photo if the step uses another
// one, show only the next instruction and highlight the step's zones.
function showStep(index) {
  const step = steps[index];
  if (!step) return;

  currentStep = index;

  // Multi-zone progress starts from scratch every time a step is shown
  // (including when the user goes Back and returns — the clicks are done
  // again). A Set holds the indexes of the zones already clicked.
  clickedZones = new Set();




  // Move the current step's zones to the top. In SVG, the order of elements
  // within a group determines their layering: elements that appear later in the
  // markup are positioned higher and receive click events first.
  // appendChild does not copy an element; instead, it MOVES it to the end of the group,
  // ensuring that the current step's zones are placed above all others.
  Array.from(clickAreasEl.children).filter((area) => Number(area.dataset.step) === currentStep).forEach((area) => clickAreasEl.appendChild(area)); 



  // Each step can show its own photo of the machine. Changing src makes
  // the browser load that file; the "load" listener on the image (see the
  // bottom of this file) then re-syncs the overlay viewBox to the new
  // photo's dimensions, so the clickable zones stay aligned.
  machineImg.src = IMAGES_DIR + (step.image || DEFAULT_IMAGE);

  // Hazard steps get a prominent prefix and the .hazard style.
  instructionEl.textContent = step.hazard
    ? `⚠ HAZARD: ${step.text}`
    : step.text;
  instructionEl.classList.toggle("hazard", step.hazard);


  

  updateFeedback();
  refreshAreaStyles();
}

// Called when the user clicks a zone on the machine photo. A step is
// complete when EVERY zone of the current step has been clicked.
function handleAreaClick(stepIndex, zoneIndex) {
  // Ignore clicks when not running or paused — the user controls the pace.
  if (!isRunning || isPaused) return;

  // A click on a zone that belongs to a different step is a wrong-part
  // click: count an error, do not change anything.
  if (stepIndex !== currentStep) {
    errors += 1;
    feedbackEl.textContent = `Wrong part. Try again. Errors: ${errors}`;
    return;
  }

  const step = steps[currentStep];

  // Clicking a zone that was already clicked in this step is simply
  // ignored — it is not an error, the zone is already done.
  if (clickedZones.has(zoneIndex)) return;

  clickedZones.add(zoneIndex);
  refreshAreaStyles();
  updateFeedback();

  // All zones of the step are clicked -> the step is complete.
  if (clickedZones.size === step.polygons.length) {
    if (currentStep === steps.length - 1) {
      finishProcedure(); // that was the last step
    } else {
      showStep(currentStep + 1);
    }
  }
}

// End of the procedure: stop, clear the highlights and show the result.
function finishProcedure() {
  isRunning = false;
  setPaused(false); // resets pause state and the button label

  // Remove the target/done highlighting from all zones.
  Array.from(clickAreasEl.children).forEach((area) => {
    area.classList.remove("target", "done");
  });

  instructionEl.textContent = "Procedure complete!";
  instructionEl.classList.remove("hazard");
  feedbackEl.textContent = `Total errors: ${errors}`;
}

// Start (or restart): resets the state and shows the first step.
startBtn.addEventListener("click", () => {
  if (steps.length === 0) return;

  currentStep = 0;
  errors = 0;
  isRunning = true;
  setPaused(false);

  showStep(currentStep);
});

// Back: re-show the previous step (including its photo and a fresh set
// of clicks for it). Blocked while paused, exactly like area clicks, so
// the state checks stay consistent.
backBtn.addEventListener("click", () => {
  if (!isRunning || isPaused || currentStep === 0) return;

  showStep(currentStep - 1);
});

// Pause / Resume: available at any time while the procedure is running.
pauseBtn.addEventListener("click", () => {
  if (!isRunning) return;

  setPaused(!isPaused);
});

// Keep the SVG overlay aligned with the photo: use the image's real pixel
// size as the viewBox, so the polygons always match the picture even if
// the image file is later replaced with a different resolution. This runs
// again automatically every time a step swaps in a different photo.
const machineImg = document.getElementById("machine");
const overlayEl = document.getElementById("overlay");

function syncOverlayToImage() {
  overlayEl.setAttribute(
    "viewBox",
    `0 0 ${machineImg.naturalWidth} ${machineImg.naturalHeight}`
  );
}

// The initial photo comes from the JS configuration (single source of
// truth, together with DEFAULT_IMAGE above).
machineImg.src = IMAGES_DIR + DEFAULT_IMAGE;

// The image may already be loaded (cached) before this script runs, and
// the "load" event also fires after every later src swap.
if (machineImg.complete) {
  syncOverlayToImage();
} else {
  machineImg.addEventListener("load", syncOverlayToImage);
}

loadProcedure();
