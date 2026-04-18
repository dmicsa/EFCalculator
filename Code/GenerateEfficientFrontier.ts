import YahooFinance from "npm:yahoo-finance2";

type HorizonYears = 1 | 3 | 5 | 10;

type FlatEtfRow = {
  symbol: string;
  name: string;
  exchange: string | null;
  category: string | null;
  sponsor: string | null;
  aumBillions: number | null;
  ar1Y: number | null;
  sr1Y: number | null;
  sd1Y: number | null;
  ar3Y: number | null;
  sr3Y: number | null;
  sd3Y: number | null;
  ar5Y: number | null;
  sr5Y: number | null;
  sd5Y: number | null;
  ar10Y: number | null;
  sr10Y: number | null;
  sd10Y: number | null;
};

type PricePoint = {
  date: Date;
  close: number;
};

type MonthlyReturnPoint = {
  period: string;
  value: number;
};

type ComputedMetrics = {
  annualizedReturn: number | null;
  annualizedStdDev: number | null;
  sharpeRatio: number | null;
};

type PreparedEtfRow = FlatEtfRow & {
  monthlyReturns: Array<[string, number]>;
  historyStart: string | null;
  historyEnd: string | null;
  monthlyObservationCount: number;
};

type MetricKey = Exclude<
  keyof FlatEtfRow,
  "symbol" | "name" | "exchange" | "category" | "sponsor" | "aumBillions"
>;

type CliOptions = {
  outputPath: string;
  cachePath: string;
  symbols: Set<string> | null;
};

type UniverseEntry = {
  symbol: string;
  companyName: string | null;
  screenerOneYearPercentage: number | null;
};

type CachedAssetData = {
  schemaVersion: number;
  updatedAt: string;
  aumBillions: number | null;
  category: string | null;
  sponsor: string | null;
  ar1Y: number | null;
  sr1Y: number | null;
  sd1Y: number | null;
  ar3Y: number | null;
  sr3Y: number | null;
  sd3Y: number | null;
  ar5Y: number | null;
  sr5Y: number | null;
  sd5Y: number | null;
  ar10Y: number | null;
  sr10Y: number | null;
  sd10Y: number | null;
  monthlyReturns: Array<[string, number]>;
  historyStart: string | null;
  historyEnd: string | null;
};

const OUTPUT_PATH = "./EfficientFrontier.html";
const CACHE_PATH = "./Code/cache.json";
const INFO_PATH = "./Code/Info.md";
const THEME_PATH = "./Code/frontier-theme.css";
const APP_PATH = "./Code/frontier-app.js";
const CACHE_VERSION = 1;
const NASDAQ_ETF_SCREENER_URL = "https://api.nasdaq.com/api/screener/etf?download=true";
const QUOTE_BATCH_SIZE = 100;
const QUOTE_BATCH_CONCURRENCY = 4;
const ENRICH_CONCURRENCY = 8;
const CACHE_TTL_HOURS = 72;
const HISTORY_BUFFER_YEARS = 16;
const OUTPUT_WINDOW_YEARS = 15;
const OUTPUT_WINDOW_MONTHS = OUTPUT_WINDOW_YEARS * 12;
const MIN_OUTPUT_AUM_BILLIONS = 0.5;
const MIN_OUTPUT_SR10Y = 0.5;
const MIN_ACTIVITY_YEARS = 10;
const MIN_ACTIVITY_MONTHS = MIN_ACTIVITY_YEARS * 12;
const SIMILARITY_THRESHOLD = 0.03;
const EXCLUDED_SYMBOLS = new Set(["SGOL", "GLDM", "BAR"]);
const ALWAYS_INCLUDE_SYMBOLS = new Set(["EUO", "TLT", "LQD", "HYG"]);
const SECTOR_CATEGORY_NAMES = new Set([
  "communications",
  "consumer cyclical",
  "consumer defensive",
  "equity energy",
  "financial",
  "health",
  "industrials",
  "natural resources",
  "real estate",
  "technology",
  "utilities",
]);
const DEDUPE_METRIC_KEYS: MetricKey[] = [
  "ar1Y",
  "sr1Y",
  "sd1Y",
  "ar3Y",
  "sr3Y",
  "sd3Y",
  "ar5Y",
  "sr5Y",
  "sd5Y",
  "ar10Y",
  "sr10Y",
  "sd10Y",
];
const NASDAQ_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  origin: "https://www.nasdaq.com",
  referer: "https://www.nasdaq.com/market-activity/etf/screener",
};

const yahooFinance = new YahooFinance();

