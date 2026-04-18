const RAW_ASSETS = normalizeRawAssets(Array.isArray(window.__FRONTIER_DATA__) ? window.__FRONTIER_DATA__ : []);
const META = window.__FRONTIER_META__ && typeof window.__FRONTIER_META__ === "object"
  ? window.__FRONTIER_META__
  : { rawUniverseCount: 0, enrichedCount: 0, frontierReadyCount: 0, generatedAt: "" };

const DATA_WINDOW_YEARS = 15;
const LONG_CALCULATION_MS = 500;
const STORAGE_KEY = "ef-frontier-controls-v4";
const THEME_KEY = "ef-frontier-theme";
const DEFAULT_STATE = {
  symbols: "QQQ, TLT, GLD, EUO, SMH, MLPX, SCHD, GRID, XAR, DXJ",
  horizonYears: 10,
  riskFreeRatePercent: 3,
  minAumBillions: 0.5,
  maxAssets: 35,
  maxWeightPercent: 35,
  minWeightRoundingPercent: 5,
  frontierPoints: 24,
  selectedFrontierIndex: 0,
};

const elements = {
  themeToggle: document.getElementById("themeToggle"),
  updateExpectedReturnsButton: document.getElementById("updateExpectedReturnsButton"),
  recalculateButton: document.getElementById("recalculateButton"),
  resetButton: document.getElementById("resetButton"),
  copyWeightsButton: document.getElementById("copyWeightsButton"),
  symbolsInput: document.getElementById("symbolsInput"),
  validTickersCsv: document.getElementById("validTickersCsv"),
  horizonSelect: document.getElementById("horizonSelect"),
  riskFreeInput: document.getElementById("riskFreeInput"),
  minAumInput: document.getElementById("minAumInput"),
  maxAssetsInput: document.getElementById("maxAssetsInput"),
  maxWeightInput: document.getElementById("maxWeightInput"),
  minWeightRoundingInput: document.getElementById("minWeightRoundingInput"),
  frontierPointsInput: document.getElementById("frontierPointsInput"),
  portfolioIndexRange: document.getElementById("portfolioIndexRange"),
  portfolioIndexValue: document.getElementById("portfolioIndexValue"),
  summaryUniverseCount: document.getElementById("summaryUniverseCount"),
  summaryReadyCount: document.getElementById("summaryReadyCount"),
  summaryCandidateCount: document.getElementById("summaryCandidateCount"),
  summaryAlignedCount: document.getElementById("summaryAlignedCount"),
  summaryMonths: document.getElementById("summaryMonths"),
  summaryPills: document.getElementById("summaryPills"),
  chartPills: document.getElementById("chartPills"),
  expectedReturnPanel: document.getElementById("expectedReturnPanel"),
  expectedReturnPills: document.getElementById("expectedReturnPills"),
  expectedReturnTableBody: document.getElementById("expectedReturnTableBody"),
  chartStage: document.getElementById("chartStage"),
  portfolioCards: document.getElementById("portfolioCards"),
  weightPills: document.getElementById("weightPills"),
  weightsTableBody: document.getElementById("weightsTableBody"),
  weightPairsBox: document.getElementById("weightPairsBox"),
  messagePanel: document.getElementById("messagePanel"),
};

let latestAnalysis = null;
let expectedReturnOverrides = {};
let autoRecalculateTimer = null;
let recalculateRequestToken = 0;
let calculationNoticeElement = null;

initialize();

function initialize() {
  elements.summaryUniverseCount.textContent = formatInteger(META.rawUniverseCount);
  elements.summaryReadyCount.textContent = formatInteger(META.frontierReadyCount);
  if (elements.validTickersCsv) {
    elements.validTickersCsv.textContent = RAW_ASSETS.map((asset) => asset.symbol).join(", ");
  }
  applyTheme(loadTheme());
  hydrateControls();
  bindEvents();
  recalculate(false);
}

function bindEvents() {
  elements.themeToggle.addEventListener("click", () => {
    const nextTheme = document.body.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
    safeSetLocalStorage(THEME_KEY, nextTheme);
  });

  elements.updateExpectedReturnsButton.addEventListener("click", () => {
    if (!latestAnalysis) {
      return;
    }

    elements.expectedReturnPanel.hidden = false;
    renderExpectedReturnEditor(latestAnalysis);
  });

  elements.recalculateButton.addEventListener("click", () => {
    recalculate(true);
  });

  elements.resetButton.addEventListener("click", () => {
    clearScheduledRecalculate();
    expectedReturnOverrides = {};
    writeControls(DEFAULT_STATE);
    persistControls(DEFAULT_STATE);
    recalculate(false);
  });

  elements.copyWeightsButton.addEventListener("click", async () => {
    await copySelectedWeights();
  });

  elements.portfolioIndexRange.addEventListener("input", () => {
    if (!latestAnalysis || latestAnalysis.frontier.length === 0) {
      return;
    }

    const state = readControls();
    state.selectedFrontierIndex = clampInteger(Number(elements.portfolioIndexRange.value), 0, latestAnalysis.frontier.length - 1, 0);
    persistControls(state);
    renderAnalysis(latestAnalysis, state);
  });

  [
    elements.horizonSelect,
    elements.riskFreeInput,
    elements.minAumInput,
    elements.maxAssetsInput,
    elements.maxWeightInput,
    elements.minWeightRoundingInput,
    elements.frontierPointsInput,
  ].forEach((element) => {
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        recalculate(true);
      }
    });
  });

  elements.symbolsInput.addEventListener("input", () => {
    scheduleAutoRecalculate();
  });

  elements.symbolsInput.addEventListener("change", () => {
    clearScheduledRecalculate();
    recalculate(true);
  });
}

function scheduleAutoRecalculate() {
  clearScheduledRecalculate();
  autoRecalculateTimer = window.setTimeout(() => {
    autoRecalculateTimer = null;
    recalculate(true);
  }, 450);
}

function clearScheduledRecalculate() {
  if (autoRecalculateTimer !== null) {
    window.clearTimeout(autoRecalculateTimer);
    autoRecalculateTimer = null;
  }
}

function normalizeRawAssets(rawAssets) {
  return Array.isArray(rawAssets)
    ? rawAssets.map((asset) => ({
      ...asset,
      symbol: String(asset?.symbol || "").toUpperCase(),
      monthlyReturns: normalizeMonthlyReturns(asset?.monthlyReturns),
    }))
    : [];
}

function normalizeMonthlyReturns(rawMonthlyReturns) {
  if (!Array.isArray(rawMonthlyReturns)) {
    return [];
  }

  return rawMonthlyReturns.map((entry) => {
    if (Array.isArray(entry) && entry.length === 2) {
      const period = typeof entry[0] === "string" ? entry[0] : null;
      const value = typeof entry[1] === "number" && Number.isFinite(entry[1]) ? entry[1] : null;
      return period !== null && value !== null ? { period, value } : null;
    }

    if (entry && typeof entry === "object") {
      const period = typeof entry.period === "string" ? entry.period : null;
      const value = typeof entry.value === "number" && Number.isFinite(entry.value) ? entry.value : null;
      return period !== null && value !== null ? { period, value } : null;
    }

    return null;
  }).filter((entry) => entry !== null);
}

function loadTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || "light";
  } catch {
    return "light";
  }
}

function applyTheme(theme) {
  document.body.dataset.theme = theme === "dark" ? "dark" : "light";
  const isDark = document.body.dataset.theme === "dark";
  elements.themeToggle.setAttribute("aria-pressed", isDark ? "true" : "false");
  elements.themeToggle.textContent = isDark ? "Light mode" : "Dark mode";
}

function hydrateControls() {
  let state = { ...DEFAULT_STATE };
  expectedReturnOverrides = {};

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        state = {
          ...state,
          horizonYears: toAllowedHorizon(parsed.horizonYears, state.horizonYears),
          riskFreeRatePercent: normalizeNumber(parsed.riskFreeRatePercent, state.riskFreeRatePercent),
          minAumBillions: normalizeNumber(parsed.minAumBillions, state.minAumBillions),
          maxAssets: clampInteger(parsed.maxAssets, 2, 120, state.maxAssets),
          maxWeightPercent: clampNumber(parsed.maxWeightPercent, 1, 100, state.maxWeightPercent),
          minWeightRoundingPercent: clampNumber(parsed.minWeightRoundingPercent, 0, 25, state.minWeightRoundingPercent),
          frontierPoints: clampInteger(parsed.frontierPoints, 8, 60, state.frontierPoints),
          selectedFrontierIndex: clampInteger(parsed.selectedFrontierIndex, 0, 200, state.selectedFrontierIndex),
        };
      }
    }
  } catch {
    state = { ...DEFAULT_STATE };
    expectedReturnOverrides = {};
  }

  writeControls(state);
}

function writeControls(state) {
  elements.symbolsInput.value = state.symbols;
  elements.horizonSelect.value = String(state.horizonYears);
  elements.riskFreeInput.value = String(state.riskFreeRatePercent);
  elements.minAumInput.value = String(state.minAumBillions);
  elements.maxAssetsInput.value = String(state.maxAssets);
  elements.maxWeightInput.value = String(state.maxWeightPercent);
  elements.minWeightRoundingInput.value = String(state.minWeightRoundingPercent);
  elements.frontierPointsInput.value = String(state.frontierPoints);
  elements.portfolioIndexRange.value = String(state.selectedFrontierIndex);
}

