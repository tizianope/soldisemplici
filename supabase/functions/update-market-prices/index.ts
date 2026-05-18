// Supabase Edge Function v262 - Yahoo dev storico prezzi + ticker Pro condivisi
// Scopo: aggiornare prezzi degli asset attivi e salvare uno snapshot storico a ogni run.
// Fonte: Yahoo Finance fallback di sviluppo. Non considerarla licenza/soluzione definitiva per produzione.
//
// Richiede secret:
// - SERVICE_ROLE_KEY
//
// Env Supabase Edge:
// - SUPABASE_URL

type MarketAsset = {
  ticker: string;
  api_symbol?: string | null;
  display_symbol?: string | null;
  isin?: string | null;
  name?: string | null;
  category?: string | null;
  currency?: string | null;
  status?: string | null;
};

type PriceResult = {
  ticker: string;
  apiSymbol: string;
  ok: boolean;
  price: number | null;
  currency: string | null;
  reason?: string;
};

const PROVIDER = "yahoo-dev-history-v262";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY") || "";
const DEFAULT_BATCH_SIZE = 8;

Deno.serve(async (req) => {
  try {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return json({
        ok: false,
        provider: PROVIDER,
        error: "Missing SUPABASE_URL or SERVICE_ROLE_KEY. Check Edge Function secrets.",
      }, 500);
    }

    const body = await safeJson(req);
    const sessionLabel = normalizeSessionLabel(body?.session_label || "manual");
    const singleTicker = body?.ticker ? String(body.ticker).trim().toUpperCase() : "";
    const category = body?.category ? String(body.category).trim() : "";
    const batchSize = clampInt(Number(body?.batch_size || DEFAULT_BATCH_SIZE), 1, 12);

    const assets = singleTicker
      ? await fetchAssetsByTicker(singleTicker)
      : await fetchActiveAssets(category);

    const uniqueAssets = dedupeAssets(assets).filter((asset) => !!asset.ticker && !!getApiSymbol(asset));

    if (!uniqueAssets.length) {
      await insertRun(sessionLabel, 0, 0, 0, "Nessun asset attivo con ticker/API trovato.");
      return json({
        ok: true,
        provider: PROVIDER,
        session_label: sessionLabel,
        tickers: 0,
        successCount: 0,
        errorCount: 0,
        updated: [],
        failed: [],
        note: "Nessun asset attivo con ticker/API trovato.",
      });
    }

    const results: PriceResult[] = [];
    for (const chunk of chunks(uniqueAssets, batchSize)) {
      const chunkResults = await Promise.all(chunk.map((asset) => fetchYahooPrice(asset)));
      results.push(...chunkResults);
    }

    const updated = results.filter((r) => r.ok && r.price !== null);
    const failed = results.filter((r) => !r.ok || r.price === null);

    await Promise.all(updated.map((r) => updateMarketAsset(r)));
    await Promise.all(updated.map((r) => insertSnapshot(r, sessionLabel)));

    const note = failed.length
      ? `Ticker non aggiornati: ${failed.map((f) => `${f.ticker}/${f.apiSymbol} (${f.reason || "errore"})`).join("; ")}`
      : `Aggiornati ${updated.length} asset e salvati ${updated.length} snapshot storici.`;

    await insertRun(sessionLabel, uniqueAssets.length, updated.length, failed.length, note);

    return json({
      ok: failed.length === 0,
      provider: PROVIDER,
      session_label: sessionLabel,
      tickers: uniqueAssets.length,
      successCount: updated.length,
      errorCount: failed.length,
      updated: updated.map((u) => ({
        ticker: u.ticker,
        apiSymbol: u.apiSymbol,
        price: u.price,
        currency: u.currency,
      })),
      failed: failed.map((f) => ({
        ticker: f.ticker,
        apiSymbol: f.apiSymbol,
        reason: f.reason || "errore",
      })),
      note,
    });
  } catch (error) {
    return json({
      ok: false,
      provider: PROVIDER,
      error: String(error?.message || error),
    }, 500);
  }
});