async function main() {
  const options = parseArgs(Deno.args);
  const [infoText, themeCssText, appJsText] = await Promise.all([
    readInfoText(INFO_PATH),
    Deno.readTextFile(THEME_PATH),
    Deno.readTextFile(APP_PATH),
  ]);
  const cache = await readCache(options.cachePath);
  const fullUniverse = await fetchNasdaqUniverse();
  const selectedUniverse = fullUniverse.filter((entry) => {
    if (!options.symbols) {
      return !EXCLUDED_SYMBOLS.has(entry.symbol);
    }

    return options.symbols.has(entry.symbol) && !EXCLUDED_SYMBOLS.has(entry.symbol);
  });

  if (selectedUniverse.length === 0) {
    throw new Error("No ETF symbols selected for the efficient frontier run.");
  }

  console.log(`Fetched ${selectedUniverse.length} ETFs from the Nasdaq screener.`);
  const quoteMap = await fetchQuoteMap(selectedUniverse.map((entry) => entry.symbol));
  const baseRows = selectedUniverse.map((entry) => buildBaseRow(entry, quoteMap.get(entry.symbol)));

  const refreshCount = baseRows.filter((row) => !isCacheFresh(cache[row.symbol])).length;
  console.log(`Refreshing ${refreshCount} ETF histories and enrichments...`);

  const enriched = await mapLimit(baseRows, ENRICH_CONCURRENCY, async (row) => {
    const currentCache = cache[row.symbol];
    if (isCacheFresh(currentCache)) {
      return { symbol: row.symbol, enrichment: currentCache };
    }

    try {
      return {
        symbol: row.symbol,
        enrichment: await enrichEtfRow(row),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Enrichment fallback for ${row.symbol}: ${message}`);
      return {
        symbol: row.symbol,
        enrichment: currentCache ?? null,
      };
    }
  });

  for (const result of enriched) {
    if (result.enrichment) {
      cache[result.symbol] = result.enrichment;
    }
  }

  await writeCache(options.cachePath, cache);

  const preparedRows = baseRows
    .map((row) => applyEnrichment(row, cache[row.symbol]))
    .sort((left, right) => (right.aumBillions ?? -1) - (left.aumBillions ?? -1));
  const eligibleRows = preparedRows.filter(isEligibleOutputRow);
  const rows = dedupeSimilarRows(eligibleRows);

  const generatedAt = formatGeneratedAt(new Date());
  const html = renderHtml({
    rows,
    infoText,
    themeCssText,
    appJsText,
    generatedAt,
    rawUniverseCount: fullUniverse.length,
    enrichedCount: preparedRows.length,
  });
  await Deno.writeTextFile(options.outputPath, html);

  console.log(`Written: ${options.outputPath}`);
  console.log(`Eligible rows after 10Y activity plus (SR10Y > 0.5 or AUM > $0.5B) filter, with explicit keeps for EUO/TLT/LQD/HYG and sector ETFs: ${eligibleRows.length}/${preparedRows.length}`);
  console.log(`Rows after similarity pruning: ${rows.length}/${eligibleRows.length}`);
}

function buildBaseRow(entry: UniverseEntry, quoteData: Record<string, unknown> | undefined): FlatEtfRow {
  return {
    symbol: entry.symbol,
    name:
      toNullableString(quoteData?.["longName"])
      ?? toNullableString(quoteData?.["shortName"])
      ?? entry.companyName
      ?? entry.symbol,
    exchange:
      toNullableString(quoteData?.["fullExchangeName"])
      ?? toNullableString(quoteData?.["exchange"]),
    category: null,
    sponsor: null,
    aumBillions: toBillions(toNullableNumber(quoteData?.["netAssets"])),
    ar1Y: entry.screenerOneYearPercentage,
    sr1Y: null,
    sd1Y: null,
    ar3Y: null,
    sr3Y: null,
    sd3Y: null,
    ar5Y: null,
    sr5Y: null,
    sd5Y: null,
    ar10Y: null,
    sr10Y: null,
    sd10Y: null,
  };
}

async function fetchNasdaqUniverse(): Promise<UniverseEntry[]> {
  const response = await fetch(NASDAQ_ETF_SCREENER_URL, {
    headers: NASDAQ_HEADERS,
  });
  if (!response.ok) {
    throw new Error(`Nasdaq ETF screener request failed with ${response.status}`);
  }

  const payload = asObject(await response.json());
  const data = asObject(payload["data"]);
  const screenerData = asObject(data["data"]);
  const rows = Array.isArray(screenerData["rows"]) ? screenerData["rows"] : [];

  return rows
    .map((row) => {
      const record = asObject(row);
      const symbol = toNullableString(record["symbol"]);
      if (!symbol) {
        return null;
      }

      return {
        symbol,
        companyName: toNullableString(record["companyName"]),
        screenerOneYearPercentage: parseLooseNumber(record["oneYearPercentage"]),
      } satisfies UniverseEntry;
    })
    .filter((entry): entry is UniverseEntry => entry !== null);
}

async function fetchQuoteMap(symbols: string[]): Promise<Map<string, Record<string, unknown>>> {
  const uniqueSymbols = [...new Set(symbols)];
  const chunks = chunkArray(uniqueSymbols, QUOTE_BATCH_SIZE);
  const quoteMap = new Map<string, Record<string, unknown>>();

  await mapLimit(chunks, QUOTE_BATCH_CONCURRENCY, async (chunk) => {
    try {
      const quoteResponse: unknown = await yahooFinance.quote(chunk);
      const quotes = Array.isArray(quoteResponse) ? quoteResponse : [];
      for (const item of quotes) {
        const record = asObject(item);
        const symbol = toNullableString(record["symbol"]);
        if (symbol) {
          quoteMap.set(symbol, record);
        }
      }
    } catch {
      await mapLimit(chunk, Math.min(10, chunk.length), async (symbol) => {
        try {
          const quoteResponse: unknown = await yahooFinance.quote(symbol);
          const record = asObject(quoteResponse);
          const resolvedSymbol = toNullableString(record["symbol"]);
          if (resolvedSymbol) {
            quoteMap.set(resolvedSymbol, record);
          }
        } catch {
          // Keep the row from the Nasdaq universe even when the quote API misses it.
        }
      });
    }
  });

  return quoteMap;
}

async function enrichEtfRow(baseRow: FlatEtfRow): Promise<CachedAssetData> {
  const symbol = baseRow.symbol;
  let stats: Record<string, unknown> = {};
  let performance: Record<string, unknown> = {};

  try {
    const quoteSummary = await yahooFinance.quoteSummary(symbol, {
      modules: ["defaultKeyStatistics", "fundPerformance", "price", "quoteType"],
    });
    stats = asObject(quoteSummary.defaultKeyStatistics);
    performance = asObject(quoteSummary.fundPerformance);
  } catch {
    // History-driven metrics are still usable even when quoteSummary is unavailable.
  }

  const trailingReturns = asObject(performance["trailingReturns"]);
  const riskLookup = getRiskStatisticsLookup(performance["riskOverviewStatistics"]);
  const history = await yahooFinance.historical(symbol, {
    period1: subtractYears(new Date(), HISTORY_BUFFER_YEARS),
    period2: new Date(),
    interval: "1d",
  });

  const points = normalizeHistory(history);
  const monthlyReturns = computeMonthlyReturns(points);
  const metrics1Y = computeMetrics(points, 1);
  const metrics3Y = computeMetrics(points, 3);
  const metrics5Y = computeMetrics(points, 5);
  const metrics10Y = computeMetrics(points, 10);

  return {
    schemaVersion: CACHE_VERSION,
    updatedAt: new Date().toISOString(),
    aumBillions:
      toBillions(toNullableNumber(stats["totalAssets"]))
      ?? baseRow.aumBillions,
    category: toNullableString(performance["fundCategoryName"]) ?? toNullableString(stats["category"]),
    sponsor: toNullableString(stats["fundFamily"]),
    ar1Y:
      toPercent(metrics1Y.annualizedReturn)
      ?? toPercent(toNullableNumber(trailingReturns["oneYear"]))
      ?? baseRow.ar1Y,
    sr1Y: roundValue(metrics1Y.sharpeRatio, 2),
    sd1Y: toPercent(metrics1Y.annualizedStdDev),
    ar3Y:
      toPercent(metrics3Y.annualizedReturn)
      ?? toPercent(toNullableNumber(trailingReturns["threeYear"])),
    sr3Y:
      roundValue(metrics3Y.sharpeRatio, 2)
      ?? roundValue(toNullableNumber(riskLookup.get("3y")?.["sharpeRatio"]), 2),
    sd3Y:
      toPercent(metrics3Y.annualizedStdDev)
      ?? roundValue(toNullableNumber(riskLookup.get("3y")?.["stdDev"]), 2),
    ar5Y:
      toPercent(metrics5Y.annualizedReturn)
      ?? toPercent(toNullableNumber(trailingReturns["fiveYear"])),
    sr5Y:
      roundValue(metrics5Y.sharpeRatio, 2)
      ?? roundValue(toNullableNumber(riskLookup.get("5y")?.["sharpeRatio"]), 2),
    sd5Y:
      toPercent(metrics5Y.annualizedStdDev)
      ?? roundValue(toNullableNumber(riskLookup.get("5y")?.["stdDev"]), 2),
    ar10Y:
      toPercent(metrics10Y.annualizedReturn)
      ?? toPercent(toNullableNumber(trailingReturns["tenYear"])),
    sr10Y:
      roundValue(metrics10Y.sharpeRatio, 2)
      ?? roundValue(toNullableNumber(riskLookup.get("10y")?.["sharpeRatio"]), 2),
    sd10Y:
      toPercent(metrics10Y.annualizedStdDev)
      ?? roundValue(toNullableNumber(riskLookup.get("10y")?.["stdDev"]), 2),
    monthlyReturns: monthlyReturns.map((point) => [point.period, roundValue(point.value, 8) ?? 0]),
    historyStart: monthlyReturns[0]?.period ?? null,
    historyEnd: monthlyReturns.at(-1)?.period ?? null,
  };
}

function getRiskStatisticsLookup(riskOverview: unknown): Map<string, Record<string, unknown>> {
  const lookup = new Map<string, Record<string, unknown>>();
  const riskOverviewObject = asObject(riskOverview);
  const riskStatistics = Array.isArray(riskOverviewObject["riskStatistics"])
    ? riskOverviewObject["riskStatistics"]
    : [];

  for (const entry of riskStatistics) {
    const record = asObject(entry);
    const year = toNullableString(record["year"]);
    if (year) {
      lookup.set(year.toLowerCase(), record);
    }
  }

  return lookup;
}

function applyEnrichment(row: FlatEtfRow, enrichment: CachedAssetData | undefined): PreparedEtfRow {
  const sponsor = preferValue(enrichment?.sponsor, row.sponsor);
  const monthlyReturns = Array.isArray(enrichment?.monthlyReturns)
    ? enrichment.monthlyReturns
      .map((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2) {
          return null;
        }
        const period = typeof entry[0] === "string" ? entry[0] : null;
        const value = typeof entry[1] === "number" && Number.isFinite(entry[1]) ? entry[1] : null;
        return period !== null && value !== null ? [period, value] as [string, number] : null;
      })
      .filter((entry): entry is [string, number] => entry !== null)
    : [];
  const embeddedMonthlyReturns = trimTrailingMonthlyReturns(monthlyReturns, OUTPUT_WINDOW_MONTHS);

  return {
    ...row,
    name: normalizeFundName(row.name, sponsor),
    aumBillions: preferValue(enrichment?.aumBillions, row.aumBillions),
    category: preferValue(enrichment?.category, row.category),
    sponsor,
    ar1Y: preferValue(enrichment?.ar1Y, row.ar1Y),
    sr1Y: preferValue(enrichment?.sr1Y, row.sr1Y),
    sd1Y: preferValue(enrichment?.sd1Y, row.sd1Y),
    ar3Y: preferValue(enrichment?.ar3Y, row.ar3Y),
    sr3Y: preferValue(enrichment?.sr3Y, row.sr3Y),
    sd3Y: preferValue(enrichment?.sd3Y, row.sd3Y),
    ar5Y: preferValue(enrichment?.ar5Y, row.ar5Y),
    sr5Y: preferValue(enrichment?.sr5Y, row.sr5Y),
    sd5Y: preferValue(enrichment?.sd5Y, row.sd5Y),
    ar10Y: preferValue(enrichment?.ar10Y, row.ar10Y),
    sr10Y: preferValue(enrichment?.sr10Y, row.sr10Y),
    sd10Y: preferValue(enrichment?.sd10Y, row.sd10Y),
    monthlyReturns: embeddedMonthlyReturns,
    historyStart: embeddedMonthlyReturns[0]?.[0] ?? null,
    historyEnd: embeddedMonthlyReturns.at(-1)?.[0] ?? null,
    monthlyObservationCount: embeddedMonthlyReturns.length,
  };
}

function trimTrailingMonthlyReturns(monthlyReturns: Array<[string, number]>, maxPoints: number): Array<[string, number]> {
  if (monthlyReturns.length <= maxPoints) {
    return monthlyReturns;
  }

  return monthlyReturns.slice(-maxPoints);
}

function isEligibleOutputRow(row: PreparedEtfRow): boolean {
  const has10YActivity = row.monthlyObservationCount >= MIN_ACTIVITY_MONTHS;
  const meetsSharpeGate = (row.sr10Y ?? -Infinity) > MIN_OUTPUT_SR10Y;
  const meetsAumGate = (row.aumBillions ?? -Infinity) > MIN_OUTPUT_AUM_BILLIONS;
  return has10YActivity && (meetsSharpeGate || meetsAumGate || shouldAlwaysKeepRow(row));
}

function shouldAlwaysKeepRow(row: PreparedEtfRow): boolean {
  return ALWAYS_INCLUDE_SYMBOLS.has(row.symbol) || isSectorCategory(row.category);
}

function isSectorCategory(category: string | null): boolean {
  if (typeof category !== "string") {
    return false;
  }

  return SECTOR_CATEGORY_NAMES.has(category.trim().toLowerCase());
}

function dedupeSimilarRows(rows: PreparedEtfRow[]): PreparedEtfRow[] {
  const sortedRows = rows.slice().sort((left, right) => (right.aumBillions ?? -Infinity) - (left.aumBillions ?? -Infinity));
  const keptRows: PreparedEtfRow[] = [];

  for (const candidate of sortedRows) {
    const hasSimilarRow = shouldAlwaysKeepRow(candidate)
      ? false
      : keptRows.some((kept) => areRowsTooSimilar(candidate, kept));
    if (!hasSimilarRow) {
      keptRows.push(candidate);
    }
  }

  return keptRows;
}

function areRowsTooSimilar(candidate: FlatEtfRow, kept: FlatEtfRow): boolean {
  let comparableMetricCount = 0;

  for (const metricKey of DEDUPE_METRIC_KEYS) {
    const candidateValue = candidate[metricKey];
    const keptValue = kept[metricKey];
    if (candidateValue === null || keptValue === null || Number.isNaN(candidateValue) || Number.isNaN(keptValue)) {
      continue;
    }

    comparableMetricCount += 1;
    if (hasRelativeDifferenceAboveThreshold(candidateValue, keptValue, SIMILARITY_THRESHOLD)) {
      return false;
    }
  }

  return comparableMetricCount > 0;
}

function hasRelativeDifferenceAboveThreshold(value: number, reference: number, threshold: number): boolean {
  if (Math.abs(reference) < 1e-9) {
    return Math.abs(value) > 1e-9;
  }

  return Math.abs(value / reference - 1) > threshold;
}

function normalizeHistory(history: unknown[]): PricePoint[] {
  return history
    .map((entry) => {
      const row = entry as Record<string, unknown>;
      const rawDate = row.date;
      const rawClose = toNullableNumber(row.adjClose) ?? toNullableNumber(row.close);
      if (!(rawDate instanceof Date) || rawClose === null || rawClose <= 0) {
        return null;
      }

      return {
        date: rawDate,
        close: rawClose,
      };
    })
    .filter((point): point is PricePoint => point !== null)
    .sort((left, right) => left.date.getTime() - right.date.getTime());
}

function computeMonthlyReturns(points: PricePoint[]): MonthlyReturnPoint[] {
  const monthEndPoints = new Map<string, PricePoint>();

  for (const point of points) {
    const period = toPeriodKey(point.date);
    const existing = monthEndPoints.get(period);
    if (!existing || point.date > existing.date) {
      monthEndPoints.set(period, point);
    }
  }

  const orderedMonths = [...monthEndPoints.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map((entry) => entry[1]);
  const monthlyReturns: MonthlyReturnPoint[] = [];

  for (let index = 1; index < orderedMonths.length; index += 1) {
    const previous = orderedMonths[index - 1];
    const current = orderedMonths[index];
    const value = current.close / previous.close - 1;
    if (Number.isFinite(value)) {
      monthlyReturns.push({
        period: toPeriodKey(current.date),
        value,
      });
    }
  }

  return monthlyReturns;
}

function computeMetrics(points: PricePoint[], years: HorizonYears): ComputedMetrics {
  const endPoint = points.at(-1);
  if (!endPoint) {
    return emptyMetrics();
  }

  const cutoff = new Date(endPoint.date);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  const startIndex = points.findIndex((point) => point.date >= cutoff);
  if (startIndex < 0) {
    return emptyMetrics();
  }

  const slice = points.slice(startIndex);
  if (slice.length < Math.max(40, years * 126)) {
    return emptyMetrics();
  }

  const startPoint = slice[0];
  const spanYears = (endPoint.date.getTime() - startPoint.date.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  if (spanYears < years * 0.85 || startPoint.close <= 0 || endPoint.close <= 0) {
    return emptyMetrics();
  }

  const dailyReturns: number[] = [];
  for (let index = 1; index < slice.length; index += 1) {
    const previousClose = slice[index - 1].close;
    const currentClose = slice[index].close;
    const dailyReturn = currentClose / previousClose - 1;
    if (Number.isFinite(dailyReturn)) {
      dailyReturns.push(dailyReturn);
    }
  }

  if (dailyReturns.length < Math.max(30, years * 126 - 1)) {
    return emptyMetrics();
  }

  const annualizedReturn = Math.pow(endPoint.close / startPoint.close, 1 / spanYears) - 1;
  const meanDailyReturn = mean(dailyReturns);
  const stdDailyReturn = standardDeviation(dailyReturns);
  const annualizedStdDev = stdDailyReturn * Math.sqrt(252);
  const annualizedMeanReturn = meanDailyReturn * 252;
  const sharpeRatio = annualizedStdDev > 0 ? annualizedMeanReturn / annualizedStdDev : null;

  return {
    annualizedReturn: Number.isFinite(annualizedReturn) ? annualizedReturn : null,
    annualizedStdDev: Number.isFinite(annualizedStdDev) ? annualizedStdDev : null,
    sharpeRatio: sharpeRatio !== null && Number.isFinite(sharpeRatio) ? sharpeRatio : null,
  };
}

function emptyMetrics(): ComputedMetrics {
  return {
    annualizedReturn: null,
    annualizedStdDev: null,
    sharpeRatio: null,
  };
}

function parseArgs(args: string[]): CliOptions {
  let outputPath = OUTPUT_PATH;
  let cachePath = CACHE_PATH;
  let symbols: Set<string> | null = null;

  for (const arg of args) {
    if (arg.startsWith("--output=")) {
      outputPath = arg.slice("--output=".length);
      continue;
    }
    if (arg.startsWith("--cache=")) {
      cachePath = arg.slice("--cache=".length);
      continue;
    }
    if (arg.startsWith("--symbols=")) {
      symbols = new Set(parseTickerSymbols(arg.slice("--symbols=".length)));
    }
  }

  return {
    outputPath,
    cachePath,
    symbols,
  };
}

function parseTickerSymbols(rawValue: string): string[] {
  const matches = rawValue.match(/[A-Za-z0-9._-]+/g) ?? [];
  return [...new Set(matches.map((value) => value.trim().toUpperCase()).filter((value) => value.length > 0))];
}

async function readInfoText(path: string): Promise<string> {
  try {
    const text = await Deno.readTextFile(path);
    return normalizeInfoMarkdown(text) || "Efficient Frontier Calculator";
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return "Efficient Frontier Calculator";
    }

    throw error;
  }
}

function normalizeInfoMarkdown(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return "";
  }

  const firstLine = lines[0];
  const headingMatch = firstLine.match(/^#\s+(.+)$/);
  if (!headingMatch) {
    return lines.join(" ");
  }

  const heading = headingMatch[1].trim();
  const remainder = lines.slice(1).join(" ");
  return remainder ? `${heading}, ${remainder}` : heading;
}

async function readCache(path: string): Promise<Record<string, CachedAssetData>> {
  try {
    const text = await Deno.readTextFile(path);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([symbol, value]) => {
        const entry = sanitizeCacheEntry(value);
        return entry ? [[symbol, entry]] : [];
      }),
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {};
    }

    throw error;
  }
}

async function writeCache(path: string, cache: Record<string, CachedAssetData>): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(cache, null, 2));
}

function sanitizeCacheEntry(value: unknown): CachedAssetData | null {
  const record = asObject(value);
  const schemaVersion = toNullableNumber(record["schemaVersion"]);
  const updatedAt = toNullableString(record["updatedAt"]);
  const rawMonthlyReturns = Array.isArray(record["monthlyReturns"]) ? record["monthlyReturns"] : [];
  const monthlyReturns = rawMonthlyReturns
    .map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2) {
        return null;
      }
      const period = typeof entry[0] === "string" ? entry[0] : null;
      const monthlyReturn = typeof entry[1] === "number" && Number.isFinite(entry[1]) ? entry[1] : null;
      return period !== null && monthlyReturn !== null ? [period, monthlyReturn] : null;
    })
    .filter((entry): entry is [string, number] => entry !== null);

  if (schemaVersion === null || updatedAt === null || monthlyReturns.length === 0) {
    return null;
  }

  return {
    schemaVersion,
    updatedAt,
    aumBillions: toNullableNumber(record["aumBillions"]),
    category: toNullableString(record["category"]),
    sponsor: toNullableString(record["sponsor"]),
    ar1Y: toNullableNumber(record["ar1Y"]),
    sr1Y: toNullableNumber(record["sr1Y"]),
    sd1Y: toNullableNumber(record["sd1Y"]),
    ar3Y: toNullableNumber(record["ar3Y"]),
    sr3Y: toNullableNumber(record["sr3Y"]),
    sd3Y: toNullableNumber(record["sd3Y"]),
    ar5Y: toNullableNumber(record["ar5Y"]),
    sr5Y: toNullableNumber(record["sr5Y"]),
    sd5Y: toNullableNumber(record["sd5Y"]),
    ar10Y: toNullableNumber(record["ar10Y"]),
    sr10Y: toNullableNumber(record["sr10Y"]),
    sd10Y: toNullableNumber(record["sd10Y"]),
    monthlyReturns,
    historyStart: toNullableString(record["historyStart"]),
    historyEnd: toNullableString(record["historyEnd"]),
  };
}

function isCacheFresh(entry: CachedAssetData | undefined): boolean {
  if (!entry) {
    return false;
  }
  if (entry.schemaVersion !== CACHE_VERSION || entry.monthlyReturns.length === 0) {
    return false;
  }

  const updatedAt = Date.parse(entry.updatedAt);
  if (Number.isNaN(updatedAt)) {
    return false;
  }

  return Date.now() - updatedAt <= CACHE_TTL_HOURS * 60 * 60 * 1000;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }

  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function toBillions(value: number | null): number | null {
  return value === null ? null : roundValue(value / 1_000_000_000, 2);
}

function toPercent(value: number | null): number | null {
  return value === null ? null : roundValue(value * 100, 2);
}

function roundValue(value: number | null, decimals: number): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseLooseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value
    .replaceAll(",", "")
    .replaceAll("$", "")
    .replaceAll("%", "")
    .trim();
  if (!normalized || normalized === "N/A") {
    return null;
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function preferValue<T>(preferred: T | null | undefined, fallback: T | null): T | null {
  return preferred ?? fallback;
}

function cleanupFundName(value: string): string {
  return value
    .replace(/^[\s,;:()\-]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeFundName(name: string, sponsor: string | null): string {
  const withoutEtf = cleanupFundName(name.replace(/\bETF\b/gi, ""));
  let normalized = withoutEtf;

  for (const sponsorVariant of getSponsorNameVariants(sponsor)) {
    const sponsorWords = sponsorVariant.split(/\s+/).filter((value) => value.length > 0);
    const normalizedWords = normalized.split(/\s+/).filter((value) => value.length > 0);
    if (
      sponsorWords.length > 0
      && sponsorWords.length <= normalizedWords.length
      && sponsorWords.every((word, index) => normalizedWords[index].toLowerCase() === word.toLowerCase())
    ) {
      normalized = cleanupFundName(normalizedWords.slice(sponsorWords.length).join(" "));
    }
  }

  normalized = cleanupFundName(normalized);
  return normalized || withoutEtf;
}

function getSponsorNameVariants(sponsor: string | null): string[] {
  if (!sponsor) {
    return [];
  }

  const trimmed = sponsor.trim();
  const simplified = trimmed
    .replace(/\b(ETFs?|Funds?|Investments?|Management|Advisors?|Assets?)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return uniqueStrings([trimmed, simplified])
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
}

function subtractYears(date: Date, years: number): Date {
  const copy = new Date(date);
  copy.setUTCFullYear(copy.getUTCFullYear() - years);
  return copy;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.toLowerCase()))];
}

function toPeriodKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function formatGeneratedAt(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function extractDocumentTitle(infoText: string): string {
  const plainInfoText = stripInfoLinks(infoText);
  const [title] = plainInfoText.split(",", 1);
  return title?.trim() || "Efficient Frontier Calculator";
}

function stripInfoLinks(infoText: string): string {
  return infoText.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1");
}

function renderInfoText(infoText: string): string {
  return infoText.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_match, label: string, url: string) => {
    return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(label) + "</a>";
  }).split(/(<a [^>]+>.*?<\/a>)/).map((part) => {
    if (part.startsWith("<a ")) {
      return part;
    }
    return escapeHtml(part);
  }).join("");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderHtml(input: {
  rows: PreparedEtfRow[];
  infoText: string;
  themeCssText: string;
  appJsText: string;
  generatedAt: string;
  rawUniverseCount: number;
  enrichedCount: number;
}): string {
  const { rows, infoText, themeCssText, appJsText, generatedAt, rawUniverseCount, enrichedCount } = input;
  const jsonRows = JSON.stringify(rows).replace(/</g, "\\u003c");
  const metaJson = JSON.stringify({
    rawUniverseCount,
    enrichedCount,
    frontierReadyCount: rows.length,
    generatedAt,
  }).replace(/</g, "\\u003c");
  const heroTitle = renderInfoText(infoText);
  const documentTitle = escapeHtml(extractDocumentTitle(infoText));
  const inlineThemeCss = escapeInlineTagText(themeCssText, "style");
  const inlineAppJs = escapeInlineTagText(appJsText, "script");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="darkreader-lock">
  <title>${documentTitle}</title>
  <style>
${inlineThemeCss}
  </style>
</head>
<body>
  <div class="page">
    <section class="hero">
      <div class="hero-card">
        <button class="theme-toggle" id="themeToggle" type="button" aria-pressed="false">Dark mode</button>
        <p class="kicker">${heroTitle}</p>
        <p class="hero-copy">This uses the ETF screener universe, Yahoo enrichment, a 10-year activity minimum, and a creation-time keep rule of SR10Y &gt; 0.5 or AUM &gt; $0.5B, while explicitly keeping EUO, TLT, LQD, HYG, and sector ETFs.</p>
        <p class="lead">Choose a subset or keep the broader universe, inspect the interactive frontier points chart, and review rounded portfolio weights for the selected universe only. <a class="linkish" href="https://en.wikipedia.org/wiki/Efficient_frontier" target="_blank" rel="noopener noreferrer">Efficient frontier on Wikipedia</a>.</p>
        <div class="hero-valid-tickers">
          <span class="field-note-label">Valid tickers (CSV)</span>
          <div class="valid-tickers-csv" id="validTickersCsv"></div>
        </div>
      </div>
      <aside class="summary-card">
        <div class="stats-grid">
          <div class="stat">
            <span class="stat-label">Nasdaq ETF rows</span>
            <span class="stat-value" id="summaryUniverseCount">${rawUniverseCount.toLocaleString("en-US")}</span>
          </div>
          <div class="stat">
            <span class="stat-label">Frontier-ready ETFs</span>
            <span class="stat-value" id="summaryReadyCount">${rows.length.toLocaleString("en-US")}</span>
          </div>
          <div class="stat">
            <span class="stat-label">Selected universe</span>
            <span class="stat-value" id="summaryCandidateCount">-</span>
          </div>
          <div class="stat">
            <span class="stat-label">Optimization set</span>
            <span class="stat-value" id="summaryAlignedCount">-</span>
          </div>
          <div class="stat">
            <span class="stat-label">Window months</span>
            <span class="stat-value" id="summaryMonths">-</span>
          </div>
          <div class="stat">
            <span class="stat-label">Generated</span>
            <span class="stat-value">${escapeHtml(generatedAt)}</span>
          </div>
        </div>
        <div class="pill-row" id="summaryPills"></div>
      </aside>
    </section>

    <section class="controls-card">
      <div class="controls-header">
        <h2>Optimizer controls</h2>
        <div class="button-row">
          <button id="updateExpectedReturnsButton" class="secondary" type="button">Update</button>
          <button id="recalculateButton" type="button">Recalculate frontier</button>
          <button id="resetButton" class="secondary" type="button">Reset defaults</button>
          <button id="copyWeightsButton" class="secondary" type="button">Copy weights CSV</button>
        </div>
      </div>
      <div class="frontier-control-grid">
        <section class="control-card control-card-wide">
          <h3>Universe</h3>
          <p>Leave blank to optimize over the broader ETF universe. Mixed separators are accepted, duplicates are removed automatically, and optional expected returns can be added beside each symbol.</p>
          <div class="field full">
            <label for="symbolsInput">Ticker subset and optional ER</label>
            <textarea id="symbolsInput" rows="7" placeholder="SPY, TLT; GLD&#10;SPY 10.0%&#10;TLT 5.0%&#10;GLD 0.3"></textarea>
          </div>
        </section>

        <section class="control-card">
          <h3>History</h3>
          <div class="field-row single-column">
            <div class="field">
              <label for="horizonSelect">Lookback horizon</label>
              <select id="horizonSelect">
                <option value="1">1 year</option>
                <option value="3">3 years</option>
                <option value="5">5 years</option>
                <option value="10" selected>10 years</option>
              </select>
            </div>
            <div class="field">
              <label for="riskFreeInput">Risk-free rate (%)</label>
              <input id="riskFreeInput" type="number" min="0" max="20" step="0.1" value="3.0">
            </div>
          </div>
        </section>

        <section class="control-card">
          <h3>Filters</h3>
          <div class="field-row single-column">
            <div class="field">
              <label for="minAumInput">Minimum AUM ($B)</label>
              <input id="minAumInput" type="number" min="0.5" max="1000" step="0.5" value="0.5">
            </div>
            <div class="field">
              <label for="maxAssetsInput">Max candidate ETFs</label>
              <input id="maxAssetsInput" type="number" min="2" max="120" step="1" value="35">
            </div>
          </div>
        </section>

        <section class="control-card">
          <h3>Constraints</h3>
          <div class="field-row single-column">
            <div class="field">
              <label for="maxWeightInput">Max asset weight (%)</label>
              <input id="maxWeightInput" type="number" min="1" max="100" step="1" value="35">
            </div>
            <div class="field">
              <label for="minWeightRoundingInput">Min weight rounding (%)</label>
              <input id="minWeightRoundingInput" type="number" min="0" max="25" step="1" value="5">
            </div>
            <div class="field">
              <label for="frontierPointsInput">Displayed frontier points</label>
              <input id="frontierPointsInput" type="number" min="8" max="60" step="1" value="24">
            </div>
          </div>
        </section>

        <section class="control-card">
          <h3>Inspect</h3>
          <p>Move along the frontier after each solve.</p>
          <div class="field-row single-column">
            <div class="field full">
              <label for="portfolioIndexRange">Frontier point</label>
              <input id="portfolioIndexRange" type="range" min="0" max="0" step="1" value="0">
            </div>
            <div class="field">
              <label for="portfolioIndexValue">Selected point</label>
              <input id="portfolioIndexValue" type="text" value="0 of 0" readonly>
            </div>
          </div>
        </section>
      </div>
    </section>

    <section class="table-card" id="expectedReturnPanel" hidden>
      <div class="table-header">
        <h2>Selected Universe Editor</h2>
        <div class="pill-row compact" id="expectedReturnPills"></div>
      </div>
      <p class="editor-note">This editor follows the active universe: the tickers listed in Ticker subset and optional ER, or all filtered ETFs when that field is empty. Leave Applied ER blank to auto-fill it from the AR Lookback horizon.</p>
      <div class="table-wrap short-wrap">
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Name</th>
              <th>Category</th>
              <th>Sponsor</th>
              <th class="numeric">Default ER</th>
              <th class="numeric">Applied ER</th>
            </tr>
          </thead>
          <tbody id="expectedReturnTableBody"></tbody>
        </table>
      </div>
    </section>

    <section class="results-grid">
      <div class="table-card chart-card">
        <div class="table-header">
          <h2>Frontier chart</h2>
          <div class="pill-row compact" id="chartPills"></div>
        </div>
        <div class="chart-stage" id="chartStage"></div>
      </div>

      <div class="summary-card portfolio-panel">
        <div class="portfolio-grid" id="portfolioCards"></div>
      </div>
    </section>

    <section class="table-card">
      <div class="table-header">
        <h2>Selected portfolio weights</h2>
        <div class="pill-row compact" id="weightPills"></div>
      </div>
      <div class="table-wrap short-wrap">
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Name</th>
              <th>Sponsor</th>
              <th class="numeric">Weight</th>
              <th class="numeric">AUM ($B)</th>
              <th class="numeric">Expected</th>
              <th class="numeric">Volatility</th>
            </tr>
          </thead>
          <tbody id="weightsTableBody"></tbody>
        </table>
      </div>
      <div class="field full pairs-box-wrap">
        <label for="weightPairsBox">Ticker / weight pairs</label>
        <textarea id="weightPairsBox" rows="6" readonly placeholder="QQQ 30.0%&#10;TLT 35.0%&#10;GLD 35.0%"></textarea>
      </div>
    </section>

    <section class="method-card">
      <h2>Method</h2>
      <p>The generator uses the Nasdaq ETF universe, Yahoo Finance enrichment, a 10-year activity requirement, a creation-time gate of SR10Y &gt; 0.5 or AUM &gt; $0.5B, explicit keeps for EUO/TLT/LQD/HYG and sector ETFs, and similarity pruning. The browser then rebuilds the covariance matrix from embedded monthly returns and solves a long-only capped-weight frontier with projected-gradient optimization.</p>
      <ul>
        <li>Data is fetched with a 15-year history buffer, rows must have at least 10 years of activity, the optimization defaults to a 10-year lookback, and the HTML embeds only the trailing 15-year monthly return window.</li>
        <li>Missing monthly returns inside the 15-year window are backfilled with 0% monthly returns so the optimizer runs without NaNs.</li>
        <li>Expected returns use the annualized arithmetic mean of the selected monthly return window.</li>
        <li>Volatility and covariance are annualized from monthly return covariance after backfilling.</li>
        <li>The frontier is generated over a dense grid of return-risk tradeoff values, then reduced to non-dominated portfolios.</li>
        <li>Displayed weights are rounded with a configurable minimum weight threshold.</li>
      </ul>
      <div id="messagePanel" class="message-panel"></div>
    </section>
  </div>

  <script>
    window.__FRONTIER_DATA__ = ${jsonRows};
    window.__FRONTIER_META__ = ${metaJson};
  </script>
  <script>
${inlineAppJs}
  </script>
</body>
</html>`;
}

function escapeInlineTagText(value: string, tagName: "script" | "style"): string {
  return value.replace(new RegExp(`</${tagName}`, "gi"), `<\\/${tagName}`);
}

await main();