function readControls() {
  syncExpectedReturnOverridesFromSymbols(elements.symbolsInput.value);
  return {
    symbols: elements.symbolsInput.value,
    horizonYears: toAllowedHorizon(Number(elements.horizonSelect.value), DEFAULT_STATE.horizonYears),
    riskFreeRatePercent: clampNumber(Number(elements.riskFreeInput.value), 0, 20, DEFAULT_STATE.riskFreeRatePercent),
    minAumBillions: clampNumber(Number(elements.minAumInput.value), 0.5, 1000, DEFAULT_STATE.minAumBillions),
    maxAssets: clampInteger(Number(elements.maxAssetsInput.value), 2, 120, DEFAULT_STATE.maxAssets),
    maxWeightPercent: clampNumber(Number(elements.maxWeightInput.value), 1, 100, DEFAULT_STATE.maxWeightPercent),
    minWeightRoundingPercent: clampNumber(Number(elements.minWeightRoundingInput.value), 0, 25, DEFAULT_STATE.minWeightRoundingPercent),
    frontierPoints: clampInteger(Number(elements.frontierPointsInput.value), 8, 60, DEFAULT_STATE.frontierPoints),
    selectedFrontierIndex: clampInteger(Number(elements.portfolioIndexRange.value), 0, 200, DEFAULT_STATE.selectedFrontierIndex),
    expectedReturnOverrides: { ...expectedReturnOverrides },
  };
}

function persistControls(state) {
  const persistedState = {
    horizonYears: state.horizonYears,
    riskFreeRatePercent: state.riskFreeRatePercent,
    minAumBillions: state.minAumBillions,
    maxAssets: state.maxAssets,
    maxWeightPercent: state.maxWeightPercent,
    minWeightRoundingPercent: state.minWeightRoundingPercent,
    frontierPoints: state.frontierPoints,
    selectedFrontierIndex: state.selectedFrontierIndex,
  };
  safeSetLocalStorage(STORAGE_KEY, JSON.stringify(persistedState));
}

function syncExpectedReturnOverridesFromSymbols(rawSymbols) {
  const entries = parseTickerEntries(rawSymbols);
  const nextOverrides = {};

  for (const entry of entries) {
    if (entry && entry.symbol && Number.isFinite(entry.expectedReturnPercent)) {
      nextOverrides[entry.symbol] = entry.expectedReturnPercent;
    }
  }

  expectedReturnOverrides = nextOverrides;
}

function safeSetLocalStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore local storage failures.
  }
}

function ensureCalculationNotice() {
  if (calculationNoticeElement) {
    return calculationNoticeElement;
  }

  calculationNoticeElement = document.createElement("div");
  calculationNoticeElement.className = "calc-busy-notice";
  calculationNoticeElement.setAttribute("role", "status");
  calculationNoticeElement.setAttribute("aria-live", "polite");
  calculationNoticeElement.setAttribute("aria-hidden", "true");
  calculationNoticeElement.innerHTML = "<strong>Calculating...</strong>";
  document.body.append(calculationNoticeElement);
  return calculationNoticeElement;
}

function setCalculationBusy(isBusy) {
  const notice = ensureCalculationNotice();
  document.body.classList.toggle("is-calculating", isBusy);
  document.body.setAttribute("aria-busy", isBusy ? "true" : "false");
  notice.setAttribute("aria-hidden", isBusy ? "false" : "true");
}

function waitForNextPaint() {
  return new Promise((resolve) => {
    if (typeof window.requestAnimationFrame !== "function") {
      window.setTimeout(resolve, 0);
      return;
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(resolve);
    });
  });
}

async function recalculate(keepSelection) {
  const requestToken = ++recalculateRequestToken;
  const state = readControls();
  persistControls(state);

  setCalculationBusy(true);
  await waitForNextPaint();
  if (requestToken !== recalculateRequestToken) {
    return;
  }

  try {
    latestAnalysis = buildAnalysis(state);

    if (!keepSelection) {
      state.selectedFrontierIndex = latestAnalysis.maxSharpeIndex >= 0 ? latestAnalysis.maxSharpeIndex : 0;
    }

    if (latestAnalysis.frontier.length > 0) {
      state.selectedFrontierIndex = clampInteger(state.selectedFrontierIndex, 0, latestAnalysis.frontier.length - 1, 0);
    } else {
      state.selectedFrontierIndex = 0;
    }

    elements.portfolioIndexRange.max = String(Math.max(0, latestAnalysis.frontier.length - 1));
    elements.portfolioIndexRange.value = String(state.selectedFrontierIndex);
    persistControls(state);
    renderAnalysis(latestAnalysis, state);
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error || "Unknown calculation error.");
    elements.messagePanel.innerHTML = `<div class="message error">${escapeHtml(`Calculation failed: ${message}`)}</div>`;
  } finally {
    if (requestToken === recalculateRequestToken) {
      setCalculationBusy(false);
    }
  }
}

function buildAnalysis(state) {
  const messages = [];
  const requestedEntries = parseTickerEntries(state.symbols);
  const requestedSymbols = requestedEntries.map((entry) => entry.symbol);
  const textareaExpectedReturnOverrides = buildExpectedReturnOverrideMap(requestedEntries);
  const sortedAssets = RAW_ASSETS.slice().sort((left, right) => (right.aumBillions || -1) - (left.aumBillions || -1));
  const allAssetLookup = new Map(sortedAssets.map((asset) => [asset.symbol, asset]));
  let filteredAssets = sortedAssets.filter((asset) => {
    const aum = typeof asset.aumBillions === "number" ? asset.aumBillions : null;
    if (aum === null || !Number.isFinite(aum) || aum < state.minAumBillions) {
      return false;
    }
    return true;
  });

  if (requestedSymbols.length > 0) {
    const lookup = allAssetLookup;
    const requestedAssets = requestedSymbols.map((symbol) => lookup.get(symbol)).filter((asset) => asset !== undefined);
    const missingSymbols = requestedSymbols.filter((symbol) => !lookup.has(symbol));
    filteredAssets = requestedAssets;

    if (missingSymbols.length > 0) {
      messages.push({
        type: "warning",
        text: "Ignored unavailable symbols: " + missingSymbols.join(", ") + ".",
      });
    }
  }

  const filteredLookup = new Map(filteredAssets.map((asset) => [asset.symbol, asset]));
  const buildEditorRows = (alignedSeriesBySymbol = new Map(), alignedLookup = new Map()) => buildSelectedUniverseRows({
    requestedEntries,
    filteredAssets,
    allAssetLookup,
    filteredLookup,
    alignedSeriesBySymbol,
    alignedLookup,
    horizonYears: state.horizonYears,
    storedOverrides: state.expectedReturnOverrides,
    parsedOverrides: textareaExpectedReturnOverrides,
  });

  if (filteredAssets.length < 2) {
    return {
      state,
      requestedEntries,
      requestedSymbols,
      filteredAssets,
      alignedAssets: [],
      commonPeriods: [],
      frontier: [],
      minVolIndex: -1,
      maxSharpeIndex: -1,
      selectedPortfolio: null,
      assetStatsBySymbol: new Map(),
      expectedReturnRows: buildEditorRows(),
      messages: messages.concat([{ type: "error", text: "At least two ETFs are required after filters." }]),
      stats: buildEmptyStats(),
    };
  }

  const historyWindow = buildWindow(filteredAssets, state.horizonYears, messages);
  const alignedAssets = historyWindow.assets;
  const commonPeriods = historyWindow.commonPeriods;

  if (alignedAssets.length < 2 || commonPeriods.length < 12) {
    return {
      state,
      requestedEntries,
      requestedSymbols,
      filteredAssets,
      alignedAssets,
      commonPeriods,
      frontier: [],
      minVolIndex: -1,
      maxSharpeIndex: -1,
      selectedPortfolio: null,
      assetStatsBySymbol: new Map(),
      expectedReturnRows: buildEditorRows(),
      messages: messages.concat([{ type: "error", text: "Not enough aligned monthly history remains after applying the selected horizon." }]),
      stats: buildEmptyStats(),
      expectedReturns: [],
      covariance: [],
    };
  }

  const returnsMatrix = alignedAssets.map((asset) => commonPeriods.map((period) => asset.periodMap.get(period) || 0));
  const expectedReturns = returnsMatrix.map((series, index) => resolveExpectedReturn(
    alignedAssets[index].source,
    state.horizonYears,
    series,
    state.expectedReturnOverrides,
    textareaExpectedReturnOverrides,
  ));
  const covariance = annualizedCovarianceMatrix(returnsMatrix);
  const riskFreeRate = state.riskFreeRatePercent / 100;
  const maxWeight = state.maxWeightPercent / 100;

  if (maxWeight * alignedAssets.length < 1 - 1e-9) {
    return {
      state,
      requestedEntries,
      requestedSymbols,
      filteredAssets,
      alignedAssets,
      commonPeriods,
      frontier: [],
      minVolIndex: -1,
      maxSharpeIndex: -1,
      selectedPortfolio: null,
      assetStatsBySymbol: new Map(),
      expectedReturnRows: buildEditorRows(),
      messages: messages.concat([{ type: "error", text: "The max weight is too restrictive for the remaining candidate set. Increase the cap or use more ETFs." }]),
      stats: buildEmptyStats(),
      expectedReturns,
      covariance,
    };
  }

  const densePoints = Math.max(state.frontierPoints * 8, 64);
  const fullFrontier = generateFrontier(expectedReturns, covariance, maxWeight, densePoints, riskFreeRate);
  const frontier = reduceFrontier(fullFrontier, state.frontierPoints);

  if (frontier.length === 0) {
    return {
      state,
      requestedEntries,
      requestedSymbols,
      filteredAssets,
      alignedAssets,
      commonPeriods,
      frontier: [],
      minVolIndex: -1,
      maxSharpeIndex: -1,
      selectedPortfolio: null,
      assetStatsBySymbol: new Map(),
      expectedReturnRows: buildEditorRows(),
      messages: messages.concat([{ type: "error", text: "No feasible frontier portfolios were produced for the current settings." }]),
      stats: buildEmptyStats(),
      expectedReturns,
      covariance,
    };
  }

  const minVolIndex = 0;
  const maxSharpeIndex = findBestIndex(frontier, (point) => point.sharpe);
  const selectedIndex = clampInteger(state.selectedFrontierIndex, 0, frontier.length - 1, 0);
  const selectedPortfolio = frontier[selectedIndex];
  const assetStatsBySymbol = new Map();
  const returnsSeriesBySymbol = new Map(alignedAssets.map((asset, index) => [asset.source.symbol, returnsMatrix[index]]));
  const alignedLookup = new Map(alignedAssets.map((asset) => [asset.source.symbol, asset.source]));

  alignedAssets.forEach((asset, index) => {
    const volatility = Math.sqrt(Math.max(0, covariance[index][index]));
    const sharpe = volatility > 0 ? (expectedReturns[index] - riskFreeRate) / volatility : 0;
    assetStatsBySymbol.set(asset.source.symbol, {
      expectedReturn: expectedReturns[index],
      defaultExpectedReturn: getDefaultExpectedReturn(asset.source, state.horizonYears, returnsMatrix[index]),
      volatility,
      sharpe,
      alignedIndex: index,
    });
  });

  const expectedReturnRows = buildEditorRows(returnsSeriesBySymbol, alignedLookup);

  return {
    state,
    requestedEntries,
    requestedSymbols,
    filteredAssets,
    alignedAssets,
    commonPeriods,
    frontier,
    minVolIndex,
    maxSharpeIndex,
    selectedPortfolio,
    assetStatsBySymbol,
    expectedReturnRows,
    messages,
    stats: {
      horizonYears: state.horizonYears,
      candidateCount: filteredAssets.length,
      alignedCount: alignedAssets.length,
      commonMonths: historyWindow.windowPeriods.length,
      optimizationMonths: commonPeriods.length,
      backfilledMonths: historyWindow.totalBackfilledMonths,
      startPeriod: historyWindow.windowPeriods[0],
      endPeriod: historyWindow.windowPeriods[historyWindow.windowPeriods.length - 1],
      riskFreeRate,
    },
    expectedReturns,
    covariance,
  };
}