async function safeJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function normalizeSessionLabel(value: unknown): string {
  const raw = String(value || "manual").trim();
  if (["midday", "close", "manual", "backfill"].includes(raw)) return raw;
  return "manual";
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function dedupeAssets(assets: MarketAsset[]): MarketAsset[] {
  const seen = new Set<string>();
  const out: MarketAsset[] = [];
  for (const asset of assets) {
    const ticker = String(asset.ticker || "").trim().toUpperCase();
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    out.push({ ...asset, ticker });
  }
  return out;
}

function getApiSymbol(asset: MarketAsset): string {
  return String(asset.api_symbol || asset.ticker || "").trim().toUpperCase();
}

async function fetchActiveAssets(category?: string): Promise<MarketAsset[]> {
  const marketAssets = await fetchActiveMarketAssets(category);
  const customAssets = await fetchActiveCustomInstrumentAssets(category);
  // Uniamo asset di sistema e strumenti Pro personalizzati, poi dedupeAssets evita richieste duplicate:
  // se 100 utenti inseriscono NVDA, la chiamata Yahoo parte una sola volta per NVDA.
  return [...marketAssets, ...customAssets];
}

async function fetchActiveMarketAssets(category?: string): Promise<MarketAsset[]> {
  let url = `${SUPABASE_URL}/rest/v1/market_assets?select=ticker,api_symbol,display_symbol,isin,name,category,currency,status&status=eq.active&order=category.asc,ticker.asc`;
  if (category) url += `&category=eq.${encodeURIComponent(category)}`;

  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Errore lettura market_assets: ${res.status} ${text}`);
  }
  return await res.json();
}

async function fetchActiveCustomInstrumentAssets(category?: string): Promise<MarketAsset[]> {
  let url = `${SUPABASE_URL}/rest/v1/user_custom_instruments?select=ticker_api,isin,name,category,api_enabled&ticker_api=not.is.null&api_enabled=eq.true&order=category.asc,name.asc`;
  if (category) url += `&category=eq.${encodeURIComponent(category)}`;

  let res = await fetch(url, { headers: supabaseHeaders() });

  // Compatibilità durante migration: se api_enabled non esiste ancora, leggiamo comunque i ticker_api non null.
  if (!res.ok) {
    const text = await res.text();
    if (/api_enabled|schema cache|column/i.test(text)) {
      let fallbackUrl = `${SUPABASE_URL}/rest/v1/user_custom_instruments?select=ticker_api,isin,name,category&ticker_api=not.is.null&order=category.asc,name.asc`;
      if (category) fallbackUrl += `&category=eq.${encodeURIComponent(category)}`;
      res = await fetch(fallbackUrl, { headers: supabaseHeaders() });
    } else if (/ticker_api|schema cache|column/i.test(text)) {
      console.warn("user_custom_instruments non ha ticker_api: nessun ticker Pro personalizzato da aggiornare.");
      return [];
    } else {
      console.warn(`Errore lettura user_custom_instruments: ${res.status} ${text}`);
      return [];
    }
  }

  if (!res.ok) {
    const text = await res.text();
    console.warn(`Errore lettura user_custom_instruments fallback: ${res.status} ${text}`);
    return [];
  }

  const rows = await res.json();
  return (Array.isArray(rows) ? rows : [])
    .map((row: any) => {
      const ticker = String(row.ticker_api || "").trim().toUpperCase();
      if (!ticker) return null;
      return {
        ticker,
        api_symbol: ticker,
        display_symbol: ticker,
        isin: row.isin || null,
        name: row.name || ticker,
        category: row.category || null,
        currency: null,
        status: "active",
      } as MarketAsset;
    })
    .filter(Boolean) as MarketAsset[];
}

async function fetchAssetsByTicker(ticker: string): Promise<MarketAsset[]> {
  const url = `${SUPABASE_URL}/rest/v1/market_assets?select=ticker,api_symbol,display_symbol,isin,name,category,currency,status&ticker=eq.${encodeURIComponent(ticker)}`;
  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Errore lettura market_assets ticker ${ticker}: ${res.status} ${text}`);
  }
  const rows = await res.json();
  if (Array.isArray(rows) && rows.length) return rows;
  return [{ ticker, api_symbol: ticker, status: "active" }];
}