function buildWindow(filteredAssets, horizonYears, messages) {
  const requiredMonths = horizonYears * 12;
  const windowMonths = DATA_WINDOW_YEARS * 12;
  const latestCommonPeriod = filteredAssets.map((asset) => getLastPeriod(asset)).filter(Boolean).sort()[0] || null;

  if (!latestCommonPeriod) {
    return { assets: [], commonPeriods: [], windowPeriods: [], totalBackfilledMonths: 0 };
  }

  const windowPeriods = buildTrailingPeriods(latestCommonPeriod, windowMonths);
  const commonPeriods = windowPeriods.slice(-requiredMonths);
  let totalBackfilledMonths = 0;
  const alignedAssets = filteredAssets.map((asset) => {
    const rawPeriodMap = new Map(
      asset.monthlyReturns
        .filter((entry) => Number.isFinite(entry.value))
        .map((entry) => [entry.period, entry.value]),
    );
    const periodMap = new Map();
    let assetBackfilledMonths = 0;

    for (const period of commonPeriods) {
      const value = rawPeriodMap.get(period);
      if (Number.isFinite(value)) {
        periodMap.set(period, value);
      } else {
        periodMap.set(period, 0);
        assetBackfilledMonths += 1;
      }
    }

    totalBackfilledMonths += assetBackfilledMonths;
    return {
      source: asset,
      periodMap,
      backfilledMonths: assetBackfilledMonths,
    };
  });

  if (totalBackfilledMonths > 0) {
    messages.push({
      type: "warning",
      text: `Backfilled ${totalBackfilledMonths} missing monthly observations with 0% returns inside the ${DATA_WINDOW_YEARS}Y window ending on ${latestCommonPeriod}.`,
    });
  }

  return {
    assets: alignedAssets,
    commonPeriods,
    windowPeriods,
    totalBackfilledMonths,
  };
}

function buildTrailingPeriods(endPeriod, count) {
  const periods = [];
  let cursor = endPeriod;

  for (let index = 0; index < count; index += 1) {
    periods.push(cursor);
    cursor = previousPeriod(cursor);
  }

  return periods.reverse();
}

function previousPeriod(period) {
  const [yearText, monthText] = String(period).split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const previousMonth = month === 1 ? 12 : month - 1;
  const previousYear = month === 1 ? year - 1 : year;
  return String(previousYear).padStart(4, "0") + "-" + String(previousMonth).padStart(2, "0");
}

function getLastPeriod(asset) {
  return Array.isArray(asset.monthlyReturns) && asset.monthlyReturns.length > 0
    ? asset.monthlyReturns[asset.monthlyReturns.length - 1].period
    : null;
}

function annualizedMeanReturn(series) {
  return mean(series) * 12;
}

function annualizedCovarianceMatrix(returnsMatrix) {
  const assetCount = returnsMatrix.length;
  const sampleCount = returnsMatrix[0].length;
  const means = returnsMatrix.map(mean);
  const covariance = Array.from({ length: assetCount }, () => Array.from({ length: assetCount }, () => 0));

  for (let row = 0; row < assetCount; row += 1) {
    for (let column = row; column < assetCount; column += 1) {
      let sum = 0;
      for (let index = 0; index < sampleCount; index += 1) {
        sum += (returnsMatrix[row][index] - means[row]) * (returnsMatrix[column][index] - means[column]);
      }

      const value = sampleCount > 1 ? (sum / (sampleCount - 1)) * 12 : 0;
      covariance[row][column] = value;
      covariance[column][row] = value;
    }
  }

  return covariance;
}

function generateFrontier(expectedReturns, covariance, maxWeight, densePoints, riskFreeRate) {
  const frontier = [];
  const assetCount = expectedReturns.length;
  const equalWeight = projectCappedSimplex(Array.from({ length: assetCount }, () => 1 / assetCount), maxWeight);
  let warmWeights = equalWeight;
  const lambdaValues = [0];
  const lambdaMin = 0.0025;
  const lambdaMax = 14;

  for (let index = 0; index < densePoints - 1; index += 1) {
    const t = densePoints === 1 ? 0 : index / Math.max(1, densePoints - 2);
    lambdaValues.push(lambdaMin * Math.pow(lambdaMax / lambdaMin, t));
  }

  for (const lambda of lambdaValues) {
    warmWeights = solveProjectedGradient(expectedReturns, covariance, lambda, maxWeight, warmWeights);
    frontier.push(buildPortfolioPoint(warmWeights, expectedReturns, covariance, riskFreeRate));
  }

  return frontier;
}

function solveProjectedGradient(expectedReturns, covariance, lambda, maxWeight, initialWeights) {
  let weights = initialWeights.slice();
  const lipschitz = Math.max(2 * maxRowAbsSum(covariance), 1e-6);
  const step = 1 / lipschitz;

  for (let iteration = 0; iteration < 900; iteration += 1) {
    const gradient = portfolioGradient(weights, covariance, expectedReturns, lambda);
    const candidate = projectCappedSimplex(weights.map((weight, index) => weight - step * gradient[index]), maxWeight);
    const difference = l2Distance(weights, candidate);
    weights = candidate;
    if (difference < 1e-8) {
      break;
    }
  }

  return weights;
}

function portfolioGradient(weights, covariance, expectedReturns, lambda) {
  const matrixProduct = multiplyMatrixVector(covariance, weights);
  return matrixProduct.map((value, index) => 2 * value - lambda * expectedReturns[index]);
}

function multiplyMatrixVector(matrix, vector) {
  return matrix.map((row) => {
    let sum = 0;
    for (let index = 0; index < row.length; index += 1) {
      sum += row[index] * vector[index];
    }
    return sum;
  });
}

function maxRowAbsSum(matrix) {
  return matrix.reduce((maxValue, row) => Math.max(maxValue, row.reduce((sum, value) => sum + Math.abs(value), 0)), 0);
}

function projectCappedSimplex(values, upperBound) {
  const clippedUpperBound = Math.max(upperBound, 1 / values.length);
  let lower = Math.min(...values) - clippedUpperBound;
  let upper = Math.max(...values);

  for (let iteration = 0; iteration < 80; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    const sum = values.reduce((accumulator, value) => accumulator + clampNumber(value - midpoint, 0, clippedUpperBound, 0), 0);
    if (sum > 1) {
      lower = midpoint;
    } else {
      upper = midpoint;
    }
  }

  const theta = (lower + upper) / 2;
  let projected = values.map((value) => clampNumber(value - theta, 0, clippedUpperBound, 0));
  const projectedSum = projected.reduce((sum, value) => sum + value, 0);

  if (projectedSum <= 0) {
    projected = Array.from({ length: values.length }, () => 1 / values.length);
  } else {
    projected = projected.map((value) => value / projectedSum);
  }

  return projected;
}

function buildPortfolioPoint(weights, expectedReturns, covariance, riskFreeRate) {
  const expectedReturn = dotProduct(weights, expectedReturns);
  const variance = quadraticForm(weights, covariance);
  const volatility = Math.sqrt(Math.max(variance, 0));
  const sharpe = volatility > 0 ? (expectedReturn - riskFreeRate) / volatility : 0;

  return {
    expectedReturn,
    volatility,
    sharpe,
    weights: weights.slice(),
  };
}

function dotProduct(left, right) {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    sum += left[index] * right[index];
  }
  return sum;
}

function quadraticForm(weights, covariance) {
  let sum = 0;
  for (let row = 0; row < covariance.length; row += 1) {
    for (let column = 0; column < covariance.length; column += 1) {
      sum += weights[row] * covariance[row][column] * weights[column];
    }
  }
  return sum;
}

function l2Distance(left, right) {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    sum += difference * difference;
  }
  return Math.sqrt(sum);
}

function reduceFrontier(frontier, displayedPoints) {
  const unique = [];

  for (const point of frontier) {
    const previous = unique[unique.length - 1];
    if (!previous) {
      unique.push(point);
      continue;
    }

    const sameReturn = Math.abs(previous.expectedReturn - point.expectedReturn) < 1e-5;
    const sameVolatility = Math.abs(previous.volatility - point.volatility) < 1e-5;
    if (!sameReturn || !sameVolatility) {
      unique.push(point);
    }
  }

  const sorted = unique.slice().sort((left, right) => left.volatility - right.volatility);
  const nonDominated = [];
  let bestReturn = -Infinity;

  for (const point of sorted) {
    if (point.expectedReturn >= bestReturn - 1e-9) {
      nonDominated.push(point);
      bestReturn = Math.max(bestReturn, point.expectedReturn);
    }
  }

  if (nonDominated.length <= displayedPoints) {
    return nonDominated;
  }

  const sampled = [];
  for (let index = 0; index < displayedPoints; index += 1) {
    const position = Math.round((index / Math.max(1, displayedPoints - 1)) * (nonDominated.length - 1));
    sampled.push(nonDominated[position]);
  }

  return sampled.filter((point, index) => index === 0 || point !== sampled[index - 1]);
}

function findBestIndex(items, selector) {
  let bestIndex = -1;
  let bestValue = -Infinity;

  for (let index = 0; index < items.length; index += 1) {
    const value = selector(items[index]);
    if (value > bestValue) {
      bestValue = value;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function renderAnalysis(analysis, state) {
  const selectedIndex = clampInteger(state.selectedFrontierIndex, 0, Math.max(0, analysis.frontier.length - 1), 0);
  renderSummary(analysis);
  renderChart(analysis, selectedIndex);
  renderPortfolioCards(analysis, selectedIndex);
  renderWeightsTable(analysis, selectedIndex);
  renderMessages(analysis);
  if (!elements.expectedReturnPanel.hidden) {
    renderExpectedReturnEditor(analysis);
  }
  elements.portfolioIndexRange.max = String(Math.max(0, analysis.frontier.length - 1));
  elements.portfolioIndexRange.value = String(selectedIndex);
  elements.portfolioIndexValue.value = analysis.frontier.length > 0
    ? `${selectedIndex + 1} of ${analysis.frontier.length}`
    : "0 of 0";
}

function renderSummary(analysis) {
  elements.summaryCandidateCount.textContent = formatInteger(analysis.stats.candidateCount);
  elements.summaryAlignedCount.textContent = formatInteger(analysis.stats.alignedCount);
  elements.summaryMonths.textContent = analysis.stats.commonMonths > 0 ? formatInteger(analysis.stats.commonMonths) : "-";

  const pills = [];
  pills.push(`Horizon: ${analysis.stats.horizonYears || 0}Y`);
  pills.push(`Data window: ${DATA_WINDOW_YEARS}Y`);
  if (analysis.stats.startPeriod && analysis.stats.endPeriod) {
    pills.push(`Window: ${formatPeriodLabel(analysis.stats.startPeriod)} to ${formatPeriodLabel(analysis.stats.endPeriod)}`);
  }
  pills.push(`Optimize: ${analysis.stats.optimizationMonths || 0} months`);
  pills.push(`Risk-free: ${formatPercent(analysis.stats.riskFreeRate)}`);
  if (analysis.requestedSymbols.length > 0) {
    pills.push(`Requested subset: ${analysis.requestedSymbols.length}`);
  }

  setPills(elements.summaryPills, pills);

  const chartPills = [];
  if (analysis.frontier.length > 0) {
    chartPills.push(`Frontier points: ${analysis.frontier.length}`);
    if (analysis.maxSharpeIndex >= 0) {
      chartPills.push(`Max Sharpe: ${formatSharpe(analysis.frontier[analysis.maxSharpeIndex].sharpe)}`);
    }
    chartPills.push(`Min vol: ${formatPercent(analysis.frontier[analysis.minVolIndex].volatility)}`);
  }
  setPills(elements.chartPills, chartPills);
}

function renderExpectedReturnEditor(analysis) {
  const rows = Array.isArray(analysis.expectedReturnRows) ? analysis.expectedReturnRows : [];
  const explicitCount = rows.filter((row) => Number.isFinite(row.explicitExpectedReturnPercent)).length;
  const autoFillCount = rows.filter((row) => !Number.isFinite(row.explicitExpectedReturnPercent) && Number.isFinite(row.defaultExpectedReturn)).length;
  const availableCount = rows.filter((row) => row.passesFilters).length;
  const rowLabel = analysis.requestedSymbols.length > 0 ? "Subset rows" : "Current universe rows";

  setPills(elements.expectedReturnPills, [
    `${rowLabel}: ${rows.length}`,
    `Available: ${availableCount}`,
    `Explicit ER: ${explicitCount}`,
    `Auto ER: ${autoFillCount}`,
  ]);

  if (rows.length === 0) {
    elements.expectedReturnTableBody.innerHTML = '<tr><td colspan="6">Add tickers in Ticker subset and optional ER to edit the selected universe here.</td></tr>';
    return;
  }

  const editorRows = rows.concat([{ symbol: "", explicitExpectedReturnPercent: null, name: "-", category: "-", sponsor: "-", defaultExpectedReturn: null, appliedExpectedReturn: null, isKnownAsset: true, passesFilters: false, isAligned: false, isAddRow: true }]);

  elements.expectedReturnTableBody.innerHTML = editorRows.map((row, index) => `
    <tr>
      <td data-editor-row="${index}"><input class="editor-symbol-input" data-editor-row="${index}" data-editor-field="symbol" type="text" value="${escapeHtml(row.symbol || "")}" placeholder="Ticker"></td>
      <td title="${escapeHtml(row.name || "-")}">${escapeHtml(row.name || "-")}</td>
      <td>${escapeHtml(row.category || "-")}</td>
      <td>${escapeHtml(row.sponsor || "-")}</td>
      <td class="numeric">${escapeHtml(formatPercent(row.defaultExpectedReturn))}</td>
      <td class="numeric"><input class="editor-input" data-editor-row="${index}" data-editor-field="expectedReturn" type="number" step="0.1" value="${escapeHtml(formatExplicitEditorPercent(row.explicitExpectedReturnPercent))}" placeholder="${escapeHtml(formatEditorPercent(row.defaultExpectedReturn))}"></td>
    </tr>
  `).join("");

  elements.expectedReturnTableBody.querySelectorAll("[data-editor-field]").forEach((input) => {
    input.addEventListener("input", handleSelectedUniverseEditorInput);
    input.addEventListener("change", handleSelectedUniverseEditorChange);
  });
}

function handleSelectedUniverseEditorInput() {
  syncSelectedUniverseEditorToSymbolsInput(false);
}

function handleSelectedUniverseEditorChange() {
  syncSelectedUniverseEditorToSymbolsInput(true);
}

function renderChart(analysis, selectedIndex) {
  if (analysis.frontier.length === 0) {
    elements.chartStage.innerHTML = '<div class="chart-shell"><div class="chart-caption"><div class="chart-metric"><strong>Frontier unavailable</strong><span>Adjust filters or constraints and recalculate.</span></div></div></div>';
    return;
  }

  const width = 820;
  const frontierHeight = 450;
  const transitionHeight = 372;
  const frontierPadding = { top: 18, right: 24, bottom: 44, left: 62 };
  const transitionPadding = { top: 18, right: 24, bottom: 42, left: 62 };
  const xValues = analysis.frontier.map((point) => point.volatility);
  const yValues = analysis.frontier.map((point) => point.expectedReturn);
  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  const yMin = Math.min(...yValues);
  const yMax = Math.max(...yValues);
  const xPad = Math.max((xMax - xMin) * 0.12, 0.01);
  const yPad = Math.max((yMax - yMin) * 0.16, 0.01);
  const chartBounds = {
    xMin: Math.max(0, xMin - xPad),
    xMax: xMax + xPad,
    yMin: Math.max(0, yMin - yPad),
    yMax: yMax + yPad,
  };

  const scaleX = (value) => {
    const usableWidth = width - frontierPadding.left - frontierPadding.right;
    return frontierPadding.left + ((value - chartBounds.xMin) / Math.max(1e-9, chartBounds.xMax - chartBounds.xMin)) * usableWidth;
  };
  const scaleY = (value) => {
    const usableHeight = frontierHeight - frontierPadding.top - frontierPadding.bottom;
    return frontierHeight - frontierPadding.bottom - ((value - chartBounds.yMin) / Math.max(1e-9, chartBounds.yMax - chartBounds.yMin)) * usableHeight;
  };
  const scaleAllocationY = (value) => {
    const usableHeight = transitionHeight - transitionPadding.top - transitionPadding.bottom;
    return transitionHeight - transitionPadding.bottom - Math.max(0, Math.min(1, value)) * usableHeight;
  };
  const pointXs = analysis.frontier.map((point) => scaleX(point.volatility));
  const transitionSeries = buildTransitionMapSeries(analysis);
  const transitionTicks = buildTicks(0, 1, 5);
  const defaultReticleX = pointXs[selectedIndex];

  const path = analysis.frontier.map((point, index) => {
    const prefix = index === 0 ? "M" : "L";
    return `${prefix} ${scaleX(point.volatility).toFixed(2)} ${scaleY(point.expectedReturn).toFixed(2)}`;
  }).join(" ");

  const yTicks = buildTicks(chartBounds.yMin, chartBounds.yMax, 5);
  const xTicks = buildTicks(chartBounds.xMin, chartBounds.xMax, 5);
  const selectedPoint = analysis.frontier[selectedIndex];
  const maxSharpePoint = analysis.maxSharpeIndex >= 0 ? analysis.frontier[analysis.maxSharpeIndex] : null;
  const minVolPoint = analysis.frontier[analysis.minVolIndex];
  const transitionWindowLabel = analysis.stats.startPeriod && analysis.stats.endPeriod
    ? `${formatPeriodLabel(analysis.stats.startPeriod)} - ${formatPeriodLabel(analysis.stats.endPeriod)}`
    : "Displayed frontier points";
  const maxSharpeX = maxSharpePoint ? scaleX(maxSharpePoint.volatility) : null;

  const chartMetrics = [
    { label: "Selected return", value: formatPercent(selectedPoint.expectedReturn) },
    { label: "Selected volatility", value: formatPercent(selectedPoint.volatility) },
    { label: "Selected Sharpe", value: formatSharpe(selectedPoint.sharpe) },
  ];

  const chartHtml = [
    '<div class="chart-shell">',
    '<div class="chart-caption">',
    ...chartMetrics.map((metric) => `<div class="chart-metric"><strong>${escapeHtml(metric.label)}</strong><span>${escapeHtml(metric.value)}</span></div>`),
    '</div>',
    `<svg class="frontier-svg" viewBox="0 0 ${width} ${frontierHeight}" role="img" aria-label="Efficient frontier chart">`,
    ...yTicks.map((tick) => {
      const y = scaleY(tick);
      return `<g><line class="grid-line" x1="${frontierPadding.left}" y1="${y}" x2="${width - frontierPadding.right}" y2="${y}"></line><text class="tick-label" x="${frontierPadding.left - 10}" y="${y + 4}" text-anchor="end">${escapeHtml(formatPercent(tick))}</text></g>`;
    }),
    ...xTicks.map((tick) => {
      const x = scaleX(tick);
      return `<g><line class="grid-line" x1="${x}" y1="${frontierPadding.top}" x2="${x}" y2="${frontierHeight - frontierPadding.bottom}"></line><text class="tick-label" x="${x}" y="${frontierHeight - frontierPadding.bottom + 18}" text-anchor="middle">${escapeHtml(formatPercent(tick))}</text></g>`;
    }),
    `<line class="axis-line" x1="${frontierPadding.left}" y1="${frontierHeight - frontierPadding.bottom}" x2="${width - frontierPadding.right}" y2="${frontierHeight - frontierPadding.bottom}"></line>`,
    `<line class="axis-line" x1="${frontierPadding.left}" y1="${frontierPadding.top}" x2="${frontierPadding.left}" y2="${frontierHeight - frontierPadding.bottom}"></line>`,
    maxSharpeX !== null
      ? `<line class="chart-reference-line chart-max-sharpe-line" x1="${maxSharpeX}" y1="${frontierPadding.top}" x2="${maxSharpeX}" y2="${frontierHeight - frontierPadding.bottom}"></line>`
      : "",
    `<line class="chart-reticle" data-reticle="frontier" x1="${defaultReticleX}" y1="${frontierPadding.top}" x2="${defaultReticleX}" y2="${frontierHeight - frontierPadding.bottom}"></line>`,
    `<path class="frontier-line" d="${path}"></path>`,
    ...analysis.frontier.map((point, index) => {
      const classes = ["frontier-point"];
      if (index === selectedIndex) {
        classes.push("active");
      }
      if (index === analysis.maxSharpeIndex) {
        classes.push("sharpe");
      }
      if (index === analysis.minVolIndex) {
        classes.push("min-vol");
      }
      const cx = scaleX(point.volatility);
      const cy = scaleY(point.expectedReturn);
      return `<g class="frontier-node" data-frontier-index="${index}" data-chart-x="${cx.toFixed(2)}" data-chart-y="${cy.toFixed(2)}" tabindex="0" role="button" aria-label="Frontier point ${index + 1}">
        <circle class="frontier-point-hit" cx="${cx}" cy="${cy}" r="14"></circle>
        <circle class="${classes.join(" ")}" cx="${cx}" cy="${cy}" r="${index === selectedIndex ? 6 : 4.5}"></circle>
      </g>`;
    }),
    `<rect class="chart-hover-surface" data-hover-surface="frontier" x="${frontierPadding.left}" y="${frontierPadding.top}" width="${width - frontierPadding.left - frontierPadding.right}" height="${frontierHeight - frontierPadding.top - frontierPadding.bottom}"></rect>`,
    `<text class="axis-label" x="${width / 2}" y="${frontierHeight - 8}" text-anchor="middle">Volatility</text>`,
    `<text class="axis-label" x="16" y="${frontierHeight / 2}" text-anchor="middle" transform="rotate(-90 16 ${frontierHeight / 2})">Expected return</text>`,
    maxSharpePoint ? `<text class="point-label" x="${scaleX(maxSharpePoint.volatility) + 8}" y="${scaleY(maxSharpePoint.expectedReturn) - 8}">Max Sharpe</text>` : "",
    minVolPoint ? `<text class="point-label" x="${scaleX(minVolPoint.volatility) + 8}" y="${scaleY(minVolPoint.expectedReturn) + 18}">Min vol</text>` : "",
    `</svg>`,
    '<div class="transition-block">',
    `<div class="transition-heading"><strong>Transition map</strong><span>${escapeHtml(transitionWindowLabel)}</span></div>`,
    `<svg class="transition-svg" viewBox="0 0 ${width} ${transitionHeight}" role="img" aria-label="Efficient frontier transition map">`,
    ...transitionTicks.map((tick) => {
      const y = scaleAllocationY(tick);
      return `<g><line class="grid-line" x1="${transitionPadding.left}" y1="${y}" x2="${width - transitionPadding.right}" y2="${y}"></line><text class="tick-label" x="${transitionPadding.left - 10}" y="${y + 4}" text-anchor="end">${escapeHtml(formatPercent(tick))}</text></g>`;
    }),
    ...xTicks.map((tick) => {
      const x = scaleX(tick);
      return `<g><line class="grid-line" x1="${x}" y1="${transitionPadding.top}" x2="${x}" y2="${transitionHeight - transitionPadding.bottom}"></line><text class="tick-label" x="${x}" y="${transitionHeight - transitionPadding.bottom + 18}" text-anchor="middle">${escapeHtml(formatPercent(tick))}</text></g>`;
    }),
    `<line class="axis-line" x1="${transitionPadding.left}" y1="${transitionHeight - transitionPadding.bottom}" x2="${width - transitionPadding.right}" y2="${transitionHeight - transitionPadding.bottom}"></line>`,
    `<line class="axis-line" x1="${transitionPadding.left}" y1="${transitionPadding.top}" x2="${transitionPadding.left}" y2="${transitionHeight - transitionPadding.bottom}"></line>`,
    ...transitionSeries.map((series) => `<path class="transition-area" d="${buildAreaPath(pointXs, series.lower, series.upper, scaleAllocationY)}" fill="${series.fillColor}" stroke="${series.strokeColor}" data-transition-symbol="${escapeHtml(series.symbol)}"></path>`),
    ...transitionSeries.map((series) => `<path class="transition-boundary" d="${buildLinePath(pointXs, series.upper, scaleAllocationY)}" stroke="${series.strokeColor}"></path>`),
    maxSharpeX !== null
      ? `<line class="chart-reference-line chart-max-sharpe-line" x1="${maxSharpeX}" y1="${transitionPadding.top}" x2="${maxSharpeX}" y2="${transitionHeight - transitionPadding.bottom}"></line>`
      : "",
    `<line class="chart-reticle" data-reticle="transition" x1="${defaultReticleX}" y1="${transitionPadding.top}" x2="${defaultReticleX}" y2="${transitionHeight - transitionPadding.bottom}"></line>`,
    `<rect class="chart-hover-surface" data-hover-surface="transition" x="${transitionPadding.left}" y="${transitionPadding.top}" width="${width - transitionPadding.left - transitionPadding.right}" height="${transitionHeight - transitionPadding.top - transitionPadding.bottom}"></rect>`,
    `<text class="axis-label" x="${width / 2}" y="${transitionHeight - 8}" text-anchor="middle">Volatility</text>`,
    `<text class="axis-label" x="16" y="${transitionHeight / 2}" text-anchor="middle" transform="rotate(-90 16 ${transitionHeight / 2})">Allocation</text>`,
    `</svg>`,
    `<div class="transition-legend">${buildTransitionLegendHtml(transitionSeries)}</div>`,
    '</div>',
    '<div class="chart-tooltip" id="chartTooltip" aria-hidden="true"></div>',
    '</div>',
  ].join("");

  elements.chartStage.innerHTML = chartHtml;
  bindChartInteractions(analysis, pointXs, selectedIndex);
}

function bindChartInteractions(analysis, pointXs, selectedIndex) {
  const tooltip = elements.chartStage.querySelector("#chartTooltip");
  if (!tooltip) {
    return;
  }

  const selectedX = pointXs[selectedIndex];

  const setHoverState = (index, chartX) => {
    const safeIndex = clampInteger(index, 0, analysis.frontier.length - 1, selectedIndex);
    const x = Number.isFinite(chartX) ? chartX : pointXs[safeIndex];
    elements.chartStage.querySelectorAll("[data-reticle]").forEach((line) => {
      line.setAttribute("x1", String(x));
      line.setAttribute("x2", String(x));
    });
    elements.chartStage.querySelectorAll("[data-frontier-index]").forEach((node) => {
      const nodeIndex = Number(node.getAttribute("data-frontier-index"));
      node.classList.toggle("is-hovered", nodeIndex === safeIndex);
    });
  };

  const hideTooltip = () => {
    tooltip.classList.remove("is-visible");
    tooltip.setAttribute("aria-hidden", "true");
    setHoverState(selectedIndex, selectedX);
  };

  const showTooltip = (hoverState, clientX, clientY) => {
    setHoverState(hoverState.index, hoverState.chartX);
    tooltip.innerHTML = buildChartTooltipHtml(analysis, buildInterpolatedHoverPortfolio(analysis, hoverState));
    tooltip.classList.add("is-visible");
    tooltip.setAttribute("aria-hidden", "false");
    positionChartTooltip(tooltip, clientX, clientY);
  };

  const getPointerChartState = (event) => {
    const surface = event.currentTarget;
    const surfaceRect = surface.getBoundingClientRect();
    const surfaceX = surface.x?.baseVal?.value ?? 0;
    const surfaceWidth = surface.width?.baseVal?.value ?? 1;
    const ratio = Math.max(0, Math.min(1, (event.clientX - surfaceRect.left) / Math.max(1, surfaceRect.width)));
    const chartX = surfaceX + ratio * surfaceWidth;
    return {
      chartX,
      ...getFrontierHoverState(pointXs, chartX),
    };
  };

  elements.chartStage.querySelectorAll("[data-hover-surface]").forEach((surface) => {
    surface.addEventListener("mouseenter", (event) => {
      const pointerState = getPointerChartState(event);
      showTooltip(pointerState, event.clientX, event.clientY);
    });
    surface.addEventListener("mousemove", (event) => {
      const pointerState = getPointerChartState(event);
      showTooltip(pointerState, event.clientX, event.clientY);
    });
    surface.addEventListener("mouseleave", hideTooltip);
    surface.addEventListener("click", (event) => {
      selectFrontierIndex(getPointerChartState(event).index);
    });
  });

  elements.chartStage.querySelectorAll("[data-frontier-index]").forEach((node) => {
    const getIndex = () => Number(node.getAttribute("data-frontier-index"));

    node.addEventListener("focus", () => {
      const rect = node.getBoundingClientRect();
      showTooltip({
        chartX: pointXs[getIndex()],
        index: getIndex(),
        leftIndex: getIndex(),
        rightIndex: getIndex(),
        ratio: 0,
      }, rect.left + rect.width / 2, rect.top + rect.height / 2);
    });
    node.addEventListener("blur", hideTooltip);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectFrontierIndex(getIndex());
      }
    });
  });

  setHoverState(selectedIndex, selectedX);
}