async function fetchYahooPrice(asset: MarketAsset): Promise<PriceResult> {
  const ticker = String(asset.ticker || "").trim().toUpperCase();
  const apiSymbol = getApiSymbol(asset);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(apiSymbol)}?range=1d&interval=1d`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "SoldiSempliciMarketData/1.0",
      },
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      return { ticker, apiSymbol, ok: false, price: null, currency: null, reason: `Yahoo HTTP ${res.status}: ${text.slice(0, 160)}` };
    }

    const data = JSON.parse(text);
    const result = data?.chart?.result?.[0];
    const error = data?.chart?.error;
    if (error) {
      return { ticker, apiSymbol, ok: false, price: null, currency: null, reason: error?.description || "Yahoo chart error" };
    }

    const meta = result?.meta || {};
    const price =
      toNumber(meta.regularMarketPrice) ??
      toNumber(meta.previousClose) ??
      toNumber(meta.chartPreviousClose);

    if (price === null) {
      return { ticker, apiSymbol, ok: false, price: null, currency: meta.currency || null, reason: "Prezzo non trovato nella risposta Yahoo" };
    }

    return {
      ticker,
      apiSymbol,
      ok: true,
      price,
      currency: meta.currency || asset.currency || null,
    };
  } catch (error) {
    return {
      ticker,
      apiSymbol,
      ok: false,
      price: null,
      currency: null,
      reason: String(error?.message || error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function updateMarketAsset(result: PriceResult): Promise<void> {
  if (result.price === null) return;

  const url = `${SUPABASE_URL}/rest/v1/market_assets?on_conflict=ticker`;
  const payload = {
    ticker: result.ticker,
    api_symbol: result.apiSymbol,
    display_symbol: result.ticker,
    status: "active",
    last_price: result.price,
    last_price_at: new Date().toISOString(),
    currency: result.currency || null,
    provider: PROVIDER,
    source_note: "Prezzo aggiornato tramite Yahoo Finance dev fallback. Uso per sviluppo/test; scegliere provider/licenza definitiva prima della produzione.",
    updated_at: new Date().toISOString(),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...supabaseHeaders(),
      "Prefer": "resolution=merge-duplicates",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Errore upsert market_assets ${result.ticker}: ${res.status} ${text}`);
  }
}

async function insertSnapshot(result: PriceResult, sessionLabel: string): Promise<void> {
  if (result.price === null) return;

  const url = `${SUPABASE_URL}/rest/v1/market_price_snapshots`;
  const payload = {
    ticker: result.ticker,
    price: result.price,
    currency: result.currency || null,
    provider: PROVIDER,
    session_label: sessionLabel,
    fetched_at: new Date().toISOString(),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Errore insert snapshot ${result.ticker}: ${res.status} ${text}`);
  }
}

async function insertRun(
  sessionLabel: string,
  tickersCount: number,
  successCount: number,
  errorCount: number,
  note: string,
): Promise<void> {
  const url = `${SUPABASE_URL}/rest/v1/market_update_runs`;
  const payload = {
    provider: PROVIDER,
    session_label: sessionLabel,
    tickers_count: tickersCount,
    success_count: successCount,
    error_count: errorCount,
    note,
  };

  await fetch(url, {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify(payload),
  });
}

function supabaseHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
    "apikey": SERVICE_ROLE_KEY,
  };
}

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