function positionChartTooltip(tooltip, clientX, clientY) {
  const stageRect = elements.chartStage.getBoundingClientRect();
  const offset = 18;
  let left = clientX - stageRect.left + offset;
  let top = clientY - stageRect.top + offset;

  tooltip.style.left = "0px";
  tooltip.style.top = "0px";

  const tooltipRect = tooltip.getBoundingClientRect();
  if (left + tooltipRect.width > stageRect.width - 10) {
    left = Math.max(10, clientX - stageRect.left - tooltipRect.width - offset);
  }
  if (top + tooltipRect.height > stageRect.height - 10) {
    top = Math.max(10, clientY - stageRect.top - tooltipRect.height - offset);
  }

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function buildChartTooltipHtml(analysis, index) {
  const hoverPortfolio = index;
  const alignedIndexBySymbol = new Map(analysis.alignedAssets.map((asset, assetIndex) => [asset.source.symbol, assetIndex]));
  const allocationRows = analysis.filteredAssets
    .map((asset) => {
      const alignedIndex = alignedIndexBySymbol.get(asset.symbol);
      const weight = alignedIndex === undefined ? 0 : hoverPortfolio.weights[alignedIndex] || 0;
      return {
        symbol: asset.symbol,
        weight,
      };
    })
    .filter((row) => row.weight > 0.0001)
    .sort((left, right) => right.weight - left.weight);

  return [
    '<div class="chart-tooltip-card">',
    `<div class="chart-tooltip-heading">${escapeHtml(hoverPortfolio.label)}</div>`,
    '<div class="chart-tooltip-metrics">',
    `<span><strong>Return</strong>${escapeHtml(formatPercent(hoverPortfolio.expectedReturn))}</span>`,
    `<span><strong>Vol</strong>${escapeHtml(formatPercent(hoverPortfolio.volatility))}</span>`,
    `<span><strong>Sharpe</strong>${escapeHtml(formatSharpe(hoverPortfolio.sharpe))}</span>`,
    '</div>',
    '<div class="chart-tooltip-subheading">Active allocation</div>',
    '<div class="chart-tooltip-list">',
    ...allocationRows.map((row) => `<div class="chart-tooltip-row"><span>${escapeHtml(row.symbol)}</span><strong>${escapeHtml(formatPercent(row.weight))}</strong></div>`),
    '</div>',
    '</div>',
  ].join("");
}

function buildInterpolatedHoverPortfolio(analysis, hoverState) {
  const leftIndex = clampInteger(hoverState?.leftIndex, 0, analysis.frontier.length - 1, 0);
  const rightIndex = clampInteger(hoverState?.rightIndex, 0, analysis.frontier.length - 1, leftIndex);
  const ratio = Math.max(0, Math.min(1, Number(hoverState?.ratio) || 0));
  const leftPoint = analysis.frontier[leftIndex];
  const rightPoint = analysis.frontier[rightIndex] || leftPoint;
  const riskFreeRate = analysis.stats.riskFreeRate;
  const weights = leftPoint.weights.map((weight, weightIndex) => {
    return lerp(weight, rightPoint.weights[weightIndex] || 0, ratio);
  });
  const expectedReturn = lerp(leftPoint.expectedReturn, rightPoint.expectedReturn, ratio);
  const volatility = lerp(leftPoint.volatility, rightPoint.volatility, ratio);
  const sharpe = volatility > 1e-9 ? (expectedReturn - riskFreeRate) / volatility : 0;
  const exactLeft = ratio <= 1e-6 || leftIndex === rightIndex;
  const exactRight = ratio >= 1 - 1e-6;
  let label = `Between points ${leftIndex + 1} and ${rightIndex + 1}`;
  if (exactLeft) {
    label = `Point ${leftIndex + 1} of ${analysis.frontier.length}`;
  } else if (exactRight) {
    label = `Point ${rightIndex + 1} of ${analysis.frontier.length}`;
  }

  return {
    label,
    expectedReturn,
    volatility,
    sharpe,
    weights,
  };
}

function buildTransitionMapSeries(analysis) {
  const alignedIndexBySymbol = new Map(analysis.alignedAssets.map((asset, index) => [asset.source.symbol, index]));
  const visibilityThreshold = Math.max(analysis.state.minWeightRoundingPercent / 100, 0.01);
  let series = analysis.filteredAssets.map((asset) => {
    const alignedIndex = alignedIndexBySymbol.get(asset.symbol);
    const weights = analysis.frontier.map((point) => alignedIndex === undefined ? 0 : point.weights[alignedIndex] || 0);
    return {
      symbol: asset.symbol,
      name: asset.name,
      weights,
      maxWeight: Math.max(...weights),
      averageWeight: mean(weights),
      isOther: false,
    };
  }).filter((entry) => entry.maxWeight >= visibilityThreshold);

  if (series.length === 0) {
    series = analysis.filteredAssets.map((asset) => {
      const alignedIndex = alignedIndexBySymbol.get(asset.symbol);
      const weights = analysis.frontier.map((point) => alignedIndex === undefined ? 0 : point.weights[alignedIndex] || 0);
      return {
        symbol: asset.symbol,
        name: asset.name,
        weights,
        maxWeight: Math.max(...weights),
        averageWeight: mean(weights),
        isOther: false,
      };
    }).filter((entry) => entry.maxWeight > 0.0001);
  }

  series.sort((left, right) => right.averageWeight - left.averageWeight);
  const includedTotals = analysis.frontier.map((_point, pointIndex) => {
    return series.reduce((sum, entry) => sum + entry.weights[pointIndex], 0);
  });
  const otherWeights = includedTotals.map((total) => Math.max(0, 1 - total));
  if (Math.max(...otherWeights) > 0.0005) {
    series.push({
      symbol: "OTHER",
      name: "Other holdings",
      weights: otherWeights,
      maxWeight: Math.max(...otherWeights),
      averageWeight: mean(otherWeights),
      isOther: true,
    });
  }

  const palette = buildTransitionPalette(series.length);
  const cumulative = Array.from({ length: analysis.frontier.length }, () => 0);

  return series.map((entry, index) => {
    const lower = cumulative.slice();
    const upper = cumulative.map((sum, pointIndex) => sum + entry.weights[pointIndex]);
    for (let pointIndex = 0; pointIndex < upper.length; pointIndex += 1) {
      cumulative[pointIndex] = upper[pointIndex];
    }

    const strokeColor = entry.isOther ? "#94a3b8" : palette[index];
    return {
      ...entry,
      lower,
      upper,
      strokeColor,
      fillColor: toRgbaColor(strokeColor, entry.isOther ? 0.3 : 0.24),
    };
  });
}

function buildTransitionLegendHtml(series) {
  return series.map((entry) => {
    const label = entry.name || entry.symbol;
    const displayLabel = entry.symbol === "OTHER" ? label : `${entry.symbol} - ${label}`;
    return `<div class="transition-legend-item" title="${escapeHtml(displayLabel)}"><span class="transition-legend-swatch" style="background:${escapeHtml(entry.strokeColor)}"></span><span>${escapeHtml(displayLabel)}</span></div>`;
  }).join("");
}

function buildAreaPath(xs, lower, upper, scaleY) {
  if (!Array.isArray(xs) || xs.length === 0) {
    return "";
  }

  const topPath = xs.map((x, index) => `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${scaleY(upper[index]).toFixed(2)}`).join(" ");
  const lowerPath = xs.map((x, index) => `L ${x.toFixed(2)} ${scaleY(lower[index]).toFixed(2)}`).reverse().join(" ");
  return `${topPath} ${lowerPath} Z`;
}

function buildLinePath(xs, values, scaleY) {
  if (!Array.isArray(xs) || xs.length === 0) {
    return "";
  }

  return xs.map((x, index) => `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${scaleY(values[index]).toFixed(2)}`).join(" ");
}

function findNearestFrontierIndex(pointXs, chartX) {
  let nearestIndex = 0;
  let nearestDistance = Infinity;

  for (let index = 0; index < pointXs.length; index += 1) {
    const distance = Math.abs(pointXs[index] - chartX);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }

  return nearestIndex;
}

function getFrontierHoverState(pointXs, chartX) {
  if (!Array.isArray(pointXs) || pointXs.length === 0) {
    return {
      leftIndex: 0,
      rightIndex: 0,
      ratio: 0,
      index: 0,
    };
  }

  if (pointXs.length === 1) {
    return {
      leftIndex: 0,
      rightIndex: 0,
      ratio: 0,
      index: 0,
    };
  }

  const clampedX = Math.max(pointXs[0], Math.min(pointXs[pointXs.length - 1], chartX));
  for (let index = 0; index < pointXs.length - 1; index += 1) {
    const leftX = pointXs[index];
    const rightX = pointXs[index + 1];
    if (clampedX <= rightX || index === pointXs.length - 2) {
      const intervalWidth = Math.max(1e-9, rightX - leftX);
      const ratio = Math.max(0, Math.min(1, (clampedX - leftX) / intervalWidth));
      return {
        leftIndex: index,
        rightIndex: index + 1,
        ratio,
        index: ratio < 0.5 ? index : index + 1,
      };
    }
  }

  return {
    leftIndex: pointXs.length - 1,
    rightIndex: pointXs.length - 1,
    ratio: 0,
    index: pointXs.length - 1,
  };
}

function lerp(start, end, ratio) {
  const safeStart = Number.isFinite(start) ? start : 0;
  const safeEnd = Number.isFinite(end) ? end : safeStart;
  return safeStart + (safeEnd - safeStart) * ratio;
}

function buildTransitionPalette(count) {
  const basePalette = [
    "#4338ca",
    "#10b981",
    "#0ea5e9",
    "#f59e0b",
    "#ef4444",
    "#8b5cf6",
    "#14b8a6",
    "#f97316",
    "#06b6d4",
    "#84cc16",
  ];

  if (count <= basePalette.length) {
    return basePalette.slice(0, count);
  }

  return Array.from({ length: count }, (_item, index) => {
    const hue = Math.round((index / Math.max(1, count)) * 320);
    return `hsl(${hue} 68% 52%)`;
  });
}

function toRgbaColor(color, alpha) {
  if (typeof color !== "string") {
    return `rgba(127, 138, 154, ${alpha})`;
  }

  if (color.startsWith("#")) {
    const hex = color.slice(1);
    const normalized = hex.length === 3 ? hex.split("").map((value) => value + value).join("") : hex;
    const red = Number.parseInt(normalized.slice(0, 2), 16);
    const green = Number.parseInt(normalized.slice(2, 4), 16);
    const blue = Number.parseInt(normalized.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  const match = color.match(/hsl\(([^)]+)\)/i);
  if (!match) {
    return color;
  }

  return color.replace(/^hsl/i, "hsla").replace(/\)$/, ` / ${alpha})`);
}

function renderPortfolioCards(analysis, selectedIndex) {
  if (analysis.frontier.length === 0) {
    elements.portfolioCards.innerHTML = '<div class="portfolio-stat"><span class="label">Portfolio status</span><span class="value small">No feasible frontier portfolio.</span></div>';
    return;
  }

  const selected = buildRoundedSelectedPortfolio(analysis, selectedIndex);
  const maxSharpe = analysis.frontier[analysis.maxSharpeIndex];
  const minVol = analysis.frontier[analysis.minVolIndex];
  const cards = [
    { label: "Selected return", value: formatPercent(selected.expectedReturn) },
    { label: "Selected volatility", value: formatPercent(selected.volatility) },
    { label: "Selected Sharpe", value: formatSharpe(selected.sharpe) },
    { label: "Max Sharpe point", value: maxSharpe ? formatPercent(maxSharpe.expectedReturn) + " / " + formatPercent(maxSharpe.volatility) : "-" },
    { label: "Minimum-vol point", value: formatPercent(minVol.expectedReturn) + " / " + formatPercent(minVol.volatility) },
    {
      label: "Aligned window",
      value: analysis.stats.startPeriod && analysis.stats.endPeriod
        ? formatPeriodLabel(analysis.stats.startPeriod) + " to " + formatPeriodLabel(analysis.stats.endPeriod)
        : "-",
      small: true,
    },
    {
      label: "Min weight rounding",
      value: formatPercent(analysis.state.minWeightRoundingPercent / 100),
      small: true,
    },
  ];

  elements.portfolioCards.innerHTML = cards.map((card) => {
    const extraClass = card.small ? " small" : "";
    return `<div class="portfolio-stat"><span class="label">${escapeHtml(card.label)}</span><span class="value${extraClass}">${escapeHtml(card.value)}</span></div>`;
  }).join("");
}

function renderWeightsTable(analysis, selectedIndex) {
  if (analysis.frontier.length === 0) {
    elements.weightsTableBody.innerHTML = "";
    elements.weightPairsBox.value = "";
    setPills(elements.weightPills, []);
    return;
  }

  const rows = buildSelectedPortfolioRows(analysis, selectedIndex);

  elements.weightsTableBody.innerHTML = rows.map((row) => {
    return `<tr>
      <td class="symbol"><a href="https://finance.yahoo.com/quote/${encodeURIComponent(row.source.symbol)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.source.symbol)}</a></td>
      <td title="${escapeHtml(row.source.name)}">${escapeHtml(row.source.name)}</td>
      <td>${escapeHtml(row.source.sponsor || "-")}</td>
      <td class="numeric">${escapeHtml(formatPercent(row.weight))}</td>
      <td class="numeric">${escapeHtml(formatBillions(row.source.aumBillions))}</td>
      <td class="numeric">${escapeHtml(row.stats ? formatPercent(row.stats.expectedReturn) : "-")}</td>
      <td class="numeric">${escapeHtml(row.stats ? formatPercent(row.stats.volatility) : "-")}</td>
    </tr>`;
  }).join("");

  elements.weightPairsBox.value = rows
    .map((row) => `${row.source.symbol} ${formatPercent(row.weight)}`)
    .join("\n");

  setPills(elements.weightPills, [
    `Holdings: ${rows.length}`,
    `Weight cap: ${formatPercent(analysis.state.maxWeightPercent / 100)}`,
    `Min rounding: ${formatPercent(analysis.state.minWeightRoundingPercent / 100)}`,
    `Sum: ${formatPercent(rows.reduce((sum, row) => sum + row.weight, 0))}`,
  ]);
}

function renderMessages(analysis) {
  const messages = analysis.messages.slice();

  if (analysis.frontier.length > 0) {
    messages.unshift({
      type: "info",
      text: `Using a ${DATA_WINDOW_YEARS}Y backfilled window (${analysis.stats.commonMonths} months) across ${analysis.stats.alignedCount} ETFs, with ${analysis.stats.optimizationMonths} months used for the ${analysis.stats.horizonYears}Y optimization horizon.`,
    });
  }

  elements.messagePanel.innerHTML = messages.map((message) => {
    const className = message.type === "warning" || message.type === "error" ? message.type : "";
    return `<div class="message ${className}">${escapeHtml(message.text)}</div>`;
  }).join("");
}

async function copySelectedWeights() {
  if (!latestAnalysis || latestAnalysis.frontier.length === 0) {
    return;
  }

  const state = readControls();
  const selectedIndex = clampInteger(Number(elements.portfolioIndexRange.value), 0, latestAnalysis.frontier.length - 1, 0);
  const rows = buildSelectedPortfolioRows(latestAnalysis, selectedIndex);
  const csvLines = ["symbol,weight_percent,name"];

  rows.forEach((row) => {
    csvLines.push(`${row.source.symbol},${(row.weight * 100).toFixed(1)},"${row.source.name.replaceAll('"', '""')}"`);
  });

  const csvText = csvLines.join("\n");
  try {
    await navigator.clipboard.writeText(csvText);
    latestAnalysis.messages = [{ type: "info", text: "Copied selected weights to the clipboard as CSV." }].concat(
      latestAnalysis.messages.filter((message) => message.text !== "Copied selected weights to the clipboard as CSV."),
    );
    renderMessages(latestAnalysis);
  } catch {
    latestAnalysis.messages = [{ type: "warning", text: "Clipboard copy failed in this browser context." }].concat(latestAnalysis.messages);
    renderMessages(latestAnalysis);
  }
}

function selectFrontierIndex(index) {
  if (!latestAnalysis || latestAnalysis.frontier.length === 0) {
    return;
  }

  const state = readControls();
  state.selectedFrontierIndex = clampInteger(index, 0, latestAnalysis.frontier.length - 1, 0);
  elements.portfolioIndexRange.value = String(state.selectedFrontierIndex);
  persistControls(state);
  renderAnalysis(latestAnalysis, state);
}

function setPills(container, values) {
  container.innerHTML = values.map((value) => `<span class="pill">${escapeHtml(value)}</span>`).join("");
}

function buildRoundedSelectedPortfolio(analysis, selectedIndex) {
  const rawPoint = analysis.frontier[selectedIndex];
  const roundedWeights = roundWeightsToMinimumStep(rawPoint.weights, analysis.state.minWeightRoundingPercent / 100);
  return buildPortfolioPoint(roundedWeights, analysis.expectedReturns, analysis.covariance, analysis.stats.riskFreeRate);
}

function buildSelectedPortfolioRows(analysis, selectedIndex) {
  const selected = buildRoundedSelectedPortfolio(analysis, selectedIndex);
  const alignedIndexBySymbol = new Map(analysis.alignedAssets.map((asset, index) => [asset.source.symbol, index]));

  return analysis.filteredAssets.map((asset) => {
    const alignedIndex = alignedIndexBySymbol.get(asset.symbol);
    const stats = analysis.assetStatsBySymbol.get(asset.symbol);
    return {
      source: asset,
      weight: alignedIndex === undefined ? 0 : selected.weights[alignedIndex] || 0,
      stats,
    };
  }).filter((row) => row.weight > 0.0001);
}

function roundWeightsToMinimumStep(weights, minimumStep) {
  const sanitized = weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 0));
  const totalWeight = sanitized.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) {
    return sanitized;
  }

  const normalized = sanitized.map((weight) => weight / totalWeight);
  if (!Number.isFinite(minimumStep) || minimumStep <= 0) {
    return normalized;
  }

  const kept = normalized.map((weight) => (weight >= minimumStep ? weight : 0));
  if (kept.every((weight) => weight === 0)) {
    const maxIndex = normalized.reduce((bestIndex, weight, index, items) => {
      return weight > items[bestIndex] ? index : bestIndex;
    }, 0);
    kept[maxIndex] = 1;
    return kept;
  }

  const keptSum = kept.reduce((sum, weight) => sum + weight, 0);
  const renormalized = kept.map((weight) => weight / keptSum);
  const stepCount = Math.round(1 / minimumStep);
  if (Math.abs(stepCount * minimumStep - 1) > 1e-9) {
    return renormalized;
  }

  const candidates = renormalized.map((weight, index) => {
    const rawUnits = weight / minimumStep;
    return {
      index,
      rawUnits,
      units: Math.floor(rawUnits),
      remainder: rawUnits - Math.floor(rawUnits),
    };
  });

  let assignedUnits = candidates.reduce((sum, item) => sum + item.units, 0);
  let remainingUnits = Math.max(0, stepCount - assignedUnits);
  candidates.sort((left, right) => right.remainder - left.remainder);

  for (const item of candidates) {
    if (remainingUnits <= 0) {
      break;
    }
    item.units += 1;
    remainingUnits -= 1;
  }

  const rounded = Array.from({ length: weights.length }, () => 0);
  for (const item of candidates) {
    rounded[item.index] = item.units * minimumStep;
  }

  const roundedSum = rounded.reduce((sum, weight) => sum + weight, 0);
  if (roundedSum <= 0) {
    return renormalized;
  }
  return rounded.map((weight) => weight / roundedSum);
}

function buildTicks(minValue, maxValue, count) {
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || count < 2) {
    return [0];
  }

  const ticks = [];
  for (let index = 0; index < count; index += 1) {
    const ratio = index / Math.max(1, count - 1);
    ticks.push(minValue + ratio * (maxValue - minValue));
  }
  return ticks;
}

function parseTickerSymbols(rawValue) {
  return parseTickerEntries(rawValue).map((entry) => entry.symbol);
}

function parseTickerEntries(rawValue) {
  const normalized = String(rawValue || "")
    .toUpperCase()
    .replace(/[%]/g, "% ")
    .replace(/[,:;|/\\=]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = normalized.match(/[A-Z0-9._-]+|[-+]?\d*\.?\d+%?/g) || [];
  const bySymbol = new Map();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!isTickerToken(token)) {
      continue;
    }

    const entry = { symbol: token, expectedReturnPercent: null };
    const nextToken = tokens[index + 1];
    if (isExpectedReturnToken(nextToken)) {
      entry.expectedReturnPercent = parseExpectedReturnPercent(nextToken);
      index += 1;
    }

    bySymbol.set(entry.symbol, entry);
  }

  return [...bySymbol.values()];
}

function isTickerToken(token) {
  return typeof token === "string" && /^(?=.*[A-Z])[A-Z0-9._-]{1,15}$/.test(token);
}

function isExpectedReturnToken(token) {
  return typeof token === "string" && /^[-+]?\d*\.?\d+%?$/.test(token);
}

function parseExpectedReturnPercent(token) {
  const rawToken = String(token || "").trim();
  const hasPercentSuffix = rawToken.endsWith("%");
  const numericValue = Number(rawToken.replace(/%/g, ""));
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  if (hasPercentSuffix) {
    return numericValue;
  }

  return Math.abs(numericValue) <= 1 ? numericValue * 100 : numericValue;
}

function buildExpectedReturnOverrideMap(entries) {
  const map = new Map();
  for (const entry of entries) {
    if (entry && entry.symbol && Number.isFinite(entry.expectedReturnPercent)) {
      map.set(entry.symbol, entry.expectedReturnPercent);
    }
  }
  return map;
}

function sanitizeExpectedReturnOverrides(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  const sanitized = {};
  Object.entries(value).forEach(([symbol, rawExpectedReturn]) => {
    const normalizedSymbol = String(symbol || "").toUpperCase();
    const numericValue = Number(rawExpectedReturn);
    if (isTickerToken(normalizedSymbol) && Number.isFinite(numericValue)) {
      sanitized[normalizedSymbol] = numericValue;
    }
  });
  return sanitized;
}

function resolveExpectedReturn(asset, horizonYears, series, storedOverrides, parsedOverrides) {
  const storedPercent = Number(storedOverrides?.[asset.symbol]);
  if (Number.isFinite(storedPercent)) {
    return storedPercent / 100;
  }

  const parsedPercent = parsedOverrides.get(asset.symbol);
  if (Number.isFinite(parsedPercent)) {
    return parsedPercent / 100;
  }

  return getDefaultExpectedReturn(asset, horizonYears, series);
}

function getDefaultExpectedReturn(asset, horizonYears, series) {
  const metricValue = getLookbackAnnualReturn(asset, horizonYears);
  if (Number.isFinite(metricValue)) {
    return metricValue / 100;
  }

  const fallback = annualizedMeanReturn(series);
  return Number.isFinite(fallback) ? fallback : 0;
}

function getLookbackAnnualReturn(asset, horizonYears) {
  if (!asset || typeof asset !== "object") {
    return null;
  }

  switch (Number(horizonYears)) {
    case 1:
      return Number.isFinite(asset.ar1Y) ? asset.ar1Y : null;
    case 3:
      return Number.isFinite(asset.ar3Y) ? asset.ar3Y : null;
    case 5:
      return Number.isFinite(asset.ar5Y) ? asset.ar5Y : null;
    case 10:
      return Number.isFinite(asset.ar10Y) ? asset.ar10Y : null;
    default:
      return null;
  }
}

function toAllowedHorizon(value, fallback) {
  return [1, 3, 5, 10].includes(Number(value)) ? Number(value) : fallback;
}

function normalizeNumber(value, fallback) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function clampNumber(value, minValue, maxValue, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maxValue, Math.max(minValue, value));
}

function clampInteger(value, minValue, maxValue, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maxValue, Math.max(minValue, Math.round(value)));
}

function mean(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatPercent(value, decimals = 1) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  return `${(value * 100).toFixed(decimals)}%`;
}

function formatPercentNumber(value) {
  return Number.isFinite(value) ? `${Number(value).toFixed(1)}%` : "-";
}

function formatEditorPercent(value) {
  if (!Number.isFinite(value)) {
    return "";
  }
  return (value * 100).toFixed(1);
}

function formatExplicitEditorPercent(value) {
  if (!Number.isFinite(value)) {
    return "";
  }
  return Number(value).toFixed(1);
}

function formatSharpe(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "-";
}

function formatInteger(value) {
  return Number.isFinite(value) ? Number(value).toLocaleString("en-US") : "-";
}

function formatBillions(value) {
  return Number.isFinite(value) ? Number(value).toFixed(2) : "-";
}

function formatPeriodLabel(period) {
  if (!period) {
    return "-";
  }

  const [yearText, monthText] = String(period).split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    return String(period);
  }

  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildEmptyStats() {
  return {
    horizonYears: 0,
    candidateCount: 0,
    alignedCount: 0,
    commonMonths: 0,
    optimizationMonths: 0,
    backfilledMonths: 0,
    startPeriod: null,
    endPeriod: null,
    riskFreeRate: 0,
  };
}

function buildSelectedUniverseRows({
  requestedEntries,
  filteredAssets,
  allAssetLookup,
  filteredLookup,
  alignedSeriesBySymbol,
  alignedLookup,
  horizonYears,
  storedOverrides,
  parsedOverrides,
}) {
  if (!Array.isArray(requestedEntries) || requestedEntries.length === 0) {
    return Array.isArray(filteredAssets) ? filteredAssets.map((asset) => {
      const series = alignedSeriesBySymbol.get(asset.symbol) || [];
      return {
        symbol: asset.symbol,
        explicitExpectedReturnPercent: Number.isFinite(storedOverrides?.[asset.symbol]) ? Number(storedOverrides[asset.symbol]) : null,
        name: asset.name || "-",
        category: asset.category || "-",
        sponsor: asset.sponsor || "-",
        defaultExpectedReturn: getDefaultExpectedReturn(asset, horizonYears, series),
        appliedExpectedReturn: resolveExpectedReturn(asset, horizonYears, series, storedOverrides, parsedOverrides),
        isKnownAsset: true,
        passesFilters: true,
        isAligned: alignedLookup.has(asset.symbol),
      };
    }) : [];
  }

  return requestedEntries.map((entry) => {
    const asset = allAssetLookup.get(entry.symbol) || null;
    const series = alignedSeriesBySymbol.get(entry.symbol) || [];
    const defaultExpectedReturn = asset ? getDefaultExpectedReturn(asset, horizonYears, series) : null;
    const appliedExpectedReturn = asset
      ? resolveExpectedReturn(asset, horizonYears, series, storedOverrides, parsedOverrides)
      : (Number.isFinite(entry.expectedReturnPercent) ? entry.expectedReturnPercent / 100 : null);

    return {
      symbol: entry.symbol,
      explicitExpectedReturnPercent: Number.isFinite(entry.expectedReturnPercent) ? entry.expectedReturnPercent : null,
      name: asset?.name || "-",
      category: asset?.category || "-",
      sponsor: asset?.sponsor || "-",
      defaultExpectedReturn,
      appliedExpectedReturn,
      isKnownAsset: asset !== null,
      passesFilters: filteredLookup.has(entry.symbol),
      isAligned: alignedLookup.has(entry.symbol),
    };
  });
}

function syncSelectedUniverseEditorToSymbolsInput(commit) {
  const rows = Array.from(elements.expectedReturnTableBody.querySelectorAll("tr"));
  const entries = [];

  rows.forEach((row) => {
    const symbolInput = row.querySelector('[data-editor-field="symbol"]');
    const expectedReturnInput = row.querySelector('[data-editor-field="expectedReturn"]');
    const symbol = String(symbolInput?.value || "").trim().toUpperCase();
    const rawExpectedReturn = String(expectedReturnInput?.value || "").trim();

    if (!symbol || !isTickerToken(symbol)) {
      return;
    }

    entries.push({
      symbol,
      expectedReturnPercent: rawExpectedReturn === "" ? null : parseExpectedReturnPercent(rawExpectedReturn),
    });
  });

  const serialized = serializeTickerEntries(entries);
  if (elements.symbolsInput.value !== serialized) {
    elements.symbolsInput.value = serialized;
  }
  syncExpectedReturnOverridesFromSymbols(serialized);

  if (commit) {
    clearScheduledRecalculate();
    recalculate(true);
  } else {
    scheduleAutoRecalculate();
  }
}

function serializeTickerEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "";
  }

  return entries.map((entry) => {
    if (!Number.isFinite(entry.expectedReturnPercent)) {
      return entry.symbol;
    }
    return `${entry.symbol} ${formatExplicitEditorPercent(entry.expectedReturnPercent)}`;
  }).join("\n");
}