"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient, User } from "@supabase/supabase-js";


// --- Tracking semplice eventi prodotto ---
// Per ora salva gli eventi in console e localStorage.
// In seguito si può collegare questa funzione a Supabase/PostHog senza cambiare il resto dell'app.
type TrackingEventName =
  | "open_app"
  | "start_test"
  | "finish_test"
  | "view_plan"
  | "click_paywall"
  | "buy_core"
  | "buy_pro"
  | "upgrade_pro"
  | "open_rebalance"
  | "open_rebalance_from_guide"
  | "open_exit_strategy"
  | "open_admin_dashboard"
  | "admin_reset_test_data"
  | "referral_visit"
  | "discount_code_seen";


type MarketingAttribution = {
  referralCode?: string;
  partnerCode?: string;
  discountCode?: string;
  utmSource?: string;
  utmCampaign?: string;
  capturedAt?: string;
};

const MARKETING_ATTRIBUTION_KEY = "soldi_semplici_marketing_attribution";

function normalizeMarketingCode(value: string | null) {
  return (value || "").trim().replace(/\s+/g, "-").slice(0, 80);
}

function firstUrlParam(params: URLSearchParams, names: string[]) {
  for (const name of names) {
    const value = normalizeMarketingCode(params.get(name));
    if (value) return value;
  }
  return "";
}

function getStoredMarketingAttribution(): MarketingAttribution | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(MARKETING_ATTRIBUTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MarketingAttribution;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    console.warn("Attribuzione marketing locale non leggibile", error);
    return null;
  }
}

function saveMarketingAttribution(attribution: MarketingAttribution) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(MARKETING_ATTRIBUTION_KEY, JSON.stringify(attribution));
  } catch (error) {
    console.warn("Attribuzione marketing locale non salvata", error);
  }
}

function captureMarketingAttributionFromUrl() {
  if (typeof window === "undefined") return null;

  const params = new URLSearchParams(window.location.search);
  const referralCode = firstUrlParam(params, ["ref", "referral", "partner", "affiliate"]);
  const partnerCode = firstUrlParam(params, ["partner"]);
  const discountCode = firstUrlParam(params, ["promo", "coupon", "codice", "sconto", "discount"]);
  const utmSource = firstUrlParam(params, ["utm_source"]);
  const utmCampaign = firstUrlParam(params, ["utm_campaign"]);

  if (!referralCode && !partnerCode && !discountCode && !utmSource && !utmCampaign) {
    return getStoredMarketingAttribution();
  }

  const previous = getStoredMarketingAttribution() || {};
  const attribution: MarketingAttribution = {
    ...previous,
    referralCode: referralCode || previous.referralCode,
    partnerCode: partnerCode || previous.partnerCode,
    discountCode: discountCode || previous.discountCode,
    utmSource: utmSource || previous.utmSource,
    utmCampaign: utmCampaign || previous.utmCampaign,
    capturedAt: new Date().toISOString(),
  };

  saveMarketingAttribution(attribution);
  return attribution;
}

function getMarketingAttributionPayload() {
  const attribution = getStoredMarketingAttribution();
  if (!attribution) return {};

  return {
    referral_code: attribution.referralCode || null,
    partner_code: attribution.partnerCode || null,
    discount_code: attribution.discountCode || null,
    utm_source: attribution.utmSource || null,
    utm_campaign: attribution.utmCampaign || null,
    attribution_captured_at: attribution.capturedAt || null,
  };
}

function getTrackingSessionId() {
  if (typeof window === "undefined") return null;

  const storageKey = "soldi_semplici_session_id";
  const existing = window.localStorage.getItem(storageKey);
  if (existing) return existing;

  const generated =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  window.localStorage.setItem(storageKey, generated);
  return generated;
}

async function trackEvent(eventName: TrackingEventName, payload: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;

  const sessionId = getTrackingSessionId();

  const rawOrder = window.localStorage.getItem("soldi_semplici_event_order");
  const eventOrder = (rawOrder ? Number(rawOrder) : 0) + 1;
  window.localStorage.setItem("soldi_semplici_event_order", String(eventOrder));

  const enrichedPayload = {
    ...getMarketingAttributionPayload(),
    ...payload,
    event_order: eventOrder,
  };

  const event = {
    eventName,
    payload: enrichedPayload,
    sessionId,
    pageUrl: window.location.href,
    userAgent: window.navigator.userAgent,
    createdAt: new Date().toISOString(),
  };

  console.log("[Soldi Semplici tracking]", event);

  // Backup locale utile per debug sul singolo browser.
  try {
    const raw = window.localStorage.getItem("soldi_semplici_events");
    const events = raw ? JSON.parse(raw) : [];
    events.push(event);
    window.localStorage.setItem("soldi_semplici_events", JSON.stringify(events.slice(-500)));
  } catch (error) {
    console.warn("Tracking locale non disponibile", error);
  }

  // Tracking centrale su Supabase.
  // Questo ritorna una Promise: negli eventi importanti lo usiamo con await,
  // così l'ordine resta pulito: finish_test -> view_plan -> click_paywall -> buy.
  try {
    let userId: string | null = null;

    const session = await safeGetSupabaseSession("tracking eventi");
    userId = session?.user?.id ?? null;

    const { error } = await supabase.from("app_events").insert({
      user_id: userId,
      session_id: sessionId,
      event_name: eventName,
      payload: enrichedPayload,
      page_url: window.location.href,
      user_agent: window.navigator.userAgent,
    });

    if (error) {
      console.warn("Tracking Supabase non salvato", error.message);
    }
  } catch (error) {
    console.warn("Tracking Supabase non disponibile", error);
  }
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);



async function recordMarketingVisit(attribution: MarketingAttribution | null) {
  if (typeof window === "undefined" || !attribution) return;
  if (!attribution.referralCode && !attribution.partnerCode && !attribution.discountCode) return;

  try {
    let userId: string | null = null;
    const session = await safeGetSupabaseSession("attribuzione marketing");
    userId = session?.user?.id ?? null;

    const { error } = await supabase.rpc("track_marketing_attribution", {
      p_user_id: userId,
      p_session_id: getTrackingSessionId(),
      p_referral_code: attribution.referralCode || attribution.partnerCode || null,
      p_partner_code: attribution.partnerCode || null,
      p_discount_code: attribution.discountCode || null,
      p_utm_source: attribution.utmSource || null,
      p_utm_campaign: attribution.utmCampaign || null,
      p_page_url: window.location.href,
    });

    if (error) console.warn("Attribuzione marketing non salvata su Supabase", error.message);
  } catch (error) {
    console.warn("Attribuzione marketing Supabase non disponibile", error);
  }
}

async function recordMarketingConversion(plan: PurchasePlan, amount: number, paymentType: PurchasePaymentType) {
  if (typeof window === "undefined") return;
  const attribution = getStoredMarketingAttribution();
  if (!attribution?.referralCode && !attribution?.partnerCode && !attribution?.discountCode) return;

  try {
    let userId: string | null = null;
    const session = await safeGetSupabaseSession("attribuzione marketing");
    userId = session?.user?.id ?? null;

    const { error } = await supabase.rpc("track_marketing_conversion", {
      p_user_id: userId,
      p_session_id: getTrackingSessionId(),
      p_referral_code: attribution.referralCode || attribution.partnerCode || null,
      p_partner_code: attribution.partnerCode || null,
      p_discount_code: attribution.discountCode || null,
      p_utm_source: attribution.utmSource || null,
      p_utm_campaign: attribution.utmCampaign || null,
      p_purchase_plan: plan,
      p_payment_type: paymentType,
      p_amount: amount,
      p_page_url: window.location.href,
    });

    if (error) console.warn("Conversione marketing non salvata su Supabase", error.message);
  } catch (error) {
    console.warn("Conversione marketing Supabase non disponibile", error);
  }
}

const SOLDI_SEMPLICI_REPORT_LOGO_SVG = `
<svg class="report-logo-mark" viewBox="0 0 96 96" role="img" aria-label="Soldi Semplici">
  <path d="M70 18C59 9 41 8 27 17C12 27 8 48 18 64C28 81 51 87 68 76" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="7.5" stroke-linecap="round"/>
  <path d="M61 69C71 64 77 55 80 44" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="7.5" stroke-linecap="round"/>
  <path d="M80 44L88 57L73 55Z" fill="rgba(255,255,255,0.92)"/>
  <text x="48" y="62" text-anchor="middle" font-size="47" font-weight="900" font-family="Inter, Arial, sans-serif" fill="rgba(255,255,255,0.96)">S</text>
</svg>`;

type BaseProfile = "stabilita" | "equilibrio" | "crescita";
type FinalPortfolioKey =
  | "stabilita_assoluta"
  | "stabilita_dinamica"
  | "equilibrio_intelligente"
  | "equilibrio_dinamico"
  | "crescita_controllata"
  | "crescita_lungo_periodo";

type ScoreMap = Record<BaseProfile, number>;

type Option = {
  label: string;
  scores: ScoreMap;
};

type Question = {
  id: number;
  text: string;
  helper?: string;
  options: Option[];
};

type StrumentiCategory =
  | "Azioni Globali"
  | "Mercati Emergenti"
  | "Obbligazioni"
  | "Obbligazioni Breve Termine"
  | "Obbligazioni Lungo Termine"
  | "Oro"
  | "Materie Prime"
  | "Liquidita";

type StrumentiRow = {
  name: string;
  isin: string;
};

type InstrumentSource = "program" | "custom";

type InstrumentOption = StrumentiRow & {
  source: InstrumentSource;
  id?: string;
  note?: string;
};

type CustomInstrument = {
  id: string;
  category: StrumentiCategory;
  name: string;
  isin: string;
  note?: string;
};

type ShoppingCategory =
  | "Frutta e verdura"
  | "Pasta, riso e pane"
  | "Proteine"
  | "Latte e derivati"
  | "Casa e pulizia"
  | "Igiene personale"
  | "Extra e sfizi"
  | "Altro";

type ShoppingItem = {
  id: string;
  name: string;
  category: ShoppingCategory;
  estimatedPrice: number;
  isExtra: boolean;
  isChecked: boolean;
  isCustom: boolean;
};

type ShoppingPreset = {
  name: string;
  category: ShoppingCategory;
  estimatedPrice: number;
  isExtra?: boolean;
};

type PortfolioTemplate = {
  key: FinalPortfolioKey;
  title: string;
  shortTitle: string;
  profileFamily: BaseProfile;
  badge: string;
  intro: string;
  whyItFits: string;
  composition: { label: string; percentage: number; category: StrumentiCategory }[];
  structureSummary: string[];
  historical: {
    average: string;
    bestYear: string;
    worstYear: string;
    maxDrawdown: string;
    recovery: string;
  };
  attention: string[];
  pacGuide: string[];
  psychology: string[];
  growthProjection: {
    twenty: string;
    twentyFive: string;
    thirty: string;
  };
  annualRebalanceNote: string;
};

type PurchasePlan = "core" | "pro";

type PurchasePaymentType = "new_core" | "new_pro" | "upgrade_core_to_pro" | "renew_core" | "renew_pro";

type PurchaseState = {
  unlocked: boolean;
  email: string;
  selectedPortfolio?: FinalPortfolioKey;
  plan?: PurchasePlan;
  paidAmount?: number;
  purchasedAt?: string;
  upgradedAt?: string;
  expiresAt?: string;
  lastPaymentType?: PurchasePaymentType;
};

type Holding = {
  id: string;
  category: StrumentiCategory;
  strumentiName: string;
  isin: string;
  amount: number;
};

type AppStep =
  | "home"
  | "quiz"
  | "preview"
  | "paywall"
  | "onboarding"
  | "portfolio"
  | "guide"
  | "awareness"
  | "strumentis"
  | "dashboard"
  | "rebalance"
  | "exit"
  | "admin";

type DashboardTab = "monitor" | "guida" | "portafoglio" | "progressi";

type AdminMetric = {
  label: string;
  value: number;
  note?: string;
};

type AdminOverview = {
  generated_at?: string;
  totals?: Record<string, number>;
  purchases?: Record<string, number>;
  usage?: Record<string, number>;
  mortgage?: Record<string, number>;
  anomalies?: Array<{ label: string; value: number; severity?: "info" | "warning" | "danger" }>;
  events?: Array<{ event_name: string; count: number }>;
  marketing?: Record<string, number>;
  referrals?: Array<{ code: string; partner_name?: string | null; visits: number; signups: number; purchases: number; core_purchases: number; pro_purchases: number; revenue: number }>;
  discount_codes?: Array<{ code: string; description?: string | null; discount_type?: string | null; discount_value?: number | null; visits: number; purchases: number; core_purchases: number; pro_purchases: number; revenue: number }>;
};


type ChecklistItem = {
  id: string;
  group: "inizio" | "mantenimento";
  title: string;
  description: string;
};

type PacMonth = {
  month: string; // YYYY-MM
  completed: boolean;
};

type Badge = {
  id: string;
  title: string;
  description: string;
  unlocked: boolean;
  tier: "inizio" | "consapevolezza" | "costanza" | "capitale" | "identità";
  icon: string;
  progress: number;
  target: number;
  progressLabel: string;
  lockedHint: string;
};

type InvestorTitle = {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  icon: string;
  unlocked: boolean;
  progress: number;
  target: number;
  progressLabel: string;
  nextHint: string;
};

type CelebrationEvent = {
  kind: "badge" | "title" | "goal";
  icon: string;
  title: string;
  subtitle: string;
  dismissedKey?: string;
};

type GoalChangeReason = "investimento" | "prelievo" | "mercato" | "stabile";

const LEGAL_DISCLAIMER =
  "Questa applicazione ha finalità esclusivamente educative e informative. Le informazioni fornite non costituiscono consulenza finanziaria personalizzata né raccomandazioni di investimento. Qualsiasi decisione di investimento resta sotto la piena responsabilità dell'utente.";

const questions: Question[] = [
  {
    id: 1,
    text: "Se il valore dei tuoi investimenti scendesse del 20%, cosa faresti?",
    helper: "Non cercare la risposta perfetta. Scegli quella più vicina al tuo istinto.",
    options: [
      { label: "Venderei tutto", scores: { stabilita: 2, equilibrio: 0, crescita: 0 } },
      { label: "Aspetterei con difficoltà", scores: { stabilita: 1, equilibrio: 1, crescita: 0 } },
      { label: "Non farei nulla", scores: { stabilita: 0, equilibrio: 2, crescita: 1 } },
      { label: "Investirei di più", scores: { stabilita: 0, equilibrio: 0, crescita: 2 } },
    ],
  },
  {
    id: 2,
    text: "Quanto ti darebbe fastidio vedere il tuo investimento scendere nel breve periodo?",
    options: [
      { label: "Moltissimo", scores: { stabilita: 2, equilibrio: 0, crescita: 0 } },
      { label: "Abbastanza", scores: { stabilita: 1, equilibrio: 1, crescita: 0 } },
      { label: "Poco", scores: { stabilita: 0, equilibrio: 2, crescita: 1 } },
      { label: "Per niente", scores: { stabilita: 0, equilibrio: 0, crescita: 2 } },
    ],
  },
  {
    id: 3,
    text: "Per quanto tempo pensi di lasciare investiti questi soldi?",
    options: [
      { label: "Meno di 3 anni", scores: { stabilita: 2, equilibrio: 0, crescita: 0 } },
      { label: "3 - 7 anni", scores: { stabilita: 1, equilibrio: 1, crescita: 0 } },
      { label: "7 - 15 anni", scores: { stabilita: 0, equilibrio: 2, crescita: 1 } },
      { label: "Più di 15 anni", scores: { stabilita: 0, equilibrio: 0, crescita: 2 } },
    ],
  },
  {
    id: 4,
    text: "Qual è il tuo obiettivo principale?",
    options: [
      { label: "Non perdere soldi", scores: { stabilita: 2, equilibrio: 0, crescita: 0 } },
      { label: "Proteggere il valore nel tempo", scores: { stabilita: 1, equilibrio: 1, crescita: 0 } },
      { label: "Far crescere i risparmi", scores: { stabilita: 0, equilibrio: 2, crescita: 1 } },
      { label: "Massimizzare la crescita nel lungo periodo", scores: { stabilita: 0, equilibrio: 0, crescita: 2 } },
    ],
  },
  {
    id: 5,
    text: "Quanto vuoi essere coinvolto nella gestione dei tuoi investimenti?",
    options: [
      { label: "Il meno possibile", scores: { stabilita: 2, equilibrio: 0, crescita: 0 } },
      { label: "Ogni tanto controllo", scores: { stabilita: 1, equilibrio: 1, crescita: 0 } },
      { label: "Mi piace capire e seguire", scores: { stabilita: 0, equilibrio: 2, crescita: 1 } },
      { label: "Voglio gestire attivamente", scores: { stabilita: 0, equilibrio: 0, crescita: 2 } },
    ],
  },
  {
    id: 6,
    text: "Quanto ti senti sicuro nel prendere decisioni finanziarie?",
    options: [
      { label: "Per niente", scores: { stabilita: 2, equilibrio: 0, crescita: 0 } },
      { label: "Poco", scores: { stabilita: 1, equilibrio: 1, crescita: 0 } },
      { label: "Abbastanza", scores: { stabilita: 0, equilibrio: 2, crescita: 1 } },
      { label: "Molto", scores: { stabilita: 0, equilibrio: 0, crescita: 2 } },
    ],
  },
  {
    id: 7,
    text: "Quanto riesci a mettere da parte con continuita?",
    options: [
      { label: "Poco o niente", scores: { stabilita: 2, equilibrio: 0, crescita: 0 } },
      { label: "Una cifra piccola ma costante", scores: { stabilita: 1, equilibrio: 1, crescita: 0 } },
      { label: "Una cifra media costante", scores: { stabilita: 0, equilibrio: 2, crescita: 1 } },
      { label: "Posso investire con regolarità senza problemi", scores: { stabilita: 0, equilibrio: 0, crescita: 2 } },
    ],
  },
  {
    id: 8,
    text: "Cosa descrive meglio il tuo approccio agli investimenti?",
    options: [
      { label: "Preferisco non rischiare", scores: { stabilita: 2, equilibrio: 0, crescita: 0 } },
      { label: "Voglio fare le cose con calma", scores: { stabilita: 1, equilibrio: 1, crescita: 0 } },
      { label: "Accetto rischi per crescere", scores: { stabilita: 0, equilibrio: 2, crescita: 1 } },
      { label: "Punto alla crescita anche con oscillazioni", scores: { stabilita: 0, equilibrio: 0, crescita: 2 } },
    ],
  },
];

const strumentiLibrary: Record<StrumentiCategory, StrumentiRow[]> = {
  "Azioni Globali": [
    { name: "Vanguard FTSE All-World", isin: "IE00BK5BQT80" },
    { name: "iShares MSCI ACWI", isin: "IE00B6R52259" },
    { name: "SPDR MSCI World", isin: "IE00BFY0GT14" },
    { name: "Vanguard FTSE Developed World", isin: "IE00BKX55T58" },
    { name: "iShares Core MSCI World", isin: "IE00B4L5Y983" },
  ],
  "Mercati Emergenti": [
    { name: "iShares MSCI Emerging Markets", isin: "IE00B4L5YC18" },
    { name: "Vanguard FTSE Emerging Markets", isin: "IE00BK5BR733" },
    { name: "SPDR Emerging Markets", isin: "IE00B469F816" },
    { name: "Xtrackers MSCI Emerging Markets", isin: "IE00BTJRMP35" },
    { name: "Amundi MSCI Emerging Markets", isin: "LU1681045370" },
  ],
  Obbligazioni: [
    { name: "iShares Core Global Aggregate Bond", isin: "IE00BDBRDM35" },
    { name: "Vanguard Global Bond Index", isin: "IE00BG47KH54" },
    { name: "SPDR Global Aggregate Bond", isin: "IE00B43QJJ40" },
    { name: "iShares Euro Government Bond", isin: "IE00B1FZS350" },
    { name: "Lyxor Euro Government Bond", isin: "LU1650490474" },
  ],
  "Obbligazioni Breve Termine": [
    { name: "iShares Short Treasury Bond", isin: "IE00BCRY6557" },
    { name: "Vanguard Short-Term Bond", isin: "IE00BH65QP03" },
    { name: "SPDR Short Term Bond", isin: "IE00B3T8XH23" },
    { name: "Lyxor Short Duration Bond", isin: "LU1650487413" },
    { name: "Amundi Gov Short Term", isin: "LU1650488494" },
  ],
  "Obbligazioni Lungo Termine": [
    { name: "iShares 20+ Treasury Bond", isin: "IE00BSKRJZ44" },
    { name: "Vanguard Long-Term Bond", isin: "IE00BLRPRF38" },
    { name: "SPDR Long Term Treasury", isin: "IE00BKWQ0R98" },
    { name: "Xtrackers Long Duration", isin: "IE00BFM6TC58" },
    { name: "Amundi Long Gov Bond", isin: "LU1681043599" },
  ],
  Oro: [
    { name: "iShares Physical Gold", isin: "IE00B4ND3602" },
    { name: "Invesco Physical Gold", isin: "IE00B579F325" },
    { name: "WisdomTree Physical Gold", isin: "JE00B1VS3770" },
    { name: "Xetra Gold", isin: "DE000A0S9GB0" },
    { name: "SPDR Gold Shares", isin: "US78463V1070" },
  ],
  "Materie Prime": [
    { name: "iShares Diversified Commodity", isin: "IE00BDFL4P12" },
    { name: "Invesco Commodity", isin: "IE00BD6FTQ80" },
    { name: "WisdomTree Broad Commodities", isin: "GB00B15KY989" },
    { name: "SPDR Commodity", isin: "IE00B44Z5B48" },
    { name: "Lyxor Commodities", isin: "LU1834988278" },
  ],
  Liquidita: [
    { name: "Conto deposito", isin: "N/A" },
    { name: "ETF Monetario Euro", isin: "LU0290358497" },
    { name: "iShares Euro Ultrashort Bond", isin: "IE00BCRY6003" },
    { name: "Lyxor Smart Cash", isin: "LU1190417599" },
    { name: "Amundi Cash ETF", isin: "LU1190417599" },
  ],
};

function getStrumentiNameFromHolding(category: StrumentiCategory, isin: string) {
  const found = strumentiLibrary[category]?.find((item) => item.isin === isin);
  return found?.name || "Strumento inserito";
}

const portfolioMap: Record<FinalPortfolioKey, PortfolioTemplate> = {
  stabilita_assoluta: {
    key: "stabilita_assoluta",
    title: "Stabilità Assoluta",
    shortTitle: "Permanent Portfolio",
    profileFamily: "stabilita",
    badge: "Prudenza massima",
    intro:
      "Questo modello punta prima di tutto a farti restare sereno nel tempo. Non cerca il massimo rendimento possibile, ma un equilibrio molto stabile.",
    whyItFits:
      "È adatto a chi vuole una strategia semplice, con oscillazioni contenute e un approccio molto prudente.",
    composition: [
      { label: "Azioni", percentage: 25, category: "Azioni Globali" },
      { label: "Obbligazioni", percentage: 25, category: "Obbligazioni Lungo Termine" },
      { label: "Oro", percentage: 25, category: "Oro" },
      { label: "Liquidita", percentage: 25, category: "Liquidita" },
    ],
    structureSummary: ["Protezione elevata", "Oscillazioni contenute", "Molto sostenibile nel tempo"],
    historical: {
      average: "6% - 7%",
      bestYear: "+20%",
      worstYear: "-12% / -15%",
      maxDrawdown: "-15%",
      recovery: "2 - 3 anni",
    },
    attention: [
      "Non aspettarti una crescita esplosiva",
      "Non cambiare strategia nei momenti difficili",
      "Rispettare le percentuali è importante",
    ],
    pacGuide: [
      "Parti da 50 EUR o 100 EUR al mese",
      "Imposta bonifico automatico appena arriva lo stipendio",
      "Usa investimento automatico dopo il bonifico mensile",
      "Scegli un strumenti per ogni categoria dal foglio integrativo",
    ],
    psychology: [
      "Le oscillazioni non significano che la strategia non funziona",
      "Il risultato si vede nel lungo periodo",
      "La costanza conta più del momento perfetto",
    ],
    growthProjection: {
      twenty: "circa 92.000 EUR",
      twentyFive: "circa 138.000 EUR",
      thirty: "circa 200.000 EUR",
    },
    annualRebalanceNote:
      "Il ribilanciamento si fa una volta l'anno tramite il nostro servizio dedicato.",
  },
  stabilita_dinamica: {
    key: "stabilita_dinamica",
    title: "Stabilità Dinamica",
    shortTitle: "Prudenza evoluta",
    profileFamily: "stabilita",
    badge: "Prudenza con primo passo verso la crescita",
    intro:
      "Mantiene una struttura prudente, ma introduce un po più di crescita rispetto al profilo più conservativo.",
    whyItFits:
      "È adatto a chi vuole stabilita, ma sente di poter fare un primo passo in più verso il lungo periodo.",
    composition: [
      { label: "Azioni", percentage: 25, category: "Azioni Globali" },
      { label: "Obbligazioni", percentage: 40, category: "Obbligazioni" },
      { label: "Oro", percentage: 20, category: "Oro" },
      { label: "Liquidita", percentage: 15, category: "Liquidita" },
    ],
    structureSummary: ["Prudente ma non immobile", "Crescita graduale", "Buona sostenibilità emotiva"],
    historical: {
      average: "5% - 6%",
      bestYear: "+15%",
      worstYear: "-10%",
      maxDrawdown: "-10% / -12%",
      recovery: "1 - 3 anni",
    },
    attention: [
      "Non alzare la parte azionaria per inseguire rendimenti",
      "Non sospendere il PAC al primo calo",
      "Resta coerente con il piano",
    ],
    pacGuide: [
      "Parti con una cifra che non generi stress",
      "Automatizza bonifico e investimento",
      "Ripeti ogni mese senza cambiare strategia",
      "Ricorda che il tempo fa la differenza",
    ],
    psychology: [
      "Una crescita lenta ma mantenibile vale più di una strategia troppo spinta",
      "La serenità operativa è un vantaggio reale",
    ],
    growthProjection: {
      twenty: "circa 80.000 EUR",
      twentyFive: "circa 110.000 EUR",
      thirty: "circa 150.000 EUR",
    },
    annualRebalanceNote:
      "Il ribilanciamento annuale mantiene il modello fedele alla struttura iniziale.",
  },
  equilibrio_intelligente: {
    key: "equilibrio_intelligente",
    title: "Equilibrio Intelligente",
    shortTitle: "All Weather",
    profileFamily: "equilibrio",
    badge: "Equilibrio tra crescita e protezione",
    intro:
      "Questo modello cerca di funzionare bene in scenari economici diversi, senza puntare tutto su una sola idea.",
    whyItFits:
      "È adatto a chi vuole crescere nel tempo ma con una struttura più robusta e diversificata.",
    composition: [
      { label: "Azioni", percentage: 30, category: "Azioni Globali" },
      { label: "Obbligazioni", percentage: 40, category: "Obbligazioni" },
      { label: "Oro", percentage: 15, category: "Oro" },
      { label: "Materie prime", percentage: 15, category: "Materie Prime" },
    ],
    structureSummary: ["Diversificazione ampia", "Crescita con difese integrate", "Approccio molto bilanciato"],
    historical: {
      average: "7% - 8%",
      bestYear: "+20%",
      worstYear: "-15%",
      maxDrawdown: "-20%",
      recovery: "2 - 4 anni",
    },
    attention: [
      "Non complicare troppo gli strumenti scelti",
      "Non eliminare le parti difensive perché sembrano lente",
      "La forza qui è nell'equilibrio",
    ],
    pacGuide: [
      "Bonifico automatico subito dopo lo stipendio",
      "Trade Republic come esempio pratico, ma puoi usare altre piattaforme",
      "Investimento automatico per non pagare commissioni sugli acquisti ricorrenti",
      "Scegli un strumenti per ogni categoria e rispetta le percentuali",
    ],
    psychology: [
      "Le oscillazioni fanno parte del percorso",
      "Non serve prevedere il mercato per investire bene",
      "La disciplina conta più delle previsioni",
    ],
    growthProjection: {
      twenty: "circa 100.000 EUR",
      twentyFive: "circa 150.000 EUR",
      thirty: "circa 220.000 EUR",
    },
    annualRebalanceNote:
      "Il nostro servizio di ribilanciamento annuale serve a mantenere la struttura coerente nel tempo.",
  },
  equilibrio_dinamico: {
    key: "equilibrio_dinamico",
    title: "Equilibrio Dinamico",
    shortTitle: "Ponte verso la crescita",
    profileFamily: "equilibrio",
    badge: "Più crescita, ma ancora con controllo",
    intro:
      "Qui la componente di crescita aumenta, ma restano presenti elementi che aiutano a contenere gli eccessi.",
    whyItFits:
      "È adatto a chi vuole far lavorare di più il capitale, senza arrivare ancora a una strategia davvero aggressiva.",
    composition: [
      { label: "Azioni", percentage: 50, category: "Azioni Globali" },
      { label: "Obbligazioni", percentage: 30, category: "Obbligazioni" },
      { label: "Oro", percentage: 10, category: "Oro" },
      { label: "Materie prime", percentage: 10, category: "Materie Prime" },
    ],
    structureSummary: ["Equilibrio orientato alla crescita", "Volatilita gestibile", "Molto adatto al medio-lungo periodo"],
    historical: {
      average: "6% - 7%",
      bestYear: "+20%",
      worstYear: "-15%",
      maxDrawdown: "-15% / -18%",
      recovery: "2 - 4 anni",
    },
    attention: [
      "Il rischio maggiore è cambiare idea nei momenti difficili",
      "Non confondere lungo periodo con immobilita mentale",
      "La strategia va mantenuta",
    ],
    pacGuide: [
      "Parti anche da 50 EUR o 100 EUR al mese",
      "Automatizza il trasferimento dopo lo stipendio",
      "Attiva gli acquisti automatici ricorrenti",
      "Non dimenticare il PAC nei mesi in cui sei più impegnato",
    ],
    psychology: [
      "La costanza è più importante del timing",
      "Le perdite temporanee fanno parte del percorso",
      "Investire con metodo riduce la fatica mentale",
    ],
    growthProjection: {
      twenty: "circa 90.000 EUR",
      twentyFive: "circa 130.000 EUR",
      thirty: "circa 180.000 EUR",
    },
    annualRebalanceNote:
      "Una volta l'anno il modello va riallineato alle percentuali iniziali.",
  },
  crescita_controllata: {
    key: "crescita_controllata",
    title: "Crescita Controllata",
    shortTitle: "Golden Butterfly",
    profileFamily: "crescita",
    badge: "Crescita con controllo",
    intro:
      "Questo modello cerca una crescita più significativa, ma senza rinunciare del tutto agli elementi di protezione.",
    whyItFits:
      "È adatto a chi vuole risultati migliori del profilo prudente, ma preferisce non spingersi ancora verso il rischio alto puro.",
    composition: [
      { label: "Azioni", percentage: 40, category: "Azioni Globali" },
      { label: "Obbligazioni", percentage: 40, category: "Obbligazioni" },
      { label: "Oro", percentage: 20, category: "Oro" },
    ],
    structureSummary: ["Buon compromesso tra crescita e stabilità", "Molto adatto a chi vuole salire di livello", "Facile da spiegare e mantenere"],
    historical: {
      average: "7% - 8%",
      bestYear: "+25%",
      worstYear: "-15%",
      maxDrawdown: "-17%",
      recovery: "2 - 3 anni",
    },
    attention: [
      "Non semplificare troppo togliendo l'oro",
      "Non aumentare il rischio per fretta",
      "La vera forza è nella disciplina",
    ],
    pacGuide: [
      "Bonifico automatico appena entra lo stipendio",
      "Investimento automatico sulla piattaforma",
      "Un strumenti per categoria, rispettando le percentuali",
      "Il piano va mantenuto nei mesi buoni e nei mesi difficili",
    ],
    psychology: [
      "Il risultato si vede nel tempo, non nel breve",
      "Una strategia sostenibile vale più di una perfetta solo sulla carta",
    ],
    growthProjection: {
      twenty: "circa 100.000 EUR",
      twentyFive: "circa 150.000 EUR",
      thirty: "circa 220.000 EUR",
    },
    annualRebalanceNote:
      "Il ribilanciamento annuale viene gestito tramite il nostro servizio dedicato.",
  },
  crescita_lungo_periodo: {
    key: "crescita_lungo_periodo",
    title: "Crescita nel Lungo Periodo",
    shortTitle: "Modello Crescita",
    profileFamily: "crescita",
    badge: "Alto potenziale, alta volatilità",
    intro:
      "Questo modello è pensato per chi vuole massimizzare la crescita nel lungo periodo e riesce a sopportare oscillazioni importanti.",
    whyItFits:
      "È adatto a chi ha orizzonte lungo, alta tolleranza emotiva e una forte disciplina nel mantenere la strategia.",
    composition: [
      { label: "Azioni globali", percentage: 80, category: "Azioni Globali" },
      { label: "Obbligazioni", percentage: 20, category: "Obbligazioni" },
    ],
    structureSummary: ["Massimo potenziale tra quelli proposti", "Strategia semplice ma intensa", "Richiede sangue freddo e pazienza"],
    historical: {
      average: "8% - 10%",
      bestYear: "+30% / +40%",
      worstYear: "-30% / -50%",
      maxDrawdown: "-35% / -50%",
      recovery: "3 - 7 anni",
    },
    attention: [
      "Non è per chi soffre molto i cali di mercato",
      "Il rischio vero è abbandonare la strategia",
      "L'orizzonte minimo deve essere lungo",
    ],
    pacGuide: [
      "Parti da 50 EUR o 100 EUR ma mantieni continuita",
      "Automatizza tutto il processo",
      "Scegli strumenti semplici e liquidi",
      "Non interrompere il piano nei crolli",
    ],
    psychology: [
      "Le perdite temporanee fanno parte del pacchetto",
      "La costanza conta più del coraggio iniziale",
      "Il tempo è il vero motore della strategia",
    ],
    growthProjection: {
      twenty: "circa 110.000 EUR",
      twentyFive: "circa 180.000 EUR",
      thirty: "circa 300.000 EUR",
    },
    annualRebalanceNote:
      "Anche qui il ribilanciamento annuale aiuta a mantenere la strategia sostenibile.",
  },
};

const checklistItems: ChecklistItem[] = [
  {
    id: "broker",
    group: "inizio",
    title: "Apri una piattaforma di investimento",
    description:
      "Apri una piattaforma semplice e adatta al tuo piano. Se sei all'inizio, Trade Republic è una buona opzione: permette acquisti frazionati e rende più semplice partire con piccole cifre. In ogni caso, verifica sempre costi e funzionamento prima di iniziare.",
  },
  {
    id: "bonifico",
    group: "inizio",
    title: "Imposta il bonifico automatico",
    description:
      "Imposta un bonifico automatico mensile verso il conto investimenti. Scegli una data subito dopo l'accredito dello stipendio, così non devi pensarci ogni mese.",
  },
  {
    id: "percentuali",
    group: "inizio",
    title: "Controlla le quote del PAC",
    description:
      "Usa il piano PAC mensile per capire quanto destinare a ogni area del modello. Non devi fare calcoli: devi solo eseguire il piano.",
  },
  {
    id: "strumenti",
    group: "inizio",
    title: "Segui il modello assegnato",
    description:
      "Usa il modello assegnato in base al tuo profilo. Non serve modificarlo: il valore sta nel seguirlo con costanza nel tempo.",
  },
  {
    id: "auto_invest",
    group: "inizio",
    title: "Attiva l'investimento automatico",
    description:
      "Configura un piano di accumulo automatico sulla tua piattaforma. Imposta prima il bonifico automatico e poi il PAC, così riduci il rischio di saldo insufficiente. Su Trade Republic: vai in Piani di accumulo, scegli gli strumenti e attiva il PAC. Nota: Trade Republic consente l'acquisto automatico a inizio mese o a metà mese; il giorno effettivo può variare se ci sono festività o la borsa è chiusa.",
  },
  {
    id: "pac_start",
    group: "inizio",
    title: "Chiudi il primo mese PAC",
    description:
      "Segna il PAC del mese come completato. Questo è il primo gesto concreto che rende operativo il sistema.",
  },
  {
    id: "non_fermarti",
    group: "mantenimento",
    title: "Non interrompere il PAC nei momenti difficili",
    description:
      "Le oscillazioni fanno parte del percorso. Il piano serve proprio a non reagire impulsivamente quando il mercato si muove.",
  },
  {
    id: "no_emozione",
    group: "mantenimento",
    title: "Non cambiare strategia per emozione",
    description:
      "Evita modifiche frequenti al piano. Le decisioni migliori si vedono nel tempo, non nel breve periodo.",
  },
  {
    id: "controllo",
    group: "mantenimento",
    title: "Controlla una volta al mese",
    description:
      "Apri l'app una volta al mese e verifica che il PAC sia stato eseguito. Non serve controllare ogni giorno: la costanza conta più della frequenza.",
  },
  {
    id: "aggiorna_capitale",
    group: "mantenimento",
    title: "Aggiorna il capitale",
    description:
      "Aggiorna il valore totale del capitale quando cambia in modo rilevante. Serve per mantenere consapevolezza, non per reagire al mercato.",
  },
  {
    id: "rebalance",
    group: "mantenimento",
    title: "Ribilancia solo quando serve",
    description:
      "Il ribilanciamento non va fatto spesso: in genere ha senso valutarlo una volta ogni uno o due anni, oppure quando il portafoglio si allontana molto dal modello. È manutenzione periodica, non una reazione emotiva al mercato.",
  },
];

type AwarenessTab = "risparmio" | "auto" | "mutuo" | "truffe";

type AwarenessAction = {
  id: string;
  title: string;
  category: "Risparmio" | "Auto" | "Mutuo" | "Anti-truffe";
  area: "Cibo" | "Energia" | "Abbonamenti" | "Casa" | "Acquisti" | "Banca" | "Auto" | "Entrate";
  estimatedSavingMonthly: number;
  estimatedSavingYearly: number;
  difficulty: 1 | 2 | 3 | 4 | 5;
  sacrifice: 1 | 2 | 3 | 4 | 5;
  minutes: number;
  why: string;
  steps: string[];
};


type MortgageMode = "sostenibilità" | "pies";
type MortgagePiesStatus = "found" | "missing" | "unclear";

type MortgagePiesFieldState = {
  status: MortgagePiesStatus;
  value: string;
  notes: string;
};

type MortgagePiesFieldDefinition = {
  id: string;
  label: string;
  placeholder: string;
  penalty: number;
  area: "costo" | "tasso" | "polizze" | "ammortamento" | "uscita";
  issue: string;
  why: string;
  question: string;
  selectOptions?: string[];
};

type MortgagePiesSection = {
  id: string;
  title: string;
  where: string;
  explanation: string;
  fields: MortgagePiesFieldDefinition[];
};

const mortgagePiesSections: MortgagePiesSection[] = [
  {
    id: "base",
    title: "1. Dati base del mutuo",
    where: "Cerca nel PIES la sezione 'Caratteristiche principali del contratto di credito'.",
    explanation: "Qui capisci quanto chiedi, per quanto tempo e quale sarà la dimensione economica complessiva del mutuo.",
    fields: [
      { id: "amount", label: "Importo mutuo", placeholder: "Es. 180000", penalty: 8, area: "costo", issue: "Importo del mutuo non chiaro", why: "Senza importo non puoi verificare coerenza di rata, durata e totale da rimborsare.", question: "Potete confermarmi l'importo esatto del mutuo indicato nella proposta?" },
      { id: "duration", label: "Durata mutuo (anni)", placeholder: "Es. 30", penalty: 6, area: "ammortamento", issue: "Durata del mutuo non chiara", why: "La durata incide su rata, interessi e costo complessivo. Inserisci solo gli anni indicati nel PIES.", question: "Potete confermarmi la durata del mutuo in anni indicata nella proposta?" },
      { id: "totalToRepay", label: "Totale da rimborsare", placeholder: "Es. 292320", penalty: 12, area: "costo", issue: "Totale da rimborsare non trovato", why: "Questo dato evita di valutare il mutuo solo dalla rata mensile.", question: "Potete indicarmi l'importo totale da rimborsare se il mutuo viene mantenuto fino alla scadenza?" },
    ],
  },
  {
    id: "rate-costs",
    title: "2. Tasso e costo reale",
    where: "Cerca la sezione 'Tasso di interesse e altri costi'.",
    explanation: "Il TAN indica il tasso nominale. Il TAEG aiuta a capire il costo complessivo e a confrontare offerte diverse.",
    fields: [
      { id: "rateType", label: "Tipo di tasso", placeholder: "Seleziona il tipo indicato nel PIES", penalty: 8, area: "tasso", issue: "Tipo di tasso non chiaro", why: "Il rischio cambia molto tra fisso, variabile e variabile con cap.", question: "Potete confermarmi se il mutuo è a tasso fisso, variabile, misto o variabile con cap?", selectOptions: ["Tasso fisso", "Tasso variabile", "Tasso variabile con cap", "Tasso misto", "Non trovato nel PIES", "Non chiaro"] },
      { id: "tan", label: "TAN", placeholder: "Es. 3,20%", penalty: 8, area: "tasso", issue: "TAN non trovato o non chiaro", why: "Serve per capire il tasso nominale applicato al capitale.", question: "Potete confermarmi il TAN applicato alla proposta?" },
      { id: "taeg", label: "TAEG", placeholder: "Es. 3,74%", penalty: 15, area: "costo", issue: "TAEG non trovato o non chiaro", why: "Il TAEG è fondamentale per confrontare offerte e capire i costi accessori inclusi.", question: "Potete confermarmi il TAEG e quali costi sono inclusi o esclusi dal calcolo?" },
      { id: "rateLocked", label: "Tasso bloccato fino alla stipula", placeholder: "Seleziona la risposta indicata nel PIES", penalty: 8, area: "tasso", issue: "Blocco tasso fino al rogito non chiaro", why: "Per un tasso fisso è importante capire se le condizioni restano valide fino alla firma. Per i mutui variabili questo controllo di solito non è applicabile: contano parametro, spread e simulazioni.", question: "Il tasso fisso indicato è bloccato fino alla stipula? Fino a quale data?", selectOptions: ["Si, fino alla stipula", "Si, fino a una data indicata", "No", "Non applicabile: tasso variabile", "Non trovato nel PIES", "Non chiaro"] },
      { id: "referenceIndex", label: "Parametro di riferimento", placeholder: "Es. Euribor 1 mese", penalty: 6, area: "tasso", issue: "Parametro di riferimento non chiaro", why: "Nei mutui variabili e nei variabili con cap serve sapere a quale indice è collegato il tasso, per esempio Euribor 1 mese o Euribor 3 mesi.", question: "Potete confermarmi il parametro di riferimento usato per il tasso variabile e la periodicità di aggiornamento?" },
      { id: "spread", label: "Spread", placeholder: "Es. 1,10%", penalty: 6, area: "tasso", issue: "Spread non chiaro", why: "Lo spread è la maggiorazione applicata dalla banca al parametro di riferimento. Incide direttamente sul tasso finale.", question: "Potete confermarmi lo spread applicato e se resta invariato per tutta la durata del mutuo?" },
      { id: "mixedChangeConditions", label: "Condizioni di cambio tasso", placeholder: "Seleziona cosa indica il PIES", penalty: 10, area: "tasso", issue: "Condizioni di cambio tasso non dettagliate", why: "Nel tasso misto è fondamentale capire quando può cambiare il tasso, se il cambio è automatico o facoltativo e quali condizioni si applicano dopo il cambio.", question: "Potete confermarmi dopo quanto tempo può cambiare il tasso, se il cambio è automatico o facoltativo e quali condizioni si applicano dopo il cambio?", selectOptions: ["Cambio dopo un periodo indicato", "Cambio automatico", "Cambio facoltativo", "Condizioni di cambio non dettagliate", "Non trovato nel PIES", "Non chiaro"] },
      { id: "mixedChangeAfterYears", label: "Dopo quanti anni può cambiare il tasso?", placeholder: "Es. 5", penalty: 5, area: "tasso", issue: "Periodo di cambio tasso non chiaro", why: "Per un tasso misto l'utente deve sapere quando termina il periodo iniziale e quando possono cambiare le condizioni.", question: "Potete indicarmi dopo quanti anni può cambiare il tasso e da quale rata decorre l'eventuale cambio?" },
      { id: "mixedChangeOutcome", label: "Cosa succede dopo il cambio?", placeholder: "Seleziona cosa indica il PIES", penalty: 8, area: "tasso", issue: "Esito del cambio tasso non chiaro", why: "L'utente deve capire se dopo il periodo iniziale il mutuo passa a fisso, variabile o se può scegliere tra più opzioni.", question: "Potete confermarmi se dopo il periodo iniziale il tasso passa a fisso, variabile o se l'utente può scegliere tra più opzioni?", selectOptions: ["Passa a variabile", "Passa a fisso", "Si può scegliere tra fisso e variabile", "Non indicato", "Non chiaro"] },
      { id: "capValue", label: "Cap / tetto massimo", placeholder: "Es. 5,50%", penalty: 8, area: "tasso", issue: "Cap non chiaro", why: "Nel variabile con cap il tetto massimo limita il tasso applicabile. Senza questo dato l'utente non può capire lo scenario peggiore.", question: "Potete confermarmi il valore del cap e se si applica al TAN complessivo o al solo parametro di riferimento?" },
      { id: "floorValue", label: "Floor / tasso minimo", placeholder: "Es. 2,25% oppure Non previsto", penalty: 6, area: "tasso", issue: "Floor non chiaro", why: "Il floor indica il tasso minimo applicabile: può limitare il beneficio se i tassi scendono molto.", question: "Potete confermarmi se è previsto un floor, qual è il suo valore e come viene applicato?" },
    ],
  },
  {
    id: "installment",
    title: "3. Rata e scenari",
    where: "Cerca 'Importo di ciascuna rata' e le eventuali simulazioni per mutui variabili.",
    explanation: "La rata iniziale non basta: se il mutuo è variabile bisogna capire quanto può aumentare.",
    fields: [
      { id: "installment", label: "Rata mensile", placeholder: "Es. 812", penalty: 8, area: "tasso", issue: "Rata mensile non trovata", why: "La rata serve per verificare la sostenibilità mensile.", question: "Potete confermarmi l'importo della rata mensile iniziale?" },
      { id: "variableSimulation", label: "Simulazioni aumento rata / dopo cambio tasso", placeholder: "Seleziona se sono presenti simulazioni", penalty: 12, area: "tasso", issue: "Simulazioni assenti o non chiare", why: "Senza simulazioni, l'utente vede solo la rata iniziale e non il rischio di aumento o cambio condizioni.", question: "Potete inviarmi una simulazione della rata negli scenari rilevanti per il tipo di tasso indicato?", selectOptions: ["Presenti per +1%, +2% e +3%", "Presente solo scenario al cap", "Simulazioni dopo cambio tasso presenti", "Presenti ma incomplete", "Non presenti", "Non trovato nel PIES", "Non chiaro", "Non applicabile"] },
      { id: "maxInstallmentAtCap", label: "Rata massima stimata al cap", placeholder: "Es. 1232", penalty: 8, area: "tasso", issue: "Rata massima al cap non chiara", why: "Nel variabile con cap il dato più utile è capire quale rata potrebbe pagare l'utente nello scenario massimo previsto.", question: "Potete confermarmi la rata massima stimata al raggiungimento del cap e le ipotesi usate per calcolarla?" },
    ],
  },
  {
    id: "amortization",
    title: "4. Piano di ammortamento",
    where: "Cerca 'Piano di ammortamento' nel PIES o in un allegato dedicato.",
    explanation: "Il piano mostra quota capitale, quota interessi e debito residuo nel tempo.",
    fields: [
      { id: "amortization", label: "Piano di ammortamento", placeholder: "Seleziona se il piano è disponibile", penalty: 8, area: "ammortamento", issue: "Piano di ammortamento mancante", why: "Aiuta a capire quanto capitale si riduce nei primi anni e quanto debito resta.", question: "Potete inviarmi il piano di ammortamento completo con quota capitale, quota interessi e debito residuo?", selectOptions: ["Presente nel PIES", "Presente come allegato", "Ricevuto separatamente", "Non presente", "Non trovato nel PIES", "Non chiaro"] },
    ],
  },
  {
    id: "policies-products",
    title: "5. Polizze e prodotti collegati",
    where: "Cerca la sezione 'Obblighi supplementari' e gli allegati assicurativi o commerciali.",
    explanation: "Questa è una delle aree più delicate: bisogna distinguere obbligo reale, proposta commerciale e sconto condizionato.",
    fields: [
      { id: "policiesObligation", label: "Polizze obbligatorie o facoltative", placeholder: "Seleziona la situazione indicata", penalty: 15, area: "polizze", issue: "Obbligatorietà delle polizze non chiara", why: "Una polizza collegata può incidere sul costo o sulle condizioni del tasso.", question: "Le polizze indicate sono obbligatorie o facoltative? Se non le sottoscrivo, il tasso o le condizioni cambiano?", selectOptions: ["Nessuna polizza indicata", "Solo polizze obbligatorie", "Solo polizze facoltative", "Polizze sia obbligatorie sia facoltative", "Polizze presenti ma obbligatorietà non chiara", "Non trovato nel PIES", "Non chiaro"] },
      { id: "policyChoiceFreedom", label: "Libertà di scelta della polizza", placeholder: "Seleziona se puoi scegliere una compagnia esterna", penalty: 8, area: "polizze", issue: "Libertà di scelta della polizza non chiara", why: "Se la polizza è vincolata alla banca può incidere su costo e flessibilità. Se invece puoi sceglierla liberamente, il rischio documentale è più basso.", question: "Potete confermarmi se posso sottoscrivere la polizza anche presso una compagnia esterna senza modifiche al tasso o alle condizioni economiche?", selectOptions: ["Sì, scegliibile anche presso compagnia esterna", "No, proposta o vincolata dalla banca", "Non ci sono polizze", "Non indicato nel PIES", "Non chiaro"] },
      { id: "policyCost", label: "Costo polizze e inclusione nel TAEG", placeholder: "Seleziona come viene indicato il costo", penalty: 10, area: "polizze", issue: "Costo polizze o inclusione nel TAEG non chiari", why: "Il costo può essere rilevante, soprattutto se finanziato o collegato allo sconto. Se la polizza è obbligatoria ma scegliibile liberamente, il costo non indicato è soprattutto un dato da stimare per confrontare l'offerta, non per forza una criticità grave.", question: "Qual è il costo di ciascuna polizza? Il costo è incluso nel TAEG? Il premio viene finanziato?", selectOptions: ["Costo indicato e incluso nel TAEG", "Costo indicato, premio finanziato e incluso nel TAEG", "Costo indicato, premio finanziato ma inclusione nel TAEG non chiara", "Costo indicato ma non incluso nel TAEG", "Costo indicato ma inclusione nel TAEG non chiara", "Costo non indicato", "Non ci sono polizze", "Non trovato nel PIES", "Non chiaro"] },
      { id: "policyCostAmount", label: "Importo polizze (€)", placeholder: "Es. 6900", penalty: 6, area: "polizze", issue: "Importo delle polizze non indicato", why: "Se una polizza ha un costo rilevante, l'importo serve per capire quanto pesa sul costo complessivo e per confrontare offerte diverse.", question: "Potete indicarmi l'importo di ciascuna polizza, se il premio viene pagato subito o finanziato e se è incluso nel TAEG?" },
      { id: "linkedProducts", label: "Prodotti collegati", placeholder: "Seleziona se ci sono prodotti collegati", penalty: 8, area: "polizze", issue: "Prodotti collegati non quantificati", why: "Prodotti aggiuntivi possono creare costi o vincoli nel tempo.", question: "Quali prodotti collegati sono richiesti o proposti? Quali costi hanno e sono necessari per ottenere le condizioni indicate?", selectOptions: ["Nessun prodotto collegato indicato", "Prodotti collegati facoltativi", "Prodotti collegati necessari per ottenere il tasso", "Prodotti collegati presenti ma costi non chiari", "Non trovato nel PIES", "Non chiaro"] },
      { id: "productsRequiredForRate", label: "Prodotti o condizioni necessari per mantenere il tasso", placeholder: "Seleziona cosa indica il PIES", penalty: 10, area: "polizze", issue: "Prodotti o requisiti per mantenere il tasso non chiari", why: "Se il tasso dipende da conto, accredito, carta, polizze o requisiti commerciali, l'utente deve sapere cosa mantenere e quali costi comporta.", question: "Potete confermarmi quali prodotti o requisiti commerciali sono necessari per ottenere e mantenere il tasso indicato?", selectOptions: ["Nessun prodotto richiesto", "Conto corrente richiesto", "Accredito stipendio richiesto", "Carta o pacchetto conto richiesto", "Polizze collegate al tasso", "Più prodotti/requisiti commerciali", "Non indicato", "Non chiaro"] },
      { id: "linkedProductsDetails", label: "Dettaglio prodotti/requisiti", placeholder: "Es. conto corrente, accredito stipendio, polizza casa, carta, requisiti commerciali", penalty: 5, area: "polizze", issue: "Dettaglio prodotti o requisiti non indicato", why: "Il dettaglio serve a capire quali prodotti o condizioni sono davvero collegati al tasso e quali costi possono aggiungersi.", question: "Potete indicarmi l'elenco completo dei prodotti o requisiti collegati al tasso e il costo di ciascuno?" },
      { id: "discountConditions", label: "Tipo di sconto o condizione promozionale", placeholder: "Seleziona se lo sconto dipende da condizioni", penalty: 15, area: "polizze", issue: "Condizioni dello sconto tasso non chiare", why: "Uno sconto non è davvero valutabile se non sai cosa succede quando chiudi o recedi dai prodotti collegati o se non rispetti i requisiti indicati.", question: "Da quali condizioni dipende lo sconto sul tasso? Cosa accade se non rispetto, chiudo o recedo dalle condizioni collegate?", selectOptions: ["Nessuno sconto indicato", "Sconto indicato senza condizioni", "Sconto collegato a prodotti bancari", "Sconto collegato a polizze", "Sconto Green / classe energetica immobile", "Sconto collegato a requisiti commerciali", "Sconto collegato ad altre condizioni", "Sconto indicato ma condizioni non chiare", "Non trovato nel PIES", "Non chiaro"] },
      { id: "discountConsequence", label: "Cosa succede se il requisito non viene mantenuto?", placeholder: "Seleziona cosa indica il PIES", penalty: 8, area: "polizze", issue: "Conseguenze della perdita dello sconto non chiare", why: "Se lo sconto dipende da condizioni, è essenziale sapere se il tasso aumenta, lo sconto viene perso o cambiano altre condizioni economiche.", question: "Cosa accade al tasso o alle condizioni economiche se il requisito dello sconto non viene rispettato o mantenuto?", selectOptions: ["Il tasso aumenta", "Lo sconto viene perso", "Condizioni economiche cambiano", "Nessuna conseguenza indicata", "Non indicato", "Non chiaro"] },
      { id: "greenDiscountRequirement", label: "Requisito sconto Green / classe energetica", placeholder: "Es. Classe A o B + documentazione energetica", penalty: 8, area: "polizze", issue: "Requisito dello sconto Green non chiaro", why: "Se lo sconto dipende dalla classe energetica, l'utente deve sapere quale documento serve, entro quando consegnarlo e cosa accade se il requisito non viene confermato.", question: "Quale classe energetica e quale documentazione sono necessarie per ottenere e mantenere lo sconto Green? Cosa accade al tasso se il requisito non viene confermato o mantenuto?" },
    ],
  },
  {
    id: "exit",
    title: "6. Estinzione, surroga e uscita",
    where: "Cerca 'Estinzione anticipata', 'portabilita', 'surroga' e condizioni sulle polizze non godute.",
    explanation: "Un buon mutuo deve essere comprensibile non solo all'ingresso, ma anche in uscita.",
    fields: [
      { id: "earlyRepayment", label: "Estinzione anticipata e surroga", placeholder: "Seleziona cosa indica la documentazione", penalty: 8, area: "uscita", issue: "Estinzione o surroga non chiare", why: "Se vuoi uscire, surrogare o chiudere il mutuo, devi sapere cosa succede a costi e polizze.", question: "Sono previsti costi o condizioni in caso di estinzione anticipata o surroga? Cosa accade alle polizze collegate e alla quota di premio non goduta?", selectOptions: ["Condizioni chiare", "Condizioni chiare e rimborso premio non goduto indicato", "Estinzione/surroga chiare e rimborso quota polizza non goduta indicato", "Estinzione chiara ma surroga non chiara", "Surroga chiara ma estinzione non chiara", "Rimando generico a normativa/foglio condizioni", "Rimborso polizze non indicato", "Polizze collegate non chiare in caso di uscita", "Non trovato nel PIES", "Non chiaro"] },
    ],
  },
];

const mortgagePiesFieldDefinitions = mortgagePiesSections.flatMap((section) => section.fields);


function getDefaultMortgagePiesFields(): Record<string, MortgagePiesFieldState> {
  return Object.fromEntries(
    mortgagePiesFieldDefinitions.map((field) => [
      field.id,
      { status: "missing" as MortgagePiesStatus, value: "", notes: "" },
    ])
  );
}

function cleanMortgagePiesFields(input: unknown): Record<string, MortgagePiesFieldState> {
  const source = input && typeof input === "object" ? (input as Record<string, Partial<MortgagePiesFieldState>>) : {};
  return Object.fromEntries(
    mortgagePiesFieldDefinitions.map((field) => {
      const raw = source[field.id] || {};
      const status = raw.status === "found" || raw.status === "unclear" || raw.status === "missing" ? raw.status : "missing";
      return [
        field.id,
        {
          status,
          value: typeof raw.value === "string" ? raw.value : "",
          notes: typeof raw.notes === "string" ? raw.notes : "",
        },
      ];
    })
  );
}




type ScamScenario = {
  id: string;
  category: string;
  situation: string;
  isRisky: boolean;
  redFlags: string[];
  explanation: string;
  safeAction: string;
  difficulty?: "facile" | "media" | "difficile";
};

const scamScenarioPool: ScamScenario[] = [
  { id: "bank_sms_blocked", category: "Banca e pagamenti", situation: "Ricevi un SMS: 'Il tuo conto è stato bloccato. Clicca qui entro 24 ore per riattivarlo'.", isRisky: true, redFlags: ["Urgenza", "Link sospetto", "Paura"], explanation: "È un classico schema di phishing: usa paura e fretta per spingerti a cliccare senza verificare.", safeAction: "Non cliccare. Apri l'app ufficiale della banca o chiama il numero indicato sul sito ufficiale." },
  { id: "bank_real_alert_app", category: "Banca e pagamenti", situation: "L'app ufficiale della tua banca, già installata sul telefono, ti chiede di confermare un pagamento che riconosci.", isRisky: false, redFlags: ["Canale ufficiale"], explanation: "Il canale è quello ufficiale e il pagamento è riconosciuto. Resta comunque attento se non sei tu ad aver avviato l'operazione.", safeAction: "Controlla importo e beneficiario, poi conferma solo se tutto torna." },
  { id: "otp_phone_bank", category: "Telefonate", situation: "Una persona che dice di essere della banca ti chiama e chiede il codice OTP appena ricevuto per 'bloccare una frode'.", isRisky: true, redFlags: ["Richiesta codici", "Autorita falsa", "Pressione"], explanation: "Banche e operatori seri non chiedono mai OTP, PIN o password al telefono. Il codice serve a autorizzare operazioni.", safeAction: "Chiudi la chiamata e contatta la banca dal numero ufficiale." },
  { id: "marketplace_shipping_link", category: "Marketplace", situation: "Stai vendendo un oggetto. L'acquirente ti manda un link per 'ricevere il pagamento' e ti chiede i dati della carta.", isRisky: true, redFlags: ["Link pagamento", "Canale esterno", "Richiesta carta"], explanation: "Nei marketplace seri non devi inserire i dati carta per ricevere denaro. Spesso questi link rubano dati o autorizzano pagamenti.", safeAction: "Usa solo il sistema di pagamento interno alla piattaforma." },
  { id: "marketplace_cash_pickup", category: "Marketplace", situation: "L'acquirente vuole vedere l'oggetto di persona e pagare in contanti al momento del ritiro.", isRisky: false, redFlags: ["Verifica dal vivo"], explanation: "Non è automaticamente una truffa. Serve comunque prudenza su luogo, banconote e sicurezza personale.", safeAction: "Incontrati in un luogo pubblico e controlla il pagamento prima di consegnare." },
  { id: "crypto_guaranteed", category: "Investimenti", situation: "Un gruppo Telegram promette rendimento garantito del 10% al mese con crypto e ti chiede un bonifico immediato.", isRisky: true, redFlags: ["Guadagno garantito", "Urgenza", "Canale informale"], explanation: "Negli investimenti il rendimento garantito alto è un segnale molto forte di rischio. Spesso sono schemi fraudolenti.", safeAction: "Non inviare denaro. Verifica autorizzazioni e soggetti su canali ufficiali." },
  { id: "friend_hot_tip", category: "Investimenti", situation: "Un conoscente ti dice che ha un investimento 'sicuro' e che devi entrare oggi per non perdere l'occasione.", isRisky: true, redFlags: ["Pressione", "Occasione irripetibile", "Fiducia personale"], explanation: "Le truffe sfruttano spesso fiducia e fretta. Un investimento serio non richiede decisioni immediate senza documenti chiari.", safeAction: "Fermati, chiedi documentazione e verifica chi propone il prodotto." },
  { id: "broker_authorized_docs", category: "Investimenti", situation: "Un intermediario autorizzato ti invia documenti ufficiali, costi chiari e ti invita a prenderti tempo prima di decidere.", isRisky: false, redFlags: ["Trasparenza", "Nessuna fretta"], explanation: "Trasparenza, tempi di valutazione e documenti controllabili sono segnali più sani. Non significa che sia adatto a te, ma non è un comportamento tipico da truffa.", safeAction: "Leggi costi e rischi, poi verifica l'intermediario su registri ufficiali." },
  { id: "package_customs", category: "SMS / email", situation: "Ricevi una email del corriere: 'Pacco fermo in dogana, paga 1,99 euro cliccando qui'. Non aspettavi pacchi.", isRisky: true, redFlags: ["Link sospetto", "Importo piccolo", "Mittente dubbio"], explanation: "Importi piccoli abbassano le difese. Il link può rubare dati carta o installare malware.", safeAction: "Controlla solo dal sito ufficiale del corriere usando il codice tracking, se lo hai." },
  { id: "package_tracking_expected", category: "SMS / email", situation: "Aspetti un pacco e ricevi una notifica dall'app ufficiale del corriere già installata con il tracking corretto.", isRisky: false, redFlags: ["Canale ufficiale"], explanation: "Il canale ufficiale e il tracking atteso riducono il rischio. Resta attento a richieste di pagamento inattese.", safeAction: "Controlla i dettagli nell'app o sul sito ufficiale." },
  { id: "family_emergency_whatsapp", category: "Familiari", situation: "Ricevi un messaggio: 'Mamma, ho cambiato numero, ho un problema, mandami subito 900 euro'.", isRisky: true, redFlags: ["Emergenza", "Nuovo numero", "Richiesta denaro"], explanation: "È una truffa molto diffusa: sfrutta ansia e legami familiari per farti pagare in fretta.", safeAction: "Chiama il vecchio numero o un familiare, non inviare denaro via chat." },
  { id: "relative_calls_from_known_number", category: "Familiari", situation: "Tuo figlio ti chiama dal suo numero abituale e ti chiede di anticipare una spesa, spiegandoti con calma il motivo.", isRisky: false, redFlags: ["Numero conosciuto", "Tempo per verificare"], explanation: "Non è automaticamente rischioso, ma i pagamenti vanno sempre verificati, soprattutto se insoliti.", safeAction: "Richiama il numero conosciuto e controlla il beneficiario prima di pagare." },
  { id: "door_utility_contract", category: "Di persona", situation: "Un venditore porta a porta dice che devi firmare subito un nuovo contratto luce per evitare una penale.", isRisky: true, redFlags: ["Pressione", "Firma immediata", "Minaccia penale"], explanation: "Le vendite aggressive usano urgenza e paura. Un contratto serio può essere letto con calma.", safeAction: "Non firmare sul momento. Chiedi documenti e confronta l'offerta da casa." },
  { id: "fake_technician_home", category: "Di persona", situation: "Una persona si presenta come tecnico del gas senza appuntamento e chiede di entrare in casa per un controllo urgente.", isRisky: true, redFlags: ["Accesso a casa", "Nessun appuntamento", "Urgenza"], explanation: "I falsi tecnici possono puntare a furti, firme o dati personali. L'urgenza non verificata è un segnale forte.", safeAction: "Non far entrare. Chiama l'azienda dal numero ufficiale." },
  { id: "planned_technician", category: "Di persona", situation: "Hai fissato tu un appuntamento con il tecnico, arriva nell'orario previsto e mostra tesserino e riferimento pratica.", isRisky: false, redFlags: ["Appuntamento atteso", "Identificazione"], explanation: "Un appuntamento atteso è verificabile e meno rischioso. Si può comunque controllare l'identità.", safeAction: "Verifica tesserino e, se hai dubbi, chiama l'azienda." },
  { id: "charity_no_docs", category: "Di persona", situation: "Fuori dal supermercato una persona chiede donazioni in contanti per una causa urgente ma non mostra documenti chiari.", isRisky: true, redFlags: ["Contanti", "Nessuna documentazione", "Pressione emotiva"], explanation: "La beneficenza vera e trasparente deve permetterti di verificare ente, finalità e ricevute.", safeAction: "Dona solo tramite canali ufficiali dell'ente." },
  { id: "charity_official_stand", category: "Di persona", situation: "Un'associazione riconosciuta ha uno stand ufficiale, materiale informativo e ti permette di donare dal sito ufficiale.", isRisky: false, redFlags: ["Verificabile", "Canale ufficiale"], explanation: "La presenza di informazioni verificabili e la possibilità di donare tramite canale ufficiale sono segnali positivi.", safeAction: "Controlla il sito dell'associazione e dona solo da li." },
  { id: "rental_deposit_before_visit", category: "Affitti e casa", situation: "Un annuncio di affitto molto conveniente chiede caparra prima di vedere casa per 'bloccare l'occasione'.", isRisky: true, redFlags: ["Prezzo troppo basso", "Caparra anticipata", "Nessuna visita"], explanation: "Le truffe sugli affitti puntano su prezzo attraente e fretta. Pagare prima di vedere e verificare è pericoloso.", safeAction: "Visita l'immobile, verifica identità e contratto prima di pagare." },
  { id: "rental_agency_visit_contract", category: "Affitti e casa", situation: "Visiti la casa con agenzia, ricevi contratto e dati verificabili prima di versare importi.", isRisky: false, redFlags: ["Visita", "Contratto", "Tracciabilità"], explanation: "La tracciabilità riduce il rischio. Controlla comunque intestatari e condizioni.", safeAction: "Paga solo con metodi tracciabili dopo aver letto il contratto." },
  { id: "job_pay_for_training", category: "Lavoro", situation: "Un annuncio di lavoro ti chiede 180 euro per iniziare un corso obbligatorio prima dell'assunzione.", isRisky: true, redFlags: ["Pagamento anticipato", "Promessa lavoro", "Pressione"], explanation: "Molte truffe lavorative chiedono soldi prima di offrire un lavoro reale.", safeAction: "Verifica azienda, contratto e condizioni. Non pagare per essere assunto." },
  { id: "job_normal_selection", category: "Lavoro", situation: "Un'azienda ti invita a colloquio, ti manda una email da dominio aziendale e non chiede soldi o documenti sensibili prima della selezione.", isRisky: false, redFlags: ["Nessun pagamento", "Dominio verificabile"], explanation: "Il processo è più normale. Resta prudente con dati personali e contratti.", safeAction: "Verifica sito aziendale e posizione, poi procedi." },
  { id: "used_car_advance", category: "Auto usata", situation: "Un venditore propone un'auto a prezzo molto basso e chiede anticipo per spedirla, senza farla vedere.", isRisky: true, redFlags: ["Prezzo troppo basso", "Anticipo", "Nessuna visione"], explanation: "Auto inesistenti o non disponibili sono una truffa frequente. L'anticipo serve a farti perdere denaro.", safeAction: "Vedi l'auto, verifica documenti e paga con metodi tracciabili." },
  { id: "used_car_seen_docs", category: "Auto usata", situation: "Vedi l'auto di persona, controlli libretto, proprietàrio e fai una visura prima di pagare.", isRisky: false, redFlags: ["Verifica documenti", "Visione dal vivo"], explanation: "Questo è un comportamento prudente. Non elimina ogni rischio, ma riduce molto le truffe comuni.", safeAction: "Completa il passaggio con documenti e pagamenti tracciabili." },
  { id: "fake_refund_trading", category: "Investimenti", situation: "Dopo aver perso soldi in trading, qualcuno ti contatta dicendo di poterli recuperare pagando una commissione iniziale.", isRisky: true, redFlags: ["Recupero soldi", "Commissione anticipata", "Vittima già colpita"], explanation: "È una truffa di recupero: colpisce persone già danneggiate promettendo recuperi improbabili.", safeAction: "Non pagare. Rivolgiti a canali legali o autorità competenti." },
  { id: "invoice_iban_changed", category: "Banca e pagamenti", situation: "Ricevi una email da un fornitore: 'Abbiamo cambiato IBAN, paga la fattura su questo nuovo conto'.", isRisky: true, redFlags: ["Cambio IBAN", "Email", "Pagamento"], explanation: "La frode del cambio IBAN è comune. Una email può essere falsificata o l'account compromesso.", safeAction: "Verifica il cambio IBAN con una telefonata a un numero già conosciuto." },
  { id: "known_supplier_call", category: "Banca e pagamenti", situation: "Un fornitore ti comunica un cambio IBAN durante una chiamata che hai fatto tu al numero ufficiale e ti invia documenti coerenti.", isRisky: false, redFlags: ["Verifica attiva", "Numero ufficiale"], explanation: "La verifica da un canale noto rende la situazione più sicura, anche se va documentata.", safeAction: "Conserva conferma scritta e verifica intestatario del conto." },
  { id: "romance_investment", category: "Relazioni", situation: "Una persona conosciuta online crea confidenza e poi ti propone una piattaforma di investimento 'usata anche da lei'.", isRisky: true, redFlags: ["Fiducia emotiva", "Piattaforma sconosciuta", "Investimento"], explanation: "Le truffe romantiche spesso portano gradualmente a richieste di denaro o investimenti falsi.", safeAction: "Non inviare soldi. Verifica piattaforma e interrompi se aumenta la pressione." },
  { id: "qr_parking", category: "Pagamenti quotidiani", situation: "In un parcheggio trovi un QR code incollato sopra quello ufficiale per pagare la sosta.", isRisky: true, redFlags: ["QR non verificato", "Pagamento", "Possibile sostituzione"], explanation: "QR falsi possono portare a siti clone e rubare dati di pagamento.", safeAction: "Usa l'app ufficiale del parcheggio o il sito indicato sui cartelli ufficiali." },
  { id: "qr_restaurant_menu", category: "Pagamenti quotidiani", situation: "Al ristorante il QR code è sul menu ufficiale e porta solo alla lista dei piatti, senza chiedere dati o pagamenti.", isRisky: false, redFlags: ["Nessun pagamento", "Contesto coerente"], explanation: "Un QR per consultare un menu è meno rischioso. Il rischio cresce quando chiede dati o pagamenti.", safeAction: "Aprilo con prudenza e non inserire dati se non serve." },
  { id: "prize_fee", category: "Premi e concorsi", situation: "Ricevi un messaggio: 'Hai vinto uno smartphone, paga 2 euro di spedizione'.", isRisky: true, redFlags: ["Premio inatteso", "Pagamento piccolo", "Link"], explanation: "I falsi premi usano importi piccoli per rubare dati della carta.", safeAction: "Ignora il link. Verifica eventuali concorsi solo dal sito ufficiale." },
  { id: "official_lottery_ticket", category: "Premi e concorsi", situation: "Hai comprato un biglietto ufficiale e controlli la vincita sul sito ufficiale, senza ricevere link esterni.", isRisky: false, redFlags: ["Canale ufficiale"], explanation: "Il controllo da canale ufficiale è coerente. Non pagare commissioni per ricevere premi non verificati.", safeAction: "Segui solo le istruzioni ufficiali." },
  { id: "insurance_accident_call", category: "Telefonate", situation: "Un presunto avvocato chiama: 'Tuo figlio ha causato un incidente, servono contanti subito per evitar guai'.", isRisky: true, redFlags: ["Emergenza", "Contanti", "Paura"], explanation: "È una truffa che sfrutta panico e autorita falsa. Nessuna procedura seria funziona così.", safeAction: "Chiama direttamente tuo figlio o le forze dell'ordine da numeri ufficiali." },
  { id: "police_never_asks_money", category: "Di persona", situation: "Una persona in divisa chiede soldi in contanti per chiudere una pratica urgente.", isRisky: true, redFlags: ["Contanti", "Autorita falsa", "Urgenza"], explanation: "Autorita e uffici pubblici non chiedono contanti per risolvere pratiche sul momento.", safeAction: "Non pagare. Verifica con l'ufficio o chiama il numero ufficiale." },
  { id: "public_office_payment_notice", category: "Pagamenti", situation: "Ricevi un avviso pagoPA con codice verificabile e lo paghi tramite app della banca o canale ufficiale.", isRisky: false, redFlags: ["Canale tracciabile", "Codice verificabile"], explanation: "Un pagamento su canale ufficiale è verificabile e più sicuro. Controlla sempre beneficiario e importo.", safeAction: "Paga solo da app o sito ufficiale, non da link sospetti." },
  { id: "investment_seminar_free_lunch", category: "Investimenti", situation: "Ti invitano a una cena gratuita per presentare un investimento con rendimenti alti e posti limitati.", isRisky: true, redFlags: ["Vendita aggressiva", "Posti limitati", "Rendimenti alti"], explanation: "Eventi commerciali possono usare pressione sociale e scarsita per vendere prodotti non adatti o rischiosi.", safeAction: "Non firmare nulla sul posto. Porta i documenti a casa e verifica costi e rischi." },
  { id: "utility_bill_review", category: "Casa e utenze", situation: "Un consulente ti propone di confrontare le bollette, ti lascia l'offerta scritta e non chiede firma immediata.", isRisky: false, redFlags: ["Documento scritto", "Nessuna urgenza"], explanation: "Confrontare può essere utile se hai tempo per leggere. Attento comunque a deleghe e contratti non richiesti.", safeAction: "Leggi condizioni, durata, penali e prezzo prima di firmare." },
  { id: "fake_parcel_home", category: "Di persona", situation: "Un corriere sconosciuto dice che devi pagare in contanti una tassa per un pacco che non aspettavi.", isRisky: true, redFlags: ["Contanti", "Pacco inatteso", "Pressione"], explanation: "Richieste di pagamento impreviste alla porta sono rischiose, soprattutto se non puoi verificare il tracking.", safeAction: "Non pagare. Verifica sul sito ufficiale del corriere." },
  { id: "atm_help", category: "Di persona", situation: "Una persona vicino al bancomat si offre di aiutarti e ti dice di reinserire il PIN per sbloccare la carta.", isRisky: true, redFlags: ["PIN", "Bancomat", "Aiuto non richiesto"], explanation: "Mai mostrare PIN o accettare aiuto da sconosciuti allo sportello. Potrebbe essere un tentativo di furto.", safeAction: "Annulla, copri la tastiera e chiedi aiuto solo dentro la filiale." },
  { id: "atm_bank_staff_inside", category: "Di persona", situation: "Hai un problema al bancomat e chiedi aiuto allo sportello interno della filiale.", isRisky: false, redFlags: ["Filiale", "Personale verificabile"], explanation: "Chiedere aiuto al personale della filiale e più sicuro. Nessuno deve comunque vedere il PIN.", safeAction: "Non comunicare il PIN e segui procedure ufficiali." },
  { id: "subscription_trial", category: "Abbonamenti", situation: "Un sito offre prova gratuita ma chiede carta e scrive in piccolo che dopo 7 giorni partono 49 euro al mese.", isRisky: true, redFlags: ["Costo nascosto", "Termini piccoli", "Carta"], explanation: "Non sempre è una truffa illegale, ma può diventare una trappola di spesa se le condizioni sono poco chiare.", safeAction: "Leggi rinnovo, disdetta e imposta un promemoria prima di inserire la carta." },
  { id: "normal_subscription_clear", category: "Abbonamenti", situation: "Un servizio mostra chiaramente prezzo, rinnovo, data di addebito e pulsante di cancellazione.", isRisky: false, redFlags: ["Prezzo chiaro", "Disdetta visibile"], explanation: "La trasparenza riduce il rischio. Devi comunque valutare se ti serve davvero.", safeAction: "Salva la data di rinnovo e controlla l'utilizzo." },
  { id: "loan_upfront_fee", category: "Prestiti", situation: "Una società online promette prestito immediato ma chiede 250 euro di spese prima di erogarlo.", isRisky: true, redFlags: ["Commissione anticipata", "Prestito facile", "Urgenza"], explanation: "I prestiti con costi anticipati e promesse facili sono spesso rischiosi o fraudolenti.", safeAction: "Verifica autorizzazioni e condizioni. Non pagare anticipi a soggetti non verificati." },
  { id: "bank_loan_branch", category: "Prestiti", situation: "La tua banca ti propone un prestito con documento informativo, TAEG e piano rate chiari prima della firma.", isRisky: false, redFlags: ["TAEG chiaro", "Documenti"], explanation: "La presenza di documenti e costi chiari è un buon segnale, anche se devi valutare sostenibilità e convenienza.", safeAction: "Confronta TAEG e rata con altre offerte prima di firmare." },
  { id: "social_fake_shop", category: "Acquisti", situation: "Vedi su social un negozio con sconti enormi, nessun indirizzo chiaro e pagamento solo bonifico.", isRisky: true, redFlags: ["Sconto enorme", "Dati societari assenti", "Bonifico"], explanation: "Negozi clone o falsi usano sconti estremi e metodi di pagamento poco reversibili.", safeAction: "Cerca recensioni indipendenti, partita IVA e paga solo con metodi protetti." },
  { id: "known_store_card", category: "Acquisti", situation: "Acquisti da un negozio conosciuto, URL corretto, pagamento con carta protetta e conferma ordine.", isRisky: false, redFlags: ["URL corretto", "Pagamento protetto"], explanation: "È una situazione più sicura. Controlla sempre URL e condizioni di reso.", safeAction: "Usa metodi tracciabili e salva la conferma ordine." },
  { id: "document_photo_request", category: "Documenti", situation: "Uno sconosciuto in chat ti chiede foto di carta d'identità e codice fiscale per 'verificare il profilo'.", isRisky: true, redFlags: ["Documenti", "Chat", "Identita"], explanation: "I documenti possono essere usati per furti d'identità, SIM swap o contratti falsi.", safeAction: "Invia documenti solo a soggetti verificati e su canali ufficiali." },
  { id: "official_kyc", category: "Documenti", situation: "Una piattaforma finanziaria regolamentata chiede identificazione tramite procedura KYC nel sito ufficiale prima di aprire il conto.", isRisky: false, redFlags: ["Procedura ufficiale", "Soggetto verificabile"], explanation: "La verifica identità è normale in contesti regolamentati, se il soggetto è verificabile e il canale è ufficiale.", safeAction: "Controlla URL, autorizzazioni e privacy prima di caricare documenti." },
  { id: "sim_swap", category: "Telefonia", situation: "Un operatore telefonico ti chiama e chiede codice ricevuto via SMS per 'aggiornare la SIM'.", isRisky: true, redFlags: ["Codice SMS", "SIM", "Telefonata inattesa"], explanation: "Quel codice può autorizzare operazioni sulla tua SIM o sui tuoi account.", safeAction: "Non comunicare codici. Contatta l'operatore da canale ufficiale." },
  { id: "bank_card_pickup", category: "Banca e pagamenti", situation: "Un finto addetto dice che la tua carta e compromessa e manda un corriere a ritirarla a casa.", isRisky: true, redFlags: ["Carta fisica", "Corriere", "Paura"], explanation: "Banche è circuiti non mandano corrieri a ritirare carte per sicurezza.", safeAction: "Blocca la carta dall'app o dal numero ufficiale e non consegnarla." },
  { id: "restaurant_bill_split", category: "Pagamenti quotidiani", situation: "Un amico ti manda una richiesta di pagamento riconoscibile per dividere una cena appena fatta insieme.", isRisky: false, redFlags: ["Contesto riconosciuto", "Importo coerente"], explanation: "Il contesto è coerente. Verifica comunque importo e destinatario.", safeAction: "Paga solo se riconosci richiesta e importo." },
  { id: "fake_survey", category: "Dati personali", situation: "Un sondaggio online promette buono spesa da 500 euro e chiede dati, carta e telefono.", isRisky: true, redFlags: ["Premio alto", "Dati sensibili", "Carta"], explanation: "Spesso questi sondaggi raccolgono dati o attivano abbonamenti indesiderati.", safeAction: "Non inserire dati sensibili per premi non verificati." },
  { id: "cash_change_trick", category: "Di persona", situation: "Un passante ti chiede di cambiare una banconota e cerca di confonderti con conti e resto.", isRisky: true, redFlags: ["Confusione", "Contanti", "Fretta"], explanation: "Le truffe del resto sfruttano confusione e rapidita per farti consegnare più soldi.", safeAction: "Non cambiare denaro a sconosciuti se non sei tranquillo." },
  { id: "parking_attendant_official", category: "Di persona", situation: "Un parcheggiatore autorizzato ha badge, tariffario esposto e ricevuta fiscale.", isRisky: false, redFlags: ["Ricevuta", "Tariffario"], explanation: "La presenza di tariffario e ricevuta riduce il rischio, pur richiedendo sempre attenzione.", safeAction: "Paga solo quanto indicato e conserva ricevuta." },
  { id: "medical_quick_cure", category: "Salute e benessere", situation: "Una pubblicità promette integratore miracoloso che fa guadagnare energia e dimagrire senza prove, solo oggi sconto 80%.", isRisky: true, redFlags: ["Miracolo", "Sconto aggressivo", "Promesse eccessive"], explanation: "Promesse estreme e urgenza commerciale sono segnali di rischio economico e personale.", safeAction: "Non acquistare d'impulso. Verifica fonti affidabili e professionisti competenti." },
  { id: "official_notice_logged_in", category: "Account online", situation: "Accedi tu al sito ufficiale di un servizio e trovi una notifica interna che ti chiede di aggiornare un dato non sensibile.", isRisky: false, redFlags: ["Accesso iniziato da te", "Canale ufficiale"], explanation: "Quando sei tu ad accedere dal sito ufficiale, il rischio è più basso. Attenzione se vengono chiesti codici o pagamenti strani.", safeAction: "Aggiorna solo ciò che capisci e verifica eventuali richieste insolite." },
  { id: "investment_cash_only", category: "Investimenti", situation: "Una persona ti propone un investimento in contanti per evitare tasse e dice di non parlarne con nessuno.", isRisky: true, redFlags: ["Contanti", "Segretezza", "Evasione"], explanation: "Segretezza, contanti e promesse fiscali sono segnali molto forti di rischio e di possibile illegalità.", safeAction: "Non partecipare. Investi solo con intermediari autorizzati e tracciabilità." },
  { id: "fake_ticket", category: "Eventi", situation: "Una persona vende biglietti sold out a meta prezzo e chiede pagamento immediato con ricarica prepagata.", isRisky: true, redFlags: ["Prezzo troppo basso", "Ricarica", "Urgenza"], explanation: "Biglietti falsi o duplicati sono comuni. Le ricariche sono difficili da recuperare.", safeAction: "Usa piattaforme ufficiali o sistemi con protezione acquisto." },
  { id: "ticket_official_resale", category: "Eventi", situation: "Compri un biglietto da rivendita ufficiale con nominativo, commissioni chiare e pagamento protetto.", isRisky: false, redFlags: ["Canale ufficiale", "Pagamento protetto"], explanation: "La rivendita ufficiale riduce il rischio di biglietti falsi.", safeAction: "Controlla nominativo, condizioni di accesso e ricevuta." },
  { id: "tax_refund_link", category: "Pubblica amministrazione", situation: "Ricevi una email: 'Rimborso fiscale disponibile, inserisci dati carta qui entro oggi'.", isRisky: true, redFlags: ["Rimborso inatteso", "Dati carta", "Urgenza"], explanation: "Enti pubblici non chiedono dati carta via link per rimborsi improvvisi.", safeAction: "Accedi solo da portali ufficiali digitando l'indirizzo o usando SPID/CIE." },
  { id: "app_store_download", category: "App e software", situation: "Scarichi un'app finanziaria dallo store ufficiale, controllando sviluppatore, recensioni e sito collegato.", isRisky: false, redFlags: ["Store ufficiale", "Sviluppatore verificabile"], explanation: "E più sicuro rispetto a link casuali. Non basta da solo: controlla permessi e reputazione.", safeAction: "Installa solo da store ufficiali e limita i permessi." },

  { id: "deepfake_ceo_voice", category: "Lavoro", situation: "Ricevi una chiamata con voce molto simile al tuo capo: ti chiede di fare subito un bonifico urgente a un nuovo fornitore.", isRisky: true, difficulty: "difficile", redFlags: ["Voce imitata", "Bonifico urgente", "Nuovo beneficiario"], explanation: "Le imitazioni vocali e i deepfake possono sembrare credibili. La richiesta di pagamento urgente verso un nuovo beneficiario va sempre verificata con un secondo canale.", safeAction: "Richiama il capo al numero già conosciuto o usa una procedura interna prima di pagare." },
  { id: "invoice_changed_iban", category: "Lavoro", situation: "Un fornitore abituale invia una fattura quasi identica alle precedenti, ma con IBAN cambiato e una nota: 'aggiornamento bancario'.", isRisky: true, difficulty: "difficile", redFlags: ["IBAN cambiato", "Fornitore abituale", "Email possibile clone"], explanation: "Le truffe su fatture reali sono difficili perché usano rapporti esistenti. Il cambio IBAN deve sempre essere verificato fuori dalla email.", safeAction: "Chiama il referente del fornitore usando un numero già noto, non quello scritto nella nuova email." },
  { id: "qr_parking_fake", category: "Pagamenti quotidiani", situation: "In un parcheggio trovi un QR code incollato sopra il cartello del pagamento. Il sito sembra simile a quello ufficiale.", isRisky: true, difficulty: "difficile", redFlags: ["QR sovrapposto", "Sito simile", "Pagamento carta"], explanation: "I QR falsi portano a pagine clone dove puoi pagare un truffatore o inserire dati carta. Il segnale è sottile: il QR può sembrare normale.", safeAction: "Usa l'app ufficiale del parcheggio o digita il sito ufficiale invece di fidarti del QR incollato." },
  { id: "rental_owner_documents", category: "Affitti e casa", situation: "Un presunto proprietàrio ti manda documento, visura e contratto, ma non può farti vedere casa e chiede caparra per bloccarla.", isRisky: true, difficulty: "difficile", redFlags: ["Documenti non bastano", "Nessuna visita", "Caparra anticipata"], explanation: "Anche documenti apparentemente reali possono essere rubati o falsificati. Senza visita e verifica dell'immobile il rischio resta alto.", safeAction: "Non pagare prima di vedere casa e verificare identità, proprietà e contratto con canali affidabili." },
  { id: "used_car_plate_docs_partial", category: "Auto usata", situation: "Il venditore mostra targa e libretto, ma dice che l'auto è fuori regione e chiede un acconto per 'prenotare la visione'.", isRisky: true, difficulty: "difficile", redFlags: ["Documenti parziali", "Auto lontana", "Acconto"], explanation: "Documenti e targa possono rendere la proposta credibile, ma l'acconto prima della visione resta un segnale di rischio.", safeAction: "Vedi l'auto di persona, controlla proprietà e pagamenti tracciabili prima di versare denaro." },
  { id: "investment_platform_professional_site", category: "Investimenti", situation: "Una piattaforma di investimento ha sito curato, area clienti e recensioni positive, ma non trovi autorizzazioni ufficiali chiare.", isRisky: true, difficulty: "difficile", redFlags: ["Sito professionale", "Autorizzazioni assenti", "Recensioni manipolabili"], explanation: "Un sito bello non prova che l'intermediario sia autorizzato. Recensioni e grafiche possono essere costruite per sembrare affidabili.", safeAction: "Verifica l'autorizzazione su registri ufficiali prima di aprire conto o inviare denaro." },
  { id: "recovery_funds_law_firm", category: "Investimenti", situation: "Uno studio legale estero dice di poter recuperare soldi persi in trading. Chiede una piccola tassa iniziale per avviare la pratica.", isRisky: true, difficulty: "difficile", redFlags: ["Recupero fondi", "Tassa iniziale", "Vittima già colpita"], explanation: "Le truffe di recupero fondi sono particolarmente insidiose: promettono aiuto a chi ha già subito una perdita.", safeAction: "Non pagare anticipi. Verifica albo, sede, reputazione e rivolgiti a canali legali riconosciuti." },
  { id: "bank_operator_knows_data", category: "Telefonate", situation: "Un presunto operatore bancario conosce il tuo nome e le ultime cifre della carta, poi ti chiede di confermare un codice per bloccare un addebito.", isRisky: true, difficulty: "difficile", redFlags: ["Dati parziali veri", "Richiesta codice", "Falsa urgenza"], explanation: "Conoscere alcuni dati non rende la chiamata sicura. I truffatori possono avere informazioni parziali e usarle per sembrare credibili.", safeAction: "Non comunicare codici. Chiudi e chiama la banca dal numero ufficiale." },
  { id: "utility_agent_real_badge_pressure", category: "Contratti", situation: "Un incaricato luce/gas mostra badge e documenti, ma insiste per farti firmare subito dicendo che domani perderai lo sconto.", isRisky: true, difficulty: "difficile", redFlags: ["Pressione", "Firma immediata", "Offerta a tempo"], explanation: "Anche un venditore reale può usare pressione commerciale. Il rischio è firmare condizioni non capite o non convenienti.", safeAction: "Prendi il materiale, confronta l'offerta e non firmare finche non hai letto con calma." },
  { id: "marketplace_buyer_sends_courier", category: "Marketplace", situation: "Un acquirente dice che manda un corriere a ritirare l'oggetto e ti invia un modulo per ricevere il pagamento anticipato.", isRisky: true, difficulty: "difficile", redFlags: ["Corriere organizzato da altri", "Modulo pagamento", "Dati carta"], explanation: "La truffa e credibile perché sembra logistica normale, ma il modulo spesso serve a rubare dati o autorizzare pagamenti.", safeAction: "Usa pagamenti e spedizioni gestiti dalla piattaforma o pagamento verificato prima della consegna." },
  { id: "job_remote_equipment_check", category: "Lavoro", situation: "Una società ti assume da remoto e ti manda un assegno o bonifico per comprare attrezzatura da un fornitore indicato da loro.", isRisky: true, difficulty: "difficile", redFlags: ["Assegno/bonifico sospetto", "Fornitore imposto", "Lavoro remoto"], explanation: "Alcune truffe lavorative usano pagamenti che poi vengono stornati, mentre tu hai già speso soldi reali.", safeAction: "Verifica azienda, contratto e modalità. Non anticipare acquisti su fornitori imposti senza garanzie." },
  { id: "romance_small_test_transfer", category: "Relazioni", situation: "Una persona conosciuta online non chiede subito grandi somme, ma prima piccoli trasferimenti per 'testare la fiducia'.", isRisky: true, difficulty: "difficile", redFlags: ["Fiducia emotiva", "Piccole somme", "Escalation"], explanation: "Le truffe affettive spesso iniziano con richieste piccole per creare abitudine e abbassare le difese.", safeAction: "Non inviare denaro a persone conosciute solo online. Parla con qualcuno di fiducia prima di agire." },
  { id: "crypto_withdrawal_tax", category: "Crypto / trading", situation: "Una piattaforma ti mostra profitti, ma per prelevare chiede di pagare prima una tassa o commissione esterna.", isRisky: true, difficulty: "difficile", redFlags: ["Prelievo bloccato", "Commissione anticipata", "Profitti non verificati"], explanation: "Nelle piattaforme fraudolente i profitti sono solo numeri sullo schermo. La richiesta di pagare per prelevare è un segnale forte.", safeAction: "Non versare altri soldi. Verifica la piattaforma e conserva prove delle comunicazioni." },
  { id: "condominium_fake_notice", category: "Casa", situation: "Trovi nella cassetta una comunicazione condominiale con QR per pagare una spesa urgente, ma l'amministratore non l'aveva annunciata.", isRisky: true, difficulty: "difficile", redFlags: ["QR pagamento", "Avviso inatteso", "Urgenza"], explanation: "Avvisi fisici possono sembrare credibili, ma possono essere falsi. Il QR rende facile deviare il pagamento.", safeAction: "Verifica con l'amministratore usando contatti già noti prima di pagare." },
  { id: "bank_branch_phone_after_visit", category: "Banca e pagamenti", situation: "Dopo una visita in filiale ricevi una chiamata che cita l'appuntamento e chiede un codice per completare la pratica.", isRisky: true, difficulty: "difficile", redFlags: ["Contesto reale", "Richiesta codice", "Falsa continuita"], explanation: "Il riferimento a un evento reale può ingannare. Codici, OTP e PIN non vanno comunicati neanche se la chiamata sembra collegata a una pratica vera.", safeAction: "Chiudi e richiama la filiale o il servizio clienti ufficiale." },
  { id: "hotel_wifi_payment", category: "Viaggi", situation: "In hotel trovi una rete Wi-Fi con nome simile a quello ufficiale. Per accedere chiede carta per una cauzione simbolica.", isRisky: true, difficulty: "difficile", redFlags: ["Wi-Fi clone", "Carta richiesta", "Nome simile"], explanation: "Reti Wi-Fi clone possono rubare dati o portarti a pagine false. La richiesta carta per accesso Wi-Fi e sospetta.", safeAction: "Chiedi alla reception il nome esatto della rete e non inserire dati carta su portali non verificati." },
  { id: "second_hand_luxury_authenticity", category: "Acquisti", situation: "Un venditore propone un orologio o borsa di lusso con certificato fotografato, prezzo buono ma non assurdo, pagamento con bonifico.", isRisky: true, difficulty: "difficile", redFlags: ["Certificato fotografato", "Bonifico", "Bene costoso"], explanation: "Nei beni di valore i certificati possono essere falsi o copiati. Il prezzo non sempre e troppo basso, proprio per sembrare credibile.", safeAction: "Usa piattaforme con autenticazione, pagamento protetto e verifica professionale." },
  { id: "tax_consultant_refund_fee", category: "Pubblica amministrazione", situation: "Un presunto consulente dice di averti trovato un rimborso fiscale e chiede una percentuale anticipata per sbloccarlo.", isRisky: true, difficulty: "difficile", redFlags: ["Rimborso inatteso", "Fee anticipata", "Soggetto non verificato"], explanation: "I rimborsi veri si verificano da canali ufficiali. Pagare prima un intermediario non verificato e rischioso.", safeAction: "Controlla dal portale ufficiale o con un professionista di fiducia." },
  { id: "family_known_voice_short_call", category: "Familiari", situation: "Una voce simile a un familiare ti chiama per pochi secondi, dice di essere nei guai e ti passa subito un 'avvocato'.", isRisky: true, difficulty: "difficile", redFlags: ["Voce simile", "Panico", "Terza persona"], explanation: "La voce può essere imitata o la chiamata costruita per farti agire sotto shock. Il passaggio a un presunto avvocato aumenta la pressione.", safeAction: "Interrompi, richiama il familiare su numero noto e verifica con altri parenti." },
  { id: "doctor_private_payment", category: "Salute e benessere", situation: "Una persona si presenta come collaboratore di una clinica e chiede pagamento anticipato su conto personale per anticipare una visita.", isRisky: true, difficulty: "difficile", redFlags: ["Conto personale", "Anticipo", "Canale non ufficiale"], explanation: "Pagamenti sanitari su conti personali o canali non ufficiali sono un segnale di rischio e vanno verificati.", safeAction: "Chiama la clinica da contatti ufficiali e paga solo tramite canali autorizzati." },
  { id: "iban_confirmed_by_two_channels", category: "Pagamenti quotidiani", situation: "Devi pagare un professionista. L'IBAN arriva via email e lo confermi anche telefonando al numero ufficiale già noto.", isRisky: false, difficulty: "difficile", redFlags: ["Doppia verifica", "Numero noto"], explanation: "La doppia verifica su un canale già conosciuto riduce molto il rischio di pagamento deviato.", safeAction: "Procedi solo dopo aver controllato beneficiario e causale." },
  { id: "official_tax_notice_spid", category: "Pubblica amministrazione", situation: "Ricevi un avviso generico via email, ma invece di cliccare accedi con SPID al portale ufficiale e trovi la stessa comunicazione.", isRisky: false, difficulty: "difficile", redFlags: ["Verifica autonoma", "Portale ufficiale"], explanation: "Il comportamento corretto è non fidarsi del link, ma controllare sul canale ufficiale. Se la comunicazione compare lì, è molto più affidabile.", safeAction: "Continua solo dal portale ufficiale, senza usare link ricevuti via email." },
  { id: "real_agent_no_pressure", category: "Contratti", situation: "Un consulente assicurativo ti invia preventivo completo, fascicolo informativo, costi e ti invita a leggere prima di firmare.", isRisky: false, difficulty: "difficile", redFlags: ["Documenti completi", "Nessuna pressione"], explanation: "Trasparenza e assenza di fretta sono segnali positivi. Resta comunque importante capire costi, esclusioni e durata.", safeAction: "Leggi documenti, confronta alternative e chiedi chiarimenti prima di firmare." },
  { id: "marketplace_cash_public_place", category: "Marketplace", situation: "Vendi un oggetto di basso valore e l'acquirente propone incontro in luogo pubblico, pagamento in contanti e controllo dell'oggetto sul posto.", isRisky: false, difficulty: "difficile", redFlags: ["Luogo pubblico", "Pagamento immediato"], explanation: "Non tutto è una truffa: per oggetti semplici, incontro sicuro e pagamento contestuale possono essere ragionevoli.", safeAction: "Scegli un luogo sicuro, non andare da solo se non ti senti tranquillo e controlla il denaro." },
  { id: "secure_bank_message_no_codes", category: "Banca e pagamenti", situation: "La banca invia una notifica nell'app ufficiale che invita a leggere un documento, senza chiedere codici o clic esterni.", isRisky: false, difficulty: "difficile", redFlags: ["App ufficiale", "Nessun codice"], explanation: "Una comunicazione interna all'app ufficiale, senza richieste di codici o pagamenti, è generalmente più sicura.", safeAction: "Leggi dall'app ufficiale e verifica se qualcosa ti sembra insolito." },
  { id: "event_ticket_friend_known", category: "Eventi", situation: "Un amico che conosci di persona ti vende un biglietto a prezzo normale e ti permette di controllare nominativo e ricevuta prima del pagamento.", isRisky: false, difficulty: "difficile", redFlags: ["Persona nota", "Verifica biglietto"], explanation: "Il rischio è minore quando identità, prezzo e biglietto sono verificabili. Non è rischio zero, ma non è una classica truffa.", safeAction: "Controlla biglietto, nominativo e regole dell'evento prima di pagare." },
  { id: "small_local_charity_receipt", category: "Di persona", situation: "Una piccola associazione locale chiede donazioni, mostra statuto, contatti verificabili e rilascia ricevuta tracciabile.", isRisky: false, difficulty: "difficile", redFlags: ["Ricevuta", "Contatti verificabili"], explanation: "Una realta piccola non è automaticamente sospetta. La chiave e poter verificare identità, finalità e pagamento.", safeAction: "Dona solo se riesci a verificare l'associazione e preferisci pagamenti tracciabili." },
  { id: "bank_url_one_letter", category: "SMS / email", situation: "Ricevi una email della banca con grafica perfetta, ma il link porta a un dominio con una lettera diversa dal sito ufficiale.", isRisky: true, difficulty: "media", redFlags: ["Dominio simile", "Grafica perfetta", "Link"], explanation: "I siti clone possono essere quasi identici. Una lettera diversa nell'indirizzo e sufficiente per indicare rischio.", safeAction: "Non cliccare. Digita tu l'indirizzo ufficiale o usa l'app." },
  { id: "fake_spid_help", category: "Pubblica amministrazione", situation: "Uno sconosciuto offre aiuto per attivare SPID e chiede foto documenti, tessera sanitaria e codice ricevuto via SMS.", isRisky: true, difficulty: "media", redFlags: ["Documenti", "Codice SMS", "Identita digitale"], explanation: "SPID e identità digitale sono molto sensibili. Codici e documenti possono permettere furti d'identità.", safeAction: "Usa solo provider ufficiali e non condividere codici con terzi." },
  { id: "fake_landlord_video_only", category: "Affitti e casa", situation: "Per un affitto, il proprietàrio ti manda solo video dell'appartamento e dice che vive all'estero, chiedendo cauzione via bonifico.", isRisky: true, difficulty: "media", redFlags: ["Solo video", "Estero", "Cauzione anticipata"], explanation: "Video e foto possono essere copiati. Il pagamento prima di una verifica reale e rischioso.", safeAction: "Visita l'immobile o usa canali verificati prima di pagare." },
  { id: "atm_card_stuck_helper", category: "Di persona", situation: "La carta resta bloccata al bancomat e uno sconosciuto molto gentile ti suggerisce di reinserire il PIN mentre lui resta vicino.", isRisky: true, difficulty: "media", redFlags: ["Sconosciuto", "PIN", "Bancomat"], explanation: "Alcune truffe al bancomat usano distrazione e osservazione del PIN.", safeAction: "Copri il PIN, non accettare aiuto da sconosciuti e contatta la banca." },
  { id: "fake_delivery_address_fee", category: "SMS / email", situation: "Ricevi SMS: 'Indirizzo pacco incompleto, paga 0,89 euro per correggere la consegna'.", isRisky: true, difficulty: "media", redFlags: ["Importo piccolo", "Link", "Pacco"], explanation: "La piccola cifra serve a farti inserire la carta con poca attenzione.", safeAction: "Verifica tracking sul sito ufficiale del corriere." },
  { id: "social_ad_investment_ai", category: "Investimenti", situation: "Una pubblicita social propone un software AI che genera rendimenti automatici e garantiti se versi almeno 250 euro.", isRisky: true, difficulty: "media", redFlags: ["AI miracolosa", "Rendimenti garantiti", "Deposito minimo"], explanation: "Parole come AI e automatico possono mascherare promesse finanziarie non realistiche.", safeAction: "Non versare denaro. Verifica autorizzazioni e rischi reali." },
  { id: "fake_charity_disaster", category: "Beneficenza", situation: "Dopo una calamita, ricevi un link per donare subito a una raccolta fondi sconosciuta con foto drammatiche.", isRisky: true, difficulty: "media", redFlags: ["Emozione forte", "Link sconosciuto", "Urgenza"], explanation: "Le emergenze vere vengono sfruttate da raccolte fondi false o poco trasparenti.", safeAction: "Dona a enti riconosciuti tramite siti ufficiali." },
  { id: "fake_refund_marketplace", category: "Marketplace", situation: "Il venditore dice che c'è stato un problema e ti manda un link per 'sbloccare il rimborso' inserendo la carta.", isRisky: true, difficulty: "media", redFlags: ["Rimborso via link", "Carta richiesta", "Canale esterno"], explanation: "I rimborsi non richiedono di reinserire la carta su link esterni alla piattaforma.", safeAction: "Gestisci rimborso solo dentro la piattaforma ufficiale." },
  { id: "fake_insurance_renewal", category: "Assicurazioni", situation: "Ricevi una proposta RC auto molto economica da un sito poco noto che chiede pagamento immediato via bonifico.", isRisky: true, difficulty: "media", redFlags: ["Prezzo troppo basso", "Bonifico", "Sito poco noto"], explanation: "Polizze false o non valide possono sembrare convenienti ma lasciarti scoperto.", safeAction: "Verifica intermediario e compagnia su registri ufficiali prima di pagare." },
  { id: "school_trip_payment", category: "Pagamenti quotidiani", situation: "Una chat non ufficiale chiede pagamento per gita scolastica su IBAN privato non indicato dalla scuola.", isRisky: true, difficulty: "media", redFlags: ["IBAN privato", "Chat", "Pagamento non ufficiale"], explanation: "Pagamenti scolastici o associativi vanno verificati con canali ufficiali, non solo in chat.", safeAction: "Chiedi conferma alla scuola o all'organizzazione tramite canali ufficiali." },
  { id: "safe_known_charity_site", category: "Beneficenza", situation: "Vuoi donare a un ente noto e vai tu sul sito ufficiale digitando l'indirizzo nel browser.", isRisky: false, difficulty: "facile", redFlags: ["Iniziativa tua", "Sito ufficiale"], explanation: "Quando sei tu a scegliere il canale ufficiale, riduci il rischio di raccolte false.", safeAction: "Controlla URL e ricevuta della donazione." },
  { id: "safe_subscription_cancel", category: "Abbonamenti", situation: "Un servizio ti avvisa chiaramente che la prova gratuita scade domani e offre pulsante di cancellazione nell'area account.", isRisky: false, difficulty: "media", redFlags: ["Trasparenza", "Area account"], explanation: "Un promemoria chiaro con possibilità di cancellare è un comportamento più corretto.", safeAction: "Decidi se tenerlo e salva conferma di eventuale disdetta." },
  { id: "safe_document_to_notary", category: "Documenti", situation: "Il notaio incaricato per una compravendita ti chiede documenti tramite canale concordato e studio verificabile.", isRisky: false, difficulty: "media", redFlags: ["Studio verificabile", "Canale concordato"], explanation: "Inviare documenti può essere normale quando il soggetto è verificabile e il canale è concordato.", safeAction: "Verifica indirizzo email, studio e finalità prima di inviare." },

  { id: "romance_video_call_avoided", category: "Relazioni", situation: "Una persona conosciuta online ti scrive ogni giorno, dice di provare qualcosa per te ma evita sempre videochiamate e incontri. Dopo settimane chiede soldi per un'emergenza.", isRisky: true, difficulty: "difficile", redFlags: ["Legame emotivo", "Nessun incontro", "Emergenza"], explanation: "Le truffe sentimentali costruiscono fiducia prima di chiedere denaro. Evitare verifiche reali e chiedere soldi è un segnale forte.", safeAction: "Non inviare denaro. Proponi una videochiamata e parlane con una persona di fiducia prima di agire." },
  { id: "romance_travel_ticket", category: "Relazioni", situation: "Una ragazza o un ragazzo conosciuto online dice di voler venire a trovarti, ma chiede di pagare biglietto, visto o assicurazione per poter partire.", isRisky: true, difficulty: "media", redFlags: ["Promessa incontro", "Soldi per viaggio", "Urgenza emotiva"], explanation: "La promessa di incontrarsi può essere usata per rendere la richiesta più credibile. Spesso dopo il primo pagamento arrivano nuovi problemi e nuove richieste.", safeAction: "Non pagare viaggi o documenti a persone mai incontrate. Verifica identità e coerenza della storia." },
  { id: "romance_medical_emergency", category: "Relazioni", situation: "Una persona con cui stai creando un rapporto online racconta di una malattia improvvisa in famiglia e chiede un prestito urgente, promettendo di restituire tutto.", isRisky: true, difficulty: "difficile", redFlags: ["Malattia", "Prestito urgente", "Rapporto recente"], explanation: "Le emergenze sanitarie vere toccano corde profonde. Proprio per questo vengono usate per far agire senza verificare.", safeAction: "Fermati. Non inviare denaro senza verifiche indipendenti e senza aver coinvolto qualcuno di fiducia." },
  { id: "romance_crypto_advice", category: "Relazioni", situation: "Dopo alcune settimane di chat, una persona molto affettuosa ti mostra i suoi guadagni e ti invita a investire su una piattaforma consigliata da lei.", isRisky: true, difficulty: "difficile", redFlags: ["Relazione + investimento", "Piattaforma consigliata", "Profitti mostrati"], explanation: "Nelle truffe sentimentali evolute, l'investimento arriva dopo aver creato fiducia. La piattaforma può mostrare profitti finti.", safeAction: "Non investire su piattaforme indicate da persone conosciute online. Verifica autorizzazioni da fonti ufficiali." },
  { id: "romance_gift_customs_fee", category: "Relazioni", situation: "Una persona conosciuta online dice di averti spedito un regalo costoso. Poco dopo arriva una richiesta di pagamento per dogana o sblocco pacco.", isRisky: true, difficulty: "media", redFlags: ["Regalo inatteso", "Dogana", "Pagamento anticipato"], explanation: "Il regalo crea gratitudine e pressione. Il pagamento per sbloccarlo e spesso il vero obiettivo della truffa.", safeAction: "Non pagare. Verifica tracking e corriere da canali ufficiali, senza usare link ricevuti." },
  { id: "romance_blackmail_photos", category: "Relazioni", situation: "Dopo una chat privata, una persona minaccia di diffondere foto o messaggi se non paghi subito.", isRisky: true, difficulty: "difficile", redFlags: ["Ricatto", "Minaccia", "Pagamento immediato"], explanation: "Il ricatto punta su vergogna e paura. Pagare non garantisce che la richiesta finisca, anzi può aumentare le pressioni.", safeAction: "Non pagare. Conserva prove, blocca il contatto e valuta di rivolgerti alle autorita." },
  { id: "romance_bank_account_problem", category: "Relazioni", situation: "Una persona con cui chatti da poco dice di avere il conto bloccato e chiede di ricevere un bonifico sul tuo conto per poi girarlo a terzi.", isRisky: true, difficulty: "difficile", redFlags: ["Conto bloccato", "Usare il tuo conto", "Giro denaro"], explanation: "Usare il tuo conto per soldi di altri può esporti a rischi seri. Potrebbe trattarsi di fondi rubati o riciclaggio.", safeAction: "Non ricevere o trasferire denaro per persone che non conosci davvero." },
  { id: "romance_slow_friendship_no_money", category: "Relazioni", situation: "Una persona conosciuta online ti propone una videochiamata, non chiede soldi, non parla di investimenti e accetta tempi lenti per conoscersi.", isRisky: false, difficulty: "media", redFlags: ["Verifica identità", "Nessuna richiesta denaro"], explanation: "Non ogni conoscenza online è una truffa. L'assenza di richieste economiche è la disponibilità a verificarsi sono segnali più positivi.", safeAction: "Resta prudente, proteggi dati personali e incontra eventualmente in luoghi pubblici." },
  { id: "friend_investment_guaranteed_return", category: "Amici e parenti", situation: "Un amico ti propone un investimento 'garantito' che gli ha fatto guadagnare molto. Dice che se entri tramite lui hai un bonus e devi decidere entro oggi.", isRisky: true, difficulty: "difficile", redFlags: ["Amico", "Rendimento garantito", "Fretta"], explanation: "La fiducia personale non sostituisce le verifiche. Anche un amico può essere in buona fede ma coinvolto in una truffa o in uno schema rischioso.", safeAction: "Chiedi documenti, autorizzazioni e rischi. Non investire solo per fiducia o pressione." },
  { id: "relative_crypto_family_group", category: "Amici e parenti", situation: "Un parente condivide nel gruppo famiglia un link per comprare una crypto 'prima che esploda', dicendo che alcuni amici hanno già raddoppiato.", isRisky: true, difficulty: "media", redFlags: ["Passaparola", "Guadagni rapidi", "Link"], explanation: "Il passaparola familiare può abbassare le difese. Guadagni rapidi e link non verificati restano segnali di rischio.", safeAction: "Non investire tramite link in chat. Verifica progetto, rischi e autorizzazioni prima di qualsiasi versamento." },
  { id: "friend_loan_emotional_pressure", category: "Amici e parenti", situation: "Un amico ti chiede un prestito importante e dice: 'Se mi vuoi bene, non farmi domande'. Vuole contanti e promette di restituire a breve.", isRisky: true, difficulty: "difficile", redFlags: ["Senso di colpa", "Contanti", "Nessuna chiarezza"], explanation: "Le richieste emotive possono rendere difficile fare domande. Un prestito senza chiarezza può danneggiare sia soldi sia rapporto.", safeAction: "Chiedi motivo, tempi e modalità scritte. Presta solo somme che puoi permetterti di perdere." },
  { id: "relative_urgent_transfer_new_number", category: "Amici e parenti", situation: "Ricevi un messaggio da un numero nuovo: 'Sono tuo figlio, ho perso il telefono. Devo pagare subito una bolletta, fai un bonifico?'.", isRisky: true, difficulty: "media", redFlags: ["Numero nuovo", "Urgenza", "Bonifico"], explanation: "La truffa del familiare in difficoltà usa affetto e urgenza. Il numero nuovo e la richiesta di soldi sono segnali importanti.", safeAction: "Chiama il familiare sul vecchio numero o verifica con altri parenti prima di pagare." },
  { id: "friend_business_partnership_cash", category: "Amici e parenti", situation: "Un conoscente ti propone di entrare in una piccola attività con denaro contante, senza contratto, dicendo che 'tra amici non servono carte'.", isRisky: true, difficulty: "difficile", redFlags: ["Niente contratto", "Contanti", "Fiducia personale"], explanation: "Quando ci sono soldi e attività economiche, la fiducia non basta. Senza documenti e regole chiare il rischio è alto.", safeAction: "Pretendi accordi scritti, conti chiari e consulenza indipendente prima di versare denaro." },
  { id: "relative_medical_loan_verified", category: "Amici e parenti", situation: "Un familiare ti chiede aiuto economico per una spesa medica, ti mostra documenti verificabili e accetta un bonifico tracciabile con accordo scritto sui tempi.", isRisky: false, difficulty: "difficile", redFlags: ["Documenti verificabili", "Bonifico tracciabile", "Accordo chiaro"], explanation: "Una richiesta emotiva non è automaticamente una truffa. Verifiche, trasparenza e tracciabilità riducono il rischio.", safeAction: "Aiuta solo se puoi permettertelo e metti per iscritto importo e tempi, senza sensi di colpa." },
  { id: "friend_asks_card_for_emergency", category: "Amici e parenti", situation: "Un amico dice di avere la carta bloccata e ti chiede di prestargli la tua carta o i dati per fare un pagamento urgente.", isRisky: true, difficulty: "media", redFlags: ["Dati carta", "Urgenza", "Prestito mezzo pagamento"], explanation: "Anche se conosci la persona, condividere carta, PIN o codici è pericoloso e può creare problemi difficili da risolvere.", safeAction: "Non condividere dati di pagamento. Se vuoi aiutare, usa un bonifico tracciabile a suo nome." },
  { id: "romance_investment_group_invite", category: "Relazioni", situation: "Una persona conosciuta su un'app di incontri ti invita in un gruppo esclusivo dove un 'mentor' insegna a fare trading con segnali sicuri.", isRisky: true, difficulty: "difficile", redFlags: ["Dating + trading", "Gruppo esclusivo", "Segnali sicuri"], explanation: "Il passaggio da relazione a gruppo di investimento è un modello frequente nelle truffe. Il gruppo crea pressione sociale e fiducia artificiale.", safeAction: "Esci dal gruppo e non versare denaro. Verifica sempre intermediari e autorizzazioni." },
  { id: "romance_money_for_document", category: "Relazioni", situation: "Una persona dice di non poter incontrarti perché deve rinnovare un documento. Chiede soldi per completare la pratica e promette che poi verrà da te.", isRisky: true, difficulty: "media", redFlags: ["Documento", "Promessa incontro", "Pagamento"], explanation: "La richiesta usa il desiderio di incontrarsi per rendere il pagamento accettabile. Spesso dopo emergono altri ostacoli.", safeAction: "Non pagare documenti a persone mai incontrate. Verifica identità e situazione con calma." },
  { id: "friend_guarantee_loan", category: "Amici e parenti", situation: "Un amico ti chiede di fare da garante per un finanziamento. Dice che è solo una formalità e che non rischi nulla.", isRisky: true, difficulty: "difficile", redFlags: ["Garante", "Rischio minimizzato", "Pressione affettiva"], explanation: "Fare da garante non è una formalità: se l'altra persona non paga, il debito può ricadere su di te.", safeAction: "Leggi il contratto, valuta il rischio reale e chiedi consulenza prima di firmare." },
  { id: "relative_investment_to_help_family", category: "Amici e parenti", situation: "Un parente ti propone di investire in un progetto 'per aiutare la famiglia' e dice che rifiutare sarebbe mancanza di fiducia.", isRisky: true, difficulty: "difficile", redFlags: ["Senso di colpa", "Famiglia", "Investimento poco chiaro"], explanation: "Quando investimento e legame familiare si mischiano, è facile perdere lucidità. La pressione emotiva è un segnale da prendere sul serio.", safeAction: "Separare affetto e soldi: chiedi business plan, rischi e accordi scritti prima di decidere." },
  { id: "friend_repay_old_debt_link", category: "Amici e parenti", situation: "Un vecchio amico ti scrive sui social dicendo di volerti restituire dei soldi, ma ti manda un link dove inserire carta e documento per riceverli.", isRisky: true, difficulty: "media", redFlags: ["Link pagamento", "Documento", "Profilo social"], explanation: "Potrebbe essere un profilo compromesso. Per ricevere soldi non serve inserire dati carta su link sospetti.", safeAction: "Verifica l'identità con una chiamata e usa metodi di pagamento noti e sicuri." },
  { id: "romance_shared_future_pressure", category: "Relazioni", situation: "Una persona parla presto di convivenza, matrimonio o futuro insieme e poi chiede un aiuto economico per 'sistemare l'ultimo problema' prima di raggiungerti.", isRisky: true, difficulty: "difficile", redFlags: ["Futuro accelerato", "Aiuto economico", "Problema finale"], explanation: "Le promesse di futuro possono creare attaccamento rapido. La richiesta economica dopo una forte spinta emotiva è un segnale di rischio.", safeAction: "Non inviare denaro. Dai tempo alla relazione e verifica fatti, identità e coerenza." },
  { id: "romance_real_meeting_public_no_money", category: "Relazioni", situation: "Una persona conosciuta online propone un primo incontro in luogo pubblico, non chiede denaro e accetta che tu avvisi un amico dell'appuntamento.", isRisky: false, difficulty: "media", redFlags: ["Luogo pubblico", "Nessuna richiesta soldi", "Prudenza"], explanation: "Questo comportamento è più prudente e trasparente. Non elimina ogni rischio personale, ma non mostra i classici segnali economici della truffa affettiva.", safeAction: "Incontra in luogo pubblico, informa qualcuno e non condividere dati finanziari." },
  { id: "friend_investment_documents_verified", category: "Amici e parenti", situation: "Un amico ti parla di un investimento, ma ti dice chiaramente che ci sono rischi, ti invita a leggere documenti ufficiali e non ti spinge a decidere subito.", isRisky: false, difficulty: "difficile", redFlags: ["Rischi dichiarati", "Documenti ufficiali", "Nessuna fretta"], explanation: "La presenza di rischi spiegati, documenti verificabili e assenza di pressione sono segnali più sani. Resta comunque da valutare se sia adatto a te.", safeAction: "Leggi documenti, verifica autorizzazioni e valuta con calma prima di investire." },
  { id: "relative_loan_no_written_terms", category: "Amici e parenti", situation: "Un cugino ti chiede 3.000 euro in prestito e dice che non serve scrivere nulla perché 'siamo parenti'.", isRisky: true, difficulty: "media", redFlags: ["Prestito familiare", "Nessun accordo", "Importo rilevante"], explanation: "Prestiti tra parenti senza accordi chiari possono creare conflitti e perdite. La fiducia non sostituisce chiarezza su tempi e restituzione.", safeAction: "Se decidi di aiutare, metti importo, tempi e modalità per iscritto." },
  { id: "friend_multilevel_recruit", category: "Amici e parenti", situation: "Un amico ti invita a un incontro per un'opportunità di guadagno. Il focus è far entrare altre persone più che vendere un prodotto reale.", isRisky: true, difficulty: "difficile", redFlags: ["Reclutamento", "Guadagni promessi", "Pressione gruppo"], explanation: "Quando il guadagno dipende soprattutto dal reclutare altri, il rischio di schema insostenibile aumenta molto.", safeAction: "Chiedi come si genera davvero il guadagno, costi iniziali e documenti. Non firmare sull'onda dell'entusiasmo." },
  { id: "romance_soldier_oil_worker", category: "Relazioni", situation: "Una persona dice di essere militare, medico o lavoratore all'estero, non può videochiamare per sicurezza e chiede soldi per sbloccare documenti o bagagli.", isRisky: true, difficulty: "media", redFlags: ["All'estero", "No videochiamata", "Soldi per sblocco"], explanation: "Profili con lavori difficili da verificare e impossibilità di incontrarsi sono comuni nelle truffe sentimentali.", safeAction: "Non inviare denaro e non fidarti di documenti inviati in chat senza verifiche indipendenti." },
  { id: "friend_sudden_profit_screenshot", category: "Amici e parenti", situation: "Un amico ti manda screenshot di profitti elevati su una piattaforma e dice che anche tu puoi iniziare con poco, ma devi usare il suo link.", isRisky: true, difficulty: "media", redFlags: ["Screenshot profitti", "Link personale", "Guadagno facile"], explanation: "Screenshot e testimonianze possono essere falsi o non rappresentare il rischio reale. Il link personale può incentivare chi ti invita.", safeAction: "Non basarti su screenshot. Verifica piattaforma, rischi, autorizzazioni e costi." },
  { id: "relative_emergency_cash_courier", category: "Amici e parenti", situation: "Un presunto parente ti chiama in lacrime e dice che manderà un corriere a ritirare contanti o gioielli per risolvere un'emergenza.", isRisky: true, difficulty: "difficile", redFlags: ["Corriere", "Contanti/gioielli", "Panico"], explanation: "Le richieste di consegnare contanti o gioielli a intermediari sono un segnale molto forte di truffa emotiva.", safeAction: "Non consegnare nulla. Richiama il parente e contatta le forze dell'ordine se necessario." },
  { id: "romance_wants_your_documents", category: "Relazioni", situation: "Una persona conosciuta da poco dice di voler prenotare un viaggio insieme e ti chiede foto di documento, codice fiscale e indirizzo.", isRisky: true, difficulty: "media", redFlags: ["Documenti", "Rapporto recente", "Viaggio"], explanation: "Documenti e dati personali possono essere usati per furto d'identità, contratti o profili falsi.", safeAction: "Non inviare documenti a persone non verificate. Prenota tu tramite canali ufficiali se necessario." },
  { id: "friend_short_term_loan_written", category: "Amici e parenti", situation: "Un amico fidato chiede un piccolo prestito, spiega il motivo, propone bonifico tracciabile e una data precisa di restituzione scritta.", isRisky: false, difficulty: "media", redFlags: ["Trasparenza", "Accordo scritto", "Importo sostenibile"], explanation: "Non ogni prestito tra amici è una truffa. Chiarezza, tracciabilità e importo sostenibile rendono la situazione più gestibile.", safeAction: "Presta solo ciò che puoi permetterti e conserva accordo e pagamento tracciabile." },
  { id: "romance_video_call_investment", category: "Relazioni", situation: "Una persona conosciuta online accetta videochiamate brevi, ma dopo pochi giorni ti propone una piattaforma di investimento usata da un suo familiare esperto.", isRisky: true, difficulty: "difficile", redFlags: ["Relazione recente", "Investimento", "Fiducia costruita"], explanation: "La videochiamata può rendere la persona più credibile, ma il passaggio rapido verso investimenti resta un segnale di rischio.", safeAction: "Non investire tramite link ricevuti in chat. Verifica piattaforma e autorizzazioni da fonti indipendenti." },
  { id: "romance_small_first_help", category: "Relazioni", situation: "Una persona con cui chatti da settimane chiede solo 25 euro per una ricarica, dicendo che è imbarazzata e te li restituira domani.", isRisky: true, difficulty: "media", redFlags: ["Richiesta piccola", "Imbarazzo", "Relazione online"], explanation: "Le richieste piccole servono spesso a testare disponibilità e fiducia. Possono diventare richieste sempre più grandi.", safeAction: "Non inviare denaro a persone mai incontrate. Mantieni confini chiari anche se l importo sembra basso." },
  { id: "romance_public_no_money", category: "Relazioni", situation: "Una persona conosciuta online propone di vedervi in un bar pubblico, non chiede soldi e accetta di aspettare i tuoi tempi.", isRisky: false, difficulty: "media", redFlags: ["Luogo pubblico", "Nessuna richiesta denaro", "Tempo per decidere"], explanation: "Non è una truffa economica evidente. Resta comunque prudente sulla sicurezza personale e sui dati che condividi.", safeAction: "Incontra in luogo pubblico, informa qualcuno e non condividere dati finanziari o documenti." },
  { id: "romance_crypto_together", category: "Relazioni", situation: "Una persona con cui stai creando confidenza dice che potreste costruire un futuro insieme iniziando a investire entrambi in crypto su una piattaforma privata.", isRisky: true, difficulty: "difficile", redFlags: ["Futuro insieme", "Crypto", "Piattaforma privata"], explanation: "La promessa di un progetto comune può abbassare le difese. Le piattaforme private non verificate sono un rischio alto.", safeAction: "Non versare denaro. Verifica società, autorizzazioni e possibilità di prelievo da fonti indipendenti." },
  { id: "romance_medical_emergency_extra2", category: "Relazioni", situation: "Una persona conosciuta in chat dice che un familiare e in ospedale e chiede un aiuto urgente, promettendo di restituire tutto.", isRisky: true, difficulty: "difficile", redFlags: ["Emergenza medica", "Urgenza", "Pressione emotiva"], explanation: "Le emergenze mediche sono usate per creare senso di colpa e velocita. La storia può sembrare umana ma non è verificabile.", safeAction: "Non inviare denaro. Chiedi verifiche indipendenti e prenditi tempo prima di qualsiasi decisione." },
  { id: "romance_ticket_to_visit", category: "Relazioni", situation: "Una persona dice di voler venire a trovarti ma chiede soldi per il biglietto aereo perché la carta non funziona.", isRisky: true, difficulty: "media", redFlags: ["Biglietto viaggio", "Carta non funziona", "Promessa incontro"], explanation: "Il desiderio di incontrarsi rende la richiesta più credibile. Spesso dopo il primo pagamento compaiono nuovi ostacoli.", safeAction: "Non pagare viaggi a persone che non conosci davvero. Verifica identità e prenotazioni da canali ufficiali." },
  { id: "romance_shared_bank_account", category: "Relazioni", situation: "Dopo poche settimane una persona dice che per fidarsi davvero dovreste aprire un conto o condividere dati bancari.", isRisky: true, difficulty: "difficile", redFlags: ["Dati bancari", "Relazione accelerata", "Fiducia richiesta"], explanation: "La richiesta di condividere dati o conti e sproporzionata rispetto a una relazione recente e può portare a furti o debiti.", safeAction: "Non condividere dati bancari, codici o documenti. Una relazione sana non richiede accesso ai tuoi soldi." },
  { id: "romance_photo_blackmail", category: "Relazioni", situation: "Dopo uno scambio intimo, una persona minaccia di inviare foto o chat ai tuoi contatti se non paghi.", isRisky: true, difficulty: "difficile", redFlags: ["Ricatto", "Vergogna", "Pagamento urgente"], explanation: "Il ricatto sfrutta paura e vergogna. Pagare non garantisce che la minaccia finisca.", safeAction: "Non pagare. Conserva prove, blocca il contatto e valuta denuncia o supporto specializzato." },
  { id: "romance_slow_boundaries", category: "Relazioni", situation: "La persona che stai conoscendo rispetta i tuoi confini, non chiede soldi e non propone investimenti o favori economici.", isRisky: false, difficulty: "facile", redFlags: ["Confini rispettati", "Nessuna pressione", "Nessuna richiesta soldi"], explanation: "Questo comportamento non mostra segnali economici di truffa. La prudenza resta utile, ma non ogni conoscenza online e pericolosa.", safeAction: "Continua con calma, proteggi dati personali e non anticipare fiducia economica." },
  { id: "romance_bank_account_transfer", category: "Relazioni", situation: "Una persona conosciuta online ti chiede di ricevere un bonifico sul tuo conto perché nel suo paese ci sono restrizioni.", isRisky: true, difficulty: "difficile", redFlags: ["Conto personale", "Estero", "Transito fondi"], explanation: "Usare il tuo conto per terzi può esporti a rischi legali e finanziari.", safeAction: "Rifiuta. Non fare transitare fondi per persone conosciute online." },
  { id: "romance_document_money", category: "Relazioni", situation: "Una persona dice di non poter viaggiare per incontrarti finche non rinnova un documento e ti chiede soldi per la pratica.", isRisky: true, difficulty: "media", redFlags: ["Documento", "Promessa incontro", "Pagamento"], explanation: "La richiesta usa il desiderio di incontrarsi per rendere il pagamento accettabile. Spesso emergono altri ostacoli.", safeAction: "Non pagare documenti a persone mai incontrate. Verifica identità e situazione con calma." },
  { id: "romance_charity_project", category: "Relazioni", situation: "Una persona conosciuta online ti chiede di donare al suo progetto benefico personale, ma il sito non indica ente, bilanci o referenti.", isRisky: true, difficulty: "media", redFlags: ["Beneficenza personale", "Sito opaco", "Relazione online"], explanation: "Beneficenza e relazione possono creare pressione. Senza ente e trasparenza, il rischio è alto.", safeAction: "Dona solo a enti verificabili e canali ufficiali." },
  { id: "romance_family_blocked_card", category: "Relazioni", situation: "Una persona con cui parli ogni giorno dice che la carta è stata bloccata e chiede un prestito per pagare affitto e medicine.", isRisky: true, difficulty: "difficile", redFlags: ["Carta bloccata", "Bisogni essenziali", "Prestito"], explanation: "Bisogni essenziali e contatto quotidiano possono creare forte coinvolgimento emotivo. La verifica resta necessaria.", safeAction: "Non inviare denaro senza verifiche indipendenti. Se vuoi aiutare, cerca canali ufficiali e tracciabili." },
  { id: "romance_investment_mentor", category: "Relazioni", situation: "Una persona conosciuta su un app di incontri ti presenta un mentor che insegna trading con segnali sicuri.", isRisky: true, difficulty: "difficile", redFlags: ["Dating + trading", "Mentor", "Segnali sicuri"], explanation: "Il passaggio da relazione a investimento è un modello frequente nelle truffe. Il mentor crea autorita artificiale.", safeAction: "Non versare denaro. Esci dal gruppo e verifica intermediari su registri ufficiali." },
  { id: "romance_future_pressure", category: "Relazioni", situation: "Una persona parla presto di convivenza e futuro insieme, poi chiede soldi per risolvere l ultimo problema prima di raggiungerti.", isRisky: true, difficulty: "difficile", redFlags: ["Futuro accelerato", "Aiuto economico", "Problema finale"], explanation: "Le promesse di futuro possono creare attaccamento rapido. La richiesta economica dopo spinta emotiva è un segnale di rischio.", safeAction: "Non inviare denaro. Dai tempo alla relazione e verifica fatti, identità e coerenza." },
  { id: "friend_loan_cash_no_trace", category: "Amici e parenti", situation: "Un amico ti chiede 1.500 euro in contanti per evitare problemi con la banca e dice di non fare bonifici.", isRisky: true, difficulty: "difficile", redFlags: ["Contanti", "Nessuna traccia", "Urgenza"], explanation: "La richiesta di contanti e assenza di traccia rende difficile dimostrare il prestito e recuperare il denaro.", safeAction: "Se decidi di aiutare, usa pagamento tracciabile e accordo scritto con tempi di restituzione." },
  { id: "friend_loan_clear_terms", category: "Amici e parenti", situation: "Un amico chiede un prestito limitato, propone bonifico, accordo scritto e restituzione a rate sostenibili.", isRisky: false, difficulty: "media", redFlags: ["Accordo scritto", "Tracciabilità", "Importo limitato"], explanation: "Non è automaticamente una truffa. Chiarezza e tracciabilità proteggono entrambi.", safeAction: "Presta solo ciò che puoi permetterti di perdere e conserva accordo e prove di pagamento." },
  { id: "relative_business_no_docs", category: "Amici e parenti", situation: "Un parente ti chiede di investire nella sua attività senza bilanci, dicendo che tra familiari non servono documenti.", isRisky: true, difficulty: "difficile", redFlags: ["Famiglia", "Nessun documento", "Investimento"], explanation: "Il legame familiare non elimina il rischio. Senza documenti non sai cosa stai finanziando e con quali diritti.", safeAction: "Chiedi numeri, contratto, rischi e tempi. Se non sono chiari, non investire." },
  { id: "friend_account_blocked_transfer", category: "Amici e parenti", situation: "Un amico dice che il suo conto è bloccato e ti chiede di ricevere soldi sul tuo conto per poi girarglieli.", isRisky: true, difficulty: "difficile", redFlags: ["Conto terzi", "Transito denaro", "Spiegazione vaga"], explanation: "Fare transitare denaro per altri può esporti a problemi seri se i fondi hanno origine dubbia.", safeAction: "Non usare il tuo conto per movimenti di altri. Suggerisci canali ufficiali e tracciabili." },
  { id: "relative_voice_iban_new", category: "Amici e parenti", situation: "Ricevi un vocale che sembra di un familiare: dice di essere nei guai e chiede un bonifico immediato su un IBAN nuovo.", isRisky: true, difficulty: "difficile", redFlags: ["Vocale credibile", "IBAN nuovo", "Emergenza"], explanation: "Anche la voce può essere imitata o manipolata. Urgenza e IBAN nuovo restano segnali molto forti.", safeAction: "Richiama il familiare su numero conosciuto o verifica con altri parenti prima di inviare denaro." },
  { id: "friend_real_product_unsuitable", category: "Amici e parenti", situation: "Un amico ti segnala un prodotto finanziario reale e autorizzato, ma molto rischioso, dicendo che a lui sta andando bene.", isRisky: true, difficulty: "difficile", redFlags: ["Prodotto reale", "Rischio alto", "Esperienza altrui"], explanation: "Anche un prodotto vero può essere inadatto. Il fatto che funzioni per un amico non significa che sia adatto a te.", safeAction: "Leggi rischi e costi. Valuta obiettivi, orizzonte e tolleranza alle perdite prima di decidere." },
  { id: "family_gift_traceable", category: "Amici e parenti", situation: "Un familiare vuole regalarti una somma con bonifico tracciabile e causale chiara, senza chiedere nulla in cambio.", isRisky: false, difficulty: "facile", redFlags: ["Bonifico tracciabile", "Nessuna pressione", "Causale chiara"], explanation: "Non mostra segnali tipici di truffa. Resta utile chiarire motivazione e aspetti fiscali se l importo e rilevante.", safeAction: "Conserva traccia del bonifico e valuta eventuali implicazioni se la somma e alta." },
  { id: "friend_card_data_request", category: "Amici e parenti", situation: "Un amico ti chiede di prestargli carta, PIN o codici per fare un pagamento urgente.", isRisky: true, difficulty: "media", redFlags: ["Dati carta", "Urgenza", "Prestito mezzo pagamento"], explanation: "Anche se conosci la persona, condividere carta, PIN o codici è pericoloso e può creare problemi difficili da risolvere.", safeAction: "Non condividere dati di pagamento. Se vuoi aiutare, usa un bonifico tracciabile." },
  { id: "friend_guarantee_loan_extra2", category: "Amici e parenti", situation: "Un amico ti chiede di fare da garante per un finanziamento. Dice che è solo una formalità e che non rischi nulla.", isRisky: true, difficulty: "difficile", redFlags: ["Garante", "Rischio minimizzato", "Pressione affettiva"], explanation: "Fare da garante non è una formalità: se l altra persona non paga, il debito può ricadere su di te.", safeAction: "Leggi il contratto, valuta il rischio reale e chiedi consulenza prima di firmare." },
  { id: "relative_family_guilt_investment", category: "Amici e parenti", situation: "Un parente ti propone di investire in un progetto per aiutare la famiglia e dice che rifiutare sarebbe mancanza di fiducia.", isRisky: true, difficulty: "difficile", redFlags: ["Senso di colpa", "Famiglia", "Investimento poco chiaro"], explanation: "Quando investimento e legame familiare si mischiano, è facile perdere lucidità. La pressione emotiva è un segnale.", safeAction: "Separa affetto e soldi: chiedi business plan, rischi e accordi scritti prima di decidere." },
  { id: "friend_repay_link", category: "Amici e parenti", situation: "Un vecchio amico ti scrive sui social dicendo di volerti restituire soldi, ma ti manda un link dove inserire carta e documento.", isRisky: true, difficulty: "media", redFlags: ["Link pagamento", "Documento", "Profilo social"], explanation: "Potrebbe essere un profilo compromesso. Per ricevere soldi non serve inserire dati carta su link sospetti.", safeAction: "Verifica l identità con una chiamata e usa metodi di pagamento noti e sicuri." },
  { id: "relative_loan_no_written_terms_extra2", category: "Amici e parenti", situation: "Un cugino ti chiede 3.000 euro in prestito e dice che non serve scrivere nulla perché siete parenti.", isRisky: true, difficulty: "media", redFlags: ["Prestito familiare", "Nessun accordo", "Importo rilevante"], explanation: "Prestiti tra parenti senza accordi chiari possono creare conflitti e perdite. La fiducia non sostituisce chiarezza.", safeAction: "Se decidi di aiutare, metti importo, tempi e modalità per iscritto." },
  { id: "friend_multilevel_recruit_extra2", category: "Amici e parenti", situation: "Un amico ti invita a un incontro per un opportunità di guadagno dove il focus e far entrare altre persone.", isRisky: true, difficulty: "difficile", redFlags: ["Reclutamento", "Guadagni promessi", "Pressione gruppo"], explanation: "Quando il guadagno dipende soprattutto dal reclutare altri, il rischio di schema insostenibile aumenta molto.", safeAction: "Chiedi come si genera davvero il guadagno, costi iniziali e documenti. Non firmare sull entusiasmo." },
  { id: "friend_medical_direct_payment", category: "Amici e parenti", situation: "Un amico chiede aiuto per una spesa medica, mostra documenti verificabili e accetta pagamento diretto alla struttura.", isRisky: false, difficulty: "difficile", redFlags: ["Documenti verificabili", "Pagamento diretto", "Nessuna fretta"], explanation: "Non è necessariamente una truffa: la possibilità di pagare direttamente e verificare riduce il rischio.", safeAction: "Se vuoi aiutare, paga canali ufficiali e conserva ricevuta." },
  { id: "emotional_blackmail_parent", category: "Amici e parenti", situation: "Un familiare ti dice che se non gli presti soldi rovinerai il rapporto e non ti parlerà più.", isRisky: true, difficulty: "difficile", redFlags: ["Ricatto emotivo", "Famiglia", "Prestito"], explanation: "La pressione affettiva può portare a decisioni finanziarie non sostenibili. Aiutare non deve metterti in difficoltà.", safeAction: "Prenditi tempo, definisci limiti e metti eventuali accordi per iscritto." },
  { id: "investment_friend_low_amount", category: "Amici e parenti", situation: "Un amico ti dice di iniziare con soli 50 euro su una piattaforma sconosciuta per vedere come va.", isRisky: true, difficulty: "difficile", redFlags: ["Importo piccolo", "Piattaforma sconosciuta", "Test fiducia"], explanation: "L importo basso serve a farti iniziare. Dopo il primo versamento possono aumentare richieste e pressione.", safeAction: "Non testare piattaforme non verificate. Cerca autorizzazioni e recensioni indipendenti." },
  { id: "door_charity_child_guilt", category: "Di persona", situation: "Una persona mostra foto di bambini malati e ti chiede contanti subito, dicendo che rifiutare significa non avere cuore.", isRisky: true, difficulty: "media", redFlags: ["Senso di colpa", "Contanti", "Nessuna verifica"], explanation: "La pressione emotiva può essere usata per impedire verifiche. Una raccolta seria accetta controlli e canali ufficiali.", safeAction: "Non donare in contanti sotto pressione. Cerca l ente e dona dal sito ufficiale." },
  { id: "door_utility_discount_now", category: "Di persona", situation: "Un incaricato dice che il tuo contratto luce e sbagliato e che solo firmando subito avrai diritto a uno sconto riservato.", isRisky: true, difficulty: "media", redFlags: ["Firma immediata", "Sconto riservato", "Confusione contratto"], explanation: "Le vendite aggressive puntano a farti firmare prima di leggere. Uno sconto vero può essere verificato con calma.", safeAction: "Non firmare subito. Chiedi copia dell offerta e confrontala da casa." },
  { id: "cash_investment_neighbor", category: "Di persona", situation: "Un vicino propone di consegnargli contanti per una occasione di investimento riservata, senza contratto.", isRisky: true, difficulty: "difficile", redFlags: ["Contanti", "Investimento riservato", "Nessun contratto"], explanation: "Vicinanza e fiducia di quartiere possono far abbassare le difese. Contanti senza contratto sono un rischio alto.", safeAction: "Non consegnare contanti per investimenti. Chiedi documenti e soggetto autorizzato." },
  { id: "community_collection_clear", category: "Di persona", situation: "Un gruppo di quartiere raccoglie piccole quote per una spesa comune, con elenco pubblico e ricevute.", isRisky: false, difficulty: "media", redFlags: ["Trasparenza", "Ricevute", "Importo piccolo"], explanation: "La trasparenza rende la situazione più gestibile. Resta utile sapere chi custodisce il denaro.", safeAction: "Versa solo importi sostenibili e con ricevuta o traccia." },
  { id: "elderly_fake_police_jewels", category: "Familiari", situation: "Un anziano riceve visita di persone che dicono di dover controllare gioielli per una indagine di polizia.", isRisky: true, difficulty: "facile", redFlags: ["Falsa autorita", "Gioielli", "Visita a casa"], explanation: "Forze dell ordine non chiedono di consegnare gioielli a casa in questo modo.", safeAction: "Non consegnare nulla e chiama il 112 o familiari da numeri conosciuti." },
  { id: "official_police_station", category: "Familiari", situation: "Una persona viene invitata a recarsi in caserma per una denuncia tramite comunicazione verificabile.", isRisky: false, difficulty: "media", redFlags: ["Sede ufficiale", "Verificabile", "Nessuna richiesta denaro"], explanation: "Una convocazione verificabile presso sede ufficiale non ha i segnali tipici della truffa economica.", safeAction: "Verifica telefonando alla sede ufficiale se hai dubbi." },
  { id: "parking_qr_fake", category: "Pagamenti reali", situation: "In un parcheggio trovi un QR code adesivo sopra il cartello ufficiale per pagare la sosta.", isRisky: true, difficulty: "difficile", redFlags: ["QR code adesivo", "Pagamento", "Sito non verificato"], explanation: "QR code falsi possono portare a siti che rubano dati. Un adesivo sovrapposto è un segnale da verificare.", safeAction: "Usa app ufficiale o sito indicato da fonti certe, non un QR sospetto." },
  { id: "restaurant_qr_menu_safe", category: "Pagamenti reali", situation: "Al ristorante il QR code porta solo al menu, non chiede dati personali o pagamenti.", isRisky: false, difficulty: "facile", redFlags: ["Menu", "Nessun pagamento", "Nessun dato sensibile"], explanation: "Un QR per consultare il menu è normale se non richiede dati o pagamenti sospetti.", safeAction: "Controlla comunque l indirizzo se devi inserire dati o pagare." },
  { id: "atm_stranger_help", category: "Pagamenti reali", situation: "Al bancomat uno sconosciuto ti offre aiuto e si avvicina mentre inserisci PIN e carta.", isRisky: true, difficulty: "facile", redFlags: ["Bancomat", "PIN", "Sconosciuto vicino"], explanation: "La vicinanza durante prelievo o inserimento PIN espone a furto di dati o carta.", safeAction: "Copri il PIN, annulla se ti senti osservato e non accettare aiuto da sconosciuti." },
  { id: "pos_amount_receipt", category: "Pagamenti reali", situation: "Paghi con carta in negozio, il commerciante ti mostra importo sul POS e ti consegna ricevuta.", isRisky: false, difficulty: "facile", redFlags: ["Importo visibile", "Ricevuta", "Negozio fisico"], explanation: "È una procedura normale. Il controllo dell importo resta sempre utile.", safeAction: "Verifica importo prima di avvicinare la carta e conserva ricevuta se serve." },
  { id: "invoice_iban_changed_extra2", category: "Banca e pagamenti", situation: "Ricevi una fattura reale da un fornitore, ma una seconda email comunica un nuovo IBAN per pagare.", isRisky: true, difficulty: "difficile", redFlags: ["IBAN cambiato", "Fattura reale", "Email separata"], explanation: "Le frodi su IBAN modificato sfruttano documenti veri e cambiano solo il conto di pagamento.", safeAction: "Verifica il cambio IBAN chiamando un numero già noto, non quello indicato nella email." },
  { id: "condo_iban_change", category: "Casa e condominio", situation: "L amministratore comunica un nuovo IBAN per le spese condominiali da una email insolita e con tono urgente.", isRisky: true, difficulty: "difficile", redFlags: ["IBAN nuovo", "Email insolita", "Urgenza"], explanation: "Un cambio IBAN e sempre da verificare. Le truffe usano contesti reali come condominio o fornitori.", safeAction: "Contatta l amministratore da numero già conosciuto prima di pagare." },
  { id: "condo_official_notice", category: "Casa e condominio", situation: "Ricevi comunicazione di assemblea condominiale con canali noti e nessuna richiesta di pagamento immediato.", isRisky: false, difficulty: "facile", redFlags: ["Canale noto", "Nessun pagamento urgente", "Verificabile"], explanation: "Non presenta segnali forti di truffa. Le comunicazioni ordinarie possono comunque essere controllate.", safeAction: "Confronta con bacheca, PEC o contatti abituali se hai dubbi." },
  { id: "rental_owner_abroad_docs", category: "Affitti e casa", situation: "Il proprietàrio dice di vivere all estero, invia documenti e chiede caparra prima della visita tramite bonifico estero.", isRisky: true, difficulty: "difficile", redFlags: ["Proprietario all estero", "Caparra prima visita", "Bonifico estero"], explanation: "Documenti inviati in chat possono essere falsi o rubati. Caparra prima di vedere resta un segnale critico.", safeAction: "Visita l immobile, verifica proprietà e contratto prima di pagare." },
  { id: "rental_after_visit_receipt", category: "Affitti e casa", situation: "Dopo visita di una stanza, coinquilini e proprietàrio verificabili chiedono una piccola caparra tracciabile con ricevuta.", isRisky: false, difficulty: "media", redFlags: ["Visita effettuata", "Ricevuta", "Tracciabilità"], explanation: "La visita e la tracciabilità riducono il rischio. Serve comunque leggere condizioni e identità.", safeAction: "Paga solo con causale chiara e conserva ricevuta e accordo." },
  { id: "used_car_no_vin", category: "Auto usata", situation: "Il venditore di un auto usata rifiuta di condividere targa o telaio prima dell incontro e chiede anticipo per bloccarla.", isRisky: true, difficulty: "media", redFlags: ["Dati auto negati", "Anticipo", "Prezzo attraente"], explanation: "Rifiutare dati base è chiedere anticipo prima delle verifiche aumenta il rischio.", safeAction: "Verifica documenti, storico, proprietà e auto dal vivo prima di pagare." },
  { id: "used_car_mechanic_ok", category: "Auto usata", situation: "Il venditore accetta controllo dal meccanico, visura, prova su strada e pagamento tracciabile dopo passaggio.", isRisky: false, difficulty: "media", redFlags: ["Controllo meccanico", "Documenti", "Pagamento tracciabile"], explanation: "È un comportamento più trasparente. Non elimina ogni rischio, ma permette verifiche concrete.", safeAction: "Fai controlli, usa pagamento tracciabile e verifica il passaggio di proprietà." },
  { id: "job_reshipping_packages", category: "Lavoro", situation: "Un lavoro da casa ti chiede di ricevere pacchi e rispedirli, promettendo compensi facili senza colloquio vero.", isRisky: true, difficulty: "difficile", redFlags: ["Pacchi da rispedire", "Lavoro facile", "Nessun colloquio"], explanation: "Potresti diventare intermediario inconsapevole di merce acquistata fraudolentemente.", safeAction: "Non accettare lavori che usano il tuo indirizzo o conto senza contratto chiaro e azienda verificata." },
  { id: "job_fake_check_equipment", category: "Lavoro", situation: "Un presunto datore invia un assegno per comprare attrezzatura e chiede di girare una parte a un fornitore indicato.", isRisky: true, difficulty: "difficile", redFlags: ["Assegno", "Fornitore imposto", "Anticipo"], explanation: "Gli assegni possono risultare falsi dopo giorni. Intanto tu avresti inviato soldi veri.", safeAction: "Non anticipare o girare denaro per un datore non verificato." },
  { id: "job_regular_contract_safe", category: "Lavoro", situation: "Un azienda verificabile propone contratto, colloquio, mansioni e pagamento su conto intestato a te.", isRisky: false, difficulty: "facile", redFlags: ["Contratto", "Azienda verificabile", "Mansioni chiare"], explanation: "Sono elementi normali di un rapporto di lavoro. Leggi comunque condizioni e contratto.", safeAction: "Verifica azienda, contratto e retribuzione prima di firmare." },
  { id: "subscription_trial_card", category: "Abbonamenti", situation: "Un sito poco conosciuto offre prova gratuita ma chiede carta e rende poco chiaro come disdire.", isRisky: true, difficulty: "media", redFlags: ["Prova gratuita", "Disdetta opaca", "Carta richiesta"], explanation: "Alcuni servizi puntano su rinnovi difficili da cancellare. La poca chiarezza è un segnale.", safeAction: "Cerca condizioni, recensioni e modalità di recesso prima di inserire la carta." },
  { id: "subscription_known_terms", category: "Abbonamenti", situation: "Un servizio noto indica prezzo, rinnovo e pulsante di cancellazione prima dell acquisto.", isRisky: false, difficulty: "facile", redFlags: ["Prezzo chiaro", "Recesso visibile", "Servizio noto"], explanation: "La trasparenza su prezzo e disdetta è un segnale positivo, anche se devi valutare se ti serve davvero.", safeAction: "Controlla data rinnovo e salva promemoria se attivi la prova." },
  { id: "tax_refund_card_link", category: "Pubblica amministrazione", situation: "Ricevi una email che promette rimborso fiscale immediato e chiede dati carta tramite link.", isRisky: true, difficulty: "facile", redFlags: ["Rimborso", "Dati carta", "Link"], explanation: "Gli enti pubblici non chiedono dati carta via email per erogare rimborsi in questo modo.", safeAction: "Accedi solo dal sito ufficiale digitando l indirizzo o usando app istituzionali." },
  { id: "municipal_pagopa_safe", category: "Pubblica amministrazione", situation: "Ricevi un avviso di pagamento con codice pagoPA verificabile sul portale ufficiale.", isRisky: false, difficulty: "media", redFlags: ["PagoPA", "Portale ufficiale", "Codice verificabile"], explanation: "Un pagamento verificabile su canali ufficiali e meno rischioso. Occhio a link copiati o siti clone.", safeAction: "Apri il portale ufficiale senza usare link sospetti e verifica il codice." },
  { id: "green_bond_private", category: "Investimenti", situation: "Un sito propone obbligazioni green riservate ai privati con rendimento alto e logo di aziende famose.", isRisky: true, difficulty: "difficile", redFlags: ["Rendimento alto", "Loghi famosi", "Sito non verificato"], explanation: "Loghi e temi sostenibili possono essere usati per sembrare affidabili. Rendimento alto e canale non verificato sono rischiosi.", safeAction: "Verifica emittente, prospetto, intermediario autorizzato e registri ufficiali." },
  { id: "bank_branch_product_docs", category: "Investimenti", situation: "La tua banca ti propone un prodotto in filiale, consegna documenti KID e ti lascia tempo per valutare.", isRisky: false, difficulty: "media", redFlags: ["Documenti ufficiali", "Tempo", "Canale verificato"], explanation: "Non è una truffa tipica, ma può comunque non essere adatto o avere costi alti.", safeAction: "Leggi costi, rischi e alternative prima di aderire." },
  { id: "trading_signal_influencer", category: "Investimenti", situation: "Un influencer offre una prova gratuita dei suoi segnali di trading e mostra solo operazioni vincenti.", isRisky: true, difficulty: "media", redFlags: ["Solo vittorie", "Segnali trading", "Influencer"], explanation: "Mostrare solo guadagni crea una percezione falsa. Il trading resta rischioso e i risultati possono essere selezionati.", safeAction: "Non pagare segnali senza verifiche, track record indipendente e comprensione dei rischi." },
  { id: "crypto_withdraw_tax", category: "Crypto", situation: "Una piattaforma crypto ti mostra profitti, ma per prelevare chiede prima una tassa da pagare separatamente.", isRisky: true, difficulty: "difficile", redFlags: ["Prelievo bloccato", "Tassa anticipata", "Profitti visibili"], explanation: "Chiedere soldi per sbloccare profitti è un segnale classico di truffa. I profitti mostrati potrebbero essere finti.", safeAction: "Non pagare ulteriori somme. Raccogli prove e valuta segnalazione." },
  { id: "crypto_exchange_2fa", category: "Crypto", situation: "Usi un exchange noto, hai 2FA attiva e prelevi su conto intestato a te con procedure standard.", isRisky: false, difficulty: "media", redFlags: ["2FA", "Exchange noto", "Conto intestato"], explanation: "Non è automaticamente rischioso, ma crypto e custodia restano aree da gestire con attenzione.", safeAction: "Usa sicurezza forte, controlla indirizzi e non investire più di quanto puoi perdere." },
  { id: "delivery_unexpected_cod", category: "Corrieri", situation: "Un corriere arriva con un pacco non atteso e chiede pagamento in contanti alla consegna.", isRisky: true, difficulty: "media", redFlags: ["Pacco non atteso", "Contanti", "Consegna"], explanation: "Il contrassegno su pacchi non attesi può essere usato per farti pagare merce inutile o mai ordinata.", safeAction: "Rifiuta se non riconosci ordine e mittente. Verifica con familiari prima di pagare." },
  { id: "delivery_expected_cod_safe", category: "Corrieri", situation: "Aspetti un pacco in contrassegno acquistato da te e l importo corrisponde all ordine.", isRisky: false, difficulty: "facile", redFlags: ["Pacco atteso", "Importo corretto", "Ordine riconosciuto"], explanation: "La situazione è coerente con un acquisto fatto da te. Controlla sempre importo e mittente.", safeAction: "Paga solo se ordine, importo e corriere corrispondono." },
  { id: "school_trip_iban_change", category: "Famiglia e scuola", situation: "Ricevi in un gruppo genitori un messaggio con nuovo IBAN per pagare una gita scolastica entro sera.", isRisky: true, difficulty: "difficile", redFlags: ["Gruppo chat", "IBAN nuovo", "Urgenza"], explanation: "Anche i gruppi reali possono essere compromessi o confusi. Nuovo IBAN e fretta vanno verificati.", safeAction: "Chiedi conferma alla scuola tramite canale ufficiale prima di pagare." },
  { id: "school_registry_payment", category: "Famiglia e scuola", situation: "La scuola invia comunicazione ufficiale dal registro elettronico con importo e causale verificabili.", isRisky: false, difficulty: "facile", redFlags: ["Registro ufficiale", "Causale", "Verificabile"], explanation: "Il canale ufficiale riduce il rischio. Resta utile controllare importo e scadenza.", safeAction: "Paga tramite canale indicato dalla scuola e conserva ricevuta." },
  { id: "health_miracle_supplement", category: "Salute e benessere", situation: "Un annuncio promette guarigione rapida o dimagrimento garantito se compri subito un integratore costoso.", isRisky: true, difficulty: "media", redFlags: ["Promessa garantita", "Salute", "Urgenza acquisto"], explanation: "Promesse sanitarie garantite e pressione commerciale sono segnali di rischio e possono danneggiare salute e soldi.", safeAction: "Parla con un professionista sanitario e diffida da promesse assolute." },
  { id: "health_official_visit", category: "Salute e benessere", situation: "Prenoti una visita da un centro noto, ricevi conferma ufficiale e paghi con ricevuta.", isRisky: false, difficulty: "facile", redFlags: ["Centro noto", "Ricevuta", "Prenotazione"], explanation: "È un processo normale. Controlla sempre dati e importi.", safeAction: "Usa canali ufficiali e conserva ricevute." },
  { id: "ticket_soldout_cheap", category: "Eventi", situation: "Trovi biglietti per un concerto sold out a prezzo basso e il venditore chiede bonifico amici e familiari.", isRisky: true, difficulty: "media", redFlags: ["Prezzo basso", "Sold out", "Pagamento non protetto"], explanation: "Biglietti falsi e pagamenti non protetti sono rischi frequenti negli eventi sold out.", safeAction: "Usa piattaforme ufficiali di rivendita e pagamenti con tutela." },
  { id: "ticket_official_resale_safe", category: "Eventi", situation: "Acquisti biglietto da piattaforma ufficiale di rivendita con trasferimento nominativo tracciato.", isRisky: false, difficulty: "media", redFlags: ["Piattaforma ufficiale", "Trasferimento nominativo", "Pagamento protetto"], explanation: "La piattaforma ufficiale riduce il rischio di biglietti falsi.", safeAction: "Controlla condizioni, nominativo e ricevuta." },
  { id: "pet_free_shipping_fee", category: "Animali", situation: "Un annuncio regala un cucciolo ma chiede soldi per trasporto, vaccini e documenti prima di vederlo.", isRisky: true, difficulty: "media", redFlags: ["Cucciolo gratuito", "Spese anticipo", "Nessuna visita"], explanation: "Le truffe sugli animali usano emozione e desiderio di aiutare. Le spese anticipate sono il vero obiettivo.", safeAction: "Vedi animale, allevamento o associazione e documenti prima di pagare." },
  { id: "pet_shelter_safe", category: "Animali", situation: "Un rifugio verificabile propone adozione con visita, modulo e donazione tracciabile.", isRisky: false, difficulty: "facile", redFlags: ["Rifugio verificabile", "Visita", "Modulo"], explanation: "Trasparenza e visita sono segnali positivi.", safeAction: "Verifica associazione e condizioni di adozione." },
];

function pickScamGameQuestions(pool: ScamScenario[], count = 5): ScamScenario[] {
  const shuffle = <T,>(items: T[]) => [...items].sort(() => Math.random() - 0.5);
  const selected: ScamScenario[] = [];
  const addUnique = (items: ScamScenario[], max: number) => {
    for (const item of items) {
      if (selected.length >= max) break;
      if (!selected.some((current) => current.id === item.id)) selected.push(item);
    }
  };

  const difficult = shuffle(pool.filter((item) => item.difficulty === "difficile"));
  const risky = shuffle(pool.filter((item) => item.isRisky));
  const safe = shuffle(pool.filter((item) => !item.isRisky));

  // Ogni partita contiene almeno uno scenario difficile, quando disponibile,
  // e almeno uno scenario non rischioso per non rendere il gioco prevedibile.
  addUnique(difficult, Math.min(1, count));
  addUnique(safe, Math.min(2, count));
  addUnique(risky, count);
  addUnique(shuffle(pool), count);

  return shuffle(selected).slice(0, count);
}

const awarenessActions: AwarenessAction[] = [
  {
    id: "unused_subscriptions",
    title: "Taglia abbonamenti inutilizzati",
    category: "Risparmio",
    area: "Abbonamenti",
    estimatedSavingMonthly: 15,
    estimatedSavingYearly: 180,
    difficulty: 1,
    sacrifice: 1,
    minutes: 10,
    why: "Molti abbonamenti restano attivi anche quando non li usi più. Toglierne uno è un risparmio immediato, senza rinunce vere.",
    steps: [
      "Apri l'elenco delle spese ricorrenti della carta o del conto",
      "Segna gli abbonamenti che non usi da almeno 30 giorni",
      "Disdici quelli inutili o mettili in pausa",
      "Sposta la cifra liberata verso il PAC o il tuo obiettivo",
    ],
  },
  {
    id: "food_waste",
    title: "Riduci lo spreco di cibo",
    category: "Risparmio",
    area: "Cibo",
    estimatedSavingMonthly: 30,
    estimatedSavingYearly: 360,
    difficulty: 2,
    sacrifice: 1,
    minutes: 15,
    why: "Buttare cibo significa buttare denaro. Una piccola organizzazione prima della spesa può liberare soldi ogni mese.",
    steps: [
      "Controlla frigo e dispensa prima di uscire",
      "Pianifica 3 pasti semplici per i prossimi giorni",
      "Fai una lista e compra solo quello che serve davvero",
      "Dedica un pasto a usare avanzi o prodotti vicini alla scadenza",
    ],
  },
  {
    id: "energy_waste",
    title: "Taglia sprechi di luce e gas",
    category: "Risparmio",
    area: "Energia",
    estimatedSavingMonthly: 25,
    estimatedSavingYearly: 300,
    difficulty: 2,
    sacrifice: 1,
    minutes: 20,
    why: "Non serve vivere al freddo o al buio. Piccole abitudini ripetute riducono bollette e sprechi senza stravolgere la casa.",
    steps: [
      "Spegni luci e dispositivi in standby quando non servono",
      "Usa lavatrice e lavastoviglie a pieno carico",
      "Abbassa il riscaldamento anche solo di 1 grado quando possibile",
      "Controlla una volta l'anno se l'offerta luce e gas e ancora conveniente",
    ],
  },
  {
    id: "phone_plan",
    title: "Rivedi telefono e internet",
    category: "Risparmio",
    area: "Casa",
    estimatedSavingMonthly: 10,
    estimatedSavingYearly: 120,
    difficulty: 2,
    sacrifice: 1,
    minutes: 20,
    why: "Se paghi più del necessario per un servizio simile, stai rinunciando a risparmio senza ottenere vero valore in cambio.",
    steps: [
      "Controlla quanto paghi oggi per telefono e internet",
      "Confronta 2 o 3 offerte simili",
      "Verifica vincoli, costi di attivazione e qualità del servizio",
      "Cambia solo se il risparmio è reale e il servizio resta adeguato",
    ],
  },
  {
    id: "bank_fees",
    title: "Controlla conto, carte e commissioni",
    category: "Risparmio",
    area: "Banca",
    estimatedSavingMonthly: 8,
    estimatedSavingYearly: 96,
    difficulty: 2,
    sacrifice: 1,
    minutes: 15,
    why: "Canoni, carte e piccole commissioni sembrano dettagli, ma sommati nel tempo possono pesare più di quanto pensi.",
    steps: [
      "Controlla canone conto, carta e prelievi",
      "Guarda se paghi commissioni ricorrenti",
      "Confronta un'alternativa con costi più bassi",
      "Tieni solo i servizi che usi davvero",
    ],
  },
  {
    id: "remunerated_liquidity",
    title: "Fai lavorare la liquidità ferma",
    category: "Risparmio",
    area: "Banca",
    estimatedSavingMonthly: 8,
    estimatedSavingYearly: 96,
    difficulty: 2,
    sacrifice: 1,
    minutes: 15,
    why: "La liquidità che resta ferma sul conto può perdere valore nel tempo. Una parte della liquidità non investita, se non ti serve subito, può stare su un conto remunerato semplice e svincolato.",
    steps: [
      "Individua quanta liquidità vuoi tenere disponibile per spese è imprevisti",
      "Confronta conti remunerati o soluzioni simili, controllando tasso, costi, vincoli e sicurezza",
      "Trade Republic è un esempio: al momento offre il 2% annuo lordo sulla liquidità con accredito mensile, ma verifica sempre le condizioni aggiornate",
      "Non spostare tutta la liquidità: tieni sempre una parte facilmente accessibile per le spese quotidiane",
    ],
  },
  {
    id: "lunch_bar",
    title: "Riduci pranzi fuori e piccoli extra",
    category: "Risparmio",
    area: "Cibo",
    estimatedSavingMonthly: 40,
    estimatedSavingYearly: 480,
    difficulty: 3,
    sacrifice: 2,
    minutes: 10,
    why: "Bar, delivery e pranzi fuori non sono un problema se scelti. Diventano costosi quando sono automatici.",
    steps: [
      "Conta quante volte compri pranzo, caffe o delivery in una settimana",
      "Scegli 2 giorni in cui porti qualcosa da casa",
      "Mantieni qualche uscita piacevole, ma programmata",
      "Trasforma il risparmio settimanale in un versamento fisso",
    ],
  },
  {
    id: "impulse_rule_24h",
    title: "Usa la regola delle 24 ore",
    category: "Risparmio",
    area: "Acquisti",
    estimatedSavingMonthly: 35,
    estimatedSavingYearly: 420,
    difficulty: 2,
    sacrifice: 2,
    minutes: 5,
    why: "Molti acquisti sembrano necessari solo nel momento. Aspettare 24 ore ti fa distinguere desiderio reale e impulso.",
    steps: [
      "Quando vuoi comprare qualcosa non essenziale, salvalo in una lista",
      "Aspetta almeno 24 ore prima di acquistarlo",
      "Chiediti se lo ricompreresti anche pagando tutto subito",
      "Se rinunci, sposta quella cifra verso il tuo obiettivo",
    ],
  },
  {
    id: "bnpl_small_rates",
    title: "Evita piccole rate inutili",
    category: "Risparmio",
    area: "Acquisti",
    estimatedSavingMonthly: 25,
    estimatedSavingYearly: 300,
    difficulty: 3,
    sacrifice: 2,
    minutes: 5,
    why: "Le rate piccole rendono invisibile il costo reale. Se un acquisto non è essenziale, la rata può diventare una trappola gentile.",
    steps: [
      "Individua le rate attive per oggetti non essenziali",
      "Evita nuove rate per acquisti impulsivi",
      "Prima di rateizzare, chiediti se compreresti lo stesso pagando subito",
      "Usa la rata evitata per aumentare il capitale mensile",
    ],
  },
  {
    id: "insurance_check",
    title: "Rivedi assicurazioni e spese auto",
    category: "Risparmio",
    area: "Auto",
    estimatedSavingMonthly: 20,
    estimatedSavingYearly: 240,
    difficulty: 3,
    sacrifice: 1,
    minutes: 25,
    why: "Assicurazione e servizi collegati all'auto cambiano nel tempo. Controllarli una volta l'anno può evitare costi inutili.",
    steps: [
      "Controlla quanto paghi oggi per assicurazione e servizi auto",
      "Confronta preventivi simili prima del rinnovo",
      "Verifica coperture doppie o servizi che non usi",
      "Scegli il risparmio solo se non riduce protezioni importanti",
    ],
  },
  {
    id: "sell_unused_items",
    title: "Vendi oggetti che non usi",
    category: "Risparmio",
    area: "Entrate",
    estimatedSavingMonthly: 50,
    estimatedSavingYearly: 600,
    difficulty: 3,
    sacrifice: 1,
    minutes: 30,
    why: "A volte il modo più rapido per liberare capitale e trasformare oggetti inutilizzati in denaro utile per un obiettivo.",
    steps: [
      "Scegli 3 oggetti che non usi da mesi",
      "Stima un prezzo realistico, non perfetto",
      "Pubblicali su un canale affidabile",
      "Destina l'incasso a fondo emergenza, PAC o obiettivo personale",
    ],
  },
];

function safeNumber(value: string | number) {
  const parsed = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function calcMortgagePayment(principal: number, annualRatePercent: number, years: number) {
  const months = Math.max(Math.round(years * 12), 1);
  const monthlyRate = annualRatePercent / 100 / 12;
  if (monthlyRate <= 0) return principal / months;
  return principal * (monthlyRate / (1 - Math.pow(1 + monthlyRate, -months)));
}

function awarenessScore(action: AwarenessAction) {
  const economicImpact = Math.min(5, Math.max(1, Math.round(action.estimatedSavingMonthly / 10)));
  const ease = 6 - action.difficulty;
  const relevance = 4;
  return economicImpact + ease + relevance - action.sacrifice;
}

const shoppingCategories: ShoppingCategory[] = [
  "Frutta e verdura",
  "Pasta, riso e pane",
  "Proteine",
  "Latte e derivati",
  "Casa e pulizia",
  "Igiene personale",
  "Extra e sfizi",
  "Altro",
];

const commonShoppingProducts: ShoppingPreset[] = [
  { name: "Frutta", category: "Frutta e verdura", estimatedPrice: 5 },
  { name: "Verdura", category: "Frutta e verdura", estimatedPrice: 6 },
  { name: "Insalata", category: "Frutta e verdura", estimatedPrice: 2.5 },
  { name: "Pomodori", category: "Frutta e verdura", estimatedPrice: 3 },
  { name: "Pasta", category: "Pasta, riso e pane", estimatedPrice: 1.5 },
  { name: "Riso", category: "Pasta, riso e pane", estimatedPrice: 2.5 },
  { name: "Pane", category: "Pasta, riso e pane", estimatedPrice: 2 },
  { name: "Farina", category: "Pasta, riso e pane", estimatedPrice: 1.2 },
  { name: "Uova", category: "Proteine", estimatedPrice: 3 },
  { name: "Legumi", category: "Proteine", estimatedPrice: 2 },
  { name: "Carne", category: "Proteine", estimatedPrice: 9 },
  { name: "Pesce", category: "Proteine", estimatedPrice: 10 },
  { name: "Latte", category: "Latte e derivati", estimatedPrice: 1.6 },
  { name: "Yogurt", category: "Latte e derivati", estimatedPrice: 3 },
  { name: "Formaggio", category: "Latte e derivati", estimatedPrice: 5 },
  { name: "Detersivo", category: "Casa e pulizia", estimatedPrice: 4 },
  { name: "Carta igienica", category: "Casa e pulizia", estimatedPrice: 4.5 },
  { name: "Sapone piatti", category: "Casa e pulizia", estimatedPrice: 2 },
  { name: "Shampoo", category: "Igiene personale", estimatedPrice: 3 },
  { name: "Dentifricio", category: "Igiene personale", estimatedPrice: 2 },
  { name: "Snack", category: "Extra e sfizi", estimatedPrice: 3, isExtra: true },
  { name: "Dolci", category: "Extra e sfizi", estimatedPrice: 4, isExtra: true },
  { name: "Bibite", category: "Extra e sfizi", estimatedPrice: 3, isExtra: true },
];


function formatEuro(value: number): string {
  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

const PLAN_VALIDITY_DAYS = 365;

function addDaysIso(baseDate: Date, days: number): string {
  const next = new Date(baseDate);
  next.setDate(next.getDate() + days);
  return next.toISOString();
}

function formatItalianDate(value?: string): string {
  if (!value) return "Non disponibile";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Non disponibile";
  return new Intl.DateTimeFormat("it-IT", { day: "2-digit", month: "long", year: "numeric" }).format(date);
}

function getPlanDaysRemaining(value?: string): number | null {
  if (!value) return null;
  const expires = new Date(value).getTime();
  if (Number.isNaN(expires)) return null;
  const remaining = Math.ceil((expires - Date.now()) / (1000 * 60 * 60 * 24));
  return Math.max(remaining, 0);
}

function isPurchaseDateValid(value?: string): boolean {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.getTime() > Date.now();
}

function getPlanRank(plan?: PurchasePlan): number {
  if (plan === "pro") return 2;
  if (plan === "core") return 1;
  return 0;
}

function getDateTime(value?: string): number {
  if (!value) return 0;
  const date = new Date(value).getTime();
  return Number.isNaN(date) ? 0 : date;
}

function normalizePurchaseState(raw: Partial<PurchaseState> | null | undefined, fallbackEmail = ""): PurchaseState {
  const plan = raw?.plan === "pro" ? "pro" : raw?.plan === "core" ? "core" : undefined;
  const fallbackPaidAmount = plan === "core" ? 29 : plan === "pro" ? 59 : 0;
  const purchasedAt = raw?.purchasedAt;
  const expiresAt = raw?.expiresAt || (raw?.unlocked ? addDaysIso(purchasedAt ? new Date(purchasedAt) : new Date(), PLAN_VALIDITY_DAYS) : undefined);
  const active = !!raw?.unlocked && isPurchaseDateValid(expiresAt);

  return {
    unlocked: active,
    email: raw?.email || fallbackEmail || "",
    selectedPortfolio: raw?.selectedPortfolio,
    plan,
    paidAmount: raw?.paidAmount ?? fallbackPaidAmount,
    purchasedAt,
    upgradedAt: raw?.upgradedAt,
    expiresAt,
    lastPaymentType: raw?.lastPaymentType,
  };
}

function getPurchaseStatusCopy(purchase: PurchaseState) {
  const days = getPlanDaysRemaining(purchase.expiresAt);
  const planLabel = purchase.plan === "pro" ? "Pro" : purchase.plan === "core" ? "Core" : "Nessun piano";
  const isActive = !!purchase.unlocked && isPurchaseDateValid(purchase.expiresAt);

  if (!isActive) {
    return {
      planLabel,
      statusLabel: purchase.expiresAt ? "Piano scaduto" : "Nessun piano attivo",
      expiresLabel: purchase.expiresAt ? formatItalianDate(purchase.expiresAt) : "Non disponibile",
      daysLabel: "0 giorni rimanenti",
      days,
      isActive,
    };
  }

  return {
    planLabel,
    statusLabel: `Piano ${planLabel} attivo`,
    expiresLabel: formatItalianDate(purchase.expiresAt),
    daysLabel: days === 1 ? "1 giorno rimanente" : `${days ?? 0} giorni rimanenti`,
    days,
    isActive,
  };
}

function getPortfolioFromScores(scores: ScoreMap): FinalPortfolioKey {
  const ordered = [
    { key: "stabilita" as BaseProfile, value: scores.stabilita },
    { key: "equilibrio" as BaseProfile, value: scores.equilibrio },
    { key: "crescita" as BaseProfile, value: scores.crescita },
  ].sort((a, b) => b.value - a.value);

  const winner = ordered[0];
  const second = ordered[1];
  const gap = winner.value - second.value;

  if (winner.key === "stabilita") return gap >= 3 ? "stabilita_assoluta" : "stabilita_dinamica";
  if (winner.key === "equilibrio") return gap >= 3 ? "equilibrio_intelligente" : "equilibrio_dinamico";
  return gap >= 3 ? "crescita_lungo_periodo" : "crescita_controllata";
}

function calculatePAC(monthly: number, years: number, annualRate: number, initial: number = 0) {
  const safeMonthly = Number.isFinite(monthly) ? monthly : 0;
  const safeYears = Number.isFinite(years) ? years : 0;
  const safeInitial = Number.isFinite(initial) ? initial : 0;
  if (safeMonthly <= 0 && safeInitial <= 0) return 0;
  if (safeYears <= 0) return Math.round(safeInitial);

  const months = safeYears * 12;
  const monthlyRate = annualRate / 12;
  let total = safeInitial;

  for (let i = 0; i < months; i++) {
    total = (total + safeMonthly) * (1 + monthlyRate);
  }

  return Math.round(total);
}

function getPortfolioRate(profileFamily: BaseProfile) {
  if (profileFamily === "crescita") return 0.09;
  if (profileFamily === "equilibrio") return 0.07;
  return 0.05;
}

function getAssetColor(category: StrumentiCategory) {
  if (category === "Azioni Globali" || category === "Mercati Emergenti") return "#ef4444";
  if (category === "Obbligazioni" || category === "Obbligazioni Breve Termine" || category === "Obbligazioni Lungo Termine") return "#2563eb";
  if (category === "Oro") return "#eab308";
  if (category === "Materie Prime") return "#94a3b8";
  if (category === "Liquidita") return "#22c55e";
  return "#8b5cf6";
}

function getPrefix(userId: string) {
  return `soldi-semplici-${userId}`;
}

function getPurchaseKey(userId: string) {
  return `${getPrefix(userId)}-purchase`;
}

function getHoldingsKey(userId: string) {
  return `${getPrefix(userId)}-holdings`;
}

function getChecklistStorageKey(userId: string, portfolioKey: FinalPortfolioKey) {
  return `${getPrefix(userId)}-checklist-${portfolioKey}`;
}

function getAwarenessActionsStorageKey(userId: string) {
  return `${getPrefix(userId)}-awareness-actions`;
}

function getMortgageCheckStorageKey(userId: string) {
  return `${getPrefix(userId)}-mortgage-check`;
}

function getValidAwarenessActionIds() {
  return new Set(awarenessActions.map((action) => action.id));
}

function cleanAwarenessActionsState(value: Record<string, boolean>) {
  const validActionIds = getValidAwarenessActionIds();
  const cleaned: Record<string, boolean> = {};

  Object.entries(value).forEach(([actionId, completed]) => {
    if (validActionIds.has(actionId)) cleaned[actionId] = !!completed;
  });

  return cleaned;
}

function getPacStorageKey(userId: string, portfolioKey: FinalPortfolioKey) {
  return `${getPrefix(userId)}-pac-${portfolioKey}`;
}

function getCurrentMonthKey() {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${month}`;
}

function getMonthLabel(monthKey: string) {
  const [year, month] = monthKey.split("-");
  const monthIndex = Number(month) - 1;
  const names = [
    "Gen", "Feb", "Mar", "Apr", "Mag", "Giu",
    "Lug", "Ago", "Set", "Ott", "Nov", "Dic"
  ];
  return `${names[monthIndex]} ${year}`;
}

function generateRecentMonths(count = 12): string[] {
  const result: string[] = [];
  const now = new Date();
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const month = String(d.getMonth() + 1).padStart(2, "0");
    result.push(`${d.getFullYear()}-${month}`);
  }
  return result;
}

function calculateCurrentStreak(history: PacMonth[]) {
  const sorted = [...history].sort((a, b) => a.month.localeCompare(b.month));
  let streak = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].completed) streak++;
    else break;
  }
  return streak;
}

function buildBadges(params: {
  purchaseUnlocked: boolean;
  checklistCompleted: number;
  totalChecklist: number;
  pacHistory: PacMonth[];
  totalInvested: number;
  goalTarget: number;
  activeCategories: number;
  awarenessActionsCompleted: number;
  monthlyFreedByAwareness: number;
  fraudChecksCompleted: number;
  scamAnsweredScenarioCount: number;
  scamScenarioPoolSize: number;
  scamPerfectGames: number;
  vehicleAnalysisUsed: boolean;
  mortgageAnalysisUsed: boolean;
}): Badge[] {
  const {
    purchaseUnlocked,
    checklistCompleted,
    totalChecklist,
    pacHistory,
    totalInvested,
    goalTarget,
    activeCategories,
    awarenessActionsCompleted,
    monthlyFreedByAwareness,
    fraudChecksCompleted,
    scamAnsweredScenarioCount,
    scamScenarioPoolSize,
    scamPerfectGames,
    vehicleAnalysisUsed,
    mortgageAnalysisUsed,
  } = params;
  const completedMonths = pacHistory.filter((m) => m.completed).length;
  const streak = calculateCurrentStreak(pacHistory);
  const setupTarget = Math.max(totalChecklist, 1);

  let hasGapAndReturn = false;
  for (let i = 1; i < pacHistory.length; i++) {
    if (!pacHistory[i - 1].completed && pacHistory[i].completed) {
      hasGapAndReturn = true;
      break;
    }
  }

  const clamp = (value: number, target: number) => Math.min(Math.max(value, 0), target);
  const capitalProgress = (target: number) => clamp(totalInvested, target);

  return [
    {
      id: "first_step",
      title: "Piano ricevuto",
      description: "Hai completato il questionario e hai un modello da seguire.",
      unlocked: purchaseUnlocked,
      tier: "inizio",
      icon: "🧭",
      progress: purchaseUnlocked ? 1 : 0,
      target: 1,
      progressLabel: purchaseUnlocked ? "1/1" : "0/1",
      lockedHint: "Completa il questionario iniziale.",
    },
    {
      id: "system_on",
      title: "Setup completato",
      description: "Hai messo in ordine i passaggi base: ora il piano è operativo.",
      unlocked: checklistCompleted >= totalChecklist && totalChecklist > 0,
      tier: "inizio",
      icon: "✅",
      progress: clamp(checklistCompleted, setupTarget),
      target: setupTarget,
      progressLabel: `${clamp(checklistCompleted, setupTarget)}/${setupTarget}`,
      lockedHint: "Completa i passaggi della guida iniziale.",
    },
    {
      id: "pac_started",
      title: "Primo mese fatto",
      description: "Hai trasformato il piano in un'azione concreta.",
      unlocked: completedMonths >= 1,
      tier: "costanza",
      icon: "🚀",
      progress: clamp(completedMonths, 1),
      target: 1,
      progressLabel: `${clamp(completedMonths, 1)}/1`,
      lockedHint: "Chiudi il primo mese di PAC.",
    },
    {
      id: "streak_3",
      title: "Routine attivata",
      description: "Tre mesi consecutivi: il metodo inizia a diventare abitudine.",
      unlocked: streak >= 3,
      tier: "costanza",
      icon: "🔥",
      progress: clamp(streak, 3),
      target: 3,
      progressLabel: `${clamp(streak, 3)}/3 mesi`,
      lockedHint: "Mantieni il PAC per 3 mesi consecutivi.",
    },
    {
      id: "streak_6",
      title: "Disciplina reale",
      description: "Sei mesi di continuità: stai costruendo comportamento, non solo capitale.",
      unlocked: streak >= 6,
      tier: "costanza",
      icon: "🛡️",
      progress: clamp(streak, 6),
      target: 6,
      progressLabel: `${clamp(streak, 6)}/6 mesi`,
      lockedHint: "Proteggi la catena per 6 mesi.",
    },
    {
      id: "streak_12",
      title: "Investitore disciplinato",
      description: "Dodici mesi consecutivi: il piano è diventato identità.",
      unlocked: streak >= 12,
      tier: "identità",
      icon: "🏆",
      progress: clamp(streak, 12),
      target: 12,
      progressLabel: `${clamp(streak, 12)}/12 mesi`,
      lockedHint: "Completa 12 mesi consecutivi.",
    },
    {
      id: "restart",
      title: "Ripartenza intelligente",
      description: "Hai ripreso dopo una pausa. La differenza la fa chi torna sul metodo.",
      unlocked: hasGapAndReturn,
      tier: "identità",
      icon: "🔁",
      progress: hasGapAndReturn ? 1 : 0,
      target: 1,
      progressLabel: hasGapAndReturn ? "ripreso" : "in attesa",
      lockedHint: "Si sblocca se riprendi il percorso dopo una pausa.",
    },
    {
      id: "capital_1000",
      title: "Prima base solida",
      description: "Hai superato 1.000 € di capitale aggiornato.",
      unlocked: totalInvested >= 1000,
      tier: "capitale",
      icon: "🌱",
      progress: capitalProgress(1000),
      target: 1000,
      progressLabel: `${formatEuro(Math.min(totalInvested, 1000))}/1.000 €`,
      lockedHint: "Aggiorna il capitale fino a 1.000 €.",
    },
    {
      id: "capital_5000",
      title: "Costruttore di capitale",
      description: "Hai superato 5.000 €: il piano sta prendendo forma.",
      unlocked: totalInvested >= 5000,
      tier: "capitale",
      icon: "🏗️",
      progress: capitalProgress(5000),
      target: 5000,
      progressLabel: `${formatEuro(Math.min(totalInvested, 5000))}/5.000 €`,
      lockedHint: "Continua fino a 5.000 € di capitale aggiornato.",
    },
    {
      id: "capital_10000",
      title: "Patrimonio in costruzione",
      description: "Hai superato 10.000 €: ora il percorso è concreto e misurabile.",
      unlocked: totalInvested >= 10000,
      tier: "capitale",
      icon: "💎",
      progress: capitalProgress(10000),
      target: 10000,
      progressLabel: `${formatEuro(Math.min(totalInvested, 10000))}/10.000 €`,
      lockedHint: "Continua fino a 10.000 € di capitale aggiornato.",
    },
    {
      id: "capital_25000",
      title: "Capitale solido",
      description: "Hai superato 25.000 €: il tuo percorso inizia ad avere una massa importante.",
      unlocked: totalInvested >= 25000,
      tier: "capitale",
      icon: "🧱",
      progress: capitalProgress(25000),
      target: 25000,
      progressLabel: `${formatEuro(Math.min(totalInvested, 25000))}/25.000 €`,
      lockedHint: "Continua fino a 25.000 € di capitale aggiornato.",
    },
    {
      id: "capital_50000",
      title: "Traguardo importante",
      description: "Hai superato 50.000 €: costanza e metodo stanno diventando patrimonio reale.",
      unlocked: totalInvested >= 50000,
      tier: "capitale",
      icon: "🏦",
      progress: capitalProgress(50000),
      target: 50000,
      progressLabel: `${formatEuro(Math.min(totalInvested, 50000))}/50.000 €`,
      lockedHint: "Continua fino a 50.000 € di capitale aggiornato.",
    },
    {
      id: "capital_100000",
      title: "Sei cifre raggiunte",
      description: "Hai superato 100.000 €: questo è un traguardo che merita orgoglio e lucidità.",
      unlocked: totalInvested >= 100000,
      tier: "capitale",
      icon: "👑",
      progress: capitalProgress(100000),
      target: 100000,
      progressLabel: `${formatEuro(Math.min(totalInvested, 100000))}/100.000 €`,
      lockedHint: "Continua fino a 100.000 € di capitale aggiornato.",
    },
    {
      id: "capital_goal_reached",
      title: "Obiettivo personale raggiunto",
      description: "Hai raggiunto l'obiettivo che ti eri dato. Complimenti: questo traguardo racconta costanza, pazienza e metodo.",
      unlocked: goalTarget > 0 && totalInvested >= goalTarget,
      tier: "capitale",
      icon: "🎯",
      progress: goalTarget > 0 ? capitalProgress(goalTarget) : 0,
      target: goalTarget > 0 ? goalTarget : 1,
      progressLabel: goalTarget > 0 ? `${formatEuro(Math.min(totalInvested, goalTarget))}/${formatEuro(goalTarget)}` : "obiettivo non impostato",
      lockedHint: goalTarget > 0 ? `Continua fino al tuo obiettivo personale: ${formatEuro(goalTarget)}.` : "Imposta un obiettivo personale nella sezione Obiettivo.",
    },
    {
      id: "awareness_first_action",
      title: "Occhio allenato",
      description: "Hai completato la prima azione di consapevolezza: meno sprechi, più controllo.",
      unlocked: awarenessActionsCompleted >= 1,
      tier: "consapevolezza",
      icon: "👀",
      progress: clamp(awarenessActionsCompleted, 1),
      target: 1,
      progressLabel: `${clamp(awarenessActionsCompleted, 1)}/1`,
      lockedHint: "Completa una azione nella sezione Consapevolezza > Risparmio.",
    },
    {
      id: "awareness_50_month",
      title: "Cacciatore di sprechi",
      description: "Hai liberato almeno 50 € al mese: piccole decisioni, grande differenza nel tempo.",
      unlocked: monthlyFreedByAwareness >= 50,
      tier: "consapevolezza",
      icon: "🕵️",
      progress: clamp(monthlyFreedByAwareness, 50),
      target: 50,
      progressLabel: `${formatEuro(Math.min(monthlyFreedByAwareness, 50))}/50 € mese`,
      lockedHint: "Completa azioni di risparmio fino a liberare 50 € al mese.",
    },
    {
      id: "awareness_150_month",
      title: "Budget sveglio",
      description: "Hai liberato almeno 150 € al mese: ora il tuo PAC può respirare davvero.",
      unlocked: monthlyFreedByAwareness >= 150,
      tier: "consapevolezza",
      icon: "💡",
      progress: clamp(monthlyFreedByAwareness, 150),
      target: 150,
      progressLabel: `${formatEuro(Math.min(monthlyFreedByAwareness, 150))}/150 € mese`,
      lockedHint: "Continua con le azioni di consapevolezza fino a 150 € al mese.",
    },
    {
      id: "vehicle_checker",
      title: "Auto sotto controllo",
      description: "Hai usato il controllo auto: non guardi solo la rata, guardi il costo reale.",
      unlocked: vehicleAnalysisUsed,
      tier: "consapevolezza",
      icon: "🚗",
      progress: vehicleAnalysisUsed ? 1 : 0,
      target: 1,
      progressLabel: vehicleAnalysisUsed ? "analisi fatta" : "da fare",
      lockedHint: "Apri Consapevolezza > Auto e controlla costo reale e maxi rata.",
    },
    {
      id: "mortgage_checker",
      title: "Casa con lucidità",
      description: "Hai usato lo stress test mutuo: prima capisci il rischio, poi decidi.",
      unlocked: mortgageAnalysisUsed,
      tier: "consapevolezza",
      icon: "🏠",
      progress: mortgageAnalysisUsed ? 1 : 0,
      target: 1,
      progressLabel: mortgageAnalysisUsed ? "stress test fatto" : "da fare",
      lockedHint: "Apri Consapevolezza > Mutuo e valuta rata, interessi e stress test.",
    },
    {
      id: "fraud_shield",
      title: "Scudo anti-truffa",
      description: "Hai completato il test anti-truffe: fermarsi prima di cliccare e già protezione.",
      unlocked: fraudChecksCompleted >= 3,
      tier: "consapevolezza",
      icon: "🛡️",
      progress: clamp(fraudChecksCompleted, 3),
      target: 3,
      progressLabel: `${clamp(fraudChecksCompleted, 3)}/3 segnali`,
      lockedHint: "Apri Consapevolezza > Anti-truffe e valuta almeno 3 segnali di rischio.",
    },
    {
      id: "fraud_all_scenarios",
      title: "Mente anti-truffa",
      description: "Hai risposto almeno una volta a tutti gli scenari del mini gioco. Ora riconosci molti schemi diversi, anche quelli meno ovvi.",
      unlocked: scamScenarioPoolSize > 0 && scamAnsweredScenarioCount >= scamScenarioPoolSize,
      tier: "consapevolezza",
      icon: "🧠",
      progress: clamp(scamAnsweredScenarioCount, scamScenarioPoolSize),
      target: scamScenarioPoolSize,
      progressLabel: `${clamp(scamAnsweredScenarioCount, scamScenarioPoolSize)}/${scamScenarioPoolSize} scenari`,
      lockedHint: `Gioca ancora: hai visto ${clamp(scamAnsweredScenarioCount, scamScenarioPoolSize)}/${scamScenarioPoolSize} scenari anti-truffa.`,
    },
    {
      id: "fraud_10_perfect_games",
      title: "Occhio infallibile",
      description: "Hai completato 10 partite anti-truffa senza errori. La prudenza sta diventando un riflesso.",
      unlocked: scamPerfectGames >= 10,
      tier: "consapevolezza",
      icon: "🎯",
      progress: clamp(scamPerfectGames, 10),
      target: 10,
      progressLabel: `${clamp(scamPerfectGames, 10)}/10 partite perfette`,
      lockedHint: `Completa 10 partite senza errori. Partite perfette: ${clamp(scamPerfectGames, 10)}/10.`,
    },
    {
      id: "all_categories",
      title: "Modello operativo",
      description: "Hai registrato almeno una categoria del modello: il sistema è vivo.",
      unlocked: activeCategories >= 1,
      tier: "inizio",
      icon: "📊",
      progress: clamp(activeCategories, 1),
      target: 1,
      progressLabel: `${clamp(activeCategories, 1)}/1`,
      lockedHint: "Registra il primo investimento nella dashboard.",
    },
  ];
}

function buildInvestorTitles(params: {
  badges: Badge[];
  currentStreak: number;
  totalInvested: number;
  goalTarget: number;
  activeCategories: number;
  setupCompleted: boolean;
}): InvestorTitle[] {
  const { badges, currentStreak, totalInvested, activeCategories, setupCompleted } = params;
  const unlockedCount = badges.filter((badge) => badge.unlocked).length;
  const hasBadge = (id: string) => badges.some((badge) => badge.id === id && badge.unlocked);
  const clamp = (value: number, target: number) => Math.min(Math.max(value, 0), target);

  return [
    {
      id: "explorer",
      title: "Esploratore finanziario",
      subtitle: "Hai iniziato a orientarti",
      description: "Hai fatto il primo passo: ora il piano non è più un'idea vaga, ma una strada da seguire.",
      icon: "🧭",
      unlocked: hasBadge("first_step"),
      progress: hasBadge("first_step") ? 1 : 0,
      target: 1,
      progressLabel: hasBadge("first_step") ? "1/1" : "0/1",
      nextHint: "Completa il questionario e sblocca il tuo modello.",
    },
    {
      id: "rookie",
      title: "Investitore alle prime armi",
      subtitle: "Hai trasformato la teoria in azione",
      description: "Non stai solo leggendo: hai iniziato a costruire il tuo percorso con dati e azioni concrete.",
      icon: "🌱",
      unlocked: hasBadge("all_categories") || hasBadge("pac_started"),
      progress: hasBadge("all_categories") || hasBadge("pac_started") ? 1 : 0,
      target: 1,
      progressLabel: hasBadge("all_categories") || hasBadge("pac_started") ? "azione fatta" : "azione mancante",
      nextHint: "Registra il primo investimento o completa il primo mese di PAC.",
    },
    {
      id: "steady",
      title: "Investitore costante",
      subtitle: "Il metodo sta diventando abitudine",
      description: "Tre mesi consecutivi non sono fortuna: sono il segnale che stai costruendo disciplina.",
      icon: "🔥",
      unlocked: currentStreak >= 3,
      progress: clamp(currentStreak, 3),
      target: 3,
      progressLabel: `${clamp(currentStreak, 3)}/3 mesi`,
      nextHint: "Mantieni il PAC per 3 mesi consecutivi.",
    },
    {
      id: "aware_manager",
      title: "Gestore consapevole",
      subtitle: "Sai tenere il piano sotto controllo",
      description: "Hai setup, capitale registrato e strumenti attivi: il portafoglio non è più improvvisato.",
      icon: "🛡️",
      unlocked: setupCompleted && activeCategories >= 1 && totalInvested >= 1000,
      progress: clamp((setupCompleted ? 1 : 0) + (activeCategories >= 1 ? 1 : 0) + (totalInvested >= 1000 ? 1 : 0), 3),
      target: 3,
      progressLabel: `${clamp((setupCompleted ? 1 : 0) + (activeCategories >= 1 ? 1 : 0) + (totalInvested >= 1000 ? 1 : 0), 3)}/3 basi`,
      nextHint: "Completa il setup, registra una categoria e aggiorna almeno 1.000 € di capitale.",
    },
    {
      id: "builder",
      title: "Costruttore di patrimonio",
      subtitle: "Il percorso è concreto",
      description: "Il capitale cresce e il metodo regge: stai costruendo una base che può durare nel tempo.",
      icon: "🏗️",
      unlocked: totalInvested >= 5000 && currentStreak >= 3,
      progress: clamp((totalInvested >= 5000 ? 1 : 0) + (currentStreak >= 3 ? 1 : 0), 2),
      target: 2,
      progressLabel: `${clamp((totalInvested >= 5000 ? 1 : 0) + (currentStreak >= 3 ? 1 : 0), 2)}/2 traguardi`,
      nextHint: "Raggiungi 5.000 € aggiornati e mantieni almeno 3 mesi consecutivi.",
    },
    {
      id: "disciplined",
      title: "Investitore disciplinato",
      subtitle: "Hai costruito identità, non solo risultati",
      description: "Dodici mesi di continuità: il piano è diventato parte del tuo comportamento.",
      icon: "🏆",
      unlocked: currentStreak >= 12 || unlockedCount >= 9,
      progress: clamp(Math.max(currentStreak, unlockedCount), 12),
      target: 12,
      progressLabel: currentStreak >= 12 ? "12/12 mesi" : `${clamp(unlockedCount, 12)}/12 progressi`,
      nextHint: "Proteggi la continuità fino a 12 mesi o completa la maggior parte dei badge.",
    },
  ];
}

function getGoalStorageKey(userId: string, portfolioKey: FinalPortfolioKey) {
  return `${getPrefix(userId)}-goal-${portfolioKey}`;
}

function getRetakeStorageKey(userId: string) {
  return `${getPrefix(userId)}-quiz-retake-meta`;
}

function getProgressStorageKey(userId: string, portfolioKey: FinalPortfolioKey) {
  return `${getPrefix(userId)}-progress-start-${portfolioKey}`;
}

function getBadgeVaultStorageKey(userId: string, portfolioKey: FinalPortfolioKey) {
  return `${getPrefix(userId)}-badge-vault-${portfolioKey}`;
}

function getCelebrationSnapshotKey(userId: string, portfolioKey: FinalPortfolioKey) {
  return `${getPrefix(userId)}-celebration-snapshot-${portfolioKey}`;
}

function getPersonalGoalCelebrationStateKey(userId: string, portfolioKey: FinalPortfolioKey) {
  return `${getPrefix(userId)}-personal-goal-celebration-state-${portfolioKey}`;
}

function getScamAnsweredStorageKey(userId: string) {
  return `${getPrefix(userId)}-scam-answered-scenarios`;
}

function getScamPerfectGamesStorageKey(userId: string) {
  return `${getPrefix(userId)}-scam-perfect-games`;
}

type PersonalGoalCelebrationState = {
  target: number;
  wasReached: boolean;
  confirmed: boolean;
  droppedBelowAfterConfirmed: boolean;
  lastCurrentValue: number;
  confirmedAt?: string;
};

function readPersonalGoalCelebrationState(key: string): PersonalGoalCelebrationState | null {
  if (typeof window === "undefined" || !key) return null;

  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as PersonalGoalCelebrationState) : null;
  } catch {
    return null;
  }
}

function writePersonalGoalCelebrationState(key: string, state: PersonalGoalCelebrationState) {
  if (typeof window === "undefined" || !key) return;
  window.localStorage.setItem(key, JSON.stringify(state));
}

function readStringArrayFromStorage(key: string): string[] {
  if (typeof window === "undefined" || !key) return [];

  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeStringArrayToStorage(key: string, values: string[]) {
  if (typeof window === "undefined" || !key) return;
  window.localStorage.setItem(key, JSON.stringify(Array.from(new Set(values))));
}


function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : String(message ?? "");
  }
  return String(error ?? "");
}


function getItalianAuthErrorMessage(error: unknown) {
  const raw = getErrorMessage(error);
  const message = raw.toLowerCase();

  if (message.includes("email rate limit") || message.includes("rate limit exceeded") || message.includes("too many") || message.includes("over email send rate limit")) {
    return "Hai richiesto troppe email in poco tempo. Per motivi di sicurezza il servizio email consente pochi invii ravvicinati. Riprova tra circa 60 minuti.";
  }

  if (message.includes("invalid login credentials")) {
    return "Email o password non corrette. Controlla i dati inseriti oppure usa Recupera password.";
  }

  if (message.includes("email not confirmed")) {
    return "La tua email non risulta ancora confermata. Controlla la casella di posta e clicca sul link di conferma.";
  }

  if (message.includes("password should be at least") || message.includes("password is too short")) {
    return "La password deve contenere almeno 8 caratteri.";
  }

  if (message.includes("otp expired") || message.includes("token has expired") || message.includes("link is invalid") || message.includes("invalid token")) {
    return "Il link non è più valido o risulta scaduto. Richiedi un nuovo link e riprova.";
  }

  return raw || "Si è verificato un errore. Riprova tra poco.";
}

function isSupabaseLockAbortError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("aborterror") || message.includes("lock broken") || message.includes("steal");
}

function isSupabaseRlsError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("row-level security") ||
    message.includes("violates row-level security policy") ||
    message.includes("permission denied")
  );
}

function clearSupabaseAuthStorage() {
  if (typeof window === "undefined") return;

  Object.keys(localStorage).forEach((key) => {
    if (key.startsWith("sb-") || key.includes("supabase.auth.token")) {
      localStorage.removeItem(key);
    }
  });

  Object.keys(sessionStorage).forEach((key) => {
    if (key.startsWith("sb-") || key.includes("supabase.auth.token")) {
      sessionStorage.removeItem(key);
    }
  });
}

function hasSupabaseAuthStorage() {
  if (typeof window === "undefined") return false;

  return [...Object.keys(localStorage), ...Object.keys(sessionStorage)].some(
    (key) => key.startsWith("sb-") || key.includes("supabase.auth.token")
  );
}

function isInvalidSupabaseRefreshTokenError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("invalid refresh token") ||
    message.includes("refresh token not found") ||
    message.includes("refresh token has expired") ||
    message.includes("refresh_token_not_found")
  );
}

function handleSupabaseAuthReadError(error: unknown, context: string) {
  const message = getErrorMessage(error);

  if (isInvalidSupabaseRefreshTokenError(error)) {
    console.warn(`Sessione Supabase locale non più valida (${context}). Pulizia locale eseguita:`, message);
    clearSupabaseAuthStorage();
    return;
  }

  if (isSupabaseLockAbortError(error)) {
    console.warn(`Lettura sessione Supabase rimandata (${context}): richiesta sovrapposta non bloccante.`, message);
    return;
  }

  console.warn(`Lettura sessione Supabase non disponibile (${context}).`, message);
}

async function safeGetSupabaseSession(context: string) {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      handleSupabaseAuthReadError(error, context);
      return null;
    }
    return data.session ?? null;
  } catch (error) {
    handleSupabaseAuthReadError(error, context);
    return null;
  }
}

async function safeGetSupabaseUser(context: string) {
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) {
      handleSupabaseAuthReadError(error, context);
      return null;
    }
    return data.user ?? null;
  } catch (error) {
    handleSupabaseAuthReadError(error, context);
    return null;
  }
}


async function safeLocalSignOut() {
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch (error) {
    console.warn("Logout locale Supabase ignorato:", error);
  }
}

export default function Home() {
  
  useEffect(() => {
    const attribution = captureMarketingAttributionFromUrl();
    void recordMarketingVisit(attribution);
    void trackEvent("open_app");
    if (attribution?.referralCode || attribution?.partnerCode) {
      void trackEvent("referral_visit", {
        referral_code: attribution.referralCode || attribution.partnerCode || null,
        partner_code: attribution.partnerCode || null,
      });
    }
    if (attribution?.discountCode) {
      void trackEvent("discount_code_seen", { discount_code: attribution.discountCode });
    }
  }, []);
const [authReady, setAuthReady] = useState(false);
  const [appBootLoading, setAppBootLoading] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register" | "reset" | "updatePassword">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authConfirmPassword, setAuthConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [accountNewPassword, setAccountNewPassword] = useState("");
  const [accountConfirmPassword, setAccountConfirmPassword] = useState("");
  const [accountPasswordMessage, setAccountPasswordMessage] = useState("");
  const [accountPasswordLoading, setAccountPasswordLoading] = useState(false);
  const [accountShowPassword, setAccountShowPassword] = useState(false);
  const [profileResetLoading, setProfileResetLoading] = useState(false);
  const [profileResetMessage, setProfileResetMessage] = useState("");
  const [adminOverview, setAdminOverview] = useState<AdminOverview | null>(null);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminMessage, setAdminMessage] = useState("");
  const [adminResetLoading, setAdminResetLoading] = useState(false);
  const [adminResetConfirm, setAdminResetConfirm] = useState("");


  const [goalTitle, setGoalTitle] = useState("Libertà finanziaria");
  const [goalTarget, setGoalTarget] = useState("100000");
  const [goalCurrentValue, setGoalCurrentValue] = useState("0");
  const [goalPreviousValue, setGoalPreviousValue] = useState("0");
  const [goalReason, setGoalReason] = useState<GoalChangeReason>("stabile");
  const [goalEndYear, setGoalEndYear] = useState(String(new Date().getFullYear() + 10));
  const [goalLoaded, setGoalLoaded] = useState(false);
  const [draftGoalTitle, setDraftGoalTitle] = useState("Libertà finanziaria");
  const [draftGoalTarget, setDraftGoalTarget] = useState("100000");
  const [draftGoalCurrentValue, setDraftGoalCurrentValue] = useState("0");
  const [draftGoalPreviousValue, setDraftGoalPreviousValue] = useState("0");
  const [draftGoalReason, setDraftGoalReason] = useState<GoalChangeReason>("stabile");
  const [draftGoalEndYear, setDraftGoalEndYear] = useState(String(new Date().getFullYear() + 10));
  const draftGoalTitleRef = useRef<HTMLInputElement | null>(null);
  const draftGoalCurrentValueRef = useRef<HTMLInputElement | null>(null);
  const draftGoalPreviousValueRef = useRef<HTMLInputElement | null>(null);
  const draftGoalTargetRef = useRef<HTMLInputElement | null>(null);
  const draftGoalEndYearRef = useRef<HTMLInputElement | null>(null);
  const draftGoalReasonRef = useRef<HTMLSelectElement | null>(null);
  const [goalSaveStatus, setGoalSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [progressStartValue, setProgressStartValue] = useState("0");
  const [progressStartMonth, setProgressStartMonth] = useState("");

  const [step, setStep] = useState<AppStep>("home");
  const [dashboardActiveTab, setDashboardActiveTab] = useState<DashboardTab>("monitor");
  const [showPacHistoryMonths, setShowPacHistoryMonths] = useState(false);
  const dashboardRouteKeyRef = useRef("");
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [answers, setAnswers] = useState<number[]>(Array(questions.length).fill(-1));
  const [showRetakeWarning, setShowRetakeWarning] = useState(false);
  const [retakeReason, setRetakeReason] = useState("situazione");
  const [retakeMeta, setRetakeMeta] = useState<{ count: number; lastAt: string | null }>({
    count: 0,
    lastAt: null,
  });
  const [purchase, setPurchase] = useState<PurchaseState>({ unlocked: false, email: "", paidAmount: 0 });
  const purchaseLoadedRef = useRef(false);
  const [showProUpgradeModal, setShowProUpgradeModal] = useState(false);
  const [celebration, setCelebration] = useState<CelebrationEvent | null>(null);
  const [goalCelebration, setGoalCelebration] = useState<CelebrationEvent | null>(null);
  const [persistedBadgeIds, setPersistedBadgeIds] = useState<string[]>([]);
  const [badgeVaultLoadedKey, setBadgeVaultLoadedKey] = useState("");
  const celebrationInitialSyncRef = useRef<Record<string, boolean>>({});
  const awarenessTabLoadedRef = useRef(false);
  const awarenessActionsLoadedRef = useRef(false);
  const mortgageCheckLoadedRef = useRef(false);
  const mortgageSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mortgageSaveStatus, setMortgageSaveStatus] = useState<"idle" | "saving" | "saved" | "local" | "error">("idle");
  const [mortgageLastSavedAt, setMortgageLastSavedAt] = useState<string | null>(null);
  const [mortgageSaveMessage, setMortgageSaveMessage] = useState("");
  const pacHistoryLoadKeyRef = useRef<string | null>(null);
  const pacHistoryRequestIdRef = useRef(0);
  const holdingsLoadKeyRef = useRef<string | null>(null);
  const holdingsLoadRequestIdRef = useRef(0);
  const customInstrumentsLoadKeyRef = useRef<string | null>(null);
  const customInstrumentsLoadRequestIdRef = useRef(0);
  const shoppingItemsLoadKeyRef = useRef<string | null>(null);
  const shoppingItemsLoadRequestIdRef = useRef(0);
  const profileLoadKeyRef = useRef<string | null>(null);
  const checklistLoadKeyRef = useRef<string | null>(null);
  const checklistLoadRequestIdRef = useRef(0);
  const goalLoadKeyRef = useRef<string | null>(null);
  const goalLoadRequestIdRef = useRef(0);
  const lastScamPerfectGameSignatureRef = useRef<string | null>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [customInstruments, setCustomInstruments] = useState<CustomInstrument[]>([]);
  const [customInstrumentDraft, setCustomInstrumentDraft] = useState({
    category: "Azioni Globali" as StrumentiCategory,
    name: "",
    isin: "",
    note: "",
  });
  const [customInstrumentMessage, setCustomInstrumentMessage] = useState("");
  const [checklistState, setChecklistState] = useState<Record<string, boolean>>({});
  const [guideActionVisited, setGuideActionVisited] = useState<Record<string, boolean>>({});
  const [pacHistory, setPacHistory] = useState<PacMonth[]>([]);
  const [awarenessTab, setAwarenessTab] = useState<AwarenessTab>("risparmio");
  const [completedAwarenessActions, setCompletedAwarenessActions] = useState<Record<string, boolean>>({});
  const [shoppingItems, setShoppingItems] = useState<ShoppingItem[]>([]);
  const [shoppingDraft, setShoppingDraft] = useState({
    name: "",
    category: "Frutta e verdura" as ShoppingCategory,
    estimatedPrice: "",
    isExtra: false,
  });
  const [shoppingMessage, setShoppingMessage] = useState("");
  const [shoppingLoading, setShoppingLoading] = useState(false);
  const [showShoppingResetConfirm, setShowShoppingResetConfirm] = useState(false);
  const [isSmartShoppingOpen, setIsSmartShoppingOpen] = useState(false);
  const [mobileAwarenessMode, setMobileAwarenessMode] = useState<"standard" | "shopping">("standard");
  const [vehiclePrice, setVehiclePrice] = useState("25000");
  const [vehicleDownPayment, setVehicleDownPayment] = useState("3000");
  const [vehicleMonthlyPayment, setVehicleMonthlyPayment] = useState("299");
  const [vehicleTaeg, setVehicleTaeg] = useState("7.5");
  const [vehicleTan, setVehicleTan] = useState("8.99");
  const [vehicleTotalCredit, setVehicleTotalCredit] = useState("");
  const [vehicleFinancingBonus, setVehicleFinancingBonus] = useState("0");
  const [vehicleScrappage, setVehicleScrappage] = useState("no");
  const [vehicleDurationMonths, setVehicleDurationMonths] = useState("36");
  const [vehicleBalloonPayment, setVehicleBalloonPayment] = useState("12000");
  const [vehicleRefinanceMonths, setVehicleRefinanceMonths] = useState("36");
  const [vehicleRefinanceRate, setVehicleRefinanceRate] = useState("9");
  const [vehicleInsuranceYearly, setVehicleInsuranceYearly] = useState("900");
  const [vehicleMaintenanceYearly, setVehicleMaintenanceYearly] = useState("600");
  const [vehicleRoadTaxYearly, setVehicleRoadTaxYearly] = useState("250");
  const [vehicleTyresYearly, setVehicleTyresYearly] = useState("250");
  const [vehicleMonthlyIncome, setVehicleMonthlyIncome] = useState("2200");
  const [vehicleKmLimit, setVehicleKmLimit] = useState("10000");
  const [vehicleKmExpected, setVehicleKmExpected] = useState("15000");
  const [mortgageHomePrice, setMortgageHomePrice] = useState("250000");
  const [mortgageDownPayment, setMortgageDownPayment] = useState("50000");
  const [mortgagePrincipal, setMortgagePrincipal] = useState("200000");
  const [mortgageRate, setMortgageRate] = useState("3.5");
  const [mortgageYears, setMortgageYears] = useState("25");
  const [mortgageRateType, setMortgageRateType] = useState("fisso");
  const [mortgageCapRate, setMortgageCapRate] = useState("5.5");
  const [mortgageDeclaredPayment, setMortgageDeclaredPayment] = useState("");
  const [mortgageMonthlyIncome, setMortgageMonthlyIncome] = useState("2800");
  const [mortgageInitialCosts, setMortgageInitialCosts] = useState("14000");
  const [mortgageRecurringYearly, setMortgageRecurringYearly] = useState("2200");
  const [mortgageCondoMonthly, setMortgageCondoMonthly] = useState("120");
  const [mortgageUtilitiesMonthly, setMortgageUtilitiesMonthly] = useState("180");
  const [mortgageInsuranceYearly, setMortgageInsuranceYearly] = useState("350");
  const [mortgageMaintenanceYearly, setMortgageMaintenanceYearly] = useState("1200");
  const [mortgageOtherDebtsMonthly, setMortgageOtherDebtsMonthly] = useState("0");
  const [mortgageFixedExpensesMonthly, setMortgageFixedExpensesMonthly] = useState("1000");
  const [mortgageLiquidAfterPurchase, setMortgageLiquidAfterPurchase] = useState("15000");
  const [mortgageEmergencyMonths, setMortgageEmergencyMonths] = useState("6");
  const [mortgageMode, setMortgageMode] = useState<MortgageMode>("sostenibilità");
  const [mortgageOfferName, setMortgageOfferName] = useState("");
  const [mortgagePiesFields, setMortgagePiesFields] = useState<Record<string, MortgagePiesFieldState>>(() =>
    getDefaultMortgagePiesFields()
  );
  const [openMortgagePiesSectionId, setOpenMortgagePiesSectionId] = useState(mortgagePiesSections[0]?.id ?? "");
  const mortgagePiesSectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [fraudAnswers, setFraudAnswers] = useState<Record<string, boolean>>({});
  const [fraudContext, setFraudContext] = useState("sms");
  const [scamGameQuestions, setScamGameQuestions] = useState<ScamScenario[]>([]);
  const [scamGameIndex, setScamGameIndex] = useState(0);
  const [scamGameAnswers, setScamGameAnswers] = useState<Array<{ id: string; correct: boolean; userChoice: "trust" | "verify" }>>([]);
  const [scamSelectedChoice, setScamSelectedChoice] = useState<"trust" | "verify" | null>(null);
  const [scamGameSessionId, setScamGameSessionId] = useState(0);
  const [scamAnsweredScenarioIds, setScamAnsweredScenarioIds] = useState<string[]>([]);
  const [scamPerfectGames, setScamPerfectGames] = useState(0);
  const [pacJustCompleted, setPacJustCompleted] = useState(false);
  const [checkedPacAllocations, setCheckedPacAllocations] = useState<Record<string, boolean>>({});
  const [newHolding, setNewHolding] = useState({
    category: "Azioni Globali" as StrumentiCategory,
    strumentiName: strumentiLibrary["Azioni Globali"][0].name,
    isin: strumentiLibrary["Azioni Globali"][0].isin,
    amount: "",
  });

  const [homeMonthly, setHomeMonthly] = useState("200");
  const [homeYears, setHomeYears] = useState("20");
  const [portMonthly, setPortMonthly] = useState("200");
  const [portYears, setPortYears] = useState("20");
  const [portInitial, setPortInitial] = useState("0");
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [rebalancePacAmount, setRebalancePacAmount] = useState("200");
  const [rebalanceValues, setRebalanceValues] = useState<Partial<Record<StrumentiCategory, string>>>({});
  const [exitInvestedAmount, setExitInvestedAmount] = useState("100000");
  const [exitCurrentAmount, setExitCurrentAmount] = useState("130000");
  const [exitGoalAmount, setExitGoalAmount] = useState("120000");
  const [exitMonths, setExitMonths] = useState("12");
  const [exitProfile, setExitProfile] = useState<"prudente" | "bilanciato" | "aggressivo" | "rendita">("bilanciato");
  const [exitMode, setExitMode] = useState<"manual" | "questionario">("manual");
  const [showExitQuestionnaireModal, setShowExitQuestionnaireModal] = useState(false);
  const [showExitQuestionnaireWarning, setShowExitQuestionnaireWarning] = useState(false);
  const [exitQuestionnaireStep, setExitQuestionnaireStep] = useState(0);
  const [exitHorizon, setExitHorizon] = useState<"entro1" | "unoTre" | "oltreTre">("unoTre");
  const [exitMainConcern, setExitMainConcern] = useState<"timing" | "guadagni" | "rendita" | "tasse">("timing");
  const [exitLifeGoal, setExitLifeGoal] = useState<"spesa" | "pensione" | "protezione" | "rendimento">("protezione");
  const [exitDropReaction, setExitDropReaction] = useState<"sicura" | "graduale" | "aspettare" | "regole">("sicura");
  const [savedExitAdvice, setSavedExitAdvice] = useState<"graduale" | "regole" | "obiettivo" | "bucket" | null>(null);
  const [selectedExitStrategy, setSelectedExitStrategy] = useState<"graduale" | "regole" | "obiettivo" | "bucket">("graduale");

  const scoreResult = useMemo(() => {
    const totals: ScoreMap = { stabilita: 0, equilibrio: 0, crescita: 0 };
    answers.forEach((answerIndex, questionIndex) => {
      if (answerIndex === -1) return;
      const option = questions[questionIndex].options[answerIndex];
      totals.stabilita += option.scores.stabilita;
      totals.equilibrio += option.scores.equilibrio;
      totals.crescita += option.scores.crescita;
    });
    const finalPortfolio = getPortfolioFromScores(totals);
    return { totals, finalPortfolio, portfolio: portfolioMap[finalPortfolio] };
  }, [answers]);

  const selectedPortfolio = portfolioMap[purchase.selectedPortfolio || scoreResult.finalPortfolio];
  const isPurchaseUnlocked = !!purchase.unlocked;
  const isProPlan = isPurchaseUnlocked && purchase.plan === "pro";
  const isCorePlan = isPurchaseUnlocked && purchase.plan === "core";
  const isAdminAccount = (user?.email || "").toLowerCase() === "tiziano.pesce50@gmail.com";

  const paidAmount = purchase.paidAmount ?? (purchase.plan === "core" ? 29 : purchase.plan === "pro" ? 59 : 0);
  const purchaseStatus = getPurchaseStatusCopy(purchase);
  const proPriceToPay = isCorePlan ? 30 : Math.max(59 - paidAmount, 0);

  const allInstrumentsByCategory = useMemo<Record<StrumentiCategory, InstrumentOption[]>>(() => {
    const merged = Object.fromEntries(
      Object.entries(strumentiLibrary).map(([category, rows]) => [
        category,
        rows.map((row) => ({ ...row, source: "program" as const })),
      ])
    ) as Record<StrumentiCategory, InstrumentOption[]>;

    customInstruments.forEach((instrument) => {
      merged[instrument.category] = [
        ...(merged[instrument.category] || []),
        {
          id: instrument.id,
          name: instrument.name,
          isin: instrument.isin,
          note: instrument.note,
          source: "custom",
        },
      ];
    });

    return merged;
  }, [customInstruments]);

  useEffect(() => {
    let mounted = true;

    function cleanAuthCallbackUrl() {
      if (typeof window === "undefined") return;
      const pathname = window.location.pathname === "/auth/callback" ? "/" : window.location.pathname;
      window.history.replaceState({}, document.title, `${window.location.origin}${pathname}`);
    }

    function readAuthCallbackFromUrl() {
      if (typeof window === "undefined") {
        return {
          isRecovery: false,
          code: null as string | null,
          accessToken: null as string | null,
          refreshToken: null as string | null,
        };
      }

      const search = new URLSearchParams(window.location.search);
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const callbackType = search.get("type") || hash.get("type");

      return {
        isRecovery:
          callbackType === "recovery" ||
          window.location.pathname.includes("/auth/callback") && callbackType === "recovery",
        code: search.get("code"),
        accessToken: hash.get("access_token"),
        refreshToken: hash.get("refresh_token"),
      };
    }

    function showUpdatePasswordScreen() {
      setAuthMode("updatePassword");
      setAuthPassword("");
      setAuthConfirmPassword("");
      setAuthMessage("Inserisci una nuova password per completare il recupero.");
      setAppBootLoading(false);
      setAuthReady(true);
    }

    async function initAuth() {
      try {
        const authCallback = readAuthCallbackFromUrl();

        if (authCallback.isRecovery) {
          if (authCallback.code) {
            const { data, error } = await supabase.auth.exchangeCodeForSession(authCallback.code);
            if (error) throw error;
            if (!mounted) return;
            setUser(data.session?.user ?? null);
            showUpdatePasswordScreen();
            cleanAuthCallbackUrl();
            return;
          }

          if (authCallback.accessToken && authCallback.refreshToken) {
            const { data, error } = await supabase.auth.setSession({
              access_token: authCallback.accessToken,
              refresh_token: authCallback.refreshToken,
            });
            if (error) throw error;
            if (!mounted) return;
            setUser(data.session?.user ?? null);
            showUpdatePasswordScreen();
            cleanAuthCallbackUrl();
            return;
          }

          if (!mounted) return;
          showUpdatePasswordScreen();
          return;
        }

        const session = await safeGetSupabaseSession("inizializzazione auth");

        if (!mounted) return;
        setUser(session?.user ?? null);
        if (!session && hasSupabaseAuthStorage()) {
          setAuthMessage("Sessione scaduta o non valida. Effettua di nuovo l'accesso.");
        }
        setAuthReady(true);
      } catch (error) {
        console.warn("Errore inizializzazione auth:", error);
        const authCallback = readAuthCallbackFromUrl();
        if (authCallback.isRecovery) {
          if (!mounted) return;
          setUser(null);
          setAppBootLoading(false);
          setAuthMode("reset");
          setAuthMessage("Il link di recupero non è valido o risulta scaduto. Richiedi un nuovo link di recupero password.");
          setAuthReady(true);
          cleanAuthCallbackUrl();
          return;
        }

        clearSupabaseAuthStorage();
        if (!mounted) return;
        setUser(null);
        setAuthMessage("Sessione scaduta o non valida. Effettua di nuovo l'accesso.");
        setAuthReady(true);
      }
    }

    initAuth();

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
      setAuthReady(true);

      if (event === "PASSWORD_RECOVERY") {
        setAuthMode("updatePassword");
        setAuthPassword("");
        setAuthConfirmPassword("");
        setAppBootLoading(false);
        setAuthMessage("Inserisci una nuova password per completare il recupero.");
      }
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!user) return;

    const saved = localStorage.getItem(getRetakeStorageKey(user.id));
    if (!saved) {
      setRetakeMeta({ count: 0, lastAt: null });
      return;
    }

    try {
      const parsed = JSON.parse(saved);
      setRetakeMeta({
        count: Number(parsed.count || 0),
        lastAt: parsed.lastAt || null,
      });
    } catch {
      setRetakeMeta({ count: 0, lastAt: null });
    }
  }, [user]);

  useEffect(() => {
    if (!user) {
      setAppBootLoading(false);
      purchaseLoadedRef.current = false;
      return;
    }

    const currentUser = user;
    let cancelled = false;

    async function hydrateUserData() {
      setAppBootLoading(true);
      purchaseLoadedRef.current = false;

      const savedPurchase = localStorage.getItem(getPurchaseKey(currentUser.id));
      const savedHoldings = localStorage.getItem(getHoldingsKey(currentUser.id));

      try {
        if (savedPurchase) {
          const parsedPurchase = normalizePurchaseState(JSON.parse(savedPurchase) as PurchaseState, currentUser.email || "");
          setPurchase(parsedPurchase);
        } else {
          setPurchase((prev) => ({
            ...prev,
            email: currentUser.email || prev.email || "",
          }));
        }
      } catch {
        setPurchase((prev) => ({
          ...prev,
          email: currentUser.email || prev.email || "",
        }));
      }

      if (savedHoldings) setHoldings(JSON.parse(savedHoldings));
      else setHoldings([]);

      try {
        // Dati essenziali per decidere la schermata iniziale: profilo e piano.
        // Li attendiamo prima di mostrare l'app per evitare passaggi rapidi
        // visibili tra home, paywall, onboarding e dashboard.
        await Promise.all([loadUserProfile(currentUser), loadPurchaseFromDb(currentUser)]);
        purchaseLoadedRef.current = true;
      } finally {
        if (!cancelled) setAppBootLoading(false);
      }

      // Dati non essenziali: possono caricarsi in background senza bloccare la UI.
      loadHoldingsFromDb(currentUser);
      loadCustomInstrumentsFromDb(currentUser);
      loadShoppingItemsFromDb(currentUser);
    }

    void hydrateUserData();

    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (!user || !purchaseLoadedRef.current) return;

    const key = getPurchaseKey(user.id);
    const savedPurchase = localStorage.getItem(key);
    let savedUnlocked = false;

    try {
      savedUnlocked = savedPurchase ? normalizePurchaseState(JSON.parse(savedPurchase) as PurchaseState, user.email || "").unlocked : false;
    } catch {
      savedUnlocked = false;
    }

    // Protezione importante: uno stato temporaneo non sbloccato non deve mai
    // sovrascrivere un pagamento già salvato.
    if (savedUnlocked && !purchase.unlocked) return;

    localStorage.setItem(key, JSON.stringify(purchase));

    // Se il piano e sbloccato, lo salviamo anche su Supabase: così lo stesso
    // utente resta sbloccato anche da un altro dispositivo/browser.
    if (purchase.unlocked) {
      void savePurchaseToDb(purchase);
    }
  }, [purchase, user]);

  useEffect(() => {
    if (!purchase.unlocked || step !== "paywall") return;

    let cancelled = false;

    async function routeAfterPlanActivation() {
      if (purchase.plan !== "core") {
        if (!cancelled) setStep("dashboard");
        return;
      }

      if (!user) return;

      const setupAlreadyCompleted = await hasCompletedDashboardSetupForPortfolio(
        user,
        purchase.selectedPortfolio
      );

      if (!cancelled) {
        setStep(setupAlreadyCompleted ? "dashboard" : "onboarding");
      }
    }

    void routeAfterPlanActivation();

    return () => {
      cancelled = true;
    };
  }, [purchase.unlocked, purchase.plan, purchase.selectedPortfolio, step, user?.id]);

  useEffect(() => {
    // Se il piano è scaduto, l'utente deve poter rivedere il Modello/Home e aprire il Profilo.
    // Blocchiamo solo le sezioni operative riservate, senza tenerlo "prigioniero" nel paywall.
    const restrictedStepsAfterExpiry: AppStep[] = ["guide", "dashboard", "awareness", "strumentis", "rebalance", "exit"];
    const hasExpiredPlan = !!purchase.expiresAt && !isPurchaseDateValid(purchase.expiresAt);

    if (!hasExpiredPlan) return;
    if (restrictedStepsAfterExpiry.includes(step) || step === "onboarding") {
      setStep("paywall");
    }
  }, [purchase.expiresAt, step]);

  // Mantiene la schermata selezionata stabile anche dopo refresh sessione,
  // inattività o cambio scheda del browser. La navigazione cambia solo quando
  // l'utente clicca volontariamente un pulsante/menu oppure quando esce dal paywall.
  useEffect(() => {
    if (!user || !purchase.unlocked) return;
    localStorage.setItem(`soldi-semplici-last-step-${user.id}`, step);
  }, [step, user, purchase.unlocked]);

  useEffect(() => {
    if (!user) return;
    const savedAwarenessTab = localStorage.getItem(`soldi-semplici-awareness-tab-${user.id}`) as AwarenessTab | null;
    if (savedAwarenessTab && ["risparmio", "auto", "mutuo", "truffe"].includes(savedAwarenessTab)) {
      setAwarenessTab(savedAwarenessTab);
    }
    awarenessTabLoadedRef.current = true;
  }, [user]);

  useEffect(() => {
    if (!user || !awarenessTabLoadedRef.current) return;
    localStorage.setItem(`soldi-semplici-awareness-tab-${user.id}`, awarenessTab);
  }, [user, awarenessTab]);

  useEffect(() => {
    if (!user) return;

    awarenessActionsLoadedRef.current = false;
    const savedAwarenessActions = localStorage.getItem(getAwarenessActionsStorageKey(user.id));
    let localAwarenessActions: Record<string, boolean> = {};

    if (savedAwarenessActions) {
      try {
        const parsed = JSON.parse(savedAwarenessActions) as Record<string, boolean>;
        localAwarenessActions = cleanAwarenessActionsState(parsed);
        setCompletedAwarenessActions(localAwarenessActions);
      } catch {
        setCompletedAwarenessActions({});
      }
    } else {
      setCompletedAwarenessActions({});
    }

    awarenessActionsLoadedRef.current = true;
    loadAwarenessActionsFromDb(user, localAwarenessActions);
  }, [user]);

  useEffect(() => {
    if (!user || !awarenessActionsLoadedRef.current) return;
    localStorage.setItem(getAwarenessActionsStorageKey(user.id), JSON.stringify(completedAwarenessActions));
  }, [completedAwarenessActions, user]);

  useEffect(() => {
    if (!user) return;

    mortgageCheckLoadedRef.current = false;
    const savedMortgageCheck = localStorage.getItem(getMortgageCheckStorageKey(user.id));
    let localMortgageCheck: any = null;

    if (savedMortgageCheck) {
      try {
        localMortgageCheck = JSON.parse(savedMortgageCheck);
        applyMortgageCheckState(localMortgageCheck);
      } catch {
        localMortgageCheck = null;
      }
    }

    mortgageCheckLoadedRef.current = true;
    loadMortgageCheckFromDb(user, localMortgageCheck);
  }, [user]);

  useEffect(() => {
    if (!user || !mortgageCheckLoadedRef.current) return;

    const state = buildMortgageCheckState();
    localStorage.setItem(getMortgageCheckStorageKey(user.id), JSON.stringify(state));
    setMortgageSaveStatus("saving");
    setMortgageSaveMessage("Salvataggio mutuo in corso...");

    if (mortgageSaveTimerRef.current) clearTimeout(mortgageSaveTimerRef.current);
    mortgageSaveTimerRef.current = setTimeout(() => {
      saveMortgageCheckToDb(user, state);
    }, 700);

    return () => {
      if (mortgageSaveTimerRef.current) {
        clearTimeout(mortgageSaveTimerRef.current);
        mortgageSaveTimerRef.current = null;
      }
    };
  }, [
    user,
    mortgageMode,
    mortgageOfferName,
    mortgageHomePrice,
    mortgageDownPayment,
    mortgagePrincipal,
    mortgageRate,
    mortgageYears,
    mortgageRateType,
    mortgageCapRate,
    mortgageDeclaredPayment,
    mortgageMonthlyIncome,
    mortgageInitialCosts,
    mortgageRecurringYearly,
    mortgageCondoMonthly,
    mortgageUtilitiesMonthly,
    mortgageInsuranceYearly,
    mortgageMaintenanceYearly,
    mortgageOtherDebtsMonthly,
    mortgageFixedExpensesMonthly,
    mortgageLiquidAfterPurchase,
    mortgageEmergencyMonths,
    mortgagePiesFields,
    openMortgagePiesSectionId,
  ]);

  useEffect(() => {
    if (!user) return;
    localStorage.setItem(getHoldingsKey(user.id), JSON.stringify(holdings));
  }, [holdings, user]);

  useEffect(() => {
    if (!user) return;
    const savedChecklist = localStorage.getItem(getChecklistStorageKey(user.id, selectedPortfolio.key));
    if (savedChecklist) setChecklistState(JSON.parse(savedChecklist));
    else setChecklistState({});
    loadChecklistFromDb(user);
  }, [selectedPortfolio.key, user]);

  useEffect(() => {
    if (!user) return;
    const months = generateRecentMonths(12).map((month) => ({ month, completed: false }));
    setPacHistory(months);
    loadPacHistoryFromDb(user);
  }, [selectedPortfolio.key, user]);

  useEffect(() => {
    if (!user) return;
    localStorage.setItem(getChecklistStorageKey(user.id, selectedPortfolio.key), JSON.stringify(checklistState));
  }, [checklistState, selectedPortfolio.key, user]);

  useEffect(() => {
    if (!user) return;
    localStorage.setItem(getPacStorageKey(user.id, selectedPortfolio.key), JSON.stringify(pacHistory));
  }, [pacHistory, selectedPortfolio.key, user]);

  useEffect(() => {
    if (!user) return;

    setGoalLoaded(false);
    loadGoalFromDb(user);
  }, [selectedPortfolio.key, user]);

  useEffect(() => {
    if (!goalLoaded) return;

    setDraftGoalTitle(goalTitle);
    setDraftGoalTarget(goalTarget);
    setDraftGoalCurrentValue(goalCurrentValue);
    setDraftGoalPreviousValue(goalPreviousValue);
    setDraftGoalReason(goalReason);
    setDraftGoalEndYear(goalEndYear);
  }, [
    goalLoaded,
    selectedPortfolio.key,
    goalTitle,
    goalTarget,
    goalCurrentValue,
    goalPreviousValue,
    goalReason,
    goalEndYear,
  ]);

  useEffect(() => {
    if (!user || !goalLoaded) return;

    const key = getProgressStorageKey(user.id, selectedPortfolio.key);
    const saved = localStorage.getItem(key);

    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setProgressStartValue(String(parsed.startValue ?? "0"));
        setProgressStartMonth(String(parsed.startMonth ?? ""));
        return;
      } catch {
        // fall through and recreate a safe baseline
      }
    }

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const baseline = String(goalCurrentValue || "0");

    setProgressStartValue(baseline);
    setProgressStartMonth(month);
    localStorage.setItem(
      key,
      JSON.stringify({
        startValue: baseline,
        startMonth: month,
      })
    );
  }, [user, goalLoaded, selectedPortfolio.key, goalCurrentValue]);

  // Il caricamento PAC viene gestito dall'effetto sopra che inizializza i mesi recenti.
  // Evitiamo un secondo fetch identico perché in sviluppo Next/React può creare richieste sovrapposte.

  // soldi-semplici-scroll-top-key
  useEffect(() => {
    if (["preview", "portfolio", "onboarding"].includes(step)) {
      window.setTimeout(() => {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }, 60);
    }
  }, [step]);


  const completedAwarenessList = awarenessActions.filter((action) => completedAwarenessActions[action.id]);
  const monthlyFreedByAwareness = completedAwarenessList.reduce((sum, action) => sum + action.estimatedSavingMonthly, 0);
  const yearlyFreedByAwareness = completedAwarenessList.reduce((sum, action) => sum + action.estimatedSavingYearly, 0);
  const shoppingTotalEstimated = shoppingItems.reduce((sum, item) => sum + Number(item.estimatedPrice || 0), 0);
  const shoppingExtraEstimated = shoppingItems
    .filter((item) => item.isExtra)
    .reduce((sum, item) => sum + Number(item.estimatedPrice || 0), 0);
  const shoppingCheckedCount = shoppingItems.filter((item) => item.isChecked).length;
  const shoppingRemainingCount = Math.max(0, shoppingItems.length - shoppingCheckedCount);
  const shoppingAllChecked = shoppingItems.length > 0 && shoppingCheckedCount === shoppingItems.length;
  const sortedAwarenessActions = [...awarenessActions].sort((a, b) => awarenessScore(b) - awarenessScore(a));

  const vehicle = {
    price: safeNumber(vehiclePrice),
    downPayment: safeNumber(vehicleDownPayment),
    monthlyPayment: safeNumber(vehicleMonthlyPayment),
    taeg: safeNumber(vehicleTaeg),
    tan: safeNumber(vehicleTan),
    totalCredit: safeNumber(vehicleTotalCredit),
    financingBonus: safeNumber(vehicleFinancingBonus),
    hasScrappage: vehicleScrappage === "si",
    durationMonths: Math.max(safeNumber(vehicleDurationMonths), 1),
    balloonPayment: safeNumber(vehicleBalloonPayment),
    insuranceYearly: safeNumber(vehicleInsuranceYearly),
    maintenanceYearly: safeNumber(vehicleMaintenanceYearly),
    roadTaxYearly: safeNumber(vehicleRoadTaxYearly),
    tyresYearly: safeNumber(vehicleTyresYearly),
    monthlyIncome: safeNumber(vehicleMonthlyIncome),
    kmLimit: safeNumber(vehicleKmLimit),
    kmExpected: safeNumber(vehicleKmExpected),
  };
  const vehicleOwnershipYears = vehicle.durationMonths / 12;
  const vehicleRegularInstallmentMonths = vehicle.balloonPayment > 0 ? Math.max(vehicle.durationMonths - 1, 1) : vehicle.durationMonths;
  const vehicleFinancedAmount = Math.max(vehicle.price - vehicle.downPayment, 0);
  const vehicleEstimatedCreditBase = Math.max(vehicle.price - vehicle.financingBonus - vehicle.downPayment, 0);
  const vehicleCreditAmountForCalculation = vehicle.totalCredit > 0 ? vehicle.totalCredit : vehicleEstimatedCreditBase;
  const vehicleMonthlyTaegRate = vehicle.taeg > 0 ? vehicle.taeg / 100 / 12 : 0;
  const vehicleEstimatedMonthlyPaymentFromTaeg = (() => {
    if (vehicle.price <= 0 || vehicle.durationMonths <= 0 || vehicle.taeg <= 0) return 0;
    const principal = vehicleCreditAmountForCalculation;
    const balloon = Math.max(vehicle.balloonPayment, 0);
    if (vehicleMonthlyTaegRate === 0) return Math.max((principal - balloon) / vehicleRegularInstallmentMonths, 0);
    const balloonDiscountFactor = Math.pow(1 + vehicleMonthlyTaegRate, -vehicle.durationMonths);
    const installmentDiscountFactor = Math.pow(1 + vehicleMonthlyTaegRate, -vehicleRegularInstallmentMonths);
    const numerator = (principal - balloon * balloonDiscountFactor) * vehicleMonthlyTaegRate;
    const denominator = 1 - installmentDiscountFactor;
    return Math.max(numerator / denominator, 0);
  })();
  const vehicleHasDeclaredPayment = vehicle.monthlyPayment > 0;
  const vehicleHasTaegEstimate = vehicleEstimatedMonthlyPaymentFromTaeg > 0;
  const vehicleMonthlyPaymentDifference = vehicleHasDeclaredPayment && vehicleHasTaegEstimate
    ? Math.abs(vehicle.monthlyPayment - vehicleEstimatedMonthlyPaymentFromTaeg)
    : 0;
  const vehicleMonthlyPaymentDifferenceRounded = Math.round(vehicleMonthlyPaymentDifference * 100) / 100;
  const vehiclePaymentCheckStatus = !vehicleHasDeclaredPayment && vehicleHasTaegEstimate
    ? "stimata"
    : vehicleHasDeclaredPayment && !vehicleHasTaegEstimate
    ? "solo_rata"
    : vehicleHasDeclaredPayment && vehicleHasTaegEstimate && vehicleMonthlyPaymentDifference <= 0.01
    ? "coincide"
    : vehicleHasDeclaredPayment && vehicleHasTaegEstimate && vehicleMonthlyPaymentDifference < 5
    ? "coerente"
    : vehicleHasDeclaredPayment && vehicleHasTaegEstimate && vehicle.monthlyPayment < vehicleEstimatedMonthlyPaymentFromTaeg
    ? "alert_rata_bassa"
    : vehicleHasDeclaredPayment && vehicleHasTaegEstimate && vehicle.monthlyPayment > vehicleEstimatedMonthlyPaymentFromTaeg
    ? "alert_rata_alta"
    : "incompleto";
  const vehicleEffectiveMonthlyPayment = vehicleHasDeclaredPayment
    ? Math.max(vehicle.monthlyPayment, vehicleEstimatedMonthlyPaymentFromTaeg || 0)
    : vehicleEstimatedMonthlyPaymentFromTaeg;
  const vehiclePaymentUsedLabel = vehicleHasDeclaredPayment && vehicleHasTaegEstimate && vehicleEstimatedMonthlyPaymentFromTaeg > vehicle.monthlyPayment + 5
    ? "rata stimata dal TAEG"
    : vehicleHasDeclaredPayment
    ? "rata dichiarata"
    : vehicleHasTaegEstimate
    ? "rata stimata dal TAEG"
    : "rata non disponibile";
  const vehicleTotalPaidFinancing = vehicle.downPayment + vehicleEffectiveMonthlyPayment * vehicleRegularInstallmentMonths + vehicle.balloonPayment;
  const vehicleExtraCost = vehicleTotalPaidFinancing - vehicle.price;
  const vehicleRunningCostsYearly = vehicle.insuranceYearly + vehicle.maintenanceYearly + vehicle.roadTaxYearly + vehicle.tyresYearly;
  const vehicleRunningCostsMonthly = vehicleRunningCostsYearly / 12;
  const vehicleHiddenCosts = vehicleRunningCostsYearly * vehicleOwnershipYears;
  const vehicleRealTotalCost = vehicleTotalPaidFinancing + vehicleHiddenCosts;
  const vehicleRealMonthlyCost = vehicleRealTotalCost / vehicle.durationMonths;
  const vehicleRealYearlyCost = vehicleRealMonthlyCost * 12;
  const vehicleCashMonthlyCost = vehicleEffectiveMonthlyPayment + vehicleRunningCostsMonthly;
  const vehicleBalloonMonthlyReserve = vehicle.balloonPayment > 0 ? vehicle.balloonPayment / vehicle.durationMonths : 0;
  const vehicleDownPaymentMonthlyWeight = vehicle.downPayment > 0 ? vehicle.downPayment / vehicle.durationMonths : 0;
  const vehicleRemainingDebtRatio = vehicle.price > 0 ? vehicle.balloonPayment / vehicle.price : 0;
  const vehiclePaidBeforeBalloonRatio =
    vehicle.price > 0 ? (vehicle.downPayment + vehicleEffectiveMonthlyPayment * vehicleRegularInstallmentMonths) / vehicle.price : 0;
  const vehicleIncomeRatio = vehicle.monthlyIncome > 0 ? vehicleRealMonthlyCost / vehicle.monthlyIncome : 0;
  const vehicleGuaranteedRiskScore =
    (vehicle.kmExpected > vehicle.kmLimit && vehicle.kmLimit > 0 ? 2 : 0) +
    (vehicleRemainingDebtRatio > 0.4 ? 2 : 0) +
    (vehicle.downPayment < vehicle.price * 0.1 ? 1 : 0) +
    (vehicleIncomeRatio > 0.2 ? 2 : vehicleIncomeRatio > 0.15 ? 1 : 0) +
    (vehiclePaymentCheckStatus === "alert_rata_bassa" ? 2 : vehiclePaymentCheckStatus === "alert_rata_alta" ? 1 : 0);
  const vehicleRiskLevel = vehicleGuaranteedRiskScore >= 4 ? "alto" : vehicleGuaranteedRiskScore >= 2 ? "medio" : "basso";
  const vehiclePaymentCheckTitle =
    vehiclePaymentCheckStatus === "coincide"
      ? "Rata e TAEG coincidono"
      : vehiclePaymentCheckStatus === "coerente"
      ? "Rata coerente con il TAEG"
      : vehiclePaymentCheckStatus === "alert_rata_bassa"
      ? "Attenzione: la rata potrebbe non raccontare tutto"
      : vehiclePaymentCheckStatus === "alert_rata_alta"
      ? "Verifica il preventivo"
      : vehiclePaymentCheckStatus === "stimata"
      ? "Rata stimata dal TAEG"
      : vehiclePaymentCheckStatus === "solo_rata"
      ? "Stima basata sulla rata dichiarata"
      : "Inserisci rata o TAEG";
  const vehiclePaymentCheckMessage =
    vehiclePaymentCheckStatus === "coincide"
      ? "La rata dichiarata e la rata calcolata dal TAEG coincidono. Il preventivo risulta più chiaro e leggibile."
      : vehiclePaymentCheckStatus === "coerente"
      ? `La differenza tra rata dichiarata e rata stimata dal TAEG e inferiore a 5 euro (${formatEuro(vehicleMonthlyPaymentDifferenceRounded)}). Il dato è coerente.`
      : vehiclePaymentCheckStatus === "alert_rata_bassa"
      ? `La rata dichiarata e più bassa della stima calcolata dal TAEG. Potrebbero esserci costi, servizi o condizioni non evidenti nella rata comunicata. Rata dichiarata: ${formatEuro(vehicle.monthlyPayment)}/mese. Rata stimata: circa ${formatEuro(vehicleEstimatedMonthlyPaymentFromTaeg)}/mese.`
      : vehiclePaymentCheckStatus === "alert_rata_alta"
      ? `La rata dichiarata e più alta della stima basata sul TAEG. Potrebbero essere inclusi servizi, assicurazioni, accessori o condizioni particolari. Rata dichiarata: ${formatEuro(vehicle.monthlyPayment)}/mese. Rata stimata: circa ${formatEuro(vehicleEstimatedMonthlyPaymentFromTaeg)}/mese.`
      : vehiclePaymentCheckStatus === "stimata"
      ? `Hai inserito il TAEG ma non la rata. L'app stima una rata di circa ${formatEuro(vehicleEstimatedMonthlyPaymentFromTaeg)}/mese: usala come riferimento indicativo prima di confrontarla con il preventivo ufficiale.`
      : vehiclePaymentCheckStatus === "solo_rata"
      ? "Abbiamo usato la rata che hai inserito. Per una verifica più completa, cerca anche il TAEG nel preventivo: è il dato più utile per leggere il costo reale del finanziamento."
      : "Per una stima utile inserisci almeno la rata mensile oppure il TAEG indicato nel preventivo.";
  const vehiclePaymentCheckTone = vehiclePaymentCheckStatus === "alert_rata_bassa" || vehiclePaymentCheckStatus === "alert_rata_alta"
    ? "amber"
    : vehiclePaymentCheckStatus === "incompleto"
    ? "slate"
    : "emerald";

  const vehicleMonthlyTanRate = vehicle.tan > 0 ? vehicle.tan / 100 / 12 : 0;
  const vehicleHasBalloonPayment = vehicle.balloonPayment > 0;
  const vehicleInsidePaymentAvailable = vehicleHasDeclaredPayment && vehicleCreditAmountForCalculation > 0 && (vehicleHasBalloonPayment || vehicle.tan > 0);

  // Se c'è una maxi rata finale, usiamo quella come riferimento principale:
  // indica quanta parte del debito resta ancora da gestire alla scadenza.
  // In questo caso la quota capitale media e più utile della quota capitale del primo mese.
  const vehicleAverageCapitalFromBalloon = vehicleHasBalloonPayment
    ? Math.max((vehicleCreditAmountForCalculation - vehicle.balloonPayment) / vehicleRegularInstallmentMonths, 0)
    : 0;
  const vehicleFirstMonthInterestByTan = vehicleMonthlyTanRate > 0 ? vehicleCreditAmountForCalculation * vehicleMonthlyTanRate : 0;
  const vehicleFirstMonthCapitalByTan = vehicleHasDeclaredPayment
    ? Math.max(vehicle.monthlyPayment - vehicleFirstMonthInterestByTan, 0)
    : vehicleHasTaegEstimate
    ? Math.max(vehicleEstimatedMonthlyPaymentFromTaeg - vehicleFirstMonthInterestByTan, 0)
    : 0;
  const vehicleInsidePaymentCapital = vehicleHasBalloonPayment
    ? Math.min(vehicleAverageCapitalFromBalloon, vehicle.monthlyPayment || vehicleEstimatedMonthlyPaymentFromTaeg || 0)
    : vehicleFirstMonthCapitalByTan;
  const vehicleInsidePaymentInterestAndCosts = vehicleHasDeclaredPayment
    ? Math.max(vehicle.monthlyPayment - vehicleInsidePaymentCapital, 0)
    : vehicleHasTaegEstimate
    ? Math.max(vehicleEstimatedMonthlyPaymentFromTaeg - vehicleInsidePaymentCapital, 0)
    : vehicleFirstMonthInterestByTan;
  const vehicleInsidePaymentInterestRatio = vehicleHasDeclaredPayment && vehicle.monthlyPayment > 0
    ? vehicleInsidePaymentInterestAndCosts / vehicle.monthlyPayment
    : 0;
  const vehicleInsidePaymentCapitalRatio = vehicleHasDeclaredPayment && vehicle.monthlyPayment > 0
    ? vehicleInsidePaymentCapital / vehicle.monthlyPayment
    : 0;
  const vehicleFirstMonthInterest = vehicleInsidePaymentInterestAndCosts;
  const vehicleFirstMonthCapital = vehicleInsidePaymentCapital;
  const vehicleFirstMonthInterestRatio = vehicleInsidePaymentInterestRatio;
  const vehicleFirstMonthCapitalRatio = vehicleInsidePaymentCapitalRatio;
  const vehicleDeclaredPaymentsBeforeBalloon = vehicleHasDeclaredPayment ? vehicle.monthlyPayment * vehicleRegularInstallmentMonths : 0;
  const vehicleDebtAfterInstallmentsEstimate = (() => {
    if (vehicleCreditAmountForCalculation <= 0 || !vehicleHasDeclaredPayment) return 0;
    if (vehicleHasBalloonPayment) return vehicle.balloonPayment;
    if (vehicleMonthlyTanRate <= 0) return 0;
    let debt = vehicleCreditAmountForCalculation;
    for (let month = 0; month < vehicleRegularInstallmentMonths; month += 1) {
      const interest = debt * vehicleMonthlyTanRate;
      const capital = Math.max(vehicle.monthlyPayment - interest, 0);
      debt = Math.max(debt - capital, 0);
    }
    return debt;
  })();
  const vehicleBalloonIsHigh = vehicleRemainingDebtRatio > 0.4;
  const vehicleScrappageMessage = vehicle.hasScrappage
    ? "Hai indicato che l'offerta prevede rottamazione. Lo sconto iniziale può rendere il prezzo più interessante, ma non elimina il costo del finanziamento: confronta sempre prezzo scontato, importo totale dovuto, rata finale e TAEG."
    : null;
  const vehicleBalloonExplanation = vehicleBalloonIsHigh
    ? "La rata finale rappresenta una parte importante del prezzo. La rata mensile può sembrare leggera, ma una quota rilevante del costo resta concentrata alla fine: dovrai pagarla, rifinanziarla oppure gestire restituzione o sostituzione secondo contratto."
    : null;
  const vehicleInsidePaymentMessage = vehicleInsidePaymentAvailable
    ? vehicleHasBalloonPayment
      ? `Su una rata mensile di ${formatEuro(vehicle.monthlyPayment)}, circa ${formatEuro(vehicleInsidePaymentCapital)} stanno riducendo il debito principale sull'auto, mentre circa ${formatEuro(vehicleInsidePaymentInterestAndCosts)} coprono interessi, costi finanziari, servizi o altre componenti del contratto. Questo succede perché una parte molto importante del capitale resta concentrata nella rata finale: alla scadenza dovrai ancora gestire circa ${formatEuro(vehicle.balloonPayment)}.`
      : vehicleFirstMonthCapitalRatio < 0.4
      ? "Nella prima parte del finanziamento la rata sta riducendo poco il debito sull'auto: una quota importante può essere assorbita da interessi e costi finanziari, mentre una parte rilevante del capitale resta da gestire alla scadenza."
      : "La rata riduce una quota significativa del debito, ma controlla comunque totale dovuto e condizioni del contratto."
    : "Inserisci rata dichiarata e importo finanziato. Se c'è una maxi rata finale, inseriscila: rende questa lettura molto più vicina alla realta. Se non c'è maxi rata, inserisci anche il TAN.";
  const vehicleRefinance = {
    amount: vehicle.balloonPayment,
    months: Math.max(safeNumber(vehicleRefinanceMonths), 1),
    rate: safeNumber(vehicleRefinanceRate),
  };
  const vehicleRefinanceMonthlyRate = vehicleRefinance.rate > 0 ? vehicleRefinance.rate / 100 / 12 : 0;
  const vehicleRefinanceMonthlyPayment = (() => {
    if (!vehicleHasBalloonPayment || vehicleRefinance.amount <= 0 || vehicleRefinance.months <= 0) return 0;
    if (vehicleRefinanceMonthlyRate === 0) return vehicleRefinance.amount / vehicleRefinance.months;
    return vehicleRefinance.amount * vehicleRefinanceMonthlyRate / (1 - Math.pow(1 + vehicleRefinanceMonthlyRate, -vehicleRefinance.months));
  })();
  const vehicleRefinanceTotalPaid = vehicleRefinanceMonthlyPayment * vehicleRefinance.months;
  const vehicleRefinanceExtraCost = Math.max(vehicleRefinanceTotalPaid - vehicleRefinance.amount, 0);
  const vehicleRefinancePaymentChange = vehicleHasDeclaredPayment ? vehicleRefinanceMonthlyPayment - vehicle.monthlyPayment : 0;
  const vehicleRefinanceAvailable = vehicleHasBalloonPayment && vehicleRefinanceMonthlyPayment > 0;
  const vehicleFinancialCostWithRefinance =
    vehicle.downPayment + vehicleEffectiveMonthlyPayment * vehicleRegularInstallmentMonths + vehicleRefinanceTotalPaid;
  const vehicleTotalCostWithRefinance = vehicleFinancialCostWithRefinance;
  const vehicleTotalCostWithRefinanceMonthly =
    vehicle.durationMonths + vehicleRefinance.months > 0
      ? vehicleTotalCostWithRefinance / (vehicle.durationMonths + vehicleRefinance.months)
      : 0;
  const vehicleRefinanceMessage = vehicleRefinanceAvailable
    ? `Se alla scadenza non paghi la maxi rata in un'unica soluzione, potresti dover rifinanziare circa ${formatEuro(vehicleRefinance.amount)}. Con i dati inseriti, la nuova rata stimata sarebbe circa ${formatEuro(vehicleRefinanceMonthlyPayment)}/mese per ${vehicleRefinance.months} mesi. Questo aiuta a capire che la maxi rata non sparisce: se la rifinanzi, diventa un nuovo debito e può portare a rate più alte e nuovi interessi.`
    : "Inserisci una maxi rata finale per stimare cosa potrebbe succedere se dovessi rifinanziarla invece di pagarla subito.";

  const vehicleAlerts = [
    vehicle.financingBonus > 0 && vehicle.totalCredit <= 0 ? "Bonus finanziamento inserito: la rata stimata dal TAEG viene calcolata su prezzo meno bonus e anticipo. Controlla comunque il totale dovuto." : null,
    vehicleRemainingDebtRatio > 0.4 ? "Maxi rata alta: una parte importante del costo resta concentrata alla fine del finanziamento." : null,
    vehicleFirstMonthCapitalRatio > 0 && vehicleFirstMonthCapitalRatio < 0.4 ? "Quota capitale bassa: le rate mensili stanno riducendo poco il debito principale." : null,
    vehicle.hasScrappage ? "Offerta con rottamazione: verifica bene condizioni, cumulabilita e prezzo senza incentivo." : null,
    vehicle.downPayment < vehicle.price * 0.1 ? "Anticipo basso: rischi di finanziare quasi tutto il bene." : null,
    vehicleIncomeRatio > 0.2
      ? "Costo auto molto pesante rispetto al reddito."
      : vehicleIncomeRatio > 0.15
        ? "Costo auto da monitorare: può comprimere risparmio e PAC."
        : null,
    vehicle.kmExpected > vehicle.kmLimit && vehicle.kmLimit > 0
      ? "Attenzione ai km: superare il limite può ridurre il valore garantito."
      : null,
  ].filter(Boolean) as string[];

  const mortgage = {
    homePrice: safeNumber(mortgageHomePrice),
    downPayment: safeNumber(mortgageDownPayment),
    principal: safeNumber(mortgagePrincipal),
    annualRate: safeNumber(mortgageRate),
    years: Math.max(safeNumber(mortgageYears), 1),
    rateType: mortgageRateType,
    capRate: safeNumber(mortgageCapRate),
    declaredPayment: safeNumber(mortgageDeclaredPayment),
    monthlyIncome: safeNumber(mortgageMonthlyIncome),
    initialCosts: safeNumber(mortgageInitialCosts),
    recurringYearly: safeNumber(mortgageRecurringYearly),
    condoMonthly: safeNumber(mortgageCondoMonthly),
    utilitiesMonthly: safeNumber(mortgageUtilitiesMonthly),
    insuranceYearly: safeNumber(mortgageInsuranceYearly),
    maintenanceYearly: safeNumber(mortgageMaintenanceYearly),
    otherDebtsMonthly: safeNumber(mortgageOtherDebtsMonthly),
    fixedExpensesMonthly: safeNumber(mortgageFixedExpensesMonthly),
    liquidAfterPurchase: safeNumber(mortgageLiquidAfterPurchase),
    emergencyMonths: Math.max(safeNumber(mortgageEmergencyMonths), 1),
  };
  const mortgageSuggestedPrincipal = Math.max(mortgage.homePrice - mortgage.downPayment, 0);
  const mortgagePrincipalForCalc = mortgage.principal > 0 ? mortgage.principal : mortgageSuggestedPrincipal;
  const mortgageEstimatedPayment = calcMortgagePayment(mortgagePrincipalForCalc, mortgage.annualRate, mortgage.years);
  const mortgageUsesDeclaredPayment = mortgage.declaredPayment > 0;
  const mortgageMonthlyPayment = mortgageUsesDeclaredPayment ? mortgage.declaredPayment : mortgageEstimatedPayment;
  const mortgageMonths = mortgage.years * 12;
  const mortgageTotalPaid = mortgageMonthlyPayment * mortgageMonths;
  const mortgageTotalInterest = Math.max(mortgageTotalPaid - mortgagePrincipalForCalc, 0);
  const mortgageRecurringMonthly = mortgage.recurringYearly / 12 + mortgage.condoMonthly + mortgage.utilitiesMonthly + mortgage.insuranceYearly / 12 + mortgage.maintenanceYearly / 12;
  const mortgageRealMonthlyHomeCost = mortgageMonthlyPayment + mortgageRecurringMonthly;
  const mortgageInitialCostsMonthly = mortgage.initialCosts / mortgageMonths;
  const mortgageRealMonthlyWithInitialCosts = mortgageRealMonthlyHomeCost + mortgageInitialCostsMonthly;
  const mortgageFrontCashNeeded = mortgage.downPayment + mortgage.initialCosts;
  const mortgageRealTotalHomeCost = mortgageTotalPaid + mortgage.initialCosts + mortgageRecurringMonthly * mortgageMonths;
  const mortgagePaymentIncomeRatio = mortgage.monthlyIncome > 0 ? mortgageMonthlyPayment / mortgage.monthlyIncome : 0;
  const mortgageHomeIncomeRatio = mortgage.monthlyIncome > 0 ? mortgageRealMonthlyHomeCost / mortgage.monthlyIncome : 0;
  const mortgageDebtIncomeRatio = mortgage.monthlyIncome > 0 ? (mortgageMonthlyPayment + mortgage.otherDebtsMonthly) / mortgage.monthlyIncome : 0;
  const mortgageMonthlyMargin = mortgage.monthlyIncome - mortgage.fixedExpensesMonthly - mortgage.otherDebtsMonthly - mortgageRealMonthlyHomeCost;
  const mortgageEmergencyNeeded = (mortgage.fixedExpensesMonthly + mortgage.otherDebtsMonthly + mortgageRealMonthlyHomeCost) * mortgage.emergencyMonths;
  const mortgageEmergencyGap = mortgage.liquidAfterPurchase - mortgageEmergencyNeeded;
  const mortgageSustainabilityLevel = mortgageHomeIncomeRatio > 0.45 || mortgageMonthlyMargin < 0
    ? "alto"
    : mortgageHomeIncomeRatio > 0.35 || mortgageDebtIncomeRatio > 0.4
    ? "medio"
    : "buono";
  const mortgageSustainabilityText = mortgageSustainabilityLevel === "buono"
    ? "Il mutuo sembra sostenibile rispetto ai dati inseriti. Mantieni comunque un fondo emergenza adeguato."
    : mortgageSustainabilityLevel === "medio"
    ? "Il mutuo assorbe una parte importante del reddito. Prima di firmare, controlla bene margine mensile e liquidità residua."
    : "Il mutuo può diventare pesante: lascia poco spazio a imprevisti, spese familiari o cali di reddito.";
  const mortgageTrafficLight = mortgageSustainabilityLevel === "buono"
    ? {
        label: "Verde",
        title: "Sembra sostenibile",
        shortText: "La rata e il costo reale della casa sembrano gestibili rispetto al reddito inserito.",
        advice: "Buon segnale: continua comunque a proteggere il fondo emergenza e non consumare tutta la liquidità per comprare casa.",
        dotClass: "bg-emerald-500",
        badgeClass: "border-emerald-200 bg-emerald-100 text-emerald-800",
      }
    : mortgageSustainabilityLevel === "medio"
    ? {
        label: "Giallo",
        title: "Da valutare con attenzione",
        shortText: "Il mutuo può essere gestibile, ma sta assorbendo una parte importante del reddito.",
        advice: "Prima di firmare, controlla bene margine mensile, fondo emergenza, costi iniziali e cosa succede negli stress test.",
        dotClass: "bg-amber-500",
        badgeClass: "border-amber-200 bg-amber-100 text-amber-800",
      }
    : {
        label: "Rosso",
        title: "Potenzialmente rischioso",
        shortText: "Il costo della casa lascia poco margine per imprevisti, spese familiari o cali di reddito.",
        advice: "Valuta una rata più bassa, più anticipo, una durata diversa o una casa meno costosa. Non ignorare questo segnale.",
        dotClass: "bg-red-500",
        badgeClass: "border-red-200 bg-red-100 text-red-800",
      };
  const mortgageIsFixedRate = mortgage.rateType === "fisso";
  const mortgageIsVariableRate = mortgage.rateType === "variabile";
  const mortgageIsCapRate = mortgage.rateType === "cap";
  const mortgageHasValidCap = mortgageIsCapRate && mortgage.capRate > 0;
  const mortgageStressIntroText = mortgageIsFixedRate
    ? "Con un tasso fisso la rata e più prevedibile. Qui lo stress test serve soprattutto a capire se il mutuo resta sostenibile se diminuisce il reddito o aumentano le spese familiari."
    : mortgageIsVariableRate
    ? "Con un tasso variabile la rata può aumentare. Guarda con attenzione gli scenari +1%, +2% e +3%: ti aiutano a capire se il mutuo resta gestibile anche in caso di aumento dei tassi."
    : "Il cap limita il tasso massimo, ma non significa che la rata non possa salire. Controlla la rata stimata al cap: e quella che devi riuscire a sostenere nello scenario peggiore previsto dal contratto.";
  const mortgageStressAdvice = mortgageIsFixedRate
    ? "Per un fisso, la domanda principale non è se il tasso sale: e se il tuo bilancio regge anche con meno reddito, più spese o imprevisti. Proteggi soprattutto margine mensile e fondo emergenza."
    : mortgageIsVariableRate
    ? "Per un variabile, non guardare solo la rata iniziale. Chiediti: se la rata salisse di 100, 200 o 300 euro, riusciresti comunque a vivere, risparmiare e gestire imprevisti?"
    : mortgageHasValidCap
    ? `Con il cap inserito, lo scenario peggiore contrattuale è circa ${mortgage.capRate}%. Non basta che la rata iniziale sia comoda: devi poter sostenere anche la rata al cap.`
    : "Hai scelto variabile con cap: inserisci il tasso massimo previsto dal contratto per vedere la rata massima stimata. Senza quel dato, il cap resta una protezione teorica ma non misurabile.";
  const mortgageStressTests = [1, 2, 3].map((shock) => {
    const rawRate = mortgage.annualRate + shock;
    const appliedRate = mortgageHasValidCap ? Math.min(rawRate, mortgage.capRate) : rawRate;
    const isCapped = mortgageHasValidCap && rawRate > mortgage.capRate;
    const payment = calcMortgagePayment(mortgagePrincipalForCalc, appliedRate, mortgage.years);
    const ratio = mortgage.monthlyIncome > 0 ? payment / mortgage.monthlyIncome : 0;
    const realRatio = mortgage.monthlyIncome > 0 ? (payment + mortgageRecurringMonthly) / mortgage.monthlyIncome : 0;
    return {
      shock,
      rawRate,
      appliedRate,
      isCapped,
      payment,
      ratio,
      realRatio,
      risk: realRatio > 0.45 ? "alto" : realRatio > 0.35 ? "medio" : "basso",
    };
  });
  const mortgageCapPayment = mortgageHasValidCap ? calcMortgagePayment(mortgagePrincipalForCalc, mortgage.capRate, mortgage.years) : 0;
  const mortgageCapRealRatio = mortgage.monthlyIncome > 0 ? (mortgageCapPayment + mortgageRecurringMonthly) / mortgage.monthlyIncome : 0;
  const mortgageCapRisk = mortgageCapRealRatio > 0.45 ? "alto" : mortgageCapRealRatio > 0.35 ? "medio" : "basso";
  const mortgageIncomeStressTests = [10, 20].map((drop) => {
    const stressedIncome = mortgage.monthlyIncome * (1 - drop / 100);
    const ratio = stressedIncome > 0 ? mortgageRealMonthlyHomeCost / stressedIncome : 0;
    return { drop, stressedIncome, ratio, risk: ratio > 0.45 ? "alto" : ratio > 0.35 ? "medio" : "basso" };
  });
  const mortgageExpenseStress = mortgage.monthlyIncome > 0 ? (mortgageRealMonthlyHomeCost + 200) / mortgage.monthlyIncome : 0;

  const updateMortgagePiesField = (fieldId: string, updates: Partial<MortgagePiesFieldState>) => {
    setMortgagePiesFields((prev) => ({
      ...prev,
      [fieldId]: {
        status: prev[fieldId]?.status ?? "missing",
        value: prev[fieldId]?.value ?? "",
        notes: prev[fieldId]?.notes ?? "",
        ...updates,
      },
    }));
  };

  const updateMortgagePiesInputValue = (fieldId: string, value: string) => {
    setMortgagePiesFields((prev) => {
      const current = prev[fieldId] ?? { status: "missing" as MortgagePiesStatus, value: "", notes: "" };
      const hadValue = current.value.trim().length > 0;
      const hasValue = value.trim().length > 0;
      const shouldAutoMarkFound = !hadValue && hasValue && current.status === "missing";

      return {
        ...prev,
        [fieldId]: {
          ...current,
          value,
          status: shouldAutoMarkFound ? "found" : current.status,
        },
      };
    });
  };

  const isPolicyCostSoftFound = (fields: Record<string, MortgagePiesFieldState>) => {
    const obligationValue = (fields.policiesObligation?.value || "").toLowerCase();
    const freedomValue = (fields.policyChoiceFreedom?.value || "").toLowerCase();
    const costValue = (fields.policyCost?.value || "").toLowerCase();
    const hasNoPolicies = obligationValue.includes("nessuna polizza") || costValue.includes("non ci sono polizze");
    const isOnlyMandatoryPolicy = obligationValue.includes("solo polizze obbligatorie");
    const isFreelySelectable = freedomValue.includes("compagnia esterna");
    const costNotIndicated = costValue.includes("costo non indicato");

    return hasNoPolicies || (isOnlyMandatoryPolicy && isFreelySelectable && costNotIndicated);
  };

  const getMortgageRateTypeCategory = (fields = mortgagePiesFields) => {
    const value = (fields.rateType?.value || "").toLowerCase();
    if (value.includes("variabile con cap")) return "cap";
    if (value.includes("tasso variabile")) return "variable";
    if (value.includes("tasso fisso")) return "fixed";
    if (value.includes("tasso misto")) return "mixed";
    if (value.includes("non trovato")) return "missing";
    if (value.includes("non chiaro")) return "unclear";
    return "unknown";
  };

  const isGreenDiscountSelected = (fields = mortgagePiesFields) => {
    const discountValue = (fields.discountConditions?.value || "").toLowerCase();
    const requirementValue = (fields.greenDiscountRequirement?.value || "").toLowerCase();
    return discountValue.includes("green") || discountValue.includes("classe energetica") || requirementValue.includes("classe") || requirementValue.includes("energetic");
  };


  const getMortgagePolicyCategory = (fields = mortgagePiesFields) => {
    const value = (fields.policiesObligation?.value || "").toLowerCase();
    if (!value) return "unknown";
    if (value.includes("nessuna polizza")) return "none";
    if (value.includes("non trovato")) return "missing";
    if (value.includes("non chiaro") || value.includes("obbligatorietà non chiara")) return "unclear";
    return "present";
  };

  const getMortgageDiscountCategory = (fields = mortgagePiesFields) => {
    const value = (fields.discountConditions?.value || "").toLowerCase();
    if (!value) return "unknown";
    if (value.includes("nessuno sconto")) return "none";
    if (value.includes("green") || value.includes("classe energetica")) return "green";
    if (value.includes("polizze")) return "policy";
    if (value.includes("conto") || value.includes("accredito") || value.includes("prodotti") || value.includes("bancari")) return "linkedProducts";
    if (value.includes("requisiti commerciali") || value.includes("altre condizioni")) return "other";
    if (value.includes("non trovato")) return "missing";
    if (value.includes("non chiaro") || value.includes("condizioni non chiare")) return "unclear";
    return "present";
  };

  const isMortgagePiesFieldVisible = (fieldId: string, fields = mortgagePiesFields) => {
    const rateTypeCategory = getMortgageRateTypeCategory(fields);
    const policyCategory = getMortgagePolicyCategory(fields);
    const discountCategory = getMortgageDiscountCategory(fields);
    const linkedProductsValue = (fields.linkedProducts?.value || "").toLowerCase();
    const productsRequirementValue = (fields.productsRequiredForRate?.value || "").toLowerCase();

    if (["referenceIndex", "spread"].includes(fieldId)) {
      return ["variable", "cap"].includes(rateTypeCategory);
    }

    if (["mixedChangeConditions", "mixedChangeAfterYears", "mixedChangeOutcome"].includes(fieldId)) {
      return rateTypeCategory === "mixed";
    }

    if (["capValue", "floorValue", "maxInstallmentAtCap"].includes(fieldId)) {
      return rateTypeCategory === "cap";
    }

    if (fieldId === "rateLocked") {
      return rateTypeCategory === "fixed" || rateTypeCategory === "unknown";
    }

    if (fieldId === "variableSimulation") {
      return ["variable", "cap", "mixed"].includes(rateTypeCategory);
    }

    if (["policyChoiceFreedom", "policyCost", "policyCostAmount"].includes(fieldId)) {
      return ["present", "unclear", "missing"].includes(policyCategory);
    }

    if (["productsRequiredForRate", "linkedProductsDetails"].includes(fieldId)) {
      const hasLinkedProducts = linkedProductsValue && !linkedProductsValue.includes("nessun prodotto");
      const hasProductsRequirement = productsRequirementValue && !productsRequirementValue.includes("nessun prodotto");
      return hasLinkedProducts || hasProductsRequirement || ["linkedProducts", "policy", "other", "unclear", "missing"].includes(discountCategory);
    }

    if (fieldId === "discountConsequence") {
      return ["linkedProducts", "policy", "green", "other", "unclear", "missing"].includes(discountCategory);
    }

    if (fieldId === "greenDiscountRequirement") {
      return isGreenDiscountSelected(fields);
    }

    return true;
  };

  const getVisibleMortgagePiesFieldDefinitions = (fields = mortgagePiesFields) =>
    mortgagePiesFieldDefinitions.filter((field) => isMortgagePiesFieldVisible(field.id, fields));

  const getVisibleMortgagePiesFieldsForSection = (section: MortgagePiesSection, fields = mortgagePiesFields) =>
    section.fields.filter((field) => isMortgagePiesFieldVisible(field.id, fields));

  const getMortgagePiesEffectiveStatus = (fieldId: string, state: MortgagePiesFieldState, fields = mortgagePiesFields): MortgagePiesStatus => {
    if (fieldId === "rateLocked") {
      const rateTypeCategory = getMortgageRateTypeCategory(fields);
      const rateLockedValue = (fields.rateLocked?.value || "").toLowerCase();

      if (rateTypeCategory === "variable" || rateTypeCategory === "cap" || rateTypeCategory === "mixed") {
        return "found";
      }

      if (rateTypeCategory === "missing" || rateTypeCategory === "unclear" || rateTypeCategory === "unknown") {
        if (!rateLockedValue || rateLockedValue.includes("non applicabile") || rateLockedValue.includes("non trovato") || rateLockedValue.includes("non chiaro")) return "found";
      }
    }

    if (fieldId === "referenceIndex" || fieldId === "spread") {
      const rateTypeCategory = getMortgageRateTypeCategory(fields);
      if (rateTypeCategory === "fixed" || rateTypeCategory === "mixed" || rateTypeCategory === "missing" || rateTypeCategory === "unclear" || rateTypeCategory === "unknown") {
        return "found";
      }
    }

    if (["mixedChangeConditions", "mixedChangeAfterYears", "mixedChangeOutcome"].includes(fieldId)) {
      const rateTypeCategory = getMortgageRateTypeCategory(fields);
      if (rateTypeCategory !== "mixed") return "found";
    }

    if (fieldId === "capValue" || fieldId === "floorValue" || fieldId === "maxInstallmentAtCap") {
      const rateTypeCategory = getMortgageRateTypeCategory(fields);
      if (rateTypeCategory !== "cap") return "found";
    }

    if (fieldId === "greenDiscountRequirement") {
      if (!isGreenDiscountSelected(fields)) return "found";
    }

    if (fieldId === "discountConsequence") {
      const discountCategory = getMortgageDiscountCategory(fields);
      if (!["linkedProducts", "policy", "green", "other", "unclear", "missing"].includes(discountCategory)) return "found";
    }

    if (fieldId === "productsRequiredForRate" || fieldId === "linkedProductsDetails") {
      if (!isMortgagePiesFieldVisible(fieldId, fields)) return "found";
    }

    if (fieldId === "variableSimulation") {
      const rateTypeCategory = getMortgageRateTypeCategory(fields);
      const simulationValue = (fields.variableSimulation?.value || "").toLowerCase();

      if (rateTypeCategory === "fixed") {
        return "found";
      }

      if (rateTypeCategory === "cap") {
        if (simulationValue.includes("presenti per +1%") || simulationValue.includes("presente solo scenario al cap")) return "found";
        if (simulationValue.includes("incomplete") || simulationValue.includes("non chiaro")) return "unclear";
        return state.status;
      }

      if (rateTypeCategory === "mixed") {
        if (!simulationValue || simulationValue.includes("non presente") || simulationValue.includes("non trovato") || simulationValue.includes("non chiaro")) return "unclear";
        return state.status;
      }

      if (rateTypeCategory === "missing" || rateTypeCategory === "unclear" || rateTypeCategory === "unknown") {
        if (!simulationValue || simulationValue.includes("non presente") || simulationValue.includes("non trovato") || simulationValue.includes("non chiaro")) return "found";
      }
    }

    if (fieldId === "policyChoiceFreedom") {
      const obligationValue = (fields.policiesObligation?.value || "").toLowerCase();
      if (obligationValue.includes("nessuna polizza")) return "found";
    }

    if (fieldId === "policyCost" && isPolicyCostSoftFound(fields)) {
      return "found";
    }

    if (fieldId === "policyCostAmount") {
      const obligationValue = (fields.policiesObligation?.value || "").toLowerCase();
      const costValue = (fields.policyCost?.value || "").toLowerCase();
      if (obligationValue.includes("nessuna polizza") || costValue.includes("non ci sono polizze") || isPolicyCostSoftFound(fields)) return "found";
    }

    if (fieldId === "earlyRepayment") {
      const value = (fields.earlyRepayment?.value || "").toLowerCase();
      if (value.includes("condizioni chiare") || value.includes("estinzione/surroga chiare")) return "found";
      if (value.includes("rimando generico") || value.includes("rimborso polizze non indicato") || value.includes("polizze collegate non chiare") || value.includes("non chiaro") || value.includes("non chiare")) return "unclear";
      if (value.includes("non trovato")) return "missing";
    }

    return state.status;
  };

  const updateMortgagePiesSelectValue = (fieldId: string, value: string) => {
    setMortgagePiesFields((prev) => {
      const normalized = value.toLowerCase();
      const baseStatus: MortgagePiesStatus = !value
        ? "missing"
        : normalized.includes("non trovato") || normalized.includes("non presente") || normalized.includes("non indicato") || normalized.includes("costo non indicato")
        ? "missing"
        : normalized.includes("non chiaro") || normalized.includes("non chiare") || normalized.includes("non chiara") || normalized.includes("incomplete") || normalized.includes("rimando generico") || normalized.includes("non dettagliate")
        ? "unclear"
        : "found";

      const current = prev[fieldId] ?? { status: "missing" as MortgagePiesStatus, value: "", notes: "" };
      const nextFields = {
        ...prev,
        [fieldId]: {
          ...current,
          value,
          status: baseStatus,
        },
      };

      if (fieldId === "policyChoiceFreedom" && isPolicyCostSoftFound(nextFields)) {
        const currentPolicyCost = nextFields.policyCost ?? { status: "missing" as MortgagePiesStatus, value: "", notes: "" };
        nextFields.policyCost = { ...currentPolicyCost, status: "found" };
      }

      if (fieldId === "policyCost" && isPolicyCostSoftFound(nextFields)) {
        nextFields.policyCost = { ...nextFields.policyCost, status: "found" };
      }

      if (fieldId === "policiesObligation" && (value.toLowerCase().includes("nessuna polizza") || isPolicyCostSoftFound(nextFields))) {
        const currentFreedom = nextFields.policyChoiceFreedom ?? { status: "missing" as MortgagePiesStatus, value: "", notes: "" };
        const currentPolicyCost = nextFields.policyCost ?? { status: "missing" as MortgagePiesStatus, value: "", notes: "" };
        if (value.toLowerCase().includes("nessuna polizza")) {
          const currentPolicyCostAmount = nextFields.policyCostAmount ?? { status: "missing" as MortgagePiesStatus, value: "", notes: "" };
          nextFields.policyChoiceFreedom = { ...currentFreedom, value: currentFreedom.value || "Non ci sono polizze", status: "found" };
          nextFields.policyCost = { ...currentPolicyCost, value: currentPolicyCost.value || "Non ci sono polizze", status: "found" };
          nextFields.policyCostAmount = { ...currentPolicyCostAmount, value: currentPolicyCostAmount.value || "", status: "found" };
        } else if (isPolicyCostSoftFound(nextFields)) {
          nextFields.policyCost = { ...currentPolicyCost, status: "found" };
        }
      }

      return nextFields;
    });
  };

  const getMortgageRateLockInfo = () => {
    const rateTypeCategory = getMortgageRateTypeCategory();

    if (rateTypeCategory === "fixed") {
      return "Per un mutuo a tasso fisso questo controllo è importante: verifica se tasso e condizioni restano validi fino alla stipula o fino a una data precisa.";
    }

    if (rateTypeCategory === "variable") {
      return "Per un mutuo a tasso variabile la data di blocco del tasso di solito non è applicabile. Contano soprattutto parametro di riferimento, spread, periodicità di aggiornamento e simulazioni di aumento rata.";
    }

    if (rateTypeCategory === "cap") {
      return "Per un variabile con cap il punto centrale non è il blocco del tasso, ma capire valore del cap, eventuale floor e rata massima stimata.";
    }

    if (rateTypeCategory === "mixed") {
      return "Per un tasso misto è più utile chiarire quando può cambiare il tasso, se il passaggio è automatico o facoltativo e quali condizioni si applicano dopo il cambio.";
    }

    return "Se non è chiaro il tipo di tasso, prima chiedi conferma se il mutuo è fisso, variabile, misto o variabile con cap.";
  };

  const getMortgageRateSimulationInfo = () => {
    const rateTypeCategory = getMortgageRateTypeCategory();

    if (rateTypeCategory === "fixed") {
      return "Per un mutuo a tasso fisso la simulazione di aumento rata non è essenziale: il controllo importante è verificare che tasso e condizioni siano bloccati fino alla stipula.";
    }

    if (rateTypeCategory === "variable") {
      return "Per un mutuo variabile la simulazione di aumento rata è importante: aiuta a capire quanto potrebbe salire la rata in scenari +1%, +2% e +3%.";
    }

    if (rateTypeCategory === "cap") {
      return "Per un variabile con cap serve capire la rata nello scenario peggiore: valore del cap, eventuale floor e rata massima stimata.";
    }

    if (rateTypeCategory === "mixed") {
      return "Per un tasso misto il punto principale è capire quando il tasso può cambiare, se il passaggio è automatico o facoltativo e quali condizioni si applicano dopo il cambio.";
    }

    return "Prima di valutare le simulazioni, chiarisci se il mutuo è fisso, variabile, misto o variabile con cap.";
  };

  const getMortgagePiesIssueCopy = (field: MortgagePiesFieldDefinition, status?: MortgagePiesStatus) => {
    if (field.id === "rateLocked") {
      const rateTypeCategory = getMortgageRateTypeCategory();

      if (rateTypeCategory === "variable" || rateTypeCategory === "cap" || rateTypeCategory === "mixed") {
        return {
          issue: "Blocco tasso non applicabile al tipo di tasso selezionato",
          why: getMortgageRateLockInfo(),
          question: rateTypeCategory === "variable"
            ? "Potete confermarmi parametro di riferimento, spread, periodicità di aggiornamento e simulazioni della rata in caso di aumento dei tassi?"
            : rateTypeCategory === "cap"
            ? "Potete confermarmi valore del cap, eventuale floor e rata massima stimata?"
            : "Potete confermarmi quando il tasso può cambiare e con quali condizioni?",
        };
      }
    }

    if (field.id === "referenceIndex" || field.id === "spread") {
      return {
        issue: field.issue,
        why: field.why,
        question: "Potete confermarmi parametro di riferimento, spread e periodicità di aggiornamento del tasso variabile?",
      };
    }

    if (["mixedChangeConditions", "mixedChangeAfterYears", "mixedChangeOutcome"].includes(field.id)) {
      return {
        issue: field.issue,
        why: field.why,
        question: "Potete confermarmi dopo quanto tempo può cambiare il tasso, se il cambio è automatico o facoltativo, quale tasso si applica dopo il cambio e quali simulazioni di rata sono disponibili?",
      };
    }

    if (field.id === "discountConsequence") {
      return {
        issue: field.issue,
        why: field.why,
        question: "Potete confermarmi cosa accade al tasso o alle condizioni economiche se il requisito dello sconto non viene rispettato, chiuso o revocato?",
      };
    }

    if (field.id === "productsRequiredForRate" || field.id === "linkedProductsDetails") {
      if (mortgageHasLinkedDiscountBundle) {
        return {
          issue: "Pacchetto prodotti / requisiti commerciali non chiaro",
          why: "La proposta sembra collegare tasso, sconto o condizioni economiche a prodotti o requisiti commerciali. L'utente deve capire quali elementi sono necessari, quali costi hanno e cosa succede se non vengono mantenuti.",
          question: "Potete confermarmi quali prodotti o requisiti commerciali sono necessari per ottenere o mantenere il tasso, quali costi hanno, se sono inclusi nel TAEG e cosa cambia se non li mantengo?",
        };
      }

      return {
        issue: field.issue,
        why: field.why,
        question: "Potete indicarmi quali prodotti o requisiti commerciali sono necessari per ottenere o mantenere il tasso, il costo di ciascuno e cosa cambia se non li mantengo?",
      };
    }

    if (field.id === "policyCost" || field.id === "policyCostAmount") {
      return {
        issue: "Costi delle polizze non chiari",
        why: "Il costo delle polizze serve per capire quanto pesa sul costo complessivo, se il premio viene pagato subito o finanziato e se rientra nel TAEG.",
        question: "Qual è il costo di ciascuna polizza? Il premio viene pagato subito o finanziato? Il costo è incluso nel TAEG?",
      };
    }

    if (field.id === "capValue" || field.id === "floorValue" || field.id === "maxInstallmentAtCap") {
      return {
        issue: field.issue,
        why: field.why,
        question: "Potete confermarmi valore del cap, eventuale floor, rata massima stimata al cap e modalità di applicazione di questi limiti?",
      };
    }

    if (field.id === "greenDiscountRequirement") {
      return {
        issue: field.issue,
        why: field.why,
        question: "Quale classe energetica e quale documentazione sono necessarie per ottenere e mantenere lo sconto Green? Cosa accade al tasso se il requisito non viene confermato o mantenuto?",
      };
    }

    if (field.id !== "variableSimulation") {
      return { issue: field.issue, why: field.why, question: field.question };
    }

    const rateTypeCategory = getMortgageRateTypeCategory();

    if (rateTypeCategory === "cap") {
      return {
        issue: "Scenario massimo del variabile con cap da chiarire",
        why: "Il cap limita il rischio massimo, ma l'utente deve sapere quale sarebbe la rata al raggiungimento del cap e se esiste un eventuale floor.",
        question: "Potete indicarmi il valore del cap, l'eventuale floor e la rata massima stimata al raggiungimento del cap?",
      };
    }

    if (rateTypeCategory === "mixed") {
      return {
        issue: "Condizioni del tasso misto da chiarire",
        why: "Nel tasso misto è importante capire quando può cambiare il tasso, se il passaggio è automatico o facoltativo e quali condizioni si applicano dopo il cambio.",
        question: "Potete confermarmi dopo quanto tempo può cambiare il tasso, se il passaggio è automatico o facoltativo, quale tasso si applica dopo il cambio e quali simulazioni di rata sono disponibili?",
      };
    }

    if (rateTypeCategory === "fixed") {
      return {
        issue: "Simulazioni non essenziali per tasso fisso",
        why: "Per un mutuo a tasso fisso la rata non varia per effetto dei tassi. Conta soprattutto verificare che le condizioni siano bloccate fino alla stipula.",
        question: "Potete confermarmi che il tasso fisso e le condizioni indicate restano valide fino alla stipula?",
      };
    }

    if (rateTypeCategory === "missing" || rateTypeCategory === "unclear" || rateTypeCategory === "unknown") {
      return {
        issue: "Prima chiarire il tipo di tasso",
        why: "Prima di valutare le simulazioni serve capire se il mutuo è fisso, variabile, misto o variabile con cap.",
        question: "Potete confermarmi se il mutuo è a tasso fisso, variabile, misto o variabile con cap?",
      };
    }

    return { issue: field.issue, why: field.why, question: field.question };
  };

  const resetMortgagePiesCheck = () => {
    setMortgagePiesFields(getDefaultMortgagePiesFields());
    setOpenMortgagePiesSectionId(mortgagePiesSections[0]?.id ?? "");
  };

  const scrollToMortgagePiesSection = (sectionId: string) => {
    if (!sectionId || typeof window === "undefined") return;

    window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        const sectionElement = mortgagePiesSectionRefs.current[sectionId];
        if (!sectionElement) return;

        const topOffset = 88;
        const top = sectionElement.getBoundingClientRect().top + window.scrollY - topOffset;
        window.scrollTo({ top: Math.max(top, 0), behavior: "smooth" });
      }, 40);
    });
  };

  const toggleMortgagePiesSection = (sectionId: string, isOpen: boolean) => {
    const nextSectionId = isOpen ? "" : sectionId;
    setOpenMortgagePiesSectionId(nextSectionId);

    if (!isOpen) {
      scrollToMortgagePiesSection(sectionId);
    }
  };

  const getMortgagePiesBundleValue = (fieldId: string, fields = mortgagePiesFields) => (fields[fieldId]?.value ?? "").toLowerCase();

  const getMortgageHasLinkedDiscountBundle = (fields = mortgagePiesFields) => {
    const discountConditionsValue = getMortgagePiesBundleValue("discountConditions", fields);
    const linkedProductsValue = getMortgagePiesBundleValue("linkedProducts", fields);
    const productsRequiredValue = getMortgagePiesBundleValue("productsRequiredForRate", fields);
    const policyFreedomValue = getMortgagePiesBundleValue("policyChoiceFreedom", fields);

    return (
      discountConditionsValue.includes("sconto collegato a polizze") ||
      discountConditionsValue.includes("sconto collegato a conto") ||
      discountConditionsValue.includes("prodotti bancari") ||
      discountConditionsValue.includes("requisiti commerciali") ||
      discountConditionsValue.includes("condizioni non chiare") ||
      discountConditionsValue.includes("non chiaro")
    ) && (
      linkedProductsValue.includes("necessari per ottenere il tasso") ||
      linkedProductsValue.includes("costi non chiari") ||
      linkedProductsValue.includes("non chiaro") ||
      productsRequiredValue.includes("conto") ||
      productsRequiredValue.includes("accredito") ||
      productsRequiredValue.includes("carta") ||
      productsRequiredValue.includes("polizze") ||
      productsRequiredValue.includes("più prodotti") ||
      productsRequiredValue.includes("requisiti commerciali") ||
      policyFreedomValue.includes("vincolata dalla banca") ||
      policyFreedomValue.includes("non chiaro")
    );
  };

  const mortgageHasLinkedDiscountBundle = getMortgageHasLinkedDiscountBundle();

  const visibleMortgagePiesFieldDefinitions = getVisibleMortgagePiesFieldDefinitions();

  const mortgagePiesIssues = visibleMortgagePiesFieldDefinitions
    .map((field) => {
      const state = mortgagePiesFields[field.id] ?? { status: "missing" as MortgagePiesStatus, value: "", notes: "" };
      return { field, state: { ...state, status: getMortgagePiesEffectiveStatus(field.id, state) } };
    })
    .filter((item) => {
      if (item.state.status === "found") return false;

      // Evita di mostrare due volte lo stesso dubbio: se il campo "costo polizze"
      // è già da chiarire, non aggiungiamo anche "importo polizze" come criticità separata.
      if (item.field.id === "policyCostAmount") {
        const policyCostState = mortgagePiesFields.policyCost ?? { status: "missing" as MortgagePiesStatus, value: "", notes: "" };
        return getMortgagePiesEffectiveStatus("policyCost", policyCostState) === "found";
      }

      // Nei casi con pacchetto promozionale, evita di mostrare nel report tanti punti separati
      // che fanno riferimento allo stesso tema. La mail e il report usano una richiesta accorpata.
      if (
        mortgageHasLinkedDiscountBundle &&
        ["linkedProductsDetails", "discountConditions", "discountConsequence"].includes(item.field.id)
      ) {
        return false;
      }

      return true;
    })
    .sort((a, b) => {
      const sectionIndexA = mortgagePiesSections.findIndex((section) => section.fields.some((field) => field.id === a.field.id));
      const sectionIndexB = mortgagePiesSections.findIndex((section) => section.fields.some((field) => field.id === b.field.id));
      if (sectionIndexA !== sectionIndexB) return sectionIndexA - sectionIndexB;
      return b.field.penalty - a.field.penalty;
    });
  const mortgagePiesFound = visibleMortgagePiesFieldDefinitions
    .map((field) => {
      const state = mortgagePiesFields[field.id] ?? { status: "missing" as MortgagePiesStatus, value: "", notes: "" };
      return { field, state: { ...state, status: getMortgagePiesEffectiveStatus(field.id, state) } };
    })
    .filter((item) => item.state.status === "found");
  const mortgagePiesTotalWeight = visibleMortgagePiesFieldDefinitions.reduce((sum, field) => sum + field.penalty, 0);
  const mortgagePiesFoundWeight = mortgagePiesFound.reduce((sum, item) => sum + item.field.penalty, 0);
  const mortgageClarityScore = mortgagePiesTotalWeight > 0 ? Math.round((mortgagePiesFoundWeight / mortgagePiesTotalWeight) * 100) : 0;
  const mortgageClarityBand = mortgageClarityScore >= 80 ? "chiaro" : mortgageClarityScore >= 60 ? "da_chiarire" : mortgageClarityScore >= 40 ? "attenzione" : "confuso";
  const mortgageClarityCopy = mortgageClarityBand === "chiaro"
    ? {
        label: "Mutuo abbastanza chiaro",
        message: "Le informazioni principali sono presenti. Restano comunque da verificare le condizioni definitive prima della firma.",
        className: "border-emerald-200 bg-emerald-50 text-emerald-900",
      }
    : mortgageClarityBand === "da_chiarire"
    ? {
        label: "Alcuni punti da chiarire",
        message: "La proposta è leggibile, ma ci sono elementi da confermare per iscritto prima di procedere.",
        className: "border-amber-200 bg-amber-50 text-amber-900",
      }
    : mortgageClarityBand === "attenzione"
    ? {
        label: "Dati importanti mancanti",
        message: "Mancano o non sono chiari dati che possono incidere su costo, rata o vincoli del mutuo.",
        className: "border-orange-200 bg-orange-50 text-orange-900",
      }
    : {
        label: "Alto rischio di confusione",
        message: "La documentazione è troppo incompleta o ambigua. Non firmare senza chiarimenti scritti sui punti critici.",
        className: "border-red-200 bg-red-50 text-red-900",
      };
  const mortgagePiesRawValue = (fieldId: string) => (mortgagePiesFields[fieldId]?.value ?? "").trim();
  const parseMortgageLooseNumber = (value: string) => {
    const cleaned = value
      .replace(/\s/g, "")
      .replace(/€/g, "")
      .replace(/%/g, "")
      .replace(/\./g, "")
      .replace(/,/g, ".");

    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const mortgagePiesTanNumberForAttention = parseMortgageLooseNumber(mortgagePiesRawValue("tan"));
  const mortgagePiesTaegNumberForAttention = parseMortgageLooseNumber(mortgagePiesRawValue("taeg"));
  const mortgageTaegTanDifference = mortgagePiesTaegNumberForAttention > 0 && mortgagePiesTanNumberForAttention > 0
    ? mortgagePiesTaegNumberForAttention - mortgagePiesTanNumberForAttention
    : 0;
  const mortgagePiesAmountNumberForAttention = parseMortgageLooseNumber(mortgagePiesRawValue("amount"));
  const mortgagePolicyCostAmountNumber = parseMortgageLooseNumber(mortgagePiesRawValue("policyCostAmount"));
  const mortgagePolicyCostRatio = mortgagePiesAmountNumberForAttention > 0 && mortgagePolicyCostAmountNumber > 0
    ? mortgagePolicyCostAmountNumber / mortgagePiesAmountNumberForAttention
    : 0;
  const mortgagePolicyCostValue = mortgagePiesRawValue("policyCost").toLowerCase();
  const mortgagePolicyPremiumIsFinanced = mortgagePolicyCostValue.includes("finanziato");
  const mortgagePolicyFreedomValue = mortgagePiesRawValue("policyChoiceFreedom").toLowerCase();
  const mortgageLinkedProductsValue = mortgagePiesRawValue("linkedProducts").toLowerCase();
  const mortgageDiscountConditionsValue = mortgagePiesRawValue("discountConditions").toLowerCase();
  const mortgageProductsRequiredValue = mortgagePiesRawValue("productsRequiredForRate").toLowerCase();
  const mortgageLinkedProductsDetailsValue = mortgagePiesRawValue("linkedProductsDetails");
  const mortgageDiscountConsequenceValue = mortgagePiesRawValue("discountConsequence").toLowerCase();
  const mortgageRateTypeCategoryForAttention = getMortgageRateTypeCategory();
  const mortgageCapValueForAttention = mortgagePiesRawValue("capValue");
  const mortgageFloorValueForAttention = mortgagePiesRawValue("floorValue");
  const mortgageMaxInstallmentAtCapNumber = parseMortgageLooseNumber(mortgagePiesRawValue("maxInstallmentAtCap"));
  const mortgageReferenceIndexValue = mortgagePiesRawValue("referenceIndex");
  const mortgageSpreadValue = mortgagePiesRawValue("spread");
  const mortgageGreenRequirementValue = mortgagePiesRawValue("greenDiscountRequirement");
  const mortgageHasGreenDiscount = isGreenDiscountSelected();
  const mortgageEarlyRepaymentValue = mortgagePiesRawValue("earlyRepayment").toLowerCase();
  const mortgageEarlyRepaymentHasRefund = mortgageEarlyRepaymentValue.includes("rimborso") && (mortgageEarlyRepaymentValue.includes("premio") || mortgageEarlyRepaymentValue.includes("polizza") || mortgageEarlyRepaymentValue.includes("non godut"));

  const mortgageEconomicAttentionFlags = [
    ...(mortgageRateTypeCategoryForAttention === "mixed" ? [{
      id: "mixed_rate_structure",
      sectionId: "rate-costs",
      area: "tasso" as const,
      severity: "Media" as const,
      title: "Tasso misto da comprendere bene",
      why: "Il tasso misto può cambiare dopo un periodo iniziale. È importante capire quando cambia, se il cambio è automatico o facoltativo e quali condizioni si applicano dopo il cambio.",
      question: "Potete confermarmi dopo quanto tempo può cambiare il tasso, se il cambio è automatico o facoltativo, quale tasso si applica dopo il cambio e quali simulazioni di rata sono disponibili?",
    }] : []),
    ...(mortgageRateTypeCategoryForAttention === "cap" && mortgageCapValueForAttention && mortgageFloorValueForAttention ? [{
      id: "cap_floor_structure",
      sectionId: "rate-costs",
      area: "tasso" as const,
      severity: "Media" as const,
      title: "Variabile con cap e floor da comprendere",
      why: `Il cap limita il tasso massimo${mortgageCapValueForAttention ? ` (${mortgageCapValueForAttention})` : ""}, mentre il floor indica un tasso minimo${mortgageFloorValueForAttention ? ` (${mortgageFloorValueForAttention})` : ""}. Questa struttura può rendere il rischio più controllato in alto, ma limita il beneficio se i tassi scendono molto.${mortgageMaxInstallmentAtCapNumber > 0 ? ` La rata massima stimata inserita è circa ${formatEuro(mortgageMaxInstallmentAtCapNumber)}.` : ""}`,
      question: mortgageMaxInstallmentAtCapNumber > 0
        ? `Potete confermarmi come vengono applicati cap e floor, se il floor limita il beneficio in caso di discesa dei tassi e se la rata massima stimata indicata, pari a circa ${formatEuro(mortgageMaxInstallmentAtCapNumber)}, è riferita allo scenario al cap?`
        : "Potete confermarmi come vengono applicati cap e floor, se il floor limita il beneficio in caso di discesa dei tassi e qual è la rata massima stimata nello scenario al cap?",
    }] : []),
    ...(mortgageHasGreenDiscount ? [{
      id: "green_discount_condition",
      sectionId: "policies-products",
      area: "polizze" as const,
      severity: "Media" as const,
      title: "Sconto Green collegato alla classe energetica",
      why: `Lo sconto sembra dipendere da un requisito energetico${mortgageGreenRequirementValue ? `: ${mortgageGreenRequirementValue}` : ""}. È utile verificare quale documentazione serve, entro quando va consegnata e cosa succede se il requisito non viene confermato o mantenuto.`,
      question: "Quale documentazione energetica è necessaria per ottenere e mantenere lo sconto Green? Cosa accade al tasso o alle condizioni se il requisito non viene confermato o mantenuto?",
    }] : []),
    ...((mortgageProductsRequiredValue.includes("conto") || mortgageProductsRequiredValue.includes("accredito") || mortgageProductsRequiredValue.includes("carta") || mortgageProductsRequiredValue.includes("polizze") || mortgageProductsRequiredValue.includes("più prodotti") || mortgageProductsRequiredValue.includes("requisiti commerciali") || mortgageDiscountConditionsValue.includes("requisiti commerciali")) ? [{
      id: "commercial_requirements_condition",
      sectionId: "policies-products",
      area: "polizze" as const,
      severity: (mortgageDiscountConditionsValue.includes("requisiti commerciali") || mortgageDiscountConditionsValue.includes("condizioni non chiare") || mortgageDiscountConditionsValue.includes("sconto collegato")) ? "Alta" as const : "Media" as const,
      title: "Requisiti commerciali collegati al tasso",
      why: `Il tasso o lo sconto sembrano dipendere da prodotti o requisiti commerciali${mortgageLinkedProductsDetailsValue ? `: ${mortgageLinkedProductsDetailsValue}` : ""}. È utile capire quali costi comportano e cosa succede se non vengono mantenuti.`,
      question: "Potete confermarmi quali prodotti o requisiti commerciali sono necessari per ottenere o mantenere il tasso, il costo di ciascuno e cosa cambia se non li mantengo?",
    }] : []),
    ...(mortgageTaegTanDifference > 0.8 ? [{
      id: "taeg_tan_high_gap",
      sectionId: "rate-costs",
      area: "costo" as const,
      severity: "Alta" as const,
      title: "TAEG sensibilmente superiore al TAN",
      why: `Il TAEG supera il TAN di circa ${mortgageTaegTanDifference.toFixed(2).replace(".", ",")} punti percentuali. Questo non indica automaticamente un problema, ma segnala costi accessori rilevanti da comprendere prima della firma.`,
      question: "Potete dettagliare quali costi, polizze e spese sono inclusi nel TAEG e quali restano eventualmente esclusi?",
    }] : mortgageTaegTanDifference > 0.3 ? [{
      id: "taeg_tan_medium_gap",
      sectionId: "rate-costs",
      area: "costo" as const,
      severity: "Media" as const,
      title: "TAEG superiore al TAN: da controllare",
      why: `Il TAEG supera il TAN di circa ${mortgageTaegTanDifference.toFixed(2).replace(".", ",")} punti percentuali. La differenza può dipendere da spese o prodotti collegati: va capita per confrontare correttamente l'offerta.`,
      question: "Potete indicarmi in modo sintetico quali costi spiegano la differenza tra TAN e TAEG?",
    }] : []),
    ...(mortgagePolicyCostAmountNumber >= 5000 || mortgagePolicyCostRatio >= 0.03 ? [{
      id: "policy_cost_high",
      sectionId: "policies-products",
      area: "polizze" as const,
      severity: "Alta" as const,
      title: mortgagePolicyPremiumIsFinanced ? "Premio assicurativo finanziato da valutare" : "Polizza di importo rilevante",
      why: mortgagePolicyPremiumIsFinanced
        ? `Nel PIES risulta una polizza di circa ${formatEuro(mortgagePolicyCostAmountNumber)}${mortgagePolicyCostRatio > 0 ? `, pari a circa ${(mortgagePolicyCostRatio * 100).toFixed(1).replace(".", ",")}% dell'importo del mutuo` : ""}. Il premio risulta finanziato nel piano di rimborso: questo può generare interessi per tutta la durata se non viene rimborsato anticipatamente.`
        : `Nel PIES risulta una polizza di circa ${formatEuro(mortgagePolicyCostAmountNumber)}${mortgagePolicyCostRatio > 0 ? `, pari a circa ${(mortgagePolicyCostRatio * 100).toFixed(1).replace(".", ",")}% dell'importo del mutuo` : ""}. Non è automaticamente un problema, ma è un costo importante da verificare.`,
      question: mortgagePolicyPremiumIsFinanced
        ? mortgageEarlyRepaymentHasRefund
          ? "Potete indicarmi il costo complessivo stimato degli interessi generati dal premio assicurativo finanziato e le modalità operative per richiedere il rimborso della quota non goduta già indicato in caso di estinzione anticipata o surroga?"
          : "Potete confermarmi che il premio della polizza è finanziato nel piano di rimborso, che è incluso nel TAEG, quali interessi può generare nel tempo e come funziona il rimborso della quota non goduta in caso di estinzione anticipata o surroga?"
        : "Potete confermarmi se la polizza è facoltativa, se il premio viene finanziato, se è incluso nel TAEG e cosa succede in caso di recesso, estinzione anticipata o surroga?",
    }] : mortgagePolicyCostAmountNumber >= 2000 || mortgagePolicyCostRatio >= 0.015 ? [{
      id: "policy_cost_medium",
      sectionId: "policies-products",
      area: "polizze" as const,
      severity: "Media" as const,
      title: mortgagePolicyPremiumIsFinanced ? "Premio assicurativo finanziato da capire" : "Costo polizza da valutare",
      why: mortgagePolicyPremiumIsFinanced
        ? `Nel PIES risulta una polizza di circa ${formatEuro(mortgagePolicyCostAmountNumber)} finanziata nel piano di rimborso. È utile capire quanto incide nel tempo e se il costo è incluso nel TAEG.`
        : `Nel PIES risulta una polizza di circa ${formatEuro(mortgagePolicyCostAmountNumber)}. È utile capire se è obbligatoria, facoltativa o collegata a condizioni economiche della proposta.`,
      question: mortgagePolicyPremiumIsFinanced
        ? mortgageEarlyRepaymentHasRefund
          ? "Potete indicarmi il costo complessivo stimato degli interessi generati dal premio finanziato e le modalità operative per richiedere il rimborso della quota non goduta già indicato in caso di estinzione o surroga?"
          : "Potete confermarmi se il premio finanziato è incluso nel TAEG, quali interessi può generare e come funziona il rimborso della quota non goduta in caso di estinzione o surroga?"
        : "Potete confermarmi il ruolo della polizza nella proposta, se il costo è incluso nel TAEG e se posso scegliere una compagnia esterna senza modifiche al tasso?",
    }] : []),
    ...(mortgagePolicyCostValue.includes("inclusione nel taeg non chiara") ? [{
      id: "policy_taeg_unclear",
      sectionId: "policies-products",
      area: "polizze" as const,
      severity: "Media" as const,
      title: "Inclusione della polizza nel TAEG non chiara",
      why: "Quando una polizza incide sul costo, è importante sapere se il suo premio è incluso nel TAEG e se viene finanziato.",
      question: "Potete confermarmi se il costo della polizza è incluso integralmente nel TAEG e se il premio viene finanziato nel mutuo?",
    }] : []),
    ...(mortgagePolicyCostValue.includes("non incluso nel taeg") ? [{
      id: "policy_not_in_taeg",
      sectionId: "policies-products",
      area: "polizze" as const,
      severity: "Media" as const,
      title: "Costo polizza indicato come non incluso nel TAEG",
      why: "Un costo non incluso nel TAEG può rendere meno immediato il confronto tra offerte. Va considerato separatamente nel costo complessivo.",
      question: "Potete confermarmi quali costi assicurativi non sono inclusi nel TAEG e come devo considerarli nel costo complessivo dell'operazione?",
    }] : []),
    ...(mortgagePolicyFreedomValue.includes("vincolata dalla banca") ? [{
      id: "policy_bank_bound",
      sectionId: "policies-products",
      area: "polizze" as const,
      severity: "Alta" as const,
      title: "Libertà di scelta della polizza da verificare",
      why: "Se la polizza è proposta o vincolata dalla banca, può incidere su costo, flessibilità e possibilità di confronto con compagnie esterne.",
      question: "Potete confermarmi se posso sottoscrivere una polizza equivalente presso una compagnia esterna senza modifiche al tasso o alle condizioni economiche?",
    }] : []),
    ...(mortgageDiscountConditionsValue.includes("sconto collegato a polizze") || mortgageDiscountConditionsValue.includes("sconto collegato a conto") ? [{
      id: "discount_linked_products",
      sectionId: "policies-products",
      area: "polizze" as const,
      severity: "Alta" as const,
      title: "Sconto sul tasso collegato a prodotti o polizze",
      why: "Uno sconto collegato a prodotti o polizze va capito bene: l'utente deve sapere cosa cambia se non sottoscrive, chiude o recede dai prodotti collegati.",
      question: "Da quali prodotti o polizze dipende lo sconto sul tasso? Cosa accade al TAN, al TAEG o alle altre condizioni se non sottoscrivo o se recedo?",
    }] : mortgageDiscountConditionsValue.includes("sconto collegato ad altre condizioni") ? [{
      id: "discount_other_conditions",
      sectionId: "policies-products",
      area: "polizze" as const,
      severity: "Media" as const,
      title: "Sconto collegato a condizioni da verificare",
      why: "Quando uno sconto dipende da condizioni specifiche, conviene capire bene quali requisiti vanno rispettati e cosa cambia se vengono meno.",
      question: "Da quali condizioni dipende lo sconto sul tasso e cosa accade se tali condizioni non vengono rispettate o mantenute?",
    }] : []),
    ...(mortgageLinkedProductsValue.includes("necessari per ottenere il tasso") || mortgageLinkedProductsValue.includes("costi non chiari") ? [{
      id: "linked_products_conditions",
      sectionId: "policies-products",
      area: "polizze" as const,
      severity: (mortgageLinkedProductsValue.includes("necessari per ottenere il tasso") || mortgageDiscountConditionsValue.includes("requisiti commerciali") || mortgageDiscountConditionsValue.includes("condizioni non chiare")) ? "Alta" as const : "Media" as const,
      title: "Prodotti collegati da verificare",
      why: "Prodotti collegati a condizioni promozionali possono incidere sul costo reale o sui vincoli nel tempo, anche quando non sono formalmente obbligatori.",
      question: "Quali prodotti collegati sono necessari per mantenere le condizioni indicate? Quali costi cambiano se non li apro o se li chiudo?",
    }] : []),
  ];


  const getMortgageAreaStatus = (area: MortgagePiesFieldDefinition["area"]) => {
    const areaItems = visibleMortgagePiesFieldDefinitions.filter((field) => field.area === area);
    const issueCount = areaItems.filter((field) => {
      const state = mortgagePiesFields[field.id] ?? { status: "missing" as MortgagePiesStatus, value: "", notes: "" };
      return getMortgagePiesEffectiveStatus(field.id, state) !== "found";
    }).length;
    const unclearCount = areaItems.filter((field) => {
      const state = mortgagePiesFields[field.id] ?? { status: "missing" as MortgagePiesStatus, value: "", notes: "" };
      return getMortgagePiesEffectiveStatus(field.id, state) === "unclear";
    }).length;
    const areaEconomicFlags = mortgageEconomicAttentionFlags.filter((flag) => flag.area === area);
    if (issueCount === 0 && areaEconomicFlags.length === 0) return { label: "Chiaro", className: "border-emerald-200 bg-emerald-50 text-emerald-800" };
    if (issueCount === 0 && areaEconomicFlags.length > 0) {
      const hasHighEconomicFlag = areaEconomicFlags.some((flag) => flag.severity === "Alta");
      return hasHighEconomicFlag
        ? { label: "Da verificare", className: "border-orange-200 bg-orange-50 text-orange-800" }
        : { label: "Da controllare", className: "border-amber-200 bg-amber-50 text-amber-800" };
    }
    if (issueCount >= Math.max(2, areaItems.length) || unclearCount > 0) return { label: "Non chiaro", className: "border-red-200 bg-red-50 text-red-800" };
    return { label: "Da controllare", className: "border-amber-200 bg-amber-50 text-amber-800" };
  };

  const mortgageAreaCards = [
    { label: "Costo reale", status: getMortgageAreaStatus("costo") },
    { label: "Tasso e rata", status: getMortgageAreaStatus("tasso") },
    { label: "Polizze e prodotti", status: getMortgageAreaStatus("polizze") },
    { label: "Ammortamento", status: getMortgageAreaStatus("ammortamento") },
    { label: "Estinzione e surroga", status: getMortgageAreaStatus("uscita") },
  ];

  const mortgageEmailSections = mortgagePiesSections
    .map((section) => {
      const issues = section.fields
        .map((field) => {
          const state = mortgagePiesFields[field.id] ?? { status: "missing" as MortgagePiesStatus, value: "", notes: "" };
          return { field, state: { ...state, status: getMortgagePiesEffectiveStatus(field.id, state) } };
        })
        .filter((item) => item.state.status !== "found");

      return { section, issues };
    })
    .filter((item) => item.issues.length > 0);

  const mortgageLinkedDiscountEmailQuestions = mortgageHasLinkedDiscountBundle
    ? [
        {
          question: "Potete confermarmi quali prodotti, polizze o requisiti commerciali sono necessari per ottenere e mantenere il TAN promozionale, inclusi eventuali conto corrente, accredito stipendio, carte o altri prodotti collegati?",
          type: "Richiesta riepilogo condizioni promozionali",
        },
        {
          question: "Potete confermarmi quali di questi elementi sono obbligatori, quali sono facoltativi, quali costi ricorrenti hanno e se tali costi sono inclusi nel TAEG?",
          type: "Richiesta costi prodotti collegati",
        },
        {
          question: "Se non sottoscrivo, chiudo o recedo da uno di questi prodotti o requisiti, cosa accade al TAN, allo sconto o alle altre condizioni economiche? Se sono previste polizze collegate, posso sottoscrivere una copertura equivalente presso una compagnia esterna senza perdere lo sconto?",
          type: "Richiesta conseguenze e libertà di scelta",
        },
      ]
    : [];

  const mortgageEconomicAttentionFlagsForEmail = mortgageEconomicAttentionFlags.filter((flag) => {
    // Il report può mostrare anche segnali educativi; la mail alla banca deve invece restare operativa
    // e contenere solo richieste realmente necessarie, non domande ridondanti su dati già inseriti.
    switch (flag.id) {
      case "cap_floor_structure":
        return mortgageMaxInstallmentAtCapNumber <= 0;
      case "taeg_tan_medium_gap":
        return false;
      case "green_discount_condition":
        return !mortgageGreenRequirementValue;
      case "policy_cost_medium":
        return false;
      case "policy_bank_bound":
      case "discount_linked_products":
      case "linked_products_conditions":
      case "commercial_requirements_condition":
        return !mortgageHasLinkedDiscountBundle;
      default:
        return true;
    }
  });

  const mortgageCombinedEmailSections = mortgagePiesSections
    .map((section) => {
      const documentQuestions = section.fields
        .map((field) => {
          if (
            mortgageHasLinkedDiscountBundle &&
            section.id === "policies-products" &&
            ["policyChoiceFreedom", "policyCost", "policyCostAmount", "linkedProducts", "productsRequiredForRate", "linkedProductsDetails", "discountConditions", "discountConsequence"].includes(field.id)
          ) {
            return null;
          }

          // Evita domande duplicate: se "costo polizze" è già mancante/non chiaro,
          // non chiediamo anche l'importo polizze con una seconda domanda quasi identica.
          if (field.id === "policyCostAmount") {
            const policyCostState = mortgagePiesFields.policyCost ?? { status: "missing" as MortgagePiesStatus, value: "", notes: "" };
            if (getMortgagePiesEffectiveStatus("policyCost", policyCostState) !== "found") return null;
          }

          const state = mortgagePiesFields[field.id] ?? { status: "missing" as MortgagePiesStatus, value: "", notes: "" };
          const effectiveStatus = getMortgagePiesEffectiveStatus(field.id, state);
          return effectiveStatus !== "found"
            ? { question: getMortgagePiesIssueCopy(field, effectiveStatus).question, type: effectiveStatus === "unclear" ? "Dato non chiaro" : "Dato non trovato" }
            : null;
        })
        .filter((item): item is { question: string; type: string } => Boolean(item));
      const economicQuestions = mortgageEconomicAttentionFlagsForEmail
        .filter((flag) => flag.sectionId === section.id)
        .map((flag) => ({ question: flag.question, type: `Segnale economico ${flag.severity.toLowerCase()}` }));
      const consolidatedQuestions = section.id === "policies-products" ? mortgageLinkedDiscountEmailQuestions : [];
      const questions = [...documentQuestions, ...consolidatedQuestions, ...economicQuestions].filter((item, index, array) =>
        array.findIndex((candidate) => candidate.question === item.question) === index
      );
      return { section, questions };
    })
    .filter((item) => item.questions.length > 0);

  const mortgageHasQuestionsForBank = mortgageCombinedEmailSections.length > 0;
  const mortgageHasRelevantReportIssues = mortgageHasQuestionsForBank || mortgageEconomicAttentionFlags.length > 0;

  const mortgageGeneratedEmail = !mortgageHasQuestionsForBank
    ? "Oggetto: Conferma condizioni proposta di mutuo\n\nBuongiorno,\nsto verificando la documentazione relativa alla proposta di mutuo. Al momento i dati principali risultano individuati.\n\nVi chiedo cortesemente di confermarmi che il PIES ricevuto e aggiornato alle condizioni definitive e che non ci sono ulteriori costi, polizze o prodotti obbligatori non indicati nella documentazione.\n\nGrazie.\nCordiali saluti"
    : `Oggetto: Richiesta chiarimenti su proposta di mutuo\n\nBuongiorno,\nsto verificando la documentazione relativa alla proposta di mutuo e avrei bisogno di chiarire alcuni punti prima di procedere.\n\nVi chiedo cortesemente di confermarmi per iscritto i seguenti chiarimenti, ordinati secondo le sezioni del PIES:\n\n${mortgageCombinedEmailSections.map(({ section, questions }, sectionIndex) => `${sectionIndex + 1}. ${section.title.replace(/^\d+\.\s*/, "")}\n${questions.map((item, issueIndex) => `   ${sectionIndex + 1}.${issueIndex + 1} ${item.question}`).join("\n")}`).join("\n\n")}\n\nLa richiesta è finalizzata esclusivamente a comprendere correttamente la proposta prima della firma.\n\nGrazie.\nCordiali saluti`;

  const mortgageRequestPiesEmail = "Oggetto: Richiesta PIES e documentazione mutuo\n\nBuongiorno,\nprima di procedere con la valutazione del mutuo, vi chiedo cortesemente di inviarmi il PIES aggiornato relativo alla proposta, insieme al piano di ammortamento e al prospetto completo delle condizioni economiche.\n\nVi chiedo inoltre di indicarmi eventuali polizze, prodotti collegati o condizioni necessarie per ottenere o mantenere il tasso proposto.\n\nGrazie.\nCordiali saluti";

  const getMortgagePiesValue = (fieldId: string) => (mortgagePiesFields[fieldId]?.value ?? "").trim();

  const parseMortgagePiesNumber = (value: string) => {
    const cleaned = value
      .replace(/\s/g, "")
      .replace(/€/g, "")
      .replace(/%/g, "")
      .replace(/\./g, "")
      .replace(/,/g, ".");

    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const formatMortgagePiesEuro = (value: string, options?: { decimals?: boolean }) => {
    const parsed = parseMortgagePiesNumber(value);
    if (!parsed) return "Da inserire";

    return new Intl.NumberFormat("it-IT", {
      style: "currency",
      currency: "EUR",
      minimumFractionDigits: options?.decimals ? 2 : 0,
      maximumFractionDigits: options?.decimals ? 2 : 0,
    }).format(parsed);
  };

  const formatMortgagePiesPercent = (value: string) => {
    const parsed = parseMortgagePiesNumber(value);
    if (!parsed) return "Da inserire";
    return `${new Intl.NumberFormat("it-IT", { maximumFractionDigits: 2 }).format(parsed)}%`;
  };

  const mortgagePiesAmountValue = getMortgagePiesValue("amount");
  const mortgagePiesDurationValue = getMortgagePiesValue("duration");
  const mortgagePiesInstallmentValue = getMortgagePiesValue("installment");
  const mortgagePiesTanValue = getMortgagePiesValue("tan");
  const mortgagePiesTotalToRepayValue = getMortgagePiesValue("totalToRepay");
  const mortgagePiesAmountNumber = parseMortgagePiesNumber(mortgagePiesAmountValue);
  const mortgagePiesTotalToRepayNumber = parseMortgagePiesNumber(mortgagePiesTotalToRepayValue);
  const mortgagePiesInterestAndCosts = mortgagePiesAmountNumber > 0 && mortgagePiesTotalToRepayNumber > 0
    ? mortgagePiesTotalToRepayNumber - mortgagePiesAmountNumber
    : 0;

  const mortgageMainNumbers = [
    { label: "Importo mutuo", value: formatMortgagePiesEuro(mortgagePiesAmountValue) },
    { label: "Durata", value: mortgagePiesDurationValue ? `${mortgagePiesDurationValue.replace(/\s*anni?$/i, "")} anni` : "Da inserire" },
    { label: "Rata mensile", value: formatMortgagePiesEuro(mortgagePiesInstallmentValue, { decimals: true }) },
    { label: "TAN / tasso", value: formatMortgagePiesPercent(mortgagePiesTanValue) },
    { label: "Totale da rimborsare", value: formatMortgagePiesEuro(mortgagePiesTotalToRepayValue) },
    { label: "Interessi e costi", value: mortgagePiesInterestAndCosts > 0 ? formatEuro(mortgagePiesInterestAndCosts) : "Da inserire" },
  ];

  const escapeReportHtml = (value: string | number) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");

  const openMortgagePdfReport = () => {
    if (typeof window === "undefined") return;

    const reportDate = new Date().toLocaleDateString("it-IT", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    });
    const reportOfferName = mortgageOfferName.trim() || "Preventivo mutuo senza nome";
    const reportLogoSvg = SOLDI_SEMPLICI_REPORT_LOGO_SVG;

    const scoreTone = mortgageClarityScore >= 80
      ? "good"
      : mortgageClarityScore >= 60
      ? "medium"
      : mortgageClarityScore >= 40
      ? "warning"
      : "risk";

    const issueCards = mortgageEmailSections.length
      ? mortgageEmailSections.map(({ section, issues }) => `
        <section class="report-section avoid-break">
          <div class="section-kicker">${escapeReportHtml(section.title.replace(/^\d+\.\s*/, ""))}</div>
          <div class="issue-list">
            ${issues.map((item) => `
              <article class="issue-card ${item.state.status === "unclear" ? "is-unclear" : "is-missing"}">
                <div class="issue-header">
                  <span class="status-pill ${item.state.status === "unclear" ? "pill-unclear" : "pill-missing"}">${item.state.status === "unclear" ? "Non chiaro" : "Non trovato"}</span>
                  <strong>${escapeReportHtml(getMortgagePiesIssueCopy(item.field, item.state.status).issue)}</strong>
                </div>
                <p>${escapeReportHtml(getMortgagePiesIssueCopy(item.field, item.state.status).why)}</p>
                <div class="question-box">${escapeReportHtml(getMortgagePiesIssueCopy(item.field, item.state.status).question)}</div>
              </article>
            `).join("")}
          </div>
        </section>
      `).join("")
      : `<div class="empty-state avoid-break"><strong>Nessuna criticità documentale rilevante.</strong><span>I dati principali controllati risultano segnati come trovati.</span></div>`;

    const economicAttentionCards = mortgageEconomicAttentionFlags.length
      ? mortgageEconomicAttentionFlags.map((flag) => `
        <article class="issue-card economic-card ${flag.severity === "Alta" ? "is-economic-high" : "is-economic-medium"}">
          <div class="issue-header">
            <span class="status-pill ${flag.severity === "Alta" ? "pill-economic-high" : "pill-economic-medium"}">${escapeReportHtml(flag.severity)}</span>
            <strong>${escapeReportHtml(flag.title)}</strong>
          </div>
          <p>${escapeReportHtml(flag.why)}</p>
          <div class="question-box">${escapeReportHtml(flag.question)}</div>
        </article>
      `).join("")
      : `<div class="empty-state avoid-break"><strong>Nessun segnale economico rilevante.</strong><span>Il documento può comunque essere confrontato con altre offerte prima della firma.</span></div>`;

    const foundItems = mortgagePiesFound.length
      ? mortgagePiesFound.map((item) => `
        <div class="data-chip">
          <span>${escapeReportHtml(item.field.label)}</span>
          ${item.state.value ? `<strong>${escapeReportHtml(item.state.value)}</strong>` : ""}
        </div>
      `).join("")
      : `<div class="empty-state"><strong>Nessun dato ancora segnato come trovato.</strong><span>Compila i blocchi PIES per far crescere l'indice di chiarezza.</span></div>`;

    const numberCards = mortgageMainNumbers.map((item) => `
      <div class="number-card">
        <span>${escapeReportHtml(item.label)}</span>
        <strong>${escapeReportHtml(item.value)}</strong>
      </div>
    `).join("");

    const areaCards = mortgageAreaCards.map((item) => {
      const normalized = item.status.label.toLowerCase();
      const areaTone = normalized.includes("chiaro") && !normalized.includes("non")
        ? "good"
        : normalized.includes("non")
        ? "risk"
        : "medium";
      return `
        <div class="area-card ${areaTone}">
          <span>${escapeReportHtml(item.label)}</span>
          <strong>${escapeReportHtml(item.status.label)}</strong>
        </div>
      `;
    }).join("");

    const html = `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <title>${escapeReportHtml(reportOfferName)} - Report verifica mutuo - Soldi Semplici</title>
  <style>
    :root {
      --ink: #0f172a;
      --muted: #64748b;
      --line: #e2e8f0;
      --soft: #f8fafc;
      --panel: #ffffff;
      --brand: #059669;
      --brand-dark: #047857;
      --good-bg: #ecfdf5;
      --good: #047857;
      --medium-bg: #fffbeb;
      --medium: #b45309;
      --warning-bg: #fff7ed;
      --warning: #c2410c;
      --risk-bg: #fef2f2;
      --risk: #b91c1c;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #e5e7eb;
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }
    .print-shell {
      width: 210mm;
      min-height: 297mm;
      margin: 0 auto;
      background: var(--panel);
      box-shadow: 0 20px 60px rgba(15, 23, 42, 0.18);
    }
    .hero {
      padding: 30px 34px 26px;
      color: white;
      background: linear-gradient(135deg, #064e3b 0%, #059669 60%, #34d399 100%);
    }
    .brand-row {
      display: flex;
      justify-content: space-between;
      gap: 18px;
      align-items: flex-start;
      margin-bottom: 24px;
    }
    .brand-mark {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    .report-logo-mark {
      width: 54px;
      height: 54px;
      flex: 0 0 auto;
      padding: 7px;
      border-radius: 18px;
      background: rgba(255,255,255,0.15);
      border: 1px solid rgba(255,255,255,0.28);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.18);
    }
    .brand-name {
      display: block;
      font-size: 20px;
      line-height: 1;
    }
    .brand-payoff {
      display: block;
      margin-top: 5px;
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.22em;
      color: rgba(255,255,255,0.78);
    }
    .date-pill {
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(255,255,255,0.16);
      border: 1px solid rgba(255,255,255,0.24);
      font-size: 12px;
      white-space: nowrap;
    }
    h1 {
      margin: 0;
      font-size: 31px;
      line-height: 1.08;
      letter-spacing: -0.04em;
      max-width: 720px;
    }
    .report-offer-title {
      display: block;
      margin-top: 8px;
      font-size: 24px;
      line-height: 1.12;
      letter-spacing: -0.025em;
      color: rgba(255,255,255,0.96);
      overflow-wrap: anywhere;
    }
    .report-offer-title::before {
      content: "Preventivo: ";
      color: rgba(255,255,255,0.72);
      font-size: 15px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .hero p {
      max-width: 680px;
      margin: 10px 0 0;
      color: rgba(255,255,255,0.88);
      font-size: 14px;
    }
    .offer-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-top: 16px;
      padding: 9px 12px;
      border-radius: 999px;
      background: rgba(255,255,255,0.16);
      border: 1px solid rgba(255,255,255,0.24);
      color: white;
      font-size: 13px;
    }
    .offer-pill span { color: rgba(255,255,255,0.78); font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; font-size: 10px; }
    .offer-pill strong { font-weight: 850; }
    .content { padding: 28px 34px 34px; }
    .summary-grid {
      display: grid;
      grid-template-columns: 1fr 1.45fr;
      gap: 18px;
      margin-top: -54px;
      align-items: stretch;
    }
    .score-card, .summary-card, .report-section, .empty-state, .email-card, .next-card {
      border: 1px solid var(--line);
      border-radius: 22px;
      background: var(--panel);
      box-shadow: 0 12px 28px rgba(15, 23, 42, 0.08);
    }
    .score-card { padding: 22px; }
    .score-label { color: var(--muted); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; }
    .score-value { display: flex; align-items: flex-end; gap: 6px; margin-top: 8px; }
    .score-value strong { font-size: 52px; line-height: 0.92; letter-spacing: -0.06em; }
    .score-value span { color: var(--muted); font-weight: 800; margin-bottom: 8px; }
    .score-bar { height: 10px; border-radius: 999px; background: #e2e8f0; overflow: hidden; margin: 18px 0 14px; }
    .score-fill { width: ${Math.max(0, Math.min(100, mortgageClarityScore))}%; height: 100%; border-radius: 999px; background: var(--brand); }
    .score-card.medium .score-fill { background: var(--medium); }
    .score-card.warning .score-fill { background: var(--warning); }
    .score-card.risk .score-fill { background: var(--risk); }
    .score-title { display: block; font-size: 17px; margin-bottom: 6px; }
    .score-card p, .summary-card p { margin: 0; color: var(--muted); font-size: 13px; }
    .summary-card { padding: 22px; }
    .summary-card h2, .report-section h2, .email-card h2, .next-card h2 {
      margin: 0 0 14px;
      font-size: 18px;
      letter-spacing: -0.025em;
    }
    .number-grid, .area-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .number-card, .area-card {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 12px;
      background: var(--soft);
      min-height: 72px;
    }
    .number-card span, .area-card span, .data-chip span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .number-card strong, .area-card strong {
      display: block;
      margin-top: 5px;
      font-size: 16px;
      letter-spacing: -0.02em;
    }
    .area-card.good { background: var(--good-bg); border-color: #bbf7d0; }
    .area-card.good strong { color: var(--good); }
    .area-card.medium { background: var(--medium-bg); border-color: #fde68a; }
    .area-card.medium strong { color: var(--medium); }
    .area-card.risk { background: var(--risk-bg); border-color: #fecaca; }
    .area-card.risk strong { color: var(--risk); }
    .report-section { padding: 22px; margin-top: 18px; }
    .section-title-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 14px;
      margin: 30px 0 12px;
    }
    .section-title-row h2 { margin: 0; font-size: 21px; letter-spacing: -0.03em; }
    .section-title-row span { color: var(--muted); font-size: 12px; font-weight: 700; }
    .data-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .data-chip {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 11px 12px;
      background: var(--soft);
    }
    .data-chip strong {
      display: block;
      margin-top: 4px;
      font-size: 13px;
      color: var(--ink);
    }
    .section-kicker {
      display: inline-flex;
      margin-bottom: 12px;
      padding: 5px 10px;
      border-radius: 999px;
      color: var(--brand-dark);
      background: var(--good-bg);
      font-size: 12px;
      font-weight: 800;
    }
    .issue-list { display: grid; gap: 10px; }
    .issue-card {
      border: 1px solid var(--line);
      border-radius: 17px;
      padding: 14px;
      background: var(--soft);
    }
    .issue-card.is-missing { border-color: #fed7aa; background: var(--warning-bg); }
    .issue-card.is-unclear { border-color: #fecaca; background: var(--risk-bg); }
    .issue-card.is-economic-high { border-color: #fdba74; background: #fff7ed; }
    .issue-card.is-economic-medium { border-color: #fde68a; background: #fffbeb; }
    .issue-header { display: flex; gap: 9px; align-items: center; margin-bottom: 7px; }
    .issue-header strong { font-size: 14px; }
    .status-pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 10px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      white-space: nowrap;
    }
    .pill-missing { background: #fed7aa; color: #9a3412; }
    .pill-unclear { background: #fecaca; color: #991b1b; }
    .pill-economic-high { background: #fdba74; color: #9a3412; }
    .pill-economic-medium { background: #fde68a; color: #92400e; }
    .neutral-note { margin: 0 0 12px; color: #475569; font-size: 13px; }
    .issue-card p { margin: 0 0 8px; color: #334155; font-size: 13px; }
    .question-box {
      border-radius: 13px;
      padding: 10px 12px;
      background: white;
      border: 1px solid rgba(15,23,42,0.08);
      color: var(--ink);
      font-size: 13px;
      font-weight: 650;
    }
    .email-card, .next-card { padding: 22px; margin-top: 18px; }
    pre {
      white-space: pre-wrap;
      margin: 0;
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 16px;
      background: #f8fafc;
      color: #0f172a;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      line-height: 1.55;
    }
    .next-list { margin: 0; padding-left: 18px; color: #334155; }
    .next-list li { margin-bottom: 8px; }
    .empty-state {
      padding: 18px;
      background: var(--good-bg);
      border-color: #bbf7d0;
    }
    .empty-state strong { display: block; color: var(--good); }
    .empty-state span { display: block; margin-top: 4px; color: #334155; font-size: 13px; }
    .footer-note {
      margin-top: 22px;
      padding-top: 16px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 11px;
    }
    .print-action {
      position: fixed;
      right: 22px;
      bottom: 22px;
      z-index: 10;
      padding: 13px 18px;
      border: 0;
      border-radius: 999px;
      background: var(--brand);
      color: white;
      font-weight: 800;
      box-shadow: 0 14px 30px rgba(5, 150, 105, 0.32);
      cursor: pointer;
    }
    .avoid-break { break-inside: avoid; page-break-inside: avoid; }
    @media print {
      @page { size: A4; margin: 12mm; }
      body { background: white; }
      .print-shell { width: auto; min-height: auto; margin: 0; box-shadow: none; }
      .hero { border-radius: 0; padding: 22px 24px; }
      .content { padding: 22px 24px; }
      .summary-grid { margin-top: 18px; grid-template-columns: 1fr 1.35fr; }
      .score-card, .summary-card, .report-section, .email-card, .next-card { box-shadow: none; }
      .print-action { display: none; }
    }
  </style>
</head>
<body>
  <button class="print-action" onclick="window.print()">Salva o stampa in PDF</button>
  <main class="print-shell">
    <header class="hero">
      <div class="brand-row">
        <div class="brand-mark">
          ${reportLogoSvg}
          <div><span class="brand-name">soldi semplici</span><span class="brand-payoff">La tua finanza. In modo semplice.</span></div>
        </div>
        <div class="date-pill">${escapeReportHtml(reportDate)}</div>
      </div>
      <h1>Report verifica mutuo:<span class="report-offer-title">${escapeReportHtml(reportOfferName)}</span></h1>
      <p>Una sintesi leggibile dei dati PIES, dei punti chiari e delle domande da inviare alla banca prima della firma.</p>
    </header>

    <div class="content">
      <section class="summary-grid avoid-break">
        <article class="score-card ${scoreTone}">
          <div class="score-label">Indice di chiarezza documentale</div>
          <div class="score-value"><strong>${mortgageClarityScore}</strong><span>/100</span></div>
          <div class="score-bar"><div class="score-fill"></div></div>
          <strong class="score-title">${escapeReportHtml(mortgageClarityCopy.label)}</strong>
          <p>${escapeReportHtml(mortgageClarityCopy.message)}</p>
          <p style="margin-top:10px;">Dati trovati: <strong>${mortgagePiesFound.length}/${visibleMortgagePiesFieldDefinitions.length}</strong></p>
        </article>

        <article class="summary-card">
          <h2>Dati principali</h2>
          <div class="number-grid">${numberCards}</div>
        </article>
      </section>

      <div class="section-title-row avoid-break">
        <h2>Aree controllate</h2>
        <span>Semaforo sintetico</span>
      </div>
      <section class="area-grid avoid-break">${areaCards}</section>

      <div class="section-title-row">
        <h2>Segnali di attenzione economica</h2>
        <span>Costi o vincoli da comprendere meglio</span>
      </div>
      <section class="report-section avoid-break">
        <p class="neutral-note">Questi segnali non indicano irregolarità. Servono a evidenziare elementi economici che possono incidere sul costo complessivo o sulla libertà di scelta dell'utente.</p>
        <div class="issue-list">${economicAttentionCards}</div>
      </section>

      <div class="section-title-row">
        <h2>Dati trovati</h2>
        <span>Valori individuati nel PIES</span>
      </div>
      <section class="data-grid avoid-break">${foundItems}</section>

      <div class="section-title-row">
        <h2>Punti da chiarire</h2>
        <span>Ordinati secondo i blocchi PIES</span>
      </div>
      ${issueCards}

      ${mortgageHasQuestionsForBank ? `
        <section class="email-card avoid-break">
          <h2>Email pronta per la banca</h2>
          <pre>${escapeReportHtml(mortgageGeneratedEmail)}</pre>
        </section>
      ` : `
        <section class="next-card avoid-break">
          <h2>Nessuna email necessaria al momento</h2>
          <p>I dati principali risultano presenti e non sono emerse criticità documentali o segnali economici rilevanti. Prima della firma verifica comunque che il PIES sia aggiornato alle condizioni definitive.</p>
        </section>
      `}

      <section class="next-card avoid-break">
        <h2>Prossimi passi</h2>
        <ul class="next-list">
          ${mortgageHasQuestionsForBank ? `
            <li>Invia la richiesta di chiarimento alla banca e attendi una conferma scritta sui punti evidenziati.</li>
            <li>Chiedi conferme scritte quando una condizione incide su costo, tasso, polizze o vincoli.</li>
          ` : `
            <li>Conserva questo report e usalo per confrontare l'offerta con eventuali altre proposte.</li>
            <li>Non serve inviare una richiesta alla banca se non emergono punti mancanti, non chiari o segnali economici da verificare.</li>
          `}
          <li>Prima della firma verifica di avere il PIES aggiornato alle condizioni definitive.</li>
        </ul>
      </section>

      <p class="footer-note">Report educativo generato da Soldi Semplici. Non sostituisce consulenza bancaria, legale o finanziaria personalizzata. Verifica sempre le condizioni definitive prima della firma.</p>
    </div>
  </main>
  <script>setTimeout(function(){ window.print(); }, 500);</script>
</body>
</html>`;
    const reportWindow = window.open("", "_blank");
    if (!reportWindow) return;
    reportWindow.document.write(html);
    reportWindow.document.close();
  };

  type FraudRiskLevel = "basso" | "medio" | "alto" | "molto alto";
  type FraudQuestion = {
    id: string;
    text: string;
    weight: number;
    severity: "critico" | "forte" | "attenzione";
    minRisk?: FraudRiskLevel;
    why: string;
    action: string;
  };

  const fraudRiskRank: Record<FraudRiskLevel, number> = {
    basso: 0,
    medio: 1,
    alto: 2,
    "molto alto": 3,
  };

  const fraudQuestions: FraudQuestion[] = [
    {
      id: "credentials",
      text: "Ti chiedono codici, password, PIN, OTP o documenti?",
      weight: 45,
      severity: "critico",
      minRisk: "alto",
      why: "Codici, password, PIN, OTP e documenti possono dare accesso ai tuoi conti, alla tua identità o ai tuoi servizi digitali.",
      action: "Non inviare nulla. Chiudi la conversazione e contatta banca, ente o piattaforma solo da canali ufficiali.",
    },
    {
      id: "remote_access",
      text: "Ti chiedono di installare app o dare accesso remoto al telefono/PC?",
      weight: 60,
      severity: "critico",
      minRisk: "molto alto",
      why: "L'accesso remoto può permettere a un truffatore di controllare dispositivo, conto, carte o app di pagamento.",
      action: "Non installare nulla e non condividere lo schermo. Se lo hai già fatto, disconnetti internet e contatta subito la banca.",
    },
    {
      id: "safe_account",
      text: "Ti chiedono di spostare soldi su un conto sicuro o temporaneo?",
      weight: 60,
      severity: "critico",
      minRisk: "molto alto",
      why: "Nessuna banca seria ti chiede di trasferire denaro su un conto 'sicuro' indicato durante una chiamata o chat.",
      action: "Non fare bonifici. Chiama la banca dal numero ufficiale e verifica la situazione con un operatore reale.",
    },
    {
      id: "outside_payment",
      text: "Ti chiedono pagamenti fuori da canali ufficiali, gift card, crypto o bonifici istantanei?",
      weight: 42,
      severity: "critico",
      minRisk: "alto",
      why: "Pagamenti fuori piattaforma, crypto, gift card e bonifici istantanei sono difficili da recuperare e spesso usati nelle truffe.",
      action: "Non pagare fuori dai canali ufficiali. Usa solo metodi tracciabili e protetti dalla piattaforma.",
    },
    {
      id: "guaranteed_gain",
      text: "Promettono guadagni sicuri, molto alti o senza rischio?",
      weight: 40,
      severity: "critico",
      minRisk: "alto",
      why: "Negli investimenti non esistono guadagni elevati e garantiti senza rischio. Questa promessa è un segnale molto pericoloso.",
      action: "Non versare soldi. Verifica intermediario, autorizzazioni e documenti ufficiali prima di qualunque decisione.",
    },
    {
      id: "secrecy",
      text: "Ti chiedono di non parlarne con nessuno o di mantenere il segreto?",
      weight: 35,
      severity: "critico",
      minRisk: "alto",
      why: "La segretezza serve a isolarti e impedirti di chiedere aiuto o fare verifiche.",
      action: "Parlane subito con una persona fidata e verifica da un canale ufficiale prima di fare qualsiasi cosa.",
    },
    {
      id: "urgency",
      text: "Ti chiedono di agire subito o ti mettono fretta?",
      weight: 18,
      severity: "forte",
      why: "La fretta riduce la lucidità e ti spinge a saltare controlli importanti.",
      action: "Fermati almeno qualche minuto. Una richiesta seria può aspettare una verifica.",
    },
    {
      id: "unknown_link",
      text: "C'è un link, QR code, numero o email non verificato?",
      weight: 18,
      severity: "forte",
      why: "Link, QR e numeri non verificati possono portarti a pagine clone o finti operatori.",
      action: "Non usare il link ricevuto. Apri sito o app ufficiale digitando tu l'indirizzo.",
    },
    {
      id: "pressure",
      text: "La comunicazione ti mette paura, ansia o pressione emotiva?",
      weight: 18,
      severity: "forte",
      why: "Paura, urgenza e pressione emotiva sono usate per farti reagire senza ragionare.",
      action: "Interrompi il contatto e verifica con calma usando canali ufficiali o persone fidate.",
    },
  ];

  const selectedFraudQuestions = fraudQuestions.filter((question) => fraudAnswers[question.id]);
  const fraudRiskScore = selectedFraudQuestions.reduce((sum, q) => sum + q.weight, 0);
  const fraudCriticalCount = selectedFraudQuestions.filter((question) => question.severity === "critico").length;
  const fraudStrongCount = selectedFraudQuestions.filter((question) => question.severity === "forte").length;
  const baseFraudRiskLevel: FraudRiskLevel =
    fraudRiskScore >= 70 ? "molto alto" : fraudRiskScore >= 40 ? "alto" : fraudRiskScore >= 20 ? "medio" : "basso";
  const minimumFraudRiskLevel = selectedFraudQuestions.reduce<FraudRiskLevel>((current, question) => {
    if (!question.minRisk) return current;
    return fraudRiskRank[question.minRisk] > fraudRiskRank[current] ? question.minRisk : current;
  }, "basso");
  const combinationFraudRiskLevel: FraudRiskLevel =
    fraudCriticalCount >= 2 || (fraudCriticalCount >= 1 && fraudStrongCount >= 1) ? "molto alto" : minimumFraudRiskLevel;
  const fraudRiskLevel: FraudRiskLevel =
    fraudRiskRank[combinationFraudRiskLevel] > fraudRiskRank[baseFraudRiskLevel] ? combinationFraudRiskLevel : baseFraudRiskLevel;
  const mainFraudSignal = selectedFraudQuestions.find((question) => question.severity === "critico") ?? selectedFraudQuestions[0];
  const fraudPrimaryAction =
    fraudRiskLevel === "molto alto"
      ? "Fermati subito. Non pagare, non inviare dati e verifica da un canale ufficiale."
      : fraudRiskLevel === "alto"
        ? "Non procedere. Il segnale rilevato è importante e richiede verifica scritta o canale ufficiale."
        : fraudRiskLevel === "medio"
          ? "Fermati e verifica prima di continuare."
          : "Resta prudente e controlla comunque i dettagli.";

  const currentScamScenario = scamGameQuestions[scamGameIndex];
  const scamGameComplete = scamGameQuestions.length > 0 && scamGameAnswers.length === scamGameQuestions.length && scamSelectedChoice === null;
  const scamScore = scamGameAnswers.filter((answer) => answer.correct).length;
  const scamGameResultSignature = scamGameComplete ? `${scamGameSessionId}:${scamGameAnswers.map((answer) => `${answer.id}:${answer.correct ? "1" : "0"}`).join("|")}` : "";
  const scamAnsweredScenarioCount = scamAnsweredScenarioIds.length;
  const scamScenarioPoolSize = scamScenarioPool.length;
  const scamEncounteredFlags = Array.from(
    new Set(
      scamGameAnswers
        .map((answer) => scamGameQuestions.find((question) => question.id === answer.id))
        .filter(Boolean)
        .flatMap((question) => question?.redFlags ?? [])
    )
  );

  function startScamGame() {
    setScamGameSessionId((prev) => prev + 1);
    setScamGameQuestions(pickScamGameQuestions(scamScenarioPool, 5));
    setScamGameIndex(0);
    setScamGameAnswers([]);
    setScamSelectedChoice(null);
  }

  function answerScamScenario(choice: "trust" | "verify") {
    if (!currentScamScenario || scamSelectedChoice) return;

    const correct = currentScamScenario.isRisky ? choice === "verify" : choice === "trust";
    setScamSelectedChoice(choice);
    setScamGameAnswers((prev) => [
      ...prev,
      { id: currentScamScenario.id, correct, userChoice: choice },
    ]);
    setScamAnsweredScenarioIds((prev) => {
      const next = Array.from(new Set([...prev, currentScamScenario.id]));
      if (scamAnsweredStorageKey) writeStringArrayToStorage(scamAnsweredStorageKey, next);
      return next;
    });
  }

  function goToNextScamScenario() {
    if (scamGameIndex < scamGameQuestions.length - 1) {
      setScamGameIndex((prev) => prev + 1);
      setScamSelectedChoice(null);
    }
  }

  const currentQuestionData = questions[currentQuestion];
  const hasAnsweredCurrent = currentQuestion < questions.length && answers[currentQuestion] !== -1;
  const progress = Math.round((currentQuestion / questions.length) * 100);

  const retakeCooldownDays = 90;
  const lastRetakeDate = retakeMeta.lastAt ? new Date(retakeMeta.lastAt) : null;
  const daysSinceLastRetake = lastRetakeDate
    ? Math.floor((Date.now() - lastRetakeDate.getTime()) / (1000 * 60 * 60 * 24))
    : null;
  const retakeIsBlocked =
    retakeMeta.count >= 2 &&
    daysSinceLastRetake !== null &&
    daysSinceLastRetake < retakeCooldownDays;
  const retakeDaysRemaining =
    retakeIsBlocked && daysSinceLastRetake !== null
      ? retakeCooldownDays - daysSinceLastRetake
      : 0;
  const totalInvested = holdings.reduce((sum, item) => sum + item.amount, 0);

  const investedByCategory = useMemo(() => {
    const grouped: Partial<Record<StrumentiCategory, number>> = {};
    holdings.forEach((item) => {
      grouped[item.category] = (grouped[item.category] || 0) + item.amount;
    });
    return grouped;
  }, [holdings]);

  const dashboardBreakdown = useMemo(() => {
    return Object.entries(investedByCategory)
      .map(([category, amount]) => ({
        category: category as StrumentiCategory,
        amount: Number(amount || 0),
        percentage: totalInvested > 0 ? Math.round((Number(amount || 0) / totalInvested) * 100) : 0,
      }))
      .sort((a, b) => b.amount - a.amount);
  }, [investedByCategory, totalInvested]);

  const isBondCategory = (category: StrumentiCategory) => category.startsWith("Obbligazioni");
  const matchesPortfolioCategory = (holdingCategory: StrumentiCategory, targetCategory: StrumentiCategory) => {
    if (holdingCategory === targetCategory) return true;
    return isBondCategory(holdingCategory) && isBondCategory(targetCategory);
  };

  const getInvestedAmountForPortfolioCategory = (targetCategory: StrumentiCategory) => {
    return holdings.reduce((sum, item) => {
      return matchesPortfolioCategory(item.category, targetCategory) ? sum + item.amount : sum;
    }, 0);
  };

  const targetCoverage = useMemo(() => {
    return selectedPortfolio.composition.map((item) => {
      const currentAmount = getInvestedAmountForPortfolioCategory(item.category);
      const currentPercentage = totalInvested > 0 ? Math.round((currentAmount / totalInvested) * 100) : 0;
      const delta = currentPercentage - item.percentage;

      return {
        label: item.label,
        category: item.category,
        targetPercentage: item.percentage,
        currentPercentage,
        currentAmount,
        delta,
      };
    });
  }, [selectedPortfolio, holdings, totalInvested]);

  const biggestGap = useMemo(() => {
    if (targetCoverage.length === 0) return null;
    return [...targetCoverage].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
  }, [targetCoverage]);

  const rebalancePacNumber = Math.max(0, Number(rebalancePacAmount || 0));
  const REBALANCE_TOLERANCE_PERCENT = 1;

  const rebalanceCurrentByCategory = useMemo(() => {
    const grouped: Partial<Record<StrumentiCategory, number>> = {};
    selectedPortfolio.composition.forEach((item) => {
      grouped[item.category] = Math.max(0, Number(rebalanceValues[item.category] || 0));
    });
    return grouped;
  }, [rebalanceValues, selectedPortfolio.composition]);

  const rebalanceTotalInvested = selectedPortfolio.composition.reduce(
    (sum, item) => sum + (rebalanceCurrentByCategory[item.category] || 0),
    0
  );

  const rebalanceCoverage = useMemo(() => {
    return selectedPortfolio.composition.map((item) => {
      const currentAmount = rebalanceCurrentByCategory[item.category] || 0;
      const currentPercentageRaw = rebalanceTotalInvested > 0 ? (currentAmount / rebalanceTotalInvested) * 100 : 0;
      const currentPercentage = Number(currentPercentageRaw.toFixed(1));
      const targetAmountNow = rebalanceTotalInvested * (item.percentage / 100);
      const amountGapNow = targetAmountNow - currentAmount;
      const rawDelta = currentPercentageRaw - item.percentage;
      const preciseDelta = Number(rawDelta.toFixed(1));
      const delta = Math.abs(rawDelta) <= REBALANCE_TOLERANCE_PERCENT ? 0 : preciseDelta;

      return {
        label: item.label,
        category: item.category,
        targetPercentage: item.percentage,
        currentPercentage,
        currentAmount,
        targetAmountNow,
        amountGapNow,
        preciseDelta,
        delta,
      };
    });
  }, [selectedPortfolio.composition, rebalanceCurrentByCategory, rebalanceTotalInvested]);

  const rebalanceBiggestGap = useMemo(() => {
    if (rebalanceCoverage.length === 0) return null;
    return [...rebalanceCoverage].sort((a, b) => Math.abs(b.preciseDelta) - Math.abs(a.preciseDelta))[0];
  }, [rebalanceCoverage]);

  const totalRebalanceAbsoluteDrift = Number(rebalanceCoverage.reduce((sum, item) => sum + Math.abs(item.delta), 0).toFixed(1));

  const automaticRebalance = useMemo(() => {
    type RebalancePlanItem = (typeof rebalanceCoverage)[number] & {
      suggestedPercentage: number;
      monthlyAmount: number;
      roundedAmount: number;
      totalAmount: number;
      exactTotalAmount: number;
      role: "correzione" | "mantenimento";
    };

    if (rebalanceTotalInvested <= 0 || rebalancePacNumber <= 0) {
      return { months: 0, feasible: false, plan: [] as RebalancePlanItem[], totalCorrectionAmount: 0 };
    }

    const buildPlanForMonths = (months: number, feasible: boolean) => {
      const totalNewCapital = rebalancePacNumber * months;
      const futureTotal = rebalanceTotalInvested + totalNewCapital;

      const requiredToReachTarget = rebalanceCoverage.map((item) => {
        const targetAmountAtFutureTotal = futureTotal * (item.targetPercentage / 100);
        const requiredAmount = Math.max(0, targetAmountAtFutureTotal - item.currentAmount);
        return { ...item, requiredAmount };
      });

      const correctionItems = requiredToReachTarget.filter((item) => item.requiredAmount > 0.5);
      const maintenanceItems = requiredToReachTarget.filter((item) => item.requiredAmount <= 0.5);
      const totalCorrectionAmount = correctionItems.reduce((sum, item) => sum + item.requiredAmount, 0);
      const remainingCapital = Math.max(0, totalNewCapital - totalCorrectionAmount);
      const maintenanceTargetTotal = maintenanceItems.reduce((sum, item) => sum + item.targetPercentage, 0);

      const plan = requiredToReachTarget
        .map((item) => {
          const correctionAmount = item.requiredAmount > 0.5 ? item.requiredAmount : 0;
          const maintenanceAmount = item.requiredAmount <= 0.5 && remainingCapital > 0
            ? remainingCapital * (maintenanceTargetTotal > 0 ? item.targetPercentage / maintenanceTargetTotal : item.targetPercentage / 100)
            : 0;
          const exactTotalAmount = correctionAmount + maintenanceAmount;
          const monthlyAmount = exactTotalAmount / months;
          const suggestedPercentage = rebalancePacNumber > 0 ? Math.round((monthlyAmount / rebalancePacNumber) * 100) : 0;

          return {
            ...item,
            suggestedPercentage,
            monthlyAmount,
            roundedAmount: Math.round(monthlyAmount / 5) * 5,
            totalAmount: monthlyAmount * months,
            exactTotalAmount,
            role: correctionAmount > 0 ? "correzione" as const : "mantenimento" as const,
          };
        })
        .filter((item) => item.exactTotalAmount > 0.5 || item.roundedAmount > 0)
        .sort((a, b) => (a.role === b.role ? Math.abs(b.preciseDelta) - Math.abs(a.preciseDelta) : a.role === "correzione" ? -1 : 1));

      return { months, feasible, plan, totalCorrectionAmount };
    };

    for (let months = 1; months <= 60; months += 1) {
      const totalNewCapital = rebalancePacNumber * months;
      const futureTotal = rebalanceTotalInvested + totalNewCapital;
      const totalRequiredToReachTarget = rebalanceCoverage.reduce((sum, item) => {
        const targetAmountAtFutureTotal = futureTotal * (item.targetPercentage / 100);
        return sum + Math.max(0, targetAmountAtFutureTotal - item.currentAmount);
      }, 0);

      if (totalRequiredToReachTarget <= totalNewCapital + 0.5) {
        return buildPlanForMonths(months, true);
      }
    }

    return buildPlanForMonths(60, false);
  }, [rebalanceCoverage, rebalancePacNumber, rebalanceTotalInvested]);

  const rebalancePlan = automaticRebalance.plan;
  const rebalanceMonthsNumber = automaticRebalance.months;
  const totalRebalanceBudget = rebalancePacNumber * rebalanceMonthsNumber;
  const acceleratedRebalanceMonths = automaticRebalance.feasible ? Math.max(1, Math.ceil(rebalanceMonthsNumber / 2)) : 0;
  const acceleratedRebalancePac = acceleratedRebalanceMonths > 0 ? Math.ceil(totalRebalanceBudget / acceleratedRebalanceMonths / 10) * 10 : 0;

  const rebalanceOverweightItems = rebalanceCoverage.filter((item) => item.amountGapNow < 0).sort((a, b) => Math.abs(b.amountGapNow) - Math.abs(a.amountGapNow));
  const estimatedSaleAmount = rebalanceOverweightItems.reduce((sum, item) => sum + Math.abs(item.amountGapNow), 0);

  const rebalanceStatus = rebalanceTotalInvested <= 0
    ? "Inserisci i valori attuali dei tuoi asset per vedere lo scostamento dal modello."
    : totalRebalanceAbsoluteDrift === 0
    ? "Il portafoglio è in linea: gli scostamenti entro l'1% per asset sono normali. Se vuoi essere molto preciso, sotto trovi comunque come orientare il prossimo PAC."
    : automaticRebalance.feasible
    ? `Il portafoglio si e allontanato dal modello: con il PAC indicato puoi simulare un rientro graduale verso le percentuali esatte in circa ${automaticRebalance.months} ${automaticRebalance.months === 1 ? "mese" : "mesi"}.`
    : "Il portafoglio si e allontanato dal modello: con il PAC indicato il rientro richiede molto tempo, quindi valuta anche le alternative educative sotto.";

  const exitInvestedNumber = Math.max(0, Number(exitInvestedAmount || 0));
  const exitCurrentNumber = Math.max(0, Number(exitCurrentAmount || 0));
  const exitGoalNumber = Math.max(0, Number(exitGoalAmount || 0));
  const exitMonthsNumber = Math.max(1, Number(exitMonths || 1));
  const exitProfit = Math.max(0, exitCurrentNumber - exitInvestedNumber);
  const exitProfitPercent = exitInvestedNumber > 0 ? Math.round((exitProfit / exitInvestedNumber) * 100) : 0;
  const exitEstimatedTax = exitProfit * 0.26;
  const exitNetIfSoldNow = Math.max(0, exitCurrentNumber - exitEstimatedTax);
  const exitMonthlySale = Math.ceil((exitCurrentNumber / exitMonthsNumber) / 100) * 100;
  const exitAnnualWithdrawal = Math.round(exitCurrentNumber * 0.03);
  const exitSafeBucket = Math.round(exitCurrentNumber * 0.3);
  const exitInvestedBucket = Math.round(exitCurrentNumber * 0.7);

  type ExitStrategyKey = "graduale" | "regole" | "obiettivo" | "bucket";

  const exitStrategyLabels: Record<ExitStrategyKey, string> = {
    graduale: "Uscita graduale",
    regole: "Uscita a regole",
    obiettivo: "Uscita per obiettivo",
    bucket: "Bucket strategy 3%",
  };

  const exitRuleSaleAmount = Math.round(exitCurrentNumber * 0.25);
  const exitNearGoal = exitGoalNumber > 0 ? Math.round(((exitCurrentNumber / exitGoalNumber) * 100)) : 0;

  const calculateExitAdvice = ({
    horizon,
    concern,
    lifeGoal,
    dropReaction,
  }: {
    horizon: "entro1" | "unoTre" | "oltreTre";
    concern: "timing" | "guadagni" | "rendita" | "tasse";
    lifeGoal: "spesa" | "pensione" | "protezione" | "rendimento";
    dropReaction: "sicura" | "graduale" | "aspettare" | "regole";
  }): ExitStrategyKey => {
    let bucketScore = 0;
    let gradualeScore = 0;
    let regoleScore = 0;
    let obiettivoScore = 0;

    if (concern === "rendita") bucketScore += 4;
    if (lifeGoal === "pensione") bucketScore += 4;
    if (dropReaction === "sicura") bucketScore += 3;
    if (horizon === "oltreTre") bucketScore += 1;

    if (concern === "timing") gradualeScore += 4;
    if (horizon === "entro1") gradualeScore += 3;
    if (dropReaction === "graduale") gradualeScore += 3;
    if (lifeGoal === "protezione") gradualeScore += 2;

    if (concern === "guadagni") regoleScore += 3;
    if (dropReaction === "regole") regoleScore += 4;
    if (lifeGoal === "rendimento") regoleScore += 3;
    if (exitProfile === "aggressivo") regoleScore += 2;

    if (lifeGoal === "spesa") obiettivoScore += 4;
    if (exitGoalNumber > 0) obiettivoScore += 2;
    if (horizon === "unoTre") obiettivoScore += 2;
    if (concern === "tasse") obiettivoScore += 1;

    const ranked = [
      { key: "bucket" as ExitStrategyKey, score: bucketScore },
      { key: "graduale" as ExitStrategyKey, score: gradualeScore },
      { key: "regole" as ExitStrategyKey, score: regoleScore },
      { key: "obiettivo" as ExitStrategyKey, score: obiettivoScore },
    ].sort((a, b) => b.score - a.score);

    return ranked[0]?.key || "graduale";
  };

  const questionnaireExitAdvice = useMemo<ExitStrategyKey>(() => {
    return calculateExitAdvice({
      horizon: exitHorizon,
      concern: exitMainConcern,
      lifeGoal: exitLifeGoal,
      dropReaction: exitDropReaction,
    });
  }, [exitMainConcern, exitLifeGoal, exitDropReaction, exitHorizon, exitProfile, exitGoalNumber]);

  const openExitQuestionnaire = () => {
    setExitMode("questionario");
    if (savedExitAdvice) {
      setShowExitQuestionnaireWarning(true);
      return;
    }
    setExitQuestionnaireStep(0);
    setShowExitQuestionnaireModal(true);
  };

  const saveExitQuestionnaireAdvice = (advice: ExitStrategyKey) => {
    setSavedExitAdvice(advice);
    setSelectedExitStrategy(advice);
    setExitMode("manual");
    setShowExitQuestionnaireModal(false);
    setShowExitQuestionnaireWarning(false);
    setExitQuestionnaireStep(0);
  };

  const completeExitQuestionnaireWith = (dropReaction: "sicura" | "graduale" | "aspettare" | "regole") => {
    setExitDropReaction(dropReaction);
    const advice = calculateExitAdvice({
      horizon: exitHorizon,
      concern: exitMainConcern,
      lifeGoal: exitLifeGoal,
      dropReaction,
    });
    saveExitQuestionnaireAdvice(advice);
  };

  const exitAdviceReasons = useMemo(() => {
    const reasons: string[] = [];
    if (savedExitAdvice === "bucket") {
      reasons.push("vuoi usare il capitale nel tempo senza vendere sempre la parte azionaria");
      reasons.push("la parte difensiva può finanziare i prelievi quando il mercato scende");
      reasons.push("è una strategia adatta a chi ragiona in termini di rendita");
    } else if (savedExitAdvice === "graduale") {
      reasons.push("vuoi ridurre il rischio di vendere tutto nel momento sbagliato");
      reasons.push("preferisci una procedura semplice e facile da seguire");
      reasons.push("hai bisogno di trasformare il capitale in liquidità in modo ordinato");
    } else if (savedExitAdvice === "regole") {
      reasons.push("vuoi evitare decisioni emotive quando il mercato si muove molto");
      reasons.push("sei disposto a seguire soglie già decise prima");
      reasons.push("può aiutare a proteggere parte dei guadagni senza uscire tutto insieme");
    } else if (savedExitAdvice === "obiettivo") {
      reasons.push("hai un traguardo concreto da raggiungere");
      reasons.push("la priorità diventa proteggere il risultato quando sei vicino al target");
      reasons.push("e semplice da capire: il piano dipende dalla distanza dall'obiettivo");
    }
    return reasons;
  }, [savedExitAdvice]);

  const exitRecommendedStrategy = useMemo(() => {
    const key = savedExitAdvice || selectedExitStrategy;
    const explanations: Record<ExitStrategyKey, string> = {
      graduale: "Strategia semplice: trasformi il capitale in liquidità poco alla volta, riducendo il rischio di vendere tutto in una giornata sfavorevole.",
      regole: "Strategia disciplinata: decidi prima soglie e comportamenti, così il mercato non ti costringe a scegliere sotto stress.",
      obiettivo: "Strategia concreta: parti dal bisogno reale e riduci il rischio man mano che ti avvicini alla cifra che ti serve.",
      bucket: "Strategia da rendita: separi una parte difensiva da cui prelevare e una parte investita che può continuare a lavorare.",
    };

    return {
      key,
      title: exitStrategyLabels[key],
      label: savedExitAdvice ? "Nostro consiglio salvato" : "Strategia selezionata",
      explanation: explanations[key],
    };
  }, [savedExitAdvice, selectedExitStrategy]);

  const exitStrategyDetails: Record<ExitStrategyKey, {
    title: string;
    plain: string;
    when: string[];
    steps: string[];
    pros: string[];
    cons: string[];
  }> = {
    graduale: {
      title: "Uscita graduale",
      plain: "Vendi una parte alla volta, invece di uscire tutto in un solo giorno. È la strategia più semplice quando vuoi trasformare gli investimenti in soldi disponibili senza dipendere dal prezzo di una singola giornata.",
      when: [
        "Ti serviranno i soldi nei prossimi mesi o nei prossimi anni",
        "Vuoi ridurre il rischio senza prendere una decisione brusca",
        "Preferisci una procedura facile da seguire: una quota al mese è poi controllo",
      ],
      steps: [
        `Scegli quale capitale vuoi rendere disponibile: nella simulazione stai usando ${formatEuro(exitCurrentNumber)}.`,
        `Decidi in quanti mesi uscire: ora hai impostato ${exitMonthsNumber} ${exitMonthsNumber === 1 ? "mese" : "mesi"}.`,
        `Vendi circa ${formatEuro(exitMonthlySale)} al mese, senza farti guidare dalle notizie del giorno.`,
        "Dopo ogni vendita, sposta il denaro verso liquidità o strumenti più prudenti se quei soldi ti servono davvero.",
        "Alla fine del periodo controlla: hai ancora bisogno di uscire oppure puoi lasciare investita una parte?",
      ],
      pros: [
        "E facile da capire e da mettere in pratica",
        "Riduce il rischio di vendere tutto in una giornata sfavorevole",
        "Aiuta a non farsi prendere dal panico quando il mercato oscilla",
      ],
      cons: [
        "Se il mercato sale, potresti aver venduto una parte troppo presto",
        "Se il mercato scende, continui comunque a vendere una quota",
        "Ogni vendita può generare tasse, costi o conseguenze fiscali da verificare",
      ],
    },
    regole: {
      title: "Uscita a regole",
      plain: "Decidi prima cosa fare e poi segui le regole. Serve quando vuoi evitare scelte impulsive: non vendi per paura e non resti investito solo per avidita.",
      when: [
        "Hai già ottenuto un buon risultato e vuoi proteggerne una parte",
        "Vuoi una procedura scritta prima, non decisa nel momento di stress",
        "Accetti una strategia un po' più tecnica, ma ancora gestibile",
      ],
      steps: [
        "Scrivi una regola semplice, per esempio: vendo una parte se il portafoglio scende troppo dal massimo raggiunto.",
        "Decidi quanto vendere se la regola scatta: una quota parziale e spesso più prudente di una vendita totale.",
        `Con i dati attuali, una vendita parziale del 25% vale circa ${formatEuro(exitRuleSaleAmount)}.`,
        "Dopo la vendita, sposta la parte uscita verso liquidità o strumenti più prudenti.",
        "Controlla le regole una volta al mese: guardarle ogni giorno aumenta solo ansia e confusione.",
      ],
      pros: [
        "Riduce le decisioni emotive",
        "Ti obbliga a sapere prima cosa farai se il mercato cambia",
        "Può proteggere parte dei guadagni senza chiudere tutto il piano",
      ],
      cons: [
        "Richiede disciplina: la regola funziona solo se la rispetti",
        "E meno immediata per chi e alle prime armi",
        "Può generare vendite non necessarie se le soglie sono scelte male",
      ],
    },
    obiettivo: {
      title: "Uscita per obiettivo",
      plain: "Parti dal motivo per cui stavi investendo. Se quei soldi servono per un obiettivo reale, la priorità diventa proteggerli, non cercare il massimo rendimento possibile.",
      when: [
        "Hai una spesa concreta: casa, famiglia, studio, progetto o sicurezza",
        "Vuoi proteggere una cifra precisa invece di inseguire sempre nuovi guadagni",
        "L'obiettivo è vicino e non vuoi rischiare di perderlo per un ribasso improvviso",
      ],
      steps: [
        `Scrivi la cifra obiettivo: ora hai impostato ${formatEuro(exitGoalNumber)}.`,
        `Confrontala con il valore attuale: sei circa al ${exitNearGoal}% dell'obiettivo.`,
        "Se sei lontano, continua il piano senza forzare l'uscita.",
        "Se sei vicino, riduci progressivamente il rischio e prepara liquidità.",
        "Se hai raggiunto l'obiettivo, valuta uscita graduale o vendita finale solo per la parte che ti serve.",
      ],
      pros: [
        "E molto intuitiva: collega l'investimento alla vita reale",
        "Evita di rischiare soldi che ti servono davvero",
        "Aiuta a smettere di inseguire rendimento quando il traguardo e già vicino",
      ],
      cons: [
        "Potresti uscire mentre il mercato continua a salire",
        "Richiede chiarezza sull'obiettivo: se non sai cosa vuoi, e difficile applicarla",
        "Una vendita finale troppo grande può concentrare tasse è decisioni in un solo momento",
      ],
    },
    bucket: {
      title: "Bucket strategy 3%",
      plain: "Dividi il capitale in due contenitori: una parte prudente da cui prelevare è una parte ancora investita. Serve quando vuoi usare il capitale nel tempo, non solo venderlo tutto.",
      when: [
        "Vuoi creare una rendita o prelevare denaro in modo regolare",
        "Hai ancora un orizzonte lungo per una parte del capitale",
        "Vuoi evitare di vendere azioni proprio nei momenti di mercato negativo",
      ],
      steps: [
        `Separa una parte più prudente: esempio ${formatEuro(exitSafeBucket)} in liquidità/strumenti difensivi e ${formatEuro(exitInvestedBucket)} ancora investiti.`,
        `Imposta un prelievo prudente: circa ${formatEuro(exitAnnualWithdrawal)} all'anno, pari al 3% del capitale simulato.`,
        "Quando la parte investita cresce molto, puoi vendere una quota e ricaricare il contenitore prudente.",
        "Quando il mercato scende, preleva dalla parte prudente e lascia respirare la parte investita.",
        "Una volta all'anno controlla se il 3% e ancora sostenibile e se i due contenitori sono da ribilanciare.",
      ],
      pros: [
        "E adatta a chi vuole usare il capitale nel tempo",
        "Riduce il rischio di vendere asset rischiosi durante i ribassi",
        "Lascia una parte del capitale ancora investita per il lungo periodo",
      ],
      cons: [
        "Il 3% è una regola prudente, non una garanzia",
        "Richiede controllo periodico e un po' di organizzazione",
        "Il capitale può comunque oscillare o ridursi se i mercati o i prelievi pesano troppo",
      ],
    },
  };

  const selectedExitDetails = exitStrategyDetails[selectedExitStrategy];



  const mostWeightedCategory = dashboardBreakdown.length > 0 ? dashboardBreakdown[0] : null;

  const dashboardMessage =
    totalInvested > 0
      ? "Stai costruendo un modello reale con dati persistenti e una struttura sempre più chiara."
      : "La dashboard è pronta: ora ti manca solo il primo investimento per trasformare il piano in azione.";

  const portfolioRate = getPortfolioRate(selectedPortfolio.profileFamily);

  const currentYear = new Date().getFullYear();
  const goalEndYearNumber = Number(goalEndYear || currentYear);
  const safeGoalEndYear = Math.max(currentYear, goalEndYearNumber);
  const goalDurationYears = safeGoalEndYear - currentYear;
  const goalDurationMonths = goalDurationYears * 12;
  const draftGoalEndYearNumber = Number(draftGoalEndYear || currentYear);
  const safeDraftGoalEndYear = Math.max(currentYear, draftGoalEndYearNumber);
  const draftGoalDurationYears = safeDraftGoalEndYear - currentYear;
  const draftGoalDurationMonths = draftGoalDurationYears * 12;
  const goalDraftFormKey = `${selectedPortfolio.key}-${goalTitle}-${goalTarget}-${goalCurrentValue}-${goalPreviousValue}-${goalReason}-${goalEndYear}`;

  const goalTargetNumber = Number(goalTarget || 0);
  const goalCurrentNumber = Number(goalCurrentValue || 0);
  const goalPreviousNumber = Number(goalPreviousValue || 0);
  const goalDelta = goalCurrentNumber - goalPreviousNumber;
  const goalProgressPercent = goalTargetNumber > 0 ? Math.max(0, Math.min(100, (goalCurrentNumber / goalTargetNumber) * 100)) : 0;
  const goalEstimatedFinal = calculatePAC(
    Number(portMonthly || 0),
    goalDurationYears,
    portfolioRate,
    0
  );

  const goalMessage = useMemo(() => {
    if (goalCurrentNumber <= 0) {
      return "Imposta il valore attuale del tuo capitale per visualizzare un progresso concreto verso l'obiettivo.";
    }

    if (goalDelta > 0 && goalReason === "investimento") {
      return "Ottimo segnale: stai aumentando il capitale con azioni concrete. La continuita nel tempo fa una differenza enorme.";
    }

    if (goalDelta > 0) {
      return "Il tuo capitale è aumentato. Continua a dare priorità alla costanza più che alla ricerca del momento perfetto.";
    }

    if (goalDelta < 0 && goalReason === "prelievo") {
      return "Hai utilizzato parte del capitale: può succedere. L'importante e riprendere il piano con serenità quando possibile.";
    }

    if (goalDelta < 0 && goalReason === "mercato") {
      return "Le oscillazioni di mercato fanno parte del percorso. Una fase negativa non significa che la strategia non funzioni.";
    }

    if (goalDelta < 0) {
      return "Il valore si e ridotto rispetto all'aggiornamento precedente. Mantieni calma e metodo, poi rivaluta il contesto.";
    }

    return "Stai mantenendo il piano. Anche la stabilita è un risultato importante quando il percorso è di lungo periodo.";
  }, [goalCurrentNumber, goalDelta, goalReason]);

  const homeProjection = calculatePAC(Number(homeMonthly || 0), Number(homeYears || 0), 0.07);
  const portfolioProjection = calculatePAC(
    Number(portMonthly || 0),
    Number(portYears || 0),
    portfolioRate,
    Number(portInitial || 0)
  );

  const initialChecklistItems = checklistItems.filter((item) => item.group === "inizio");
  const maintenanceChecklistItems = checklistItems.filter((item) => item.group === "mantenimento");
  const completedInitialChecklist = initialChecklistItems.filter((item) => checklistState[item.id]).length;
  const completedMaintenanceChecklist = maintenanceChecklistItems.filter((item) => checklistState[item.id]).length;
  const completedChecklist = completedInitialChecklist;
  const checklistPercent =
    initialChecklistItems.length > 0
      ? Math.round((completedInitialChecklist / initialChecklistItems.length) * 100)
      : 0;
  const setupCompleted =
    initialChecklistItems.length > 0 && completedInitialChecklist >= initialChecklistItems.length;

  const nextInitialChecklistItem = initialChecklistItems.find((item) => !checklistState[item.id]) || null;
  const nextMaintenanceChecklistItem = maintenanceChecklistItems.find((item) => !checklistState[item.id]) || null;
  const nextGuideItem = nextInitialChecklistItem || nextMaintenanceChecklistItem;
  const nextGuideAction = nextGuideItem ? getChecklistToolAction(nextGuideItem.id) : null;
  const currentMonthKey = getCurrentMonthKey();
  const currentMonthEntry = pacHistory.find((m) => m.month === currentMonthKey);
  const pacCompletedMonths = pacHistory.filter((m) => m.completed).length;
  const pacCompletionPercent = pacHistory.length > 0 ? Math.round((pacCompletedMonths / pacHistory.length) * 100) : 0;
  const currentStreak = calculateCurrentStreak(pacHistory);
  const streakTarget = 12;
  const streakProgressPercent = Math.min(100, Math.round((currentStreak / streakTarget) * 100));
  const streakMessage =
    currentStreak >= 12
      ? "Straordinario: hai costruito un anno completo di continuita."
      : currentStreak >= 6
      ? "Ottimo ritmo: la continuita sta diventando una vera abitudine."
      : currentStreak >= 3
      ? "Stai creando una base solida: proteggi questa serie."
      : currentStreak >= 1
      ? "Stai facendo esattamente quello che serve: ripetere il piano anche quando sembra poco."
      : "Segna il PAC del mese per iniziare a costruire la tua serie.";

  const monthlyPacAmount = Number(portMonthly || 0);
  const monthlyAllocationPlan = selectedPortfolio.composition.map((item) => {
    const rawAmount = (monthlyPacAmount * item.percentage) / 100;
    const roundedAmount = Math.round(rawAmount / 5) * 5;

    return {
      ...item,
      rawAmount,
      roundedAmount,
    };
  });

  const checkedAllocationCount = monthlyAllocationPlan.filter((item) => checkedPacAllocations[item.category]).length;
  const allocationChecklistComplete =
    monthlyAllocationPlan.length > 0 && checkedAllocationCount === monthlyAllocationPlan.length;

  const monthlyAllocationAlignedCount = monthlyAllocationPlan.filter((item) => {
    const investedAmount = getInvestedAmountForPortfolioCategory(item.category);
    return item.roundedAmount > 0 && Math.abs(investedAmount - item.roundedAmount) <= 1;
  }).length;
  const monthlyAllocationIsAligned =
    monthlyAllocationPlan.length > 0 && monthlyAllocationAlignedCount === monthlyAllocationPlan.length;

  useEffect(() => {
    setCheckedPacAllocations({});
  }, [portMonthly, selectedPortfolio.key]);

  const pacImpactPercent =
    goalTargetNumber > 0 ? (monthlyPacAmount / goalTargetNumber) * 100 : 0;
  const nextMilestone =
    currentStreak >= 12
      ? "Hai già raggiunto il traguardo dei 12 mesi consecutivi."
      : currentStreak >= 6
      ? "Prossimo traguardo: 12 mesi consecutivi."
      : currentStreak >= 3
      ? "Prossimo traguardo: 6 mesi consecutivi."
      : "Prossimo traguardo: 3 mesi consecutivi.";

  const userLevel =
    currentStreak >= 12
      ? "Avanzato"
      : currentStreak >= 6
      ? "Disciplinato"
      : currentStreak >= 3
      ? "Costante"
      : "Inizio";

  const userLevelMessage =
    currentStreak >= 12
      ? "Sei avanti rispetto alla maggior parte delle persone: proteggi questa abitudine."
      : currentStreak >= 6
      ? "Stai facendo ciò che funziona davvero: ripetere il piano nel tempo."
      : currentStreak >= 3
      ? "Stai costruendo una routine: ora il tuo vantaggio è la continuità."
      : "Hai appena iniziato: il primo obiettivo è rendere il PAC un gesto mensile.";

  const nextUserLevelMessage =
    currentStreak >= 12
      ? "Livello massimo raggiunto: continua a mantenere il metodo."
      : currentStreak >= 6
      ? `${12 - currentStreak} ${12 - currentStreak === 1 ? "mese" : "mesi"} al livello Avanzato.`
      : currentStreak >= 3
      ? `${6 - currentStreak} ${6 - currentStreak === 1 ? "mese" : "mesi"} al livello Disciplinato.`
      : `${3 - currentStreak} ${3 - currentStreak === 1 ? "mese" : "mesi"} al livello Costante.`;

  const userLevelProgress =
    currentStreak >= 12
      ? 100
      : currentStreak >= 6
      ? Math.min(100, ((currentStreak - 6) / 6) * 100)
      : currentStreak >= 3
      ? Math.min(100, ((currentStreak - 3) / 3) * 100)
      : Math.min(100, (currentStreak / 3) * 100);

  const currentMonthLabel = getMonthLabel(currentMonthKey);
  const currentMonthCompleted = !!currentMonthEntry?.completed;
  const hasStartedPac = pacCompletedMonths > 0;

  useEffect(() => {
    if (!hasStartedPac || checklistState.pac_start) return;

    setChecklistState((prev) => {
      if (prev.pac_start) return prev;
      return { ...prev, pac_start: true };
    });
    saveChecklistItemToDb("pac_start", true);
  }, [hasStartedPac, checklistState.pac_start, selectedPortfolio.key, user?.id]);

  const nextChainTarget =
    currentStreak >= 12
      ? 12
      : currentStreak >= 6
      ? 12
      : currentStreak >= 3
      ? 6
      : currentStreak >= 1
      ? 3
      : 1;
  const chainRemaining = Math.max(0, nextChainTarget - currentStreak);
  const chainProgressPercent =
    nextChainTarget > 0 ? Math.min(100, Math.round((currentStreak / nextChainTarget) * 100)) : 100;
  const chainTitle = !hasStartedPac
    ? "Completa il primo mese di PAC"
    : currentMonthCompleted
    ? "Catena protetta"
    : "Non spezzare la catena";
  const chainMessage = !hasStartedPac
    ? "Il PAC è il Piano di Accumulo mensile: investi una cifra ricorrente, senza provare a prevedere il mercato."
    : currentMonthCompleted
    ? "Hai chiuso il mese. Ora la priorità è proteggere questa continuita nel tempo."
    : "Hai già iniziato: completa anche questo mese per non interrompere la serie.";
  const chainNextStep = currentStreak >= 12
    ? "Hai raggiunto 12 mesi consecutivi. Ora devi solo mantenere il metodo."
    : chainRemaining === 0
    ? "Traguardo raggiunto."
    : `${chainRemaining} ${chainRemaining === 1 ? "mese" : "mesi"} al prossimo traguardo: ${nextChainTarget} consecutivi.`;

  const progressStartNumber = Number(progressStartValue || 0);
  const progressDelta = goalCurrentNumber - progressStartNumber;
  const progressDeltaPercent =
    progressStartNumber > 0 ? (progressDelta / progressStartNumber) * 100 : 0;
  const progressStartLabel = progressStartMonth ? getMonthLabel(progressStartMonth) : "inizio";
  const progressTone =
    progressDelta > 0 ? "positivo" : progressDelta < 0 ? "negativo" : "stabile";

  const nowForMonthlyReturn = new Date();
  const nextMonthDate = new Date(nowForMonthlyReturn.getFullYear(), nowForMonthlyReturn.getMonth() + 1, 1);
  const daysUntilNextMonth = Math.max(
    1,
    Math.ceil((nextMonthDate.getTime() - nowForMonthlyReturn.getTime()) / (1000 * 60 * 60 * 24))
  );
  const monthlyReturnTitle = currentMonthCompleted
    ? "Questo mese sei a posto"
    : "Questo mese ti manca";
  const monthlyReturnAction = currentMonthCompleted
    ? "Prossimo check mensile"
    : "Completa il PAC del mese";
  const monthlyReturnMessage = currentMonthCompleted
    ? `Torna tra circa ${daysUntilNextMonth} ${daysUntilNextMonth === 1 ? "giorno" : "giorni"} per chiudere il prossimo mese.`
    : "Chiudi il PAC mensile per proteggere la catena e mantenere vivo il piano.";
  const monthlyReturnStatus = currentMonthCompleted
    ? `Prossimo check: tra ${daysUntilNextMonth} ${daysUntilNextMonth === 1 ? "giorno" : "giorni"}`
    : `Da fare: PAC di ${currentMonthLabel}`;

  const smartTips = [
    !setupCompleted
      ? {
          title: "Completa prima il setup",
          text: "Il setup iniziale va fatto una sola volta. Dopo, il sistema diventa molto più semplice da mantenere.",
        }
      : null,
    !currentMonthCompleted
      ? {
          title: "Chiudi il mese",
          text: "Segna il PAC solo dopo aver verificato che il versamento o l'acquisto automatico sia partito correttamente.",
        }
      : {
          title: "Mese chiuso",
          text: "Hai fatto il gesto più importante: ora evita di controllare troppo spesso il mercato.",
        },
    currentStreak < 3
      ? {
          title: "Punta alla prima serie",
          text: "Arrivare a 3 mesi consecutivi è il primo vero segnale che il piano sta diventando abitudine.",
        }
      : null,
    !currentMonthCompleted
      ? {
          title: "Ritorna per chiudere il mese",
          text: "La dashboard deve servire a una cosa: ricordarti il gesto mensile che mantiene vivo il piano.",
        }
      : null,
    goalProgressPercent < 30
      ? {
          title: "Normale essere all'inizio",
          text: "All'inizio la percentuale sembra piccola. Il vantaggio arriva dalla ripetizione, non dal singolo mese.",
        }
      : null,
    progressDelta > 0
      ? {
          title: "Il progresso si vede",
          text: `Da ${progressStartLabel} hai costruito ${formatEuro(progressDelta)} in più. Questo rende il percorso concreto.`,
        }
      : null,
  ].filter(Boolean) as { title: string; text: string }[];
  const pacPerfectMessage = currentMonthCompleted
    ? `Mese chiuso. Sei a ${currentStreak} ${currentStreak === 1 ? "mese" : "mesi"} consecutivi: proteggi questa serie.`
    : hasStartedPac
    ? "Non spezzare la catena: completa il PAC mensile e mantieni vivo il ritmo."
    : "Il primo PAC è il passaggio chiave: da qui il piano smette di essere teoria e diventa abitudine.";
  const dashboardOverallProgress = Math.round(
    (checklistPercent + (holdings.length > 0 ? 100 : 0) + (currentMonthCompleted ? 100 : 0) + Math.min(100, currentStreak * 33)) / 4
  );
  const dashboardNextActionTitle = !setupCompleted
    ? "Completa la guida operativa"
    : holdings.length === 0
    ? "Registra il primo investimento"
    : !currentMonthCompleted
    ? "Chiudi il PAC del mese"
    : "Mantieni il ritmo";
  const dashboardNextActionText = !setupCompleted
    ? "Prima rendi chiari i passaggi: modello, cifra mensile, strumenti e metodo. Dopo la dashboard diventa davvero utile."
    : holdings.length === 0
    ? "Aggiungi il primo investimento per trasformare il piano da teoria a percorso monitorabile."
    : !currentMonthCompleted
    ? "Segna il PAC solo dopo aver completato il versamento o verificato che l'automatismo sia partito."
    : `Hai chiuso ${currentMonthLabel}. Ora controlla il piano senza inseguire il mercato.`;
  const dashboardNextActionLabel = !setupCompleted
    ? "Continua il percorso"
    : holdings.length === 0
    ? "Aggiungi investimento"
    : !currentMonthCompleted
    ? "Completa il mese"
    : "Vai al controllo mensile";
  const awarenessActionsCompleted = completedAwarenessList.length;
  const fraudChecksCompleted = Object.values(fraudAnswers).filter(Boolean).length;
  const vehicleAnalysisUsed = safeNumber(vehiclePrice) > 0 && (safeNumber(vehicleMonthlyPayment) > 0 || safeNumber(vehicleTaeg) > 0) && safeNumber(vehicleDurationMonths) > 0;
  const mortgageAnalysisUsed = safeNumber(mortgagePrincipal) > 0 && safeNumber(mortgageRate) > 0 && safeNumber(mortgageYears) > 0;

  const userId = user?.id || "";
  const badgeVaultStorageKey = userId ? getBadgeVaultStorageKey(userId, selectedPortfolio.key) : "";
  const celebrationSnapshotKey = userId ? getCelebrationSnapshotKey(userId, selectedPortfolio.key) : "";
  const personalGoalCelebrationStateKey = userId ? getPersonalGoalCelebrationStateKey(userId, selectedPortfolio.key) : "";
  const scamAnsweredStorageKey = userId ? getScamAnsweredStorageKey(userId) : "";
  const scamPerfectGamesStorageKey = userId ? getScamPerfectGamesStorageKey(userId) : "";

  useEffect(() => {
    if (!userId) {
      setScamAnsweredScenarioIds([]);
      setScamPerfectGames(0);
      lastScamPerfectGameSignatureRef.current = null;
      return;
    }

    setScamAnsweredScenarioIds(readStringArrayFromStorage(scamAnsweredStorageKey));
    const savedPerfectGames = Number(window.localStorage.getItem(scamPerfectGamesStorageKey) || "0");
    setScamPerfectGames(Number.isFinite(savedPerfectGames) ? savedPerfectGames : 0);
    lastScamPerfectGameSignatureRef.current = null;
  }, [userId, scamAnsweredStorageKey, scamPerfectGamesStorageKey]);

  useEffect(() => {
    if (!scamPerfectGamesStorageKey || !scamGameComplete || !scamGameResultSignature) return;
    if (lastScamPerfectGameSignatureRef.current === scamGameResultSignature) return;

    lastScamPerfectGameSignatureRef.current = scamGameResultSignature;
    if (scamScore !== scamGameQuestions.length) return;

    setScamPerfectGames((prev) => {
      const next = prev + 1;
      window.localStorage.setItem(scamPerfectGamesStorageKey, String(next));
      return next;
    });
  }, [scamPerfectGamesStorageKey, scamGameComplete, scamGameResultSignature, scamScore, scamGameQuestions.length]);

  const rawBadges = buildBadges({
    purchaseUnlocked: purchase.unlocked,
    checklistCompleted: completedInitialChecklist,
    totalChecklist: initialChecklistItems.length,
    pacHistory,
    totalInvested: goalCurrentNumber,
    goalTarget: goalTargetNumber,
    activeCategories: dashboardBreakdown.length,
    awarenessActionsCompleted,
    monthlyFreedByAwareness,
    fraudChecksCompleted,
    scamAnsweredScenarioCount,
    scamScenarioPoolSize,
    scamPerfectGames,
    vehicleAnalysisUsed,
    mortgageAnalysisUsed,
  });

  const persistedBadgeIdSet = new Set(persistedBadgeIds);
  const badges = rawBadges.map((badge) => {
    if (badge.unlocked || !persistedBadgeIdSet.has(badge.id)) return badge;

    return {
      ...badge,
      unlocked: true,
      progress: badge.target,
      progressLabel: "raggiunto",
    };
  });
  const badgeDisplayOrder = [
    "first_step",
    "system_on",
    "awareness_first_action",
    "awareness_50_month",
    "awareness_150_month",
    "vehicle_checker",
    "mortgage_checker",
    "fraud_shield",
    "fraud_all_scenarios",
    "fraud_10_perfect_games",
    "all_categories",
    "pac_started",
    "streak_3",
    "streak_6",
    "capital_1000",
    "capital_5000",
    "capital_10000",
    "capital_25000",
    "capital_50000",
    "capital_100000",
    "capital_goal_reached",
    "streak_12",
    "restart",
  ];

  const orderedBadges = [...badges].sort((a, b) => {
    const aIndex = badgeDisplayOrder.indexOf(a.id);
    const bIndex = badgeDisplayOrder.indexOf(b.id);
    return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
  });

  const unlockedBadges = orderedBadges.filter((b) => b.unlocked);
  const nextBadge = orderedBadges.find((badge) => !badge.unlocked) || null;
  const nextBadgeAction =
    nextBadge?.id === "first_step"
      ? "Completa il questionario per ricevere il tuo piano."
      : nextBadge?.id === "system_on"
      ? `Completa il setup iniziale: mancano ${Math.max(0, initialChecklistItems.length - completedInitialChecklist)} passaggi.`
      : nextBadge?.id === "pac_started"
      ? "Chiudi il primo mese di PAC per accendere la catena."
      : nextBadge?.id === "streak_3"
      ? `Proteggi la catena: mancano ${Math.max(0, 3 - currentStreak)} mesi a Routine attivata.`
      : nextBadge?.id === "streak_6"
      ? `Continua così: mancano ${Math.max(0, 6 - currentStreak)} mesi a Disciplina reale.`
      : nextBadge?.id === "streak_12"
      ? `Non spezzare la catena: mancano ${Math.max(0, 12 - currentStreak)} mesi a Macchina da compounding.`
      : nextBadge?.id === "capital_1000"
      ? `Aggiorna il capitale: mancano ${formatEuro(Math.max(0, 1000 - goalCurrentNumber))} al primo capitale serio.`
      : nextBadge?.id === "capital_5000"
      ? `Continua a costruire: mancano ${formatEuro(Math.max(0, 5000 - goalCurrentNumber))} a Costruttore di capitale.`
      : nextBadge?.id === "capital_10000"
      ? `Continua a costruire: mancano ${formatEuro(Math.max(0, 10000 - goalCurrentNumber))} a Patrimonio in costruzione.`
      : nextBadge?.id === "capital_25000"
      ? `Continua a costruire: mancano ${formatEuro(Math.max(0, 25000 - goalCurrentNumber))} a Capitale solido.`
      : nextBadge?.id === "capital_50000"
      ? `Continua a costruire: mancano ${formatEuro(Math.max(0, 50000 - goalCurrentNumber))} a Traguardo importante.`
      : nextBadge?.id === "capital_100000"
      ? `Continua a costruire: mancano ${formatEuro(Math.max(0, 100000 - goalCurrentNumber))} a Sei cifre raggiunte.`
      : nextBadge?.id === "capital_goal_reached"
      ? goalTargetNumber > 0
        ? `Manca ${formatEuro(Math.max(0, goalTargetNumber - goalCurrentNumber))} al tuo obiettivo personale.`
        : "Imposta un obiettivo personale per sbloccare il badge finale Capitale."
      : nextBadge?.id === "awareness_first_action"
      ? "Completa una azione nella sezione Consapevolezza per sbloccare Occhio allenato."
      : nextBadge?.id === "awareness_50_month"
      ? `Libera ancora ${formatEuro(Math.max(0, 50 - monthlyFreedByAwareness))} al mese con le azioni di consapevolezza.`
      : nextBadge?.id === "awareness_150_month"
      ? `Libera ancora ${formatEuro(Math.max(0, 150 - monthlyFreedByAwareness))} al mese per sbloccare Budget sveglio.`
      : nextBadge?.id === "vehicle_checker"
      ? "Usa il controllo Auto per capire costo reale, maxi rata e impatto sul reddito."
      : nextBadge?.id === "mortgage_checker"
      ? "Usa lo stress test Mutuo per vedere rata, interessi e margine di sicurezza."
      : nextBadge?.id === "fraud_shield"
      ? `Valuta ancora ${Math.max(0, 3 - fraudChecksCompleted)} segnali nel test Anti-truffe.`
      : nextBadge?.id === "fraud_all_scenarios"
      ? `Gioca ancora al mini gioco Anti-truffe: hai visto ${Math.min(scamAnsweredScenarioCount, scamScenarioPool.length)}/${scamScenarioPool.length} scenari.`
      : nextBadge?.id === "fraud_10_perfect_games"
      ? `Completa 10 partite senza errori. Partite perfette: ${Math.min(scamPerfectGames, 10)}/10.`
      : nextBadge?.id === "all_categories"
      ? "Registra almeno una categoria del modello per renderlo operativo."
      : "Hai sbloccato tutti i badge disponibili in questa fase.";

  const investorTitles = buildInvestorTitles({
    badges,
    currentStreak,
    totalInvested: goalCurrentNumber,
    goalTarget: goalTargetNumber,
    activeCategories: dashboardBreakdown.length,
    setupCompleted,
  });
  const unlockedInvestorTitles = investorTitles.filter((title) => title.unlocked);
  const currentInvestorTitle = unlockedInvestorTitles[unlockedInvestorTitles.length - 1] || investorTitles[0];
  const nextInvestorTitle = investorTitles.find((title) => !title.unlocked) || null;
  const nextTitleProgressPercent = nextInvestorTitle
    ? Math.round((nextInvestorTitle.progress / Math.max(nextInvestorTitle.target, 1)) * 100)
    : 100;
  const unlockedBadgeSignature = unlockedBadges.map((badge) => badge.id).join("|");
  const currentTitleId = currentInvestorTitle?.id || "none";
  const hasReachedPersonalGoal = goalTargetNumber > 0 && goalCurrentNumber >= goalTargetNumber;
  const currentUnlockedBadgeIds = rawBadges.filter((badge) => badge.unlocked).map((badge) => badge.id);
  const currentUnlockedBadgeSignature = currentUnlockedBadgeIds.join("|");

  const showPersonalGoalCelebration = (dismissedKey: string) => {
    setGoalCelebration((current) => {
      if (current?.dismissedKey === dismissedKey) return current;

      return {
        kind: "goal",
        icon: "🎯",
        title: "Hai raggiunto qualcosa di importante",
        subtitle:
          "Questo non è solo un numero. È disciplina, costanza e scelte fatte bene nel tempo. Hai trasformato un obiettivo in un risultato concreto, passo dopo passo. Grazie per averci scelto come compagno di viaggio: questo traguardo è tuo, e siamo davvero orgogliosi di averti accompagnato fin qui.",
        dismissedKey,
      };
    });
  };

  const replayPersonalGoalCelebration = () => {
    if (!personalGoalCelebrationStateKey) return;
    showPersonalGoalCelebration(personalGoalCelebrationStateKey);
  };

  useEffect(() => {
    if (!badgeVaultStorageKey) {
      setPersistedBadgeIds([]);
      setBadgeVaultLoadedKey("");
      return;
    }

    setPersistedBadgeIds(readStringArrayFromStorage(badgeVaultStorageKey));
    setBadgeVaultLoadedKey(badgeVaultStorageKey);
  }, [badgeVaultStorageKey]);

  useEffect(() => {
    if (!userId || !authReady || !goalLoaded || !badgeVaultStorageKey || badgeVaultLoadedKey !== badgeVaultStorageKey || !celebrationSnapshotKey) return;

    const sessionKey = `${userId}-${selectedPortfolio.key}`;
    const firstSyncForThisSession = !celebrationInitialSyncRef.current[sessionKey];
    const savedBadgeIds = readStringArrayFromStorage(badgeVaultStorageKey);
    const savedBadgeSet = new Set(savedBadgeIds);
    const newlyUnlockedBadgeIds = currentUnlockedBadgeIds.filter((id) => !savedBadgeSet.has(id));
    const mergedBadgeIds = Array.from(new Set([...savedBadgeIds, ...currentUnlockedBadgeIds]));

    if (mergedBadgeIds.length !== savedBadgeIds.length) {
      writeStringArrayToStorage(badgeVaultStorageKey, mergedBadgeIds);
      setPersistedBadgeIds(mergedBadgeIds);
    }

    const savedSnapshotRaw = window.localStorage.getItem(celebrationSnapshotKey);
    const savedSnapshot = savedSnapshotRaw
      ? (() => {
          try {
            return JSON.parse(savedSnapshotRaw) as { title?: string };
          } catch {
            return null;
          }
        })()
      : null;

    const currentSnapshot = {
      badges: mergedBadgeIds,
      title: currentTitleId,
    };

    const storedGoalState = readPersonalGoalCelebrationState(personalGoalCelebrationStateKey);
    const targetChanged = Boolean(storedGoalState && storedGoalState.target !== goalTargetNumber);
    const shouldShowGoalCelebration =
      hasReachedPersonalGoal &&
      goalTargetNumber > 0 &&
      (!storedGoalState || targetChanged || !storedGoalState.confirmed || storedGoalState.droppedBelowAfterConfirmed);

    if (goalTargetNumber > 0) {
      if (hasReachedPersonalGoal) {
        if (shouldShowGoalCelebration) {
          writePersonalGoalCelebrationState(personalGoalCelebrationStateKey, {
            target: goalTargetNumber,
            wasReached: true,
            confirmed: false,
            droppedBelowAfterConfirmed: false,
            lastCurrentValue: goalCurrentNumber,
          });
          window.localStorage.setItem(celebrationSnapshotKey, JSON.stringify(currentSnapshot));
          showPersonalGoalCelebration(personalGoalCelebrationStateKey);
          celebrationInitialSyncRef.current[sessionKey] = true;
          return;
        }

        if (!storedGoalState || storedGoalState.lastCurrentValue !== goalCurrentNumber || storedGoalState.droppedBelowAfterConfirmed) {
          writePersonalGoalCelebrationState(personalGoalCelebrationStateKey, {
            target: goalTargetNumber,
            wasReached: true,
            confirmed: storedGoalState?.confirmed ?? true,
            droppedBelowAfterConfirmed: false,
            lastCurrentValue: goalCurrentNumber,
            confirmedAt: storedGoalState?.confirmedAt,
          });
        }
      } else if (storedGoalState?.confirmed && storedGoalState.wasReached && !storedGoalState.droppedBelowAfterConfirmed) {
        writePersonalGoalCelebrationState(personalGoalCelebrationStateKey, {
          ...storedGoalState,
          droppedBelowAfterConfirmed: true,
          lastCurrentValue: goalCurrentNumber,
        });
      }
    }

    if (firstSyncForThisSession) {
      celebrationInitialSyncRef.current[sessionKey] = true;
      window.localStorage.setItem(celebrationSnapshotKey, JSON.stringify(currentSnapshot));
      return;
    }

    const previousTitle = savedSnapshot?.title;
    const titleChanged = Boolean(previousTitle && previousTitle !== currentTitleId && currentInvestorTitle?.unlocked);

    window.localStorage.setItem(celebrationSnapshotKey, JSON.stringify(currentSnapshot));

    if (goalCelebration) return;

    if (titleChanged && currentInvestorTitle) {
      setCelebration({
        kind: "title",
        icon: currentInvestorTitle.icon,
        title: currentInvestorTitle.title,
        subtitle: currentInvestorTitle.subtitle,
      });
      return;
    }

    const newBadge = orderedBadges.find((badge) => newlyUnlockedBadgeIds.includes(badge.id));
    if (newBadge) {
      setCelebration({
        kind: "badge",
        icon: newBadge.icon,
        title: newBadge.title,
        subtitle: newBadge.description,
      });
    }
  }, [
    authReady,
    userId,
    goalLoaded,
    selectedPortfolio.key,
    badgeVaultStorageKey,
    badgeVaultLoadedKey,
    celebrationSnapshotKey,
    personalGoalCelebrationStateKey,
    currentUnlockedBadgeSignature,
    currentTitleId,
    currentInvestorTitle?.id,
    hasReachedPersonalGoal,
    goalTargetNumber,
    goalCurrentNumber,
    goalCelebration,
  ]);

  useEffect(() => {
    if (!celebration || celebration.kind === "goal") return;

    const autoCloseTimer = window.setTimeout(() => {
      setCelebration((current) => (current === celebration ? null : current));
    }, 4200);

    return () => window.clearTimeout(autoCloseTimer);
  }, [celebration]);

  const reminderCards = useMemo(() => {
    const reminders: {
      title: string;
      text: string;
      tone: "neutral" | "warning" | "success";
    }[] = [];

    const completedMonths = pacHistory.filter((m) => m.completed).length;
    const currentMonthDone = !!currentMonthEntry?.completed;
    const fullChecklistDone = setupCompleted;

    if (!purchase.unlocked) {
      reminders.push({
        title: "Sblocca il piano",
        text: "Completa lo sblocco del modello per trasformare il profilo in un piano operativo completo.",
        tone: "warning",
      });
    }

    if (purchase.unlocked && !fullChecklistDone) {
      reminders.push({
        title: "Completa la guida operativa",
        text: "Ti mancano ancora alcuni passaggi operativi. Apri la pagina Guida per completare il percorso.",
        tone: "warning",
      });
    }

    if (purchase.unlocked && totalInvested <= 0) {
      reminders.push({
        title: "Inserisci il primo investimento",
        text: "Hai definito il piano ma non hai ancora registrato capitale. Il primo investimento trasforma la teoria in azione.",
        tone: "warning",
      });
    }

    if (purchase.unlocked && completedMonths === 0) {
      reminders.push({
        title: "Avvia il PAC",
        text: "Non risulta ancora nessun mese PAC completato. Inizia dal primo mese per costruire continuità reale.",
        tone: "warning",
      });
    }

    if (purchase.unlocked && completedMonths > 0 && !currentMonthDone) {
      reminders.push({
        title: "Completa il mese corrente",
        text: "Hai già costruito ritmo. Registrare anche il mese corrente ti aiuta a non interrompere la continuità.",
        tone: "neutral",
      });
    }

    if (biggestGap && Math.abs(biggestGap.delta) >= 10) {
      reminders.push({
        title: "Valuta un ribilanciamento",
        text: `${biggestGap.label} è la parte più distante dal target in questo momento. Potrebbe essere utile riallineare il modello.`,
        tone: "neutral",
      });
    }

    if (currentStreak >= 3) {
      reminders.push({
        title: "Continuità positiva",
        text: `Hai già mantenuto ${currentStreak} mesi consecutivi di PAC. Ora la priorità è proteggere questa costanza.`,
        tone: "success",
      });
    }

    if (reminders.length === 0) {
      reminders.push({
        title: "Situazione in ordine",
        text: "In questo momento non emergono criticità evidenti. Continua a mantenere il piano con costanza e semplicità.",
        tone: "success",
      });
    }

    return reminders.slice(0, 3);
  }, [
    purchase.unlocked,
    completedChecklist,
    checklistItems.length,
    totalInvested,
    pacHistory,
    currentMonthEntry,
    biggestGap,
    currentStreak,
  ]);

  const pacFeedback = useMemo(() => {
    const completedMonths = pacHistory.filter((m) => m.completed).length;
    if (completedMonths === 0) return "Hai già il piano. Ora il prossimo passo è completare il primo mese.";
    if (currentStreak >= 12) return "Stai facendo quello che la maggior parte delle persone non riesce a fare: continuità reale.";
    if (currentStreak >= 6) return "Stai costruendo una disciplina molto solida. Continua così.";
    if (currentStreak >= 3) return "Stai costruendo continuità. È così che si ottengono risultati.";
    if (pacHistory.some((m, i) => i > 0 && !pacHistory[i - 1].completed && m.completed)) {
      return "Hai ripreso il piano dopo una pausa. Ottima scelta: ripartire conta molto.";
    }
    return "Hai iniziato. È il passo più importante.";
  }, [pacHistory, currentStreak]);

  async function handleAuthSubmit() {
    setAuthLoading(true);
    setAuthMessage("");

    const normalizedEmail = authEmail.trim().toLowerCase();

    if (!normalizedEmail || !authPassword) {
      setAuthMessage("Inserisci email e password.");
      setAuthLoading(false);
      return;
    }

    if (authMode === "register") {
      if (authPassword !== authConfirmPassword) {
        setAuthMessage("Le password non coincidono.");
        setAuthLoading(false);
        return;
      }

      const emailRedirectTo =
        typeof window !== "undefined" ? `${window.location.origin}/auth/callback` : undefined;

      const { data, error } = await supabase.auth.signUp({
        email: normalizedEmail,
        password: authPassword,
        options: {
          emailRedirectTo,
        },
      });

      if (error) {
        const message = error.message.toLowerCase();
        const alreadyRegistered =
          message.includes("already") ||
          message.includes("registered") ||
          message.includes("exists") ||
          message.includes("user already");

        setAuthMessage(
          alreadyRegistered
            ? "Questa email risulta già collegata a un account. Accedi con la tua password oppure usa Recupera password."
            : getItalianAuthErrorMessage(error)
        );
      } else {
        const identities = data.user?.identities;
        const emailAlreadyRegistered = Array.isArray(identities) && identities.length === 0;

        if (emailAlreadyRegistered) {
          setAuthMessage("Questa email risulta già collegata a un account. Accedi con la tua password oppure usa Recupera password.");
          setAuthMode("login");
        } else {
          setAuthMessage("Registrazione inviata. Controlla la tua email: dopo la conferma tornerai su una pagina dedicata di Soldi Semplici.");
          setAuthMode("login");
        }
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({
        email: normalizedEmail,
        password: authPassword,
      });

      if (error) setAuthMessage(getItalianAuthErrorMessage(error));
      else setAuthMessage("");
    }

    setAuthLoading(false);
  }

  async function handlePasswordResetRequest() {
    setAuthLoading(true);
    setAuthMessage("");

    const normalizedEmail = authEmail.trim().toLowerCase();
    if (!normalizedEmail) {
      setAuthMessage("Inserisci la tua email per ricevere il link di recupero password.");
      setAuthLoading(false);
      return;
    }

    const redirectTo =
      typeof window !== "undefined" ? `${window.location.origin}/?type=recovery` : undefined;

    const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
      redirectTo,
    });

    if (error) {
      setAuthMessage(getItalianAuthErrorMessage(error));
    } else {
      setAuthMessage("Ti abbiamo inviato un'email con il link per impostare una nuova password. Controlla anche la cartella spam o promozioni.");
    }

    setAuthLoading(false);
  }

  async function handlePasswordUpdate() {
    setAuthLoading(true);
    setAuthMessage("");

    if (!authPassword || !authConfirmPassword) {
      setAuthMessage("Inserisci e conferma la nuova password.");
      setAuthLoading(false);
      return;
    }

    if (authPassword.length < 8) {
      setAuthMessage("La nuova password deve contenere almeno 8 caratteri.");
      setAuthLoading(false);
      return;
    }

    if (authPassword !== authConfirmPassword) {
      setAuthMessage("Le password non coincidono.");
      setAuthLoading(false);
      return;
    }

    const { error } = await supabase.auth.updateUser({ password: authPassword });

    if (error) {
      setAuthMessage(getItalianAuthErrorMessage(error));
    } else {
      setAuthMessage("Password aggiornata correttamente. Ora puoi continuare a usare Soldi Semplici.");
      setAuthMode("login");
      setAuthPassword("");
      setAuthConfirmPassword("");
      setStep("dashboard");
    }

    setAuthLoading(false);
  }

  async function handleAccountPasswordChange() {
    if (!user) return;

    setAccountPasswordLoading(true);
    setAccountPasswordMessage("");

    if (accountNewPassword.length < 8) {
      setAccountPasswordMessage("La nuova password deve contenere almeno 8 caratteri.");
      setAccountPasswordLoading(false);
      return;
    }

    if (accountNewPassword !== accountConfirmPassword) {
      setAccountPasswordMessage("Le password non coincidono.");
      setAccountPasswordLoading(false);
      return;
    }

    try {
      const { error } = await supabase.auth.updateUser({ password: accountNewPassword });

      if (error) {
        setAccountPasswordMessage(getItalianAuthErrorMessage(error));
        return;
      }

      setAccountPasswordMessage("Password aggiornata correttamente. Il tuo profilo è aggiornato.");
      setAccountNewPassword("");
      setAccountConfirmPassword("");
    } catch (error) {
      setAccountPasswordMessage(getItalianAuthErrorMessage(error));
    } finally {
      setAccountPasswordLoading(false);
    }
  }

  function openProfileModal() {
    setAccountNewPassword("");
    setAccountConfirmPassword("");
    setAccountPasswordMessage("");
    setAccountShowPassword(false);
    setProfileModalOpen(true);
  }

  async function handleLogout() {
    await safeLocalSignOut();
    clearSupabaseAuthStorage();
    setUser(null);
    setStep("home");
    setAnswers(Array(questions.length).fill(-1));
    setCurrentQuestion(0);
    setCompletedAwarenessActions({});
    awarenessActionsLoadedRef.current = false;
    mortgageCheckLoadedRef.current = false;
    if (mortgageSaveTimerRef.current) {
      clearTimeout(mortgageSaveTimerRef.current);
      mortgageSaveTimerRef.current = null;
    }
  }

  async function clearBrokenSession() {
    clearSupabaseAuthStorage();
    await safeLocalSignOut();
    setUser(null);
    setAuthMessage("Sessione locale pulita. Ora puoi accedere di nuovo.");
    setAuthReady(true);
  }

  async function loadAwarenessActionsFromDb(currentUser: User, localFallback: Record<string, boolean> = {}) {
    try {
      const { data, error } = await supabase
        .from("user_awareness_actions")
        .select("action_id, completed")
        .eq("user_id", currentUser.id);

      if (error) {
        if (isSupabaseRlsError(error)) {
          console.warn(
            "Azioni risparmio caricate solo in locale: policy RLS di Supabase da verificare per user_awareness_actions.",
            error.message
          );
        } else {
          console.warn("Azioni risparmio caricate solo in locale: errore Supabase.", error.message);
        }
        return;
      }

      if (!data || data.length === 0) {
        const localCompletedEntries = Object.entries(localFallback).filter(([, completed]) => completed);
        if (localCompletedEntries.length > 0) {
          syncAwarenessActionsToDb(currentUser, localFallback);
        }
        return;
      }

      const mapped: Record<string, boolean> = {};
      data.forEach((row: any) => {
        mapped[row.action_id] = !!row.completed;
      });

      setCompletedAwarenessActions(cleanAwarenessActionsState(mapped));
    } catch (error) {
      console.warn("Azioni risparmio caricate solo in locale: errore non bloccante.", getErrorMessage(error));
    }
  }

  async function syncAwarenessActionsToDb(currentUser: User, actionsState: Record<string, boolean>) {
    const rows = Object.entries(cleanAwarenessActionsState(actionsState)).map(([actionId, completed]) => ({
      user_id: currentUser.id,
      action_id: actionId,
      completed,
      updated_at: new Date().toISOString(),
    }));

    if (rows.length === 0) return;

    try {
      const authUser = await safeGetSupabaseUser("sincronizzazione azioni risparmio");
      const authUserId = authUser?.id;

      if (!authUserId || authUserId !== currentUser.id) {
        console.warn("Sincronizzazione azioni risparmio rimandata: utente Supabase non ancora confermato.");
        return;
      }

      const { error } = await supabase.from("user_awareness_actions").upsert(rows, {
        onConflict: "user_id,action_id",
      });

      if (error) {
        console.warn("Sincronizzazione azioni risparmio non completata.", error.message);
      }
    } catch (error) {
      console.warn("Sincronizzazione azioni risparmio non disponibile.", getErrorMessage(error));
    }
  }

  async function saveAwarenessActionToDb(actionId: string, completed: boolean) {
    if (!user) return;

    try {
      const authUser = await safeGetSupabaseUser("salvataggio azione risparmio");
      const authUserId = authUser?.id;

      if (!authUserId || authUserId !== user.id) {
        console.warn("Azione risparmio salvata solo in locale: utente Supabase non ancora confermato.");
        return;
      }

      const { error } = await supabase
        .from("user_awareness_actions")
        .upsert(
          {
            user_id: authUserId,
            action_id: actionId,
            completed,
            updated_at: new Date().toISOString(),
          },
          {
            onConflict: "user_id,action_id",
          }
        );

      if (error) {
        if (isSupabaseRlsError(error)) {
          console.warn(
            "Azione risparmio salvata solo in locale: policy RLS di Supabase da verificare per user_awareness_actions.",
            error.message
          );
        } else {
          console.warn("Azione risparmio salvata solo in locale: errore Supabase.", error.message);
        }
      }
    } catch (error) {
      console.warn("Azione risparmio salvata solo in locale: errore non bloccante.", getErrorMessage(error));
    }
  }

  function toggleAwarenessAction(actionId: string, completed: boolean) {
    setCompletedAwarenessActions((prev) => ({
      ...prev,
      [actionId]: completed,
    }));
    saveAwarenessActionToDb(actionId, completed);
  }

  function buildMortgageCheckState() {
    return {
      mortgageMode,
      sustainability: {
        offerName: mortgageOfferName,
        homePrice: mortgageHomePrice,
        downPayment: mortgageDownPayment,
        principal: mortgagePrincipal,
        rate: mortgageRate,
        years: mortgageYears,
        rateType: mortgageRateType,
        capRate: mortgageCapRate,
        declaredPayment: mortgageDeclaredPayment,
        monthlyIncome: mortgageMonthlyIncome,
        initialCosts: mortgageInitialCosts,
        recurringYearly: mortgageRecurringYearly,
        condoMonthly: mortgageCondoMonthly,
        utilitiesMonthly: mortgageUtilitiesMonthly,
        insuranceYearly: mortgageInsuranceYearly,
        maintenanceYearly: mortgageMaintenanceYearly,
        otherDebtsMonthly: mortgageOtherDebtsMonthly,
        fixedExpensesMonthly: mortgageFixedExpensesMonthly,
        liquidAfterPurchase: mortgageLiquidAfterPurchase,
        emergencyMonths: mortgageEmergencyMonths,
      },
      piesFields: cleanMortgagePiesFields(mortgagePiesFields),
      openMortgagePiesSectionId,
      results: {
        sustainability: {
          monthlyPayment: mortgageMonthlyPayment,
          totalPaid: mortgageTotalPaid,
          totalInterest: mortgageTotalInterest,
          realMonthlyHomeCost: mortgageRealMonthlyHomeCost,
          realMonthlyWithInitialCosts: mortgageRealMonthlyWithInitialCosts,
          paymentIncomeRatio: mortgagePaymentIncomeRatio,
          debtIncomeRatio: mortgageDebtIncomeRatio,
          monthlyMargin: mortgageMonthlyMargin,
          emergencyGap: mortgageEmergencyGap,
          sustainabilityLevel: mortgageSustainabilityLevel,
          trafficLight: mortgageTrafficLight.label,
        },
        pies: {
          clarityScore: mortgageClarityScore,
          foundCount: mortgagePiesFound.length,
          issueCount: mortgagePiesIssues.length,
          visibleFieldCount: visibleMortgagePiesFieldDefinitions.length,
          hasRelevantIssues: mortgageHasRelevantReportIssues,
        },
      },
      updatedAt: new Date().toISOString(),
    };
  }

  function applyMortgageCheckState(saved: any) {
    if (!saved || typeof saved !== "object") return;

    if (saved.mortgageMode === "sostenibilità" || saved.mortgageMode === "pies") {
      setMortgageMode(saved.mortgageMode);
    }

    const data = saved.sustainability && typeof saved.sustainability === "object" ? saved.sustainability : {};
    if (typeof data.offerName === "string") setMortgageOfferName(data.offerName);
    if (typeof data.homePrice === "string") setMortgageHomePrice(data.homePrice);
    if (typeof data.downPayment === "string") setMortgageDownPayment(data.downPayment);
    if (typeof data.principal === "string") setMortgagePrincipal(data.principal);
    if (typeof data.rate === "string") setMortgageRate(data.rate);
    if (typeof data.years === "string") setMortgageYears(data.years);
    if (typeof data.rateType === "string") setMortgageRateType(data.rateType);
    if (typeof data.capRate === "string") setMortgageCapRate(data.capRate);
    if (typeof data.declaredPayment === "string") setMortgageDeclaredPayment(data.declaredPayment);
    if (typeof data.monthlyIncome === "string") setMortgageMonthlyIncome(data.monthlyIncome);
    if (typeof data.initialCosts === "string") setMortgageInitialCosts(data.initialCosts);
    if (typeof data.recurringYearly === "string") setMortgageRecurringYearly(data.recurringYearly);
    if (typeof data.condoMonthly === "string") setMortgageCondoMonthly(data.condoMonthly);
    if (typeof data.utilitiesMonthly === "string") setMortgageUtilitiesMonthly(data.utilitiesMonthly);
    if (typeof data.insuranceYearly === "string") setMortgageInsuranceYearly(data.insuranceYearly);
    if (typeof data.maintenanceYearly === "string") setMortgageMaintenanceYearly(data.maintenanceYearly);
    if (typeof data.otherDebtsMonthly === "string") setMortgageOtherDebtsMonthly(data.otherDebtsMonthly);
    if (typeof data.fixedExpensesMonthly === "string") setMortgageFixedExpensesMonthly(data.fixedExpensesMonthly);
    if (typeof data.liquidAfterPurchase === "string") setMortgageLiquidAfterPurchase(data.liquidAfterPurchase);
    if (typeof data.emergencyMonths === "string") setMortgageEmergencyMonths(data.emergencyMonths);

    if (saved.piesFields) {
      setMortgagePiesFields(cleanMortgagePiesFields(saved.piesFields));
    }

    if (typeof saved.openMortgagePiesSectionId === "string" && mortgagePiesSections.some((section) => section.id === saved.openMortgagePiesSectionId)) {
      setOpenMortgagePiesSectionId(saved.openMortgagePiesSectionId);
    }
  }

  async function loadMortgageCheckFromDb(currentUser: User, localFallback: any = null) {
    try {
      const { data, error } = await supabase
        .from("user_mortgage_checks")
        .select("mortgage_mode, sustainability, pies_fields, open_section_id, updated_at")
        .eq("user_id", currentUser.id)
        .maybeSingle();

      if (error) {
        if (isSupabaseRlsError(error)) {
          console.warn("Mutuo caricato solo in locale: policy RLS di Supabase da verificare per user_mortgage_checks.", error.message);
        } else {
          console.warn("Mutuo caricato solo in locale: errore Supabase.", error.message);
        }
        return;
      }

      if (!data) {
        if (localFallback) {
          saveMortgageCheckToDb(currentUser, localFallback);
        }
        return;
      }

      applyMortgageCheckState({
        mortgageMode: data.mortgage_mode,
        sustainability: data.sustainability,
        piesFields: data.pies_fields,
        openMortgagePiesSectionId: data.open_section_id,
        updatedAt: data.updated_at,
      });
      setMortgageSaveStatus("saved");
      setMortgageLastSavedAt(data.updated_at || null);
      setMortgageSaveMessage("Dati mutuo recuperati da Supabase.");
    } catch (error) {
      console.warn("Mutuo caricato solo in locale: errore non bloccante.", getErrorMessage(error));
    }
  }

  async function saveMortgageCheckToDb(currentUser: User, state: any) {
    try {
      const authUser = await safeGetSupabaseUser("salvataggio mutuo");
      const authUserId = authUser?.id;

      if (!authUserId || authUserId !== currentUser.id) {
        console.warn("Mutuo salvato solo in locale: utente Supabase non ancora confermato.");
        setMortgageSaveStatus("local");
        setMortgageSaveMessage("Salvato sul dispositivo. Sincronizzazione online rimandata.");
        return false;
      }

      const nowIso = new Date().toISOString();
      const { error } = await supabase.from("user_mortgage_checks").upsert(
        {
          user_id: authUserId,
          mortgage_mode: state.mortgageMode,
          sustainability: state.sustainability,
          pies_fields: state.piesFields,
          open_section_id: state.openMortgagePiesSectionId,
          calculated_results: state.results ?? {},
          updated_at: nowIso,
        },
        { onConflict: "user_id" }
      );

      if (error) {
        if (isSupabaseRlsError(error)) {
          console.warn("Mutuo salvato solo in locale: policy RLS di Supabase da verificare per user_mortgage_checks.", error.message);
        } else {
          console.warn("Mutuo salvato solo in locale: errore Supabase.", error.message);
        }
        setMortgageSaveStatus("local");
        setMortgageSaveMessage("Salvato sul dispositivo. Controlla la tabella user_mortgage_checks/RLS su Supabase.");
        return false;
      }

      setMortgageSaveStatus("saved");
      setMortgageLastSavedAt(nowIso);
      setMortgageSaveMessage("Dati mutuo salvati anche online.");
      return true;
    } catch (error) {
      console.warn("Mutuo salvato solo in locale: errore non bloccante.", getErrorMessage(error));
      setMortgageSaveStatus("local");
      setMortgageSaveMessage("Salvato sul dispositivo. Sincronizzazione online non disponibile ora.");
      return false;
    }
  }


  async function forceSaveMortgageCheck() {
    if (!user) return;
    const state = buildMortgageCheckState();
    localStorage.setItem(getMortgageCheckStorageKey(user.id), JSON.stringify(state));
    setMortgageSaveStatus("saving");
    setMortgageSaveMessage("Salvataggio mutuo in corso...");
    await saveMortgageCheckToDb(user, state);
  }

  async function saveHoldingToDb(item: Holding) {
    if (!user) return;

    const { error } = await supabase
      .from("user_holdings")
      .upsert({
        user_id: user.id,
        holding_key: item.id,
        asset_name: item.strumentiName || getStrumentiNameFromHolding(item.category, item.isin),
        category: item.category,
        isin: item.isin,
        amount: item.amount,
        updated_at: new Date().toISOString(),
      })
      .select();

    if (error) {
      console.error("Errore salvataggio holding:", error.message);
    }
  }

  async function deleteHoldingFromDb(holdingKey: string) {
    if (!user) return;

    const { error } = await supabase
      .from("user_holdings")
      .delete()
      .eq("user_id", user.id)
      .eq("holding_key", holdingKey);

    if (error) {
      console.error("Errore eliminazione holding:", error.message);
    }
  }

  async function loadHoldingsFromDb(currentUser: User) {
    const loadKey = currentUser.id;

    // In sviluppo React/Next può rieseguire gli effetti e far partire due fetch identici.
    // Evitiamo richieste sovrapposte: Supabase può interromperne una con AbortError/lock broken.
    if (holdingsLoadKeyRef.current === loadKey) return;

    holdingsLoadKeyRef.current = loadKey;
    const requestId = holdingsLoadRequestIdRef.current + 1;
    holdingsLoadRequestIdRef.current = requestId;

    try {
      const { data, error } = await supabase
        .from("user_holdings")
        .select("*")
        .eq("user_id", currentUser.id)
        .order("created_at", { ascending: true });

      if (requestId !== holdingsLoadRequestIdRef.current) return;

      if (error) {
        const message = getErrorMessage(error);
        if (isSupabaseLockAbortError(error)) {
          console.warn("Caricamento investimenti rimandato: richiesta Supabase sovrapposta.", message);
        } else {
          console.error("Errore caricamento holdings:", message);
        }
        return;
      }

      if (data && data.length > 0) {
        const mapped: Holding[] = data.map((row: any) => ({
          id: row.holding_key,
          category: row.category,
          strumentiName: row.asset_name || row.strumenti_name || getStrumentiNameFromHolding(row.category, row.isin),
          isin: row.isin,
          amount: Number(row.amount || 0),
        }));
        setHoldings(mapped);
      }
    } catch (error) {
      if (requestId !== holdingsLoadRequestIdRef.current) return;

      const message = getErrorMessage(error);
      if (isSupabaseLockAbortError(error)) {
        console.warn("Caricamento investimenti rimandato: richiesta Supabase sovrapposta.", message);
      } else {
        console.error("Errore caricamento holdings:", message);
      }
    } finally {
      if (holdingsLoadKeyRef.current === loadKey) {
        holdingsLoadKeyRef.current = null;
      }
    }
  }

  async function loadCustomInstrumentsFromDb(currentUser: User) {
    const loadKey = currentUser.id;

    if (customInstrumentsLoadKeyRef.current === loadKey) return;

    customInstrumentsLoadKeyRef.current = loadKey;
    const requestId = customInstrumentsLoadRequestIdRef.current + 1;
    customInstrumentsLoadRequestIdRef.current = requestId;

    try {
      const { data, error } = await supabase
        .from("user_custom_instruments")
        .select("*")
        .eq("user_id", currentUser.id)
        .order("created_at", { ascending: true });

      if (requestId !== customInstrumentsLoadRequestIdRef.current) return;

      if (error) {
        const message = getErrorMessage(error);
        if (isSupabaseLockAbortError(error)) {
          console.warn("Caricamento strumenti personali rimandato: richiesta Supabase sovrapposta.", message);
        } else {
          console.error("Errore caricamento strumenti personali:", message);
          setCustomInstrumentMessage("Non riesco a caricare gli strumenti personali. Controlla la tabella Supabase user_custom_instruments.");
        }
        return;
      }

      const mapped: CustomInstrument[] = (data || []).map((row: any) => ({
        id: String(row.id),
        category: row.category as StrumentiCategory,
        name: row.name || row.asset_name || "Strumento personale",
        isin: row.isin || "",
        note: row.note || "",
      }));

      setCustomInstruments(mapped);
    } catch (error) {
      if (requestId !== customInstrumentsLoadRequestIdRef.current) return;

      const message = getErrorMessage(error);
      if (isSupabaseLockAbortError(error)) {
        console.warn("Caricamento strumenti personali rimandato: richiesta Supabase sovrapposta.", message);
      } else {
        console.error("Errore caricamento strumenti personali:", message);
        setCustomInstrumentMessage("Non riesco a caricare gli strumenti personali. Controlla la tabella Supabase user_custom_instruments.");
      }
    } finally {
      if (customInstrumentsLoadKeyRef.current === loadKey) {
        customInstrumentsLoadKeyRef.current = null;
      }
    }
  }

  async function addCustomInstrument() {
    if (!user) return;

    const name = customInstrumentDraft.name.trim();
    const isin = customInstrumentDraft.isin.trim().toUpperCase();
    const note = customInstrumentDraft.note.trim();

    if (!name || !isin) {
      setCustomInstrumentMessage("Inserisci almeno nome strumento e ISIN / ticker.");
      return;
    }

    setCustomInstrumentMessage("");

    const { data, error } = await supabase
      .from("user_custom_instruments")
      .insert({
        user_id: user.id,
        category: customInstrumentDraft.category,
        name,
        isin,
        note: note || null,
        created_at: new Date().toISOString(),
      })
      .select("*")
      .single();

    if (error) {
      console.error("Errore salvataggio strumento personale:", error.message);
      setCustomInstrumentMessage("Errore nel salvataggio. Verifica la tabella Supabase user_custom_instruments e le policy RLS.");
      return;
    }

    const created: CustomInstrument = {
      id: String(data.id),
      category: data.category as StrumentiCategory,
      name: data.name || name,
      isin: data.isin || isin,
      note: data.note || "",
    };

    setCustomInstruments((prev) => [...prev, created]);
    setCustomInstrumentDraft((prev) => ({ ...prev, name: "", isin: "", note: "" }));
    setCustomInstrumentMessage("Strumento personale aggiunto. Ora lo trovi anche nella Dashboard, dentro Aggiungi investimento.");
  }

  async function deleteCustomInstrument(id: string) {
    if (!user) return;

    const instrument = customInstruments.find((item) => item.id === id);
    if (!instrument) return;

    const confirmed = window.confirm(`Eliminare lo strumento personale "${instrument.name}"? Gli investimenti già registrati non verranno cancellati.`);
    if (!confirmed) return;

    const { error } = await supabase
      .from("user_custom_instruments")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);

    if (error) {
      console.error("Errore eliminazione strumento personale:", error.message);
      setCustomInstrumentMessage("Non riesco a eliminare lo strumento. Controlla le policy RLS su Supabase.");
      return;
    }

    setCustomInstruments((prev) => prev.filter((item) => item.id !== id));

    if (newHolding.strumentiName === instrument.name && newHolding.isin === instrument.isin) {
      const fallback = strumentiLibrary[instrument.category][0];
      setNewHolding((prev) => ({
        ...prev,
        category: instrument.category,
        strumentiName: fallback.name,
        isin: fallback.isin,
      }));
    }

    setCustomInstrumentMessage("Strumento personale eliminato.");
  }

  function mapShoppingRow(row: any): ShoppingItem {
    return {
      id: String(row.id),
      name: row.name || "Prodotto",
      category: (row.category || "Altro") as ShoppingCategory,
      estimatedPrice: Number(row.estimated_price || 0),
      isExtra: !!row.is_extra,
      isChecked: !!row.is_checked,
      isCustom: !!row.is_custom,
    };
  }

  async function loadShoppingItemsFromDb(currentUser: User) {
    const loadKey = currentUser.id;

    if (shoppingItemsLoadKeyRef.current === loadKey) return;

    shoppingItemsLoadKeyRef.current = loadKey;
    const requestId = shoppingItemsLoadRequestIdRef.current + 1;
    shoppingItemsLoadRequestIdRef.current = requestId;

    try {
      const { data, error } = await supabase
        .from("user_shopping_items")
        .select("*")
        .eq("user_id", currentUser.id)
        .order("created_at", { ascending: true });

      if (requestId !== shoppingItemsLoadRequestIdRef.current) return;

      if (error) {
        const message = getErrorMessage(error);
        if (isSupabaseLockAbortError(error)) {
          console.warn("Caricamento lista spesa rimandato: richiesta Supabase sovrapposta.", message);
        } else {
          console.error("Errore caricamento lista spesa:", message);
          setShoppingMessage("Non riesco a caricare la lista spesa. Controlla la tabella Supabase user_shopping_items.");
        }
        return;
      }

      setShoppingItems((data || []).map(mapShoppingRow));
    } catch (error) {
      if (requestId !== shoppingItemsLoadRequestIdRef.current) return;

      const message = getErrorMessage(error);
      if (isSupabaseLockAbortError(error)) {
        console.warn("Caricamento lista spesa rimandato: richiesta Supabase sovrapposta.", message);
      } else {
        console.error("Errore caricamento lista spesa:", message);
        setShoppingMessage("Non riesco a caricare la lista spesa. Controlla la tabella Supabase user_shopping_items.");
      }
    } finally {
      if (shoppingItemsLoadKeyRef.current === loadKey) {
        shoppingItemsLoadKeyRef.current = null;
      }
    }
  }

  async function createShoppingItem(input: { name: string; category: ShoppingCategory; estimatedPrice?: number; isExtra?: boolean; isCustom?: boolean }) {
    if (!user) return;

    const name = input.name.trim();
    if (!name) {
      setShoppingMessage("Inserisci il nome del prodotto.");
      return;
    }

    setShoppingLoading(true);
    setShoppingMessage("");

    const { data, error } = await supabase
      .from("user_shopping_items")
      .insert({
        user_id: user.id,
        name,
        category: input.category,
        estimated_price: Number(input.estimatedPrice || 0),
        is_extra: !!input.isExtra,
        is_checked: false,
        is_custom: !!input.isCustom,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select("*")
      .single();

    setShoppingLoading(false);

    if (error) {
      console.error("Errore salvataggio prodotto spesa:", error.message);
      setShoppingMessage("Errore nel salvataggio. Verifica la tabella Supabase user_shopping_items e le policy RLS.");
      return;
    }

    setShoppingItems((prev) => [...prev, mapShoppingRow(data)]);
  }

  async function addShoppingPreset(product: ShoppingPreset) {
    await createShoppingItem({
      name: product.name,
      category: product.category,
      estimatedPrice: product.estimatedPrice,
      isExtra: !!product.isExtra,
      isCustom: false,
    });
  }

  async function addCustomShoppingItem() {
    const price = Number(String(shoppingDraft.estimatedPrice).replace(",", "."));
    await createShoppingItem({
      name: shoppingDraft.name,
      category: shoppingDraft.category,
      estimatedPrice: Number.isFinite(price) ? Math.max(0, price) : 0,
      isExtra: shoppingDraft.isExtra,
      isCustom: true,
    });

    setShoppingDraft((prev) => ({ ...prev, name: "", estimatedPrice: "", isExtra: false }));
  }

  async function toggleShoppingItem(item: ShoppingItem) {
    if (!user) return;

    const nextChecked = !item.isChecked;
    setShoppingItems((prev) => prev.map((current) => (current.id === item.id ? { ...current, isChecked: nextChecked } : current)));

    const { error } = await supabase
      .from("user_shopping_items")
      .update({ is_checked: nextChecked, updated_at: new Date().toISOString() })
      .eq("id", item.id)
      .eq("user_id", user.id);

    if (error) {
      console.error("Errore aggiornamento prodotto spesa:", error.message);
      setShoppingItems((prev) => prev.map((current) => (current.id === item.id ? item : current)));
      setShoppingMessage("Non riesco ad aggiornare il prodotto. Riprova tra poco.");
    }
  }

  async function deleteShoppingItem(item: ShoppingItem) {
    if (!user) return;

    const { error } = await supabase
      .from("user_shopping_items")
      .delete()
      .eq("id", item.id)
      .eq("user_id", user.id);

    if (error) {
      console.error("Errore eliminazione prodotto spesa:", error.message);
      setShoppingMessage("Non riesco a eliminare il prodotto. Riprova tra poco.");
      return;
    }

    setShoppingItems((prev) => prev.filter((current) => current.id !== item.id));
  }

  async function resetShoppingList() {
    if (!user) return;

    setShoppingLoading(true);
    const { error } = await supabase
      .from("user_shopping_items")
      .delete()
      .eq("user_id", user.id);

    setShoppingLoading(false);
    setShowShoppingResetConfirm(false);

    if (error) {
      console.error("Errore reset lista spesa:", error.message);
      setShoppingMessage("Non riesco ad azzerare la lista. Riprova tra poco.");
      return;
    }

    setShoppingItems([]);
    setShoppingMessage("Lista azzerata. Puoi prepararne una nuova partendo dai prodotti comuni.");
  }

  async function loadPacHistoryFromDb(currentUser = user) {
    if (!currentUser) return;

    const portfolioKey = selectedPortfolio.key;
    const loadKey = `${currentUser.id}:${portfolioKey}`;

    // Evita richieste duplicate sullo stesso utente/portafoglio.
    // In modalità sviluppo React/Next può rieseguire gli effetti e far partire due fetch identici.
    if (pacHistoryLoadKeyRef.current === loadKey) return;

    pacHistoryLoadKeyRef.current = loadKey;
    const requestId = pacHistoryRequestIdRef.current + 1;
    pacHistoryRequestIdRef.current = requestId;

    const recentMonths = generateRecentMonths(12).map((month) => ({
      month,
      completed: false,
    }));

    try {
      const { data, error } = await supabase
        .from("user_pac_history")
        .select("*")
        .eq("user_id", currentUser.id)
        .eq("portfolio_key", portfolioKey);

      // Se nel frattempo è partita una richiesta più recente, questa risposta non aggiorna lo stato.
      if (requestId !== pacHistoryRequestIdRef.current) return;

      if (error) {
        const message = String(error.message || "");

        // Questo errore può comparire con richieste sovrapposte in sviluppo.
        // Non è un errore funzionale dei dati: manteniamo lo stato locale senza bloccare l'app.
        if (message.includes("Lock broken") || message.includes("AbortError")) {
          console.warn("Caricamento PAC ignorato perché una richiesta più recente lo ha sostituito.");
          return;
        }

        console.error("Errore caricamento PAC:", message);
        setPacHistory(recentMonths);
        return;
      }

      const mergedHistory = recentMonths.map((month) => {
        const found = data?.find((row: any) => row.month_key === month.month);
        return found ? { ...month, completed: !!found.completed } : month;
      });

      setPacHistory(mergedHistory);
      localStorage.setItem(getPacStorageKey(currentUser.id, portfolioKey), JSON.stringify(mergedHistory));
    } catch (error: any) {
      const message = String(error?.message || error || "");

      if (message.includes("Lock broken") || message.includes("AbortError")) {
        console.warn("Caricamento PAC ignorato perché una richiesta più recente lo ha sostituito.");
        return;
      }

      console.error("Errore caricamento PAC:", message);
      setPacHistory(recentMonths);
    } finally {
      if (pacHistoryLoadKeyRef.current === loadKey) {
        pacHistoryLoadKeyRef.current = null;
      }
    }
  }

  async function savePacMonthToDb(monthKey: string, completed: boolean) {
    if (!user) return;

    const { data: existingRow, error: selectError } = await supabase
      .from("user_pac_history")
      .select("id")
      .eq("user_id", user.id)
      .eq("portfolio_key", selectedPortfolio.key)
      .eq("month_key", monthKey)
      .maybeSingle();

    if (selectError) {
      console.error("Errore controllo PAC:", selectError.message);
      return;
    }

    if (existingRow) {
      const { error } = await supabase
        .from("user_pac_history")
        .update({
          completed,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingRow.id);

      if (error) {
        console.error("Errore aggiornamento PAC:", error.message);
      }

      return;
    }

    const { error } = await supabase
      .from("user_pac_history")
      .insert({
        user_id: user.id,
        portfolio_key: selectedPortfolio.key,
        month_key: monthKey,
        completed,
        updated_at: new Date().toISOString(),
      });

    if (error) {
      console.error("Errore salvataggio PAC:", error.message);
    }
  }


  async function saveChecklistItemToDb(itemId: string, completed: boolean) {
    if (!user) return;

    const { error } = await supabase
      .from("user_checklist")
      .upsert(
        {
          user_id: user.id,
          portfolio_key: selectedPortfolio.key,
          item_id: itemId,
          completed,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "user_id,portfolio_key,item_id",
        }
      )
      .select();

    if (error) {
      console.error("Errore salvataggio guida operativa:", error.message);
    }
  }

  async function loadChecklistFromDb(currentUser: User) {
    const portfolioKey = selectedPortfolio.key;
    const loadKey = `${currentUser.id}:${portfolioKey}`;

    // Evita richieste sovrapposte in sviluppo/refresh sessione: Supabase può
    // interromperne una con AbortError/lock broken. Non è un errore bloccante.
    if (checklistLoadKeyRef.current === loadKey) return;

    checklistLoadKeyRef.current = loadKey;
    const requestId = checklistLoadRequestIdRef.current + 1;
    checklistLoadRequestIdRef.current = requestId;

    try {
      const { data, error } = await supabase
        .from("user_checklist")
        .select("*")
        .eq("user_id", currentUser.id)
        .eq("portfolio_key", portfolioKey);

      if (requestId !== checklistLoadRequestIdRef.current) return;

      if (error) {
        const message = getErrorMessage(error);
        if (isSupabaseLockAbortError(error)) {
          console.warn("Caricamento guida operativa rimandato: richiesta Supabase sovrapposta.", message);
        } else {
          console.error("Errore caricamento guida operativa:", message);
        }
        return;
      }

      if (data && data.length > 0) {
        const mapped: Record<string, boolean> = {};
        data.forEach((row: any) => {
          mapped[row.item_id] = !!row.completed;
        });
        setChecklistState(mapped);
      }
    } catch (error) {
      if (requestId !== checklistLoadRequestIdRef.current) return;

      const message = getErrorMessage(error);
      if (isSupabaseLockAbortError(error)) {
        console.warn("Caricamento guida operativa rimandato: richiesta Supabase sovrapposta.", message);
      } else {
        console.error("Errore caricamento guida operativa:", message);
      }
    } finally {
      if (checklistLoadKeyRef.current === loadKey) {
        checklistLoadKeyRef.current = null;
      }
    }
  }

  function applyGoalData(data: any) {
    setGoalTitle(data.goal_title || data.goalTitle || "Libertà finanziaria");
    setGoalTarget(String(data.goal_target ?? data.goalTarget ?? "100000"));
    setGoalCurrentValue(String(data.goal_current_value ?? data.goalCurrentValue ?? "0"));
    setGoalPreviousValue(String(data.goal_previous_value ?? data.goalPreviousValue ?? "0"));
    setGoalReason((data.goal_reason || data.goalReason || "stabile") as GoalChangeReason);
    setGoalEndYear(String(data.goal_end_year ?? data.goalEndYear ?? new Date().getFullYear() + 10));
    setPortMonthly(String(data.pac_monthly ?? data.portMonthly ?? "200"));
  }

  async function loadGoalFromDb(currentUser: User) {
    const portfolioKey = selectedPortfolio.key;
    const loadKey = `${currentUser.id}:${portfolioKey}`;

    // In sviluppo React/Next può avviare lo stesso caricamento due volte.
    // Evitiamo richieste sovrapposte, che in Supabase possono generare AbortError/lock broken.
    if (goalLoadKeyRef.current === loadKey) return;

    goalLoadKeyRef.current = loadKey;
    const requestId = goalLoadRequestIdRef.current + 1;
    goalLoadRequestIdRef.current = requestId;

    const fallbackGoal = localStorage.getItem(getGoalStorageKey(currentUser.id, portfolioKey));

    const applyFallbackGoal = () => {
      if (fallbackGoal) {
        try {
          applyGoalData(JSON.parse(fallbackGoal));
          return;
        } catch {
          // fall through and apply defaults
        }
      }

      applyGoalData({});
    };

    try {
      const { data, error } = await supabase
        .from("user_goals")
        .select("*")
        .eq("user_id", currentUser.id)
        .eq("portfolio_key", portfolioKey)
        .maybeSingle();

      if (requestId !== goalLoadRequestIdRef.current) return;

      if (error) {
        const message = getErrorMessage(error);

        if (isSupabaseLockAbortError(error)) {
          console.warn("Caricamento obiettivo rimandato: richiesta Supabase sovrapposta.", message);
        } else {
          console.error("Errore caricamento obiettivo:", message);
        }

        applyFallbackGoal();
        setGoalLoaded(true);
        return;
      }

      if (data) {
        applyGoalData(data);
        localStorage.setItem(
          getGoalStorageKey(currentUser.id, portfolioKey),
          JSON.stringify({
            goalTitle: data.goal_title,
            goalTarget: String(data.goal_target ?? "100000"),
            goalCurrentValue: String(data.goal_current_value ?? "0"),
            goalPreviousValue: String(data.goal_previous_value ?? "0"),
            goalReason: data.goal_reason || "stabile",
            goalEndYear: String(data.goal_end_year ?? new Date().getFullYear() + 10),
            portMonthly: String(data.pac_monthly ?? "200"),
          })
        );
        setGoalLoaded(true);
        return;
      }

      applyFallbackGoal();
      setGoalLoaded(true);
    } catch (error) {
      if (requestId !== goalLoadRequestIdRef.current) return;

      const message = getErrorMessage(error);
      if (isSupabaseLockAbortError(error)) {
        console.warn("Caricamento obiettivo rimandato: richiesta Supabase sovrapposta.", message);
      } else {
        console.error("Errore caricamento obiettivo:", message);
      }

      applyFallbackGoal();
      setGoalLoaded(true);
    } finally {
      if (goalLoadKeyRef.current === loadKey) {
        goalLoadKeyRef.current = null;
      }
    }
  }

  async function saveGoalToDb(
    forceSave = false,
    nextGoal?: {
      title?: string;
      target?: string;
      currentValue?: string;
      previousValue?: string;
      reason?: GoalChangeReason;
      endYear?: string;
      monthly?: string;
    }
  ) {
    if (!user || (!goalLoaded && !forceSave)) return;

    const titleToSave = nextGoal?.title ?? goalTitle;
    const targetToSave = nextGoal?.target ?? goalTarget;
    const currentValueToSave = nextGoal?.currentValue ?? goalCurrentValue;
    const previousValueToSave = nextGoal?.previousValue ?? goalPreviousValue;
    const reasonToSave = nextGoal?.reason ?? goalReason;
    const endYearToSave = nextGoal?.endYear ?? goalEndYear;
    const monthlyToSave = nextGoal?.monthly ?? portMonthly;

    const storagePayload = {
      goalTitle: titleToSave,
      goalTarget: targetToSave,
      goalCurrentValue: currentValueToSave,
      goalPreviousValue: previousValueToSave,
      goalReason: reasonToSave,
      goalEndYear: endYearToSave,
      portMonthly: monthlyToSave,
    };

    // Salviamo sempre prima in locale: se Supabase ha una policy RLS da correggere,
    // l'app resta usabile e non perde l'obiettivo dell'utente nella sessione/browser.
    localStorage.setItem(getGoalStorageKey(user.id, selectedPortfolio.key), JSON.stringify(storagePayload));

    try {
      const authUser = await safeGetSupabaseUser("salvataggio obiettivo");
      const authUserId = authUser?.id;

      if (!authUserId || authUserId !== user.id) {
        console.warn("Salvataggio obiettivo solo locale: utente Supabase non ancora confermato.");
        return;
      }

      const payload = {
        user_id: authUserId,
        portfolio_key: selectedPortfolio.key,
        goal_title: titleToSave,
        goal_target: Number(targetToSave || 0),
        goal_current_value: Number(currentValueToSave || 0),
        goal_previous_value: Number(previousValueToSave || 0),
        goal_reason: reasonToSave,
        goal_end_year: Number(endYearToSave || new Date().getFullYear() + 10),
        pac_monthly: Number(monthlyToSave || 0),
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from("user_goals")
        .upsert(payload, {
          onConflict: "user_id,portfolio_key",
        });

      if (error) {
        if (isSupabaseRlsError(error)) {
          console.warn(
            "Salvataggio obiettivo solo locale: policy RLS di Supabase da verificare per user_goals.",
            error.message
          );
        } else {
          console.warn("Salvataggio obiettivo solo locale: errore Supabase.", error.message);
        }
      }
    } catch (error) {
      const message = getErrorMessage(error);
      if (isSupabaseRlsError(error) || isSupabaseLockAbortError(error)) {
        console.warn("Salvataggio obiettivo solo locale: Supabase non disponibile o policy da verificare.", message);
      } else {
        console.warn("Salvataggio obiettivo solo locale: errore non bloccante.", message);
      }
    }
  }

  async function saveGoalUpdateFromDashboard() {
    setGoalSaveStatus("saving");

    const nextGoal = {
      title: draftGoalTitleRef.current?.value ?? draftGoalTitle,
      target: draftGoalTargetRef.current?.value ?? draftGoalTarget,
      currentValue: draftGoalCurrentValueRef.current?.value ?? draftGoalCurrentValue,
      previousValue: draftGoalPreviousValueRef.current?.value ?? draftGoalPreviousValue,
      reason: (draftGoalReasonRef.current?.value as GoalChangeReason | undefined) ?? draftGoalReason,
      endYear: draftGoalEndYearRef.current?.value ?? draftGoalEndYear,
      monthly: portMonthly,
    };

    setDraftGoalTitle(nextGoal.title);
    setDraftGoalTarget(nextGoal.target);
    setDraftGoalCurrentValue(nextGoal.currentValue);
    setDraftGoalPreviousValue(nextGoal.previousValue);
    setDraftGoalReason(nextGoal.reason);
    setDraftGoalEndYear(nextGoal.endYear);
    setGoalTitle(nextGoal.title);
    setGoalTarget(nextGoal.target);
    setGoalCurrentValue(nextGoal.currentValue);
    setGoalPreviousValue(nextGoal.previousValue);
    setGoalReason(nextGoal.reason);
    setGoalEndYear(nextGoal.endYear);

    try {
      await saveGoalToDb(true, nextGoal);
      setGoalSaveStatus("saved");
      window.setTimeout(() => setGoalSaveStatus("idle"), 2200);
    } catch {
      setGoalSaveStatus("error");
    }
  }

  async function savePurchaseToDb(nextPurchase: PurchaseState) {
    if (!user || !nextPurchase.unlocked) return;

    try {
      const authUser = await safeGetSupabaseUser("salvataggio piano");
      const authUserId = authUser?.id;

      if (!authUserId || authUserId !== user.id) {
        console.warn("Salvataggio piano su Supabase saltato: utente autenticato non disponibile.");
        return;
      }

      let purchaseToSave = nextPurchase;

      const { data: existingData, error: existingReadError } = await supabase
        .from("user_purchases")
        .select("*")
        .eq("user_id", authUserId)
        .maybeSingle();

      if (existingReadError && existingReadError.code !== "PGRST116") {
        console.warn("Controllo piano esistente non riuscito, procedo con prudenza:", existingReadError.message);
      }

      if (existingData?.unlocked) {
        const existingPlan = (existingData.plan === "pro" ? "pro" : "core") as PurchasePlan;
        const existingPurchase = normalizePurchaseState(
          {
            unlocked: !!existingData.unlocked,
            email: existingData.email || user.email || "",
            selectedPortfolio: existingData.selected_portfolio || undefined,
            plan: existingPlan,
            paidAmount: Number(existingData.paid_amount ?? (existingPlan === "core" ? 29 : 59)),
            purchasedAt: existingData.purchased_at || undefined,
            upgradedAt: existingData.upgraded_at || undefined,
            expiresAt: existingData.expires_at || undefined,
            lastPaymentType: existingData.last_payment_type || undefined,
          },
          user.email || ""
        );

        const existingRank = getPlanRank(existingPurchase.plan);
        const nextRank = getPlanRank(nextPurchase.plan);
        const existingExpiry = getDateTime(existingPurchase.expiresAt);
        const nextExpiry = getDateTime(nextPurchase.expiresAt);

        // Protezione anti-downgrade: un piano Pro attivo salvato su Supabase non deve
        // essere sovrascritto da uno stato locale Core rimasto vecchio su un altro percorso/dispositivo.
        // A parità di piano, preserviamo anche la scadenza più lunga.
        if (existingPurchase.unlocked && (existingRank > nextRank || (existingRank === nextRank && existingExpiry > nextExpiry))) {
          purchaseToSave = {
            ...existingPurchase,
            email: nextPurchase.email || existingPurchase.email || user.email || "",
            selectedPortfolio: nextPurchase.selectedPortfolio || existingPurchase.selectedPortfolio,
          };
        }
      }

      const plan = purchaseToSave.plan || "core";
      const paidAmount = purchaseToSave.paidAmount ?? (plan === "core" ? 29 : plan === "pro" ? 59 : 0);

      const { error } = await supabase.from("user_purchases").upsert(
        {
          user_id: authUserId,
          email: purchaseToSave.email || user.email || "",
          unlocked: !!purchaseToSave.unlocked,
          plan,
          paid_amount: paidAmount,
          selected_portfolio: purchaseToSave.selectedPortfolio || null,
          purchased_at: purchaseToSave.purchasedAt || new Date().toISOString(),
          upgraded_at: purchaseToSave.upgradedAt || null,
          expires_at: purchaseToSave.expiresAt || addDaysIso(new Date(), PLAN_VALIDITY_DAYS),
          last_payment_type: purchaseToSave.lastPaymentType || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

      if (error) {
        if (isSupabaseRlsError(error)) {
          console.warn("Salvataggio piano solo locale: policy RLS da verificare per user_purchases.", error.message);
        } else {
          console.warn("Salvataggio piano solo locale: errore Supabase.", error.message);
        }
      }
    } catch (error) {
      const message = getErrorMessage(error);
      if (isSupabaseRlsError(error) || isSupabaseLockAbortError(error)) {
        console.warn("Salvataggio piano solo locale: Supabase non disponibile o policy da verificare.", message);
      } else {
        console.warn("Salvataggio piano solo locale: errore non bloccante.", message);
      }
    }
  }

  async function hasSavedGoalForPortfolio(currentUser: User, portfolioKey?: FinalPortfolioKey | string | null) {
    if (!portfolioKey) return false;

    try {
      const { data, error } = await supabase
        .from("user_goals")
        .select("user_id")
        .eq("user_id", currentUser.id)
        .eq("portfolio_key", portfolioKey)
        .maybeSingle();

      if (error) {
        const message = getErrorMessage(error);
        if (isSupabaseLockAbortError(error)) {
          console.warn("Verifica onboarding completato rimandata: richiesta Supabase sovrapposta.", message);
        } else {
          console.warn("Verifica onboarding completato non riuscita:", message);
        }
        return false;
      }

      return !!data;
    } catch (error) {
      const message = getErrorMessage(error);
      if (isSupabaseLockAbortError(error)) {
        console.warn("Verifica onboarding completato rimandata: richiesta Supabase sovrapposta.", message);
      } else {
        console.warn("Verifica onboarding completato non riuscita:", message);
      }
      return false;
    }
  }


  async function hasCompletedDashboardSetupForPortfolio(currentUser: User, portfolioKey?: FinalPortfolioKey | string | null) {
    if (!portfolioKey || !(portfolioKey in portfolioMap)) return false;
    const safePortfolioKey = portfolioKey as FinalPortfolioKey;

    const localGoal = localStorage.getItem(getGoalStorageKey(currentUser.id, safePortfolioKey));
    if (localGoal) {
      try {
        const parsed = JSON.parse(localGoal);
        const hasGoalData =
          parsed.goalTitle ||
          parsed.goalTarget ||
          parsed.goalCurrentValue ||
          parsed.goalEndYear ||
          parsed.portMonthly;

        if (hasGoalData) return true;
      } catch {
        return true;
      }
    }

    return await hasSavedGoalForPortfolio(currentUser, portfolioKey);
  }

  async function loadPurchaseFromDb(currentUser: User) {
    try {
      const { data, error } = await supabase
        .from("user_purchases")
        .select("*")
        .eq("user_id", currentUser.id)
        .maybeSingle();

      if (error) {
        if (error.code !== "PGRST116") {
          console.warn("Caricamento piano da Supabase non riuscito:", error.message);
        }
        return;
      }

      if (!data?.unlocked) return;

      const remotePlan = (data.plan === "pro" ? "pro" : "core") as PurchasePlan;
      const remotePurchase = normalizePurchaseState(
        {
          unlocked: !!data.unlocked,
          email: data.email || currentUser.email || "",
          selectedPortfolio: data.selected_portfolio || undefined,
          plan: remotePlan,
          paidAmount: Number(data.paid_amount ?? (remotePlan === "core" ? 29 : 59)),
          purchasedAt: data.purchased_at || undefined,
          upgradedAt: data.upgraded_at || undefined,
          expiresAt: data.expires_at || undefined,
          lastPaymentType: data.last_payment_type || undefined,
        },
        currentUser.email || ""
      );

      localStorage.setItem(getPurchaseKey(currentUser.id), JSON.stringify(remotePurchase));

      setPurchase((prev) => ({
        ...remotePurchase,
        email: remotePurchase.email || prev.email || "",
        selectedPortfolio: remotePurchase.selectedPortfolio || prev.selectedPortfolio,
      }));

      const savedStep = localStorage.getItem(`soldi-semplici-last-step-${currentUser.id}`) as AppStep | null;
      const allowedPaidSteps: AppStep[] = ["portfolio", "guide", "dashboard", "awareness", "strumentis", "rebalance", "exit"];
      const shouldAutoRoute = ["home", "quiz", "preview", "paywall", "onboarding"].includes(step);

      if (!remotePurchase.unlocked) {
        if (shouldAutoRoute || step === "dashboard") setStep("paywall");
        return;
      }

      if (savedStep && allowedPaidSteps.includes(savedStep)) {
        setStep(savedStep);
      } else if (shouldAutoRoute) {
        const onboardingAlreadyCompleted =
          remotePlan !== "core" || await hasSavedGoalForPortfolio(currentUser, remotePurchase.selectedPortfolio);
        setStep(onboardingAlreadyCompleted ? "dashboard" : "onboarding");
      }
    } catch (error) {
      const message = getErrorMessage(error);
      if (isSupabaseLockAbortError(error)) {
        console.warn("Caricamento piano da Supabase ignorato per richiesta interrotta:", message);
      } else {
        console.warn("Caricamento piano da Supabase non riuscito:", message);
      }
    }
  }

  async function saveUserProfile(profile: {
    selected_portfolio: string;
    quiz_answers: number[];
  }) {
    if (!user) return;

    const { error } = await supabase
      .from("user_profiles")
      .upsert({
        id: user.id,
        email: user.email,
        selected_portfolio: profile.selected_portfolio,
        quiz_answers: profile.quiz_answers,
        updated_at: new Date().toISOString(),
      })
      .select();

    if (error) {
      console.error("Errore salvataggio profilo:", error.message);
    }
  }

  async function loadUserProfile(currentUser: User) {
    const loadKey = currentUser.id;

    // Evita richieste duplicate durante boot, login/logout o refresh sessione.
    // In sviluppo Next/React Supabase può interrompere una richiesta sovrapposta
    // con AbortError/lock broken: non deve aprire l'overlay di errore.
    if (profileLoadKeyRef.current === loadKey) return;

    profileLoadKeyRef.current = loadKey;

    try {
      const { data, error } = await supabase
        .from("user_profiles")
        .select("*")
        .eq("id", currentUser.id)
        .single();

      if (error) {
        if (error.code !== "PGRST116") {
          const message = getErrorMessage(error);
          if (isSupabaseLockAbortError(error)) {
            console.warn("Caricamento profilo rimandato: richiesta Supabase sovrapposta.", message);
          } else {
            console.error("Errore caricamento profilo:", message);
          }
        }
        return;
      }

      if (data) {
        const savedPortfolio = data.selected_portfolio || undefined;
        const localPurchaseRaw = localStorage.getItem(getPurchaseKey(currentUser.id));
        let localPurchase: PurchaseState | null = null;

        try {
          localPurchase = localPurchaseRaw ? normalizePurchaseState(JSON.parse(localPurchaseRaw), currentUser.email || "") : null;
        } catch {
          localPurchase = null;
        }

        const paidUnlocked = !!localPurchase?.unlocked;

        setPurchase((prev) => {
          const sourcePurchase = prev.unlocked ? prev : localPurchase || prev;
          const shouldStayUnlocked = !!prev.unlocked || paidUnlocked;
          const resolvedPlan = prev.unlocked ? prev.plan : localPurchase?.plan;
          const resolvedPaidAmount =
            prev.unlocked
              ? prev.paidAmount ?? (prev.plan === "core" ? 29 : prev.plan === "pro" ? 59 : 0)
              : localPurchase?.paidAmount ?? (localPurchase?.plan === "core" ? 29 : localPurchase?.plan === "pro" ? 59 : 0);

          return {
            ...sourcePurchase,
            unlocked: shouldStayUnlocked,
            email: data.email || currentUser.email || prev.email || "",
            selectedPortfolio: savedPortfolio || prev.selectedPortfolio || localPurchase?.selectedPortfolio,
            plan: resolvedPlan,
            paidAmount: resolvedPaidAmount,
            purchasedAt: sourcePurchase.purchasedAt,
            upgradedAt: sourcePurchase.upgradedAt,
            expiresAt: sourcePurchase.expiresAt,
            lastPaymentType: sourcePurchase.lastPaymentType,
          };
        });

        if (Array.isArray(data.quiz_answers) && data.quiz_answers.length === questions.length) {
          setAnswers(data.quiz_answers);
        }

        if (savedPortfolio) {
          const savedStep = localStorage.getItem(`soldi-semplici-last-step-${currentUser.id}`) as AppStep | null;
          const allowedPaidSteps: AppStep[] = ["portfolio", "guide", "dashboard", "awareness", "strumentis", "rebalance", "exit"];
          const shouldAutoRoute = ["home", "quiz", "preview", "paywall", "onboarding"].includes(step);

          if (paidUnlocked && savedStep && allowedPaidSteps.includes(savedStep)) {
            setStep(savedStep);
          } else if (shouldAutoRoute) {
            setStep(paidUnlocked ? "dashboard" : "portfolio");
          }
        }
      }
    } catch (error) {
      const message = getErrorMessage(error);
      if (isSupabaseLockAbortError(error)) {
        console.warn("Caricamento profilo rimandato: richiesta Supabase sovrapposta.", message);
      } else {
        console.error("Errore caricamento profilo:", message);
      }
    } finally {
      if (profileLoadKeyRef.current === loadKey) {
        profileLoadKeyRef.current = null;
      }
    }
  }

  function hasCompletedQuizOrPlan() {
    return Boolean(purchase.selectedPortfolio) || answers.every((answer) => answer !== -1);
  }

  function goToPaywallTop() {
    setStep("paywall");
    if (typeof window !== "undefined") {
      window.setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
    }
  }

  function goToSafeHome() {
    if (purchase.unlocked) {
      setStep("dashboard");
      return;
    }

    if (hasCompletedQuizOrPlan()) {
      setStep("portfolio");
      return;
    }

    setStep("home");
  }

  function startQuizFlow() {
    if (purchase.unlocked) {
      setShowRetakeWarning(true);
      return;
    }

    if (hasCompletedQuizOrPlan()) {
      setStep("portfolio");
      return;
    }

    void trackEvent("start_test");
    setCurrentQuestion(0);
    setStep("quiz");
  }

  function confirmRetakeQuiz() {
    if (!user || retakeIsBlocked) return;

    const nextMeta = {
      count: retakeMeta.count + 1,
      lastAt: new Date().toISOString(),
    };

    setRetakeMeta(nextMeta);
    localStorage.setItem(getRetakeStorageKey(user.id), JSON.stringify(nextMeta));

    setAnswers(Array(questions.length).fill(-1));
    setCurrentQuestion(0);
    setShowRetakeWarning(false);
    void trackEvent("start_test", { retake: true, reason: retakeReason });
    setStep("quiz");
  }

  function cancelRetakeQuiz() {
    setShowRetakeWarning(false);
    setRetakeReason("situazione");
  }

  function selectAnswer(index: number) {
    const updated = [...answers];
    updated[currentQuestion] = index;
    setAnswers(updated);
  }

  async function nextQuestion() {
    if (!hasAnsweredCurrent) return;
    if (currentQuestion === questions.length - 1) {
      const finalPortfolio = scoreResult.finalPortfolio;
      const previewPurchase: PurchaseState = {
        ...purchase,
        email: user?.email || purchase.email,
        selectedPortfolio: finalPortfolio,
      };

      setPurchase(previewPurchase);
      if (user) {
        localStorage.setItem(getPurchaseKey(user.id), JSON.stringify(previewPurchase));
        await saveUserProfile({
          selected_portfolio: finalPortfolio,
          quiz_answers: answers,
        });
      }

      await trackEvent("finish_test", { portfolio: scoreResult.portfolio.title });
      await trackEvent("view_plan", { portfolio: scoreResult.portfolio.title, step: "preview" });
      setStep("preview");
      return;
    }
    setCurrentQuestion((prev) => prev + 1);
  }

  function previousQuestion() {
    if (currentQuestion === 0) {
      goToSafeHome();
      return;
    }
    setCurrentQuestion((prev) => prev - 1);
  }

  async function unlockPlan(plan: PurchasePlan = "core") {
    const finalPortfolio = purchase.selectedPortfolio || scoreResult.finalPortfolio;
    const currentPaid = purchase.paidAmount ?? (purchase.plan === "core" ? 29 : purchase.plan === "pro" ? 59 : 0);
    const now = new Date();
    const isActiveCoreUpgrade = plan === "pro" && purchase.unlocked && purchase.plan === "core" && isPurchaseDateValid(purchase.expiresAt);
    const isRenewal = !purchase.unlocked && !!purchase.expiresAt;
    const dashboardSetupAlreadyCompleted = user
      ? await hasCompletedDashboardSetupForPortfolio(user, finalPortfolio)
      : false;
    const shouldRunDashboardSetup = plan === "core" && !dashboardSetupAlreadyCompleted;
    const nextPaidAmount = plan === "pro" ? 59 : Math.max(currentPaid, 29);
    const paymentType: PurchasePaymentType = isActiveCoreUpgrade
      ? "upgrade_core_to_pro"
      : plan === "pro"
        ? isRenewal ? "renew_pro" : "new_pro"
        : isRenewal ? "renew_core" : "new_core";
    const updatedPurchase: PurchaseState = {
      unlocked: true,
      email: user?.email || purchase.email,
      selectedPortfolio: finalPortfolio,
      plan,
      paidAmount: nextPaidAmount,
      purchasedAt: isActiveCoreUpgrade ? purchase.purchasedAt || now.toISOString() : now.toISOString(),
      upgradedAt: isActiveCoreUpgrade ? now.toISOString() : undefined,
      expiresAt: addDaysIso(now, PLAN_VALIDITY_DAYS),
      lastPaymentType: paymentType,
    };

    setPurchase(updatedPurchase);
    if (user) {
      localStorage.setItem(getPurchaseKey(user.id), JSON.stringify(updatedPurchase));
      await savePurchaseToDb(updatedPurchase);
    }

    if (shouldRunDashboardSetup) {
      setGoalTitle("Libertà finanziaria");
      setGoalTarget("100000");
      setGoalCurrentValue("0");
      setGoalPreviousValue("0");
      setGoalReason("stabile");
      setGoalEndYear(String(new Date().getFullYear() + 20));
      setPortMonthly("200");
      setPortYears("20");
      setOnboardingStep(0);
    }

    await saveUserProfile({
      selected_portfolio: finalPortfolio,
      quiz_answers: answers,
    });

    const marketingAmount = plan === "core" ? 29 : isActiveCoreUpgrade ? 30 : 59;
    if (plan === "core") {
      await trackEvent("buy_core", { amount: marketingAmount, validity_days: PLAN_VALIDITY_DAYS, portfolio: portfolioMap[finalPortfolio].title });
    } else {
      const eventName = isActiveCoreUpgrade ? "upgrade_pro" : "buy_pro";
      await trackEvent(eventName, { amount: marketingAmount, validity_days: PLAN_VALIDITY_DAYS, portfolio: portfolioMap[finalPortfolio].title });
    }
    await recordMarketingConversion(plan, marketingAmount, paymentType);

    setShowProUpgradeModal(false);
    setStep(shouldRunDashboardSetup ? "onboarding" : "dashboard");
  }

  function requestProUpgrade() {
    setShowProUpgradeModal(true);
  }

  function cancelProUpgrade() {
    setShowProUpgradeModal(false);
  }

  async function startFreePlan() {
    const finalPortfolio = scoreResult.finalPortfolio;
    setPurchase((prev) => ({
      ...prev,
      email: user?.email || prev.email,
      selectedPortfolio: finalPortfolio,
    }));
    setGoalTitle("Libertà finanziaria");
    setGoalTarget("100000");
    setGoalCurrentValue("0");
    setGoalPreviousValue("0");
    setGoalReason("stabile");
    setGoalEndYear(String(new Date().getFullYear() + 20));
    setPortMonthly("200");
    setPortYears("20");
    setOnboardingStep(0);

    await saveUserProfile({
      selected_portfolio: finalPortfolio,
      quiz_answers: answers,
    });

    await trackEvent("view_plan", { portfolio: portfolioMap[finalPortfolio].title, step: "portfolio" });
    setStep("portfolio");
  }

  async function completeOnboarding() {
    const years = Math.max(0, Number(goalEndYear || new Date().getFullYear()) - new Date().getFullYear());
    setPortYears(String(years));
    setGoalLoaded(true);
    await saveGoalToDb(true);
    goToFirstTimeGuide();
  }

  function updateCategory(category: StrumentiCategory) {
    const firstStrumenti = allInstrumentsByCategory[category]?.[0] || strumentiLibrary[category][0];
    setNewHolding({
      category,
      strumentiName: firstStrumenti.name,
      isin: firstStrumenti.isin,
      amount: newHolding.amount,
    });
  }

  function addHolding() {
    const amount = Number(newHolding.amount.replace(",", "."));
    if (!amount || amount <= 0) return;
    const item: Holding = {
      id: `${Date.now()}`,
      category: newHolding.category,
      strumentiName: newHolding.strumentiName,
      isin: newHolding.isin,
      amount,
    };
    setHoldings((prev) => [...prev, item]);
    saveHoldingToDb(item);
    setNewHolding((prev) => ({ ...prev, amount: "" }));
  }

  function removeHolding(id: string) {
    setHoldings((prev) => prev.filter((item) => item.id !== id));
    deleteHoldingFromDb(id);
  }

  function toggleChecklist(id: string) {
    const nextValue = !checklistState[id];
    setChecklistState((prev) => ({ ...prev, [id]: nextValue }));
    saveChecklistItemToDb(id, nextValue);
  }

  function completeChecklistItem(id: string) {
    if (checklistState[id]) return;
    setChecklistState((prev) => ({ ...prev, [id]: true }));
    saveChecklistItemToDb(id, true);
  }

  function togglePacMonth(month: string) {
    const current = pacHistory.find((item) => item.month === month);
    const nextValue = !current?.completed;

    if (nextValue) {
      setPacJustCompleted(true);
      window.setTimeout(() => setPacJustCompleted(false), 2400);
    }

    const exists = !!current;
    const updated = exists
      ? pacHistory.map((item) =>
          item.month === month ? { ...item, completed: nextValue } : item
        )
      : [...pacHistory, { month, completed: nextValue }].sort((a, b) => a.month.localeCompare(b.month));

    setPacHistory(updated);
    savePacMonthToDb(month, nextValue);
  }

  function openDashboardTab(tab: DashboardTab) {
    setStep("dashboard");
    setDashboardActiveTab(tab);
    window.setTimeout(() => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }, 80);
  }

  function goToDashboardSection(sectionId: string) {
    const monitorSections = new Set(["azione-del-mese", "storico-pac", "validità-piano"]);
    const guideSections = new Set(["prima-volta-qui"]);
    const tab: DashboardTab = guideSections.has(sectionId)
      ? "guida"
      : monitorSections.has(sectionId)
      ? "monitor"
      : "portafoglio";

    setStep("dashboard");
    setDashboardActiveTab(tab);
    window.setTimeout(() => {
      document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 160);
  }

  function goBackToGuideFromDashboard() {
    openDashboardTab("guida");
  }

  function goToFirstTimeGuide() {
    openDashboardTab("guida");
  }

  function getChecklistToolAction(id: string): { label: string; onClick: () => void } | null {
    if (!purchase.unlocked) return null;

    const actions: Record<string, { label: string; onClick: () => void } | null> = {
      broker: null,
      strumenti: null,
      percentuali: { label: "Calcola quote PAC", onClick: () => goToDashboardSection("aggiungi-investimento") },
      pac_start: { label: "Segna PAC del mese", onClick: () => goToDashboardSection("azione-del-mese") },
      controllo: null,
      rebalance: {
        label: "Ribilanciamento",
        onClick: () => {
          void trackEvent("open_rebalance_from_guide");
          setStep("rebalance");
          window.setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 80);
        },
      },
      aggiorna_capitale: { label: "Aggiorna capitale", onClick: () => goToDashboardSection("obiettivo-personale") },
    };

    return actions[id] || null;
  }

  function handleGuideToolAction(itemId: string, action: { label: string; onClick: () => void }) {
    setGuideActionVisited((prev) => ({ ...prev, [itemId]: true }));
    action.onClick();
  }

  function clearLocalProfileData(currentUser: User) {
    const prefix = getPrefix(currentUser.id);

    // Reset test davvero totale: elimina anche eventuali chiavi vecchie
    // o residue create da versioni precedenti dell app.
    Object.keys(localStorage).forEach((key) => {
      if (key.startsWith(prefix)) {
        localStorage.removeItem(key);
      }
    });

    localStorage.removeItem(getPurchaseKey(currentUser.id));
    localStorage.removeItem(getHoldingsKey(currentUser.id));
    localStorage.removeItem(getRetakeStorageKey(currentUser.id));

    Object.keys(portfolioMap).forEach((key) => {
      localStorage.removeItem(getChecklistStorageKey(currentUser.id, key as FinalPortfolioKey));
      localStorage.removeItem(getPacStorageKey(currentUser.id, key as FinalPortfolioKey));
      localStorage.removeItem(getGoalStorageKey(currentUser.id, key as FinalPortfolioKey));
      localStorage.removeItem(getProgressStorageKey(currentUser.id, key as FinalPortfolioKey));
    });
  }

  function resetClientState() {
    setAnswers(Array(questions.length).fill(-1));
    setCurrentQuestion(0);
    setPurchase({ unlocked: false, email: user?.email || "", selectedPortfolio: undefined, paidAmount: 0, expiresAt: undefined, purchasedAt: undefined, upgradedAt: undefined, lastPaymentType: undefined });
    setHoldings([]);
    setChecklistState({});
    setPacHistory(generateRecentMonths(12).map((month) => ({ month, completed: false })));
    setCheckedPacAllocations({});
    setRetakeMeta({ count: 0, lastAt: null });
    setGoalTitle("Libertà finanziaria");
    setGoalTarget("100000");
    setGoalCurrentValue("0");
    setGoalPreviousValue("0");
    setGoalReason("stabile");
    setGoalEndYear(String(new Date().getFullYear() + 10));
    setProgressStartValue("0");
    setProgressStartMonth("");
    setOnboardingStep(0);
    setStep("home");
  }

  async function loadAdminOverview() {
    if (!user || !isAdminAccount) return;

    setAdminLoading(true);
    setAdminMessage("");

    try {
      const { data, error } = await supabase.rpc("admin_get_overview");
      if (error) {
        setAdminMessage("Impossibile caricare la plancia admin. Controlla di aver eseguito lo script SQL admin su Supabase.");
        console.warn("Admin overview non disponibile:", error.message);
        return;
      }

      setAdminOverview((data || null) as AdminOverview | null);
    } catch (error) {
      setAdminMessage("Errore nel caricamento della plancia admin. Riprova o controlla Supabase.");
      console.warn("Admin overview errore:", error);
    } finally {
      setAdminLoading(false);
    }
  }

  async function resetAdminTestData() {
    if (!user || !isAdminAccount) return;

    if (adminResetConfirm.trim().toUpperCase() !== "AZZERA") {
      setAdminMessage("Per confermare il reset scrivi AZZERA nel campo di sicurezza.");
      return;
    }

    setAdminResetLoading(true);
    setAdminMessage("");

    try {
      const { data, error } = await supabase.rpc("admin_reset_test_data");
      if (error) {
        setAdminMessage("Reset non eseguito. Controlla policy/funzioni admin su Supabase.");
        console.warn("Reset admin non riuscito:", error.message);
        return;
      }

      setAdminMessage("Dati di test azzerati. Gli account auth non sono stati cancellati.");
      setAdminResetConfirm("");
      void trackEvent("admin_reset_test_data", { admin_email: user.email || "", result: data || null });
      await loadAdminOverview();
    } catch (error) {
      setAdminMessage("Errore durante il reset admin. Riprova o controlla Supabase.");
      console.warn("Reset admin errore:", error);
    } finally {
      setAdminResetLoading(false);
    }
  }

  async function resetAll() {
    if (!user) return;

    const confirmed = window.confirm(
      "Vuoi azzerare il profilo di test? Cancellerai test, modello scelto, obiettivo, PAC, checklist e strumenti salvati. L'account rimane attivo."
    );

    if (!confirmed) return;

    setProfileResetLoading(true);
    setProfileResetMessage("");

    clearLocalProfileData(user);
    resetClientState();

    const operations = await Promise.all([
      supabase.from("user_profiles").delete().eq("id", user.id),
      supabase.from("user_holdings").delete().eq("user_id", user.id),
      supabase.from("user_pac_history").delete().eq("user_id", user.id),
      supabase.from("user_checklist").delete().eq("user_id", user.id),
      supabase.from("user_goals").delete().eq("user_id", user.id),
      supabase.from("user_custom_instruments").delete().eq("user_id", user.id),
      supabase.from("user_purchases").delete().eq("user_id", user.id),
    ]);

    // Seconda protezione per i test: se la DELETE del profilo non passa per policy/RLS,
    // almeno svuotiamo il modello salvato così il prossimo quiz non eredita il piano precedente.
    await supabase
      .from("user_profiles")
      .upsert({
        id: user.id,
        email: user.email,
        selected_portfolio: null,
        quiz_answers: [],
        updated_at: new Date().toISOString(),
      });

    const firstError = operations.find((result) => result.error)?.error;

    // Dopo le scritture asincrone, puliamo di nuovo per evitare che qualche useEffect
    // abbia risalvato purchase/retake mentre il reset era in corso.
    clearLocalProfileData(user);
    resetClientState();
    setProfileResetLoading(false);

    if (firstError) {
      console.error("Reset profilo parziale:", firstError.message);
      setProfileResetMessage(
        "Profilo locale azzerato. Alcuni dati online potrebbero non essere stati cancellati: controlla le policy Supabase/RLS."
      );
      return;
    }

    setProfileResetMessage("Profilo azzerato. Puoi rifare il test come nuovo utente.");
  }

  useEffect(() => {
    if (step === "admin" && isAdminAccount) {
      void trackEvent("open_admin_dashboard", { admin_email: user?.email || "" });
      void loadAdminOverview();
    }
  }, [step, isAdminAccount, user?.id]);

  useEffect(() => {
    if (step !== "dashboard") {
      dashboardRouteKeyRef.current = "";
      return;
    }

    const routeKey = `${user?.id || "anon"}:${setupCompleted ? "ready" : "setup"}`;
    if (dashboardRouteKeyRef.current === routeKey) return;

    dashboardRouteKeyRef.current = routeKey;
    setDashboardActiveTab(setupCompleted ? "monitor" : "guida");
  }, [step, setupCompleted, user?.id]);

  const mortgageLastSavedLabel = mortgageLastSavedAt
    ? new Date(mortgageLastSavedAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })
    : "";
  const mortgageSaveStatusLabel = mortgageSaveStatus === "saving"
    ? "Salvataggio in corso..."
    : mortgageSaveStatus === "saved"
    ? `Salvato su Supabase${mortgageLastSavedLabel ? ` alle ${mortgageLastSavedLabel}` : ""}`
    : mortgageSaveStatus === "local"
    ? "Salvato in locale, sincronizzazione online da verificare"
    : mortgageSaveStatus === "error"
    ? "Errore di salvataggio online"
    : "Salvataggio automatico attivo";
  const mortgageSaveStatusClass = mortgageSaveStatus === "saved"
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : mortgageSaveStatus === "saving"
    ? "border-sky-200 bg-sky-50 text-sky-800"
    : mortgageSaveStatus === "local" || mortgageSaveStatus === "error"
    ? "border-amber-200 bg-amber-50 text-amber-900"
    : "border-slate-200 bg-slate-50 text-slate-600";

  if (!authReady || (user && appBootLoading && authMode !== "updatePassword")) {
    return (
      <main className="min-h-screen overflow-x-hidden bg-slate-50 text-slate-900">
        <div className="mx-auto flex min-h-screen max-w-xl items-center justify-center px-6">
          <div className="w-full rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <div className="mx-auto inline-flex rounded-3xl border border-emerald-100 bg-white/90 p-4 shadow-sm">
              <SoldiSempliciLogo size="compact" showTagline={false} />
            </div>
            <div className="mx-auto mt-6 h-2 w-40 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full w-1/2 animate-pulse rounded-full bg-emerald-600" />
            </div>
            <p className="mt-6 text-lg font-bold text-slate-950">
              {user ? "Sto preparando la tua area personale..." : "Caricamento in corso..."}
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              {user
                ? "Controllo piano, profilo e dati principali prima di aprire la Dashboard."
                : "Verifico la sessione prima di mostrarti l'app."}
            </p>
          </div>
        </div>
      </main>
    );
  }

  if (authMode === "updatePassword") {
    return (
      <main className="min-h-screen overflow-x-hidden bg-slate-50 text-slate-900">
        <div className="mx-auto flex min-h-screen w-full max-w-xl items-center justify-center px-4 py-8 sm:px-6">
          <div className="w-full rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <div className="inline-flex rounded-3xl border border-emerald-100 bg-white/85 p-4 shadow-sm backdrop-blur">
              <SoldiSempliciLogo size="compact" showTagline={false} />
            </div>
            <p className="mt-7 text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">Recupero password</p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Imposta una nuova password</h1>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              Inserisci una nuova password per il tuo account Soldi Semplici. Dopo il salvataggio potrai continuare il percorso normalmente.
            </p>

            <div className="mt-6 space-y-4">
              <div>
                <label className="text-sm font-medium text-slate-700">Nuova password</label>
                <div className="mt-2 relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    placeholder="Almeno 8 caratteri"
                    className="w-full rounded-xl border border-slate-200 px-4 py-3 pr-12 outline-none transition focus:border-slate-400"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500 hover:text-slate-700"
                  >
                    {showPassword ? "Nascondi" : "Mostra"}
                  </button>
                </div>
              </div>

              <div>
                <label className="text-sm font-medium text-slate-700">Conferma nuova password</label>
                <input
                  type={showPassword ? "text" : "password"}
                  value={authConfirmPassword}
                  onChange={(e) => setAuthConfirmPassword(e.target.value)}
                  placeholder="Ripeti la nuova password"
                  className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                />
              </div>

              {authMessage && (
                <div className={`rounded-2xl border p-4 text-sm leading-6 ${authMessage.toLowerCase().includes("correttamente") || authMessage.toLowerCase().includes("inserisci") ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-800"}`}>
                  {authMessage}
                </div>
              )}

              <button
                type="button"
                onClick={handlePasswordUpdate}
                disabled={authLoading}
                className="w-full rounded-xl bg-emerald-600 px-6 py-3 font-semibold text-white shadow-sm transition hover:bg-emerald-700 hover:shadow-md active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {authLoading ? "Salvataggio..." : "Salva nuova password"}
              </button>
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="min-h-screen overflow-x-hidden bg-slate-50 text-slate-900">
        <div className="mx-auto grid min-h-screen w-full max-w-6xl gap-6 overflow-x-hidden px-3 py-6 sm:px-6 sm:py-10 lg:grid-cols-[1.15fr_0.85fr]">
          <section className="relative overflow-hidden rounded-3xl border border-slate-200 bg-white p-8 shadow-sm md:p-10">
            <div className="absolute right-[-90px] top-[-90px] h-64 w-64 rounded-full bg-emerald-100 blur-3xl" />
            <div className="absolute bottom-[-100px] left-[-100px] h-72 w-72 rounded-full bg-sky-100 blur-3xl" />

            <div className="relative">
              <div className="inline-flex rounded-3xl border border-emerald-100 bg-white/85 p-4 shadow-sm backdrop-blur">
                <SoldiSempliciLogo size="large" showTagline />
              </div>
              <h1 className="mt-7 max-w-3xl text-4xl font-bold tracking-tight text-slate-950 md:text-6xl">
                Gestisci i tuoi soldi con più metodo e meno confusione.
              </h1>
              <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-600">
                Crea il tuo piano, segui la guida operativa e usa strumenti semplici per investimenti, risparmio, auto, mutuo, spesa intelligente e anti-truffe.
              </p>

              <div className="mt-8 grid gap-4 md:grid-cols-3">
                <FeatureCard title="Piano personalizzato" text="Modello, PAC e guida passo passo per sapere cosa fare adesso." />
                <FeatureCard title="Costruisci il PAC" text="Imposti una cifra mensile sostenibile e segui un percorso ordinato, senza confusione." />
                <FeatureCard title="Gestisci nel tempo" text="Con il Pro trovi ribilanciamento guidato e strategie di uscita più avanzate." />
              </div>

              <div className="mt-8 rounded-3xl border border-slate-200 bg-slate-50 p-5">
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">Perché registrarti</p>
                <div className="mt-4 grid gap-3 text-sm leading-6 text-slate-700 md:grid-cols-2">
                  <div className="rounded-2xl bg-white p-4">✓ Crei il tuo piano gratuitamente prima di pagare.</div>
                  <div className="rounded-2xl bg-white p-4">✓ Salvi test, modello, PAC e progressi.</div>
                  <div className="rounded-2xl bg-white p-4">✓ Nessuna esperienza finanziaria richiesta.</div>
                  <div className="rounded-2xl bg-white p-4">✓ Nessuna consulenza personalizzata: solo educazione guidata.</div>
                </div>
              </div>
            </div>
          </section>

          <aside className="flex items-center">
            <div className="w-full rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <div className="mb-6 flex justify-end">
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">Accesso sicuro</span>
              </div>
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
                  {authMode === "login" ? "Bentornato" : authMode === "reset" ? "Recupera password" : "Crea il tuo piano"}
                </p>
                <h2 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
                  {authMode === "login" ? "Accedi" : authMode === "reset" ? "Recupera l'accesso" : "Inizia gratis"}
                </h2>
                <p className="mt-3 text-sm leading-6 text-slate-600">
                  {authMode === "login"
                    ? "Rientra nel tuo percorso e continua da dove eri rimasto."
                    : authMode === "reset"
                      ? "Inserisci l'email del tuo account: ti invieremo un link per impostare una nuova password."
                      : "Crea un account per salvare il tuo piano e arrivare al modello senza pagare."}
                </p>
              </div>

              <div className="mt-6 grid grid-cols-2 gap-2 rounded-2xl bg-slate-100 p-1.5">
                <button
                  type="button"
                  onClick={() => { setAuthMode("register"); setAuthMessage(""); }}
                  className={`rounded-xl px-4 py-3 text-sm font-semibold transition ${
                    authMode === "register"
                      ? "bg-emerald-600 text-white shadow-sm"
                      : "bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  Inizia gratis
                </button>
                <button
                  type="button"
                  onClick={() => { setAuthMode("login"); setAuthMessage(""); }}
                  className={`rounded-xl px-4 py-3 text-sm font-semibold transition ${
                    authMode === "login"
                      ? "bg-emerald-600 text-white shadow-sm"
                      : "bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  Ho già un account
                </button>
              </div>

              <div className="mt-6 space-y-4">
                <div>
                  <label className="text-sm font-medium text-slate-700">Email</label>
                  <input
                    type="email"
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    placeholder="nome@email.it"
                    className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                  />
                </div>

                {authMode !== "reset" && (
                  <div>
                    <label className="text-sm font-medium text-slate-700">Password</label>
                    <div className="mt-2 relative">
                      <input
                        type={showPassword ? "text" : "password"}
                        value={authPassword}
                        onChange={(e) => setAuthPassword(e.target.value)}
                        placeholder="Inserisci la password"
                        className="w-full rounded-xl border border-slate-200 px-4 py-3 pr-12 outline-none transition focus:border-slate-400"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((prev) => !prev)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500 hover:text-slate-700"
                      >
                        {showPassword ? "Nascondi" : "Mostra"}
                      </button>
                    </div>
                    {authMode === "login" && (
                      <button
                        type="button"
                        onClick={() => { setAuthMode("reset"); setAuthMessage(""); setAuthPassword(""); setAuthConfirmPassword(""); }}
                        className="mt-3 text-sm font-semibold text-emerald-700 hover:text-emerald-800"
                      >
                        Hai dimenticato la password?
                      </button>
                    )}
                  </div>
                )}

                {authMode === "register" && (
                  <div>
                    <label className="text-sm font-medium text-slate-700">Conferma password</label>
                    <div className="mt-2 relative">
                      <input
                        type={showPassword ? "text" : "password"}
                        value={authConfirmPassword}
                        onChange={(e) => setAuthConfirmPassword(e.target.value)}
                        placeholder="Ripeti la password"
                        className="w-full rounded-xl border border-slate-200 px-4 py-3 pr-12 outline-none transition focus:border-slate-400"
                      />
                    </div>
                  </div>
                )}

                {authMode === "reset" && (
                  <button
                    type="button"
                    onClick={() => { setAuthMode("login"); setAuthMessage(""); }}
                    className="text-sm font-semibold text-slate-600 hover:text-slate-900"
                  >
                    Torna all'accesso
                  </button>
                )}

                {authMessage && (
                  <div
                    className={`rounded-2xl border p-4 text-sm leading-6 ${
                      authMessage.toLowerCase().includes("registrazione inviata") || authMessage.toLowerCase().includes("ti abbiamo inviato")
                        ? "border-emerald-200 bg-emerald-50 text-emerald-900 shadow-sm"
                        : "border-red-200 bg-red-50 text-red-800"
                    }`}
                  >
                    <p className="font-semibold">
                      {authMessage.toLowerCase().includes("registrazione inviata") || authMessage.toLowerCase().includes("ti abbiamo inviato")
                        ? "Controlla la tua email"
                        : "Attenzione"}
                    </p>
                    <p className="mt-1">{authMessage}</p>
                  </div>
                )}

                <button
                  type="button"
                  onClick={authMode === "reset" ? handlePasswordResetRequest : handleAuthSubmit}
                  disabled={authLoading}
                  className="w-full rounded-xl bg-emerald-600 px-6 py-3 font-semibold text-white shadow-sm transition hover:bg-emerald-700 hover:shadow-md active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {authLoading ? "Attendi..." : authMode === "login" ? "Accedi" : authMode === "reset" ? "Invia link di recupero" : "Crea account e inizia gratis"}
                </button>

                <button
                  type="button"
                  onClick={clearBrokenSession}
                  className="w-full rounded-xl border border-gray-300 bg-white px-5 py-3 text-sm font-semibold text-gray-800 transition hover:bg-gray-50 active:scale-95"
                >
                  Pulisci sessione locale
                </button>

                <p className="text-xs leading-6 text-slate-500">
                  Il primo piano è gratuito. Le funzioni complete si sbloccano solo dopo, quando hai capito il modello.
                </p>
              </div>
            </div>
          </aside>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-slate-50 text-slate-900">
      <style>{`
        @media (max-width: 1023px) {
          :root,
          html,
          body {
            width: 100%;
            max-width: 100%;
            overflow-x: hidden !important;
            overscroll-behavior-x: none;
          }

          body {
            position: relative;
            touch-action: pan-y;
          }

          body > *,
          #__next,
          main {
            width: 100%;
            max-width: 100vw;
            overflow-x: clip;
          }

          main,
          section,
          article,
          aside,
          header,
          footer,
          div {
            min-width: 0;
          }

          input,
          select,
          textarea,
          button,
          img,
          svg {
            max-width: 100%;
          }

          .mobile-no-horizontal-pan {
            max-width: 100vw;
            overflow-x: hidden;
          }

          table {
            display: block;
            max-width: 100%;
            overflow-x: auto;
            -webkit-overflow-scrolling: touch;
          }
        }
      `}</style>
      <CelebrationOverlay
        celebration={goalCelebration || celebration}
        onClose={() => {
          if (goalCelebration?.kind === "goal" && goalCelebration.dismissedKey) {
            writePersonalGoalCelebrationState(goalCelebration.dismissedKey, {
              target: goalTargetNumber,
              wasReached: true,
              confirmed: true,
              droppedBelowAfterConfirmed: false,
              lastCurrentValue: goalCurrentNumber,
              confirmedAt: new Date().toISOString(),
            });
            setGoalCelebration(null);
            return;
          }

          setCelebration(null);
        }}
      />
      <div className="mobile-no-horizontal-pan mx-auto w-full max-w-full overflow-x-hidden px-3 py-5 sm:px-4 md:px-8 md:py-8 lg:max-w-7xl">
        <TopBar
          step={step}
          unlocked={purchase.unlocked}
          isProPlan={isProPlan}
          userEmail={user.email || ""}
          onGoHome={goToSafeHome}
          onGoPortfolio={() => setStep("portfolio")}
          onGoGuide={() => openDashboardTab("guida")}
          onGoAwareness={() => setStep("awareness")}
          onGoStrumentis={() => openDashboardTab("portafoglio")}
          onGoDashboard={() => setStep("dashboard")}
          onGoDashboardTab={(tab) => openDashboardTab(tab)}
          onGoAwarenessTab={(tab) => {
            setMobileAwarenessMode("standard");
            setAwarenessTab(tab);
            setStep("awareness");
          }}
          onGoShoppingList={() => {
            setMobileAwarenessMode("shopping");
            setAwarenessTab("risparmio");
            setIsSmartShoppingOpen(true);
            setStep("awareness");
            setTimeout(() => {
              document.getElementById("spesa-intelligente")?.scrollIntoView({ behavior: "smooth", block: "start" });
            }, 120);
          }}
          onGoRebalance={() => {
            void trackEvent("open_rebalance");
            setStep("rebalance");
          }}
          onGoExit={() => {
            void trackEvent("open_exit_strategy");
            setStep("exit");
          }}
          isAdminAccount={isAdminAccount}
          onGoAdmin={() => setStep("admin")}
          onLogout={handleLogout}
          onOpenProfile={openProfileModal}
          onResetProfile={resetAll}
          resetLoading={profileResetLoading}
        />

        {profileModalOpen && (
          <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/50 p-4" role="dialog" aria-modal="true">
            <div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-[2rem] border border-emerald-100 bg-white shadow-2xl">
              <div className="relative overflow-hidden bg-gradient-to-br from-emerald-700 via-emerald-600 to-slate-900 p-6 text-white sm:p-8">
                <div className="absolute -right-16 -top-16 h-44 w-44 rounded-full bg-white/10 blur-2xl" />
                <div className="absolute -bottom-20 left-10 h-40 w-40 rounded-full bg-emerald-300/20 blur-2xl" />
                <div className="relative flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.24em] text-emerald-100">Profilo</p>
                    <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">Bentornato in Soldi Semplici</h2>
                    <p className="mt-3 max-w-2xl text-sm leading-6 text-emerald-50 sm:text-base">
                      Qui trovi le informazioni del tuo account, lo stato del piano e le azioni utili per tenere tutto sotto controllo con serenità.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setProfileModalOpen(false)}
                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/15 text-2xl font-light text-white transition hover:bg-white/25"
                    aria-label="Chiudi profilo"
                  >
                    ×
                  </button>
                </div>

                <div className="relative mt-6 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-2xl bg-white/12 p-4 ring-1 ring-white/15">
                    <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-100">Account</p>
                    <p className="mt-2 truncate text-sm font-bold text-white">{user.email}</p>
                  </div>
                  <div className="rounded-2xl bg-white/12 p-4 ring-1 ring-white/15">
                    <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-100">Piano</p>
                    <p className="mt-2 text-sm font-bold text-white">{purchaseStatus.statusLabel}</p>
                  </div>
                  <div className="rounded-2xl bg-white p-4 text-slate-950 shadow-sm">
                    <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-700">Giorni rimasti</p>
                    <p className="mt-1 text-3xl font-black">{purchaseStatus.days ?? 0}</p>
                  </div>
                </div>
              </div>

              <div className="space-y-5 p-5 sm:p-7">
                <section className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="text-xs font-black uppercase tracking-[0.2em] text-emerald-700">Il tuo piano</p>
                      <h3 className="mt-2 text-2xl font-black tracking-tight text-slate-950">{purchaseStatus.planLabel}</h3>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        {purchaseStatus.isActive ? (
                          <>Piano attivo fino al <strong className="text-slate-900">{purchaseStatus.expiresLabel}</strong>. Continua così: il valore vero è avere un metodo semplice da seguire nel tempo.</>
                        ) : (
                          <>Al momento non risulta un piano attivo. Quando attiverai Core o Pro, qui vedrai scadenza e giorni rimanenti.</>
                        )}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-emerald-100 bg-white px-5 py-4 text-center shadow-sm">
                      <p className="text-3xl font-black tracking-tight text-slate-950">{purchaseStatus.daysLabel}</p>
                      <p className="mt-1 text-xs font-bold uppercase tracking-[0.16em] text-slate-500">validità</p>
                    </div>
                  </div>
                </section>

                <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex items-start gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-xl text-emerald-700 ring-1 ring-emerald-100">🔐</div>
                    <div>
                      <p className="text-xs font-black uppercase tracking-[0.2em] text-emerald-700">Sicurezza account</p>
                      <h3 className="mt-1 text-xl font-black tracking-tight text-slate-950">Cambia password</h3>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        Aggiorna la password quando vuoi. Scegline una lunga, unica e diversa da quelle usate su altri servizi.
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <label className="block">
                      <span className="text-sm font-semibold text-slate-700">Nuova password</span>
                      <input
                        type={accountShowPassword ? "text" : "password"}
                        value={accountNewPassword}
                        onChange={(event) => setAccountNewPassword(event.target.value)}
                        className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100"
                        placeholder="Almeno 8 caratteri"
                        autoComplete="new-password"
                      />
                    </label>

                    <label className="block">
                      <span className="text-sm font-semibold text-slate-700">Conferma nuova password</span>
                      <input
                        type={accountShowPassword ? "text" : "password"}
                        value={accountConfirmPassword}
                        onChange={(event) => setAccountConfirmPassword(event.target.value)}
                        className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100"
                        placeholder="Ripeti la nuova password"
                        autoComplete="new-password"
                      />
                    </label>
                  </div>

                  <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <label className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600">
                      <input
                        type="checkbox"
                        checked={accountShowPassword}
                        onChange={(event) => setAccountShowPassword(event.target.checked)}
                        className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                      />
                      Mostra password
                    </label>
                    <button
                      type="button"
                      onClick={handleAccountPasswordChange}
                      disabled={accountPasswordLoading}
                      className="rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {accountPasswordLoading ? "Salvataggio..." : "Salva nuova password"}
                    </button>
                  </div>

                  {accountPasswordMessage && (
                    <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm font-semibold leading-6 text-slate-700">
                      {accountPasswordMessage}
                    </div>
                  )}
                </section>

                <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="text-xs font-black uppercase tracking-[0.2em] text-slate-500">Azioni account</p>
                      <h3 className="mt-1 text-xl font-black tracking-tight text-slate-950">Gestione profilo</h3>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        Da qui gestisci in modo semplice l'accesso, la sicurezza dell'account e le informazioni principali del tuo percorso.
                      </p>
                    </div>
                    <div className="flex flex-col gap-3 sm:min-w-48">
                      <button
                        type="button"
                        onClick={async () => {
                          setProfileModalOpen(false);
                          await handleLogout();
                        }}
                        className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-black text-white transition hover:bg-slate-800"
                      >
                        Logout
                      </button>
                      <button
                        type="button"
                        onClick={resetAll}
                        disabled={profileResetLoading}
                        className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-3 text-sm font-bold text-amber-800 transition hover:bg-amber-100 disabled:opacity-50"
                      >
                        {profileResetLoading ? "Reset..." : "Reset test"}
                      </button>
                    </div>
                  </div>
                </section>
              </div>
            </div>
          </div>
        )}

        {profileResetMessage && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-sm">
            {profileResetMessage}
          </div>
        )}

        {showProUpgradeModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
            <div className="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl sm:p-8">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Prima di passare al Pro</p>
              <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900">Il Pro è pensato per una fase più avanzata</h2>
              <p className="mt-4 text-sm leading-6 text-slate-600">
                Il piano Pro è consigliato non prima del secondo anno e soprattutto quando il portafoglio presenta discostamenti importanti rispetto al modello. Se stai iniziando ora, il Core da 29 EUR/anno resta il piano più adatto.
              </p>
              <div className="mt-5 rounded-2xl bg-slate-50 p-5 text-sm leading-6 text-slate-700">
                {isCorePlan ? (
                  <p>
                    Hai già attivo il Core: per fare l'upgrade al Pro paghi solo la differenza tra 59 EUR e quanto hai già pagato. Importo upgrade: <strong>{proPriceToPay} EUR</strong>.
                  </p>
                ) : (
                  <p>
                    Il Pro costa <strong>59 EUR/anno</strong>. Include tutte le funzioni Core più ribilanciamento guidato, alert e supporto più avanzato.
                  </p>
                )}
              </div>
              <div className="mt-8 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button
                  onClick={cancelProUpgrade}
                  className="rounded-xl border border-gray-300 bg-white px-5 py-3 font-semibold text-gray-800 transition hover:bg-gray-50 active:scale-95"
                >
                  Resta sul Core
                </button>
                <button
                  onClick={() => unlockPlan("pro")}
                  className="rounded-xl bg-emerald-600 px-5 py-3 font-semibold text-white shadow-sm transition hover:bg-emerald-700 active:scale-95"
                >
                  {isCorePlan ? "Continua e paga " + proPriceToPay + " EUR" : "Continua con Pro"}
                </button>
              </div>
            </div>
          </div>
        )}

        {step === "home" && (
          <section className="space-y-6">
            <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm md:p-10">
              <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">Soldi Semplici</p>
              <h1 className="mt-3 max-w-4xl text-4xl font-bold tracking-tight md:text-5xl">
                Gestisci i tuoi soldi con più metodo e meno confusione
              </h1>
              <p className="mt-5 max-w-3xl text-lg leading-8 text-slate-600">
                Soldi Semplici ti aiuta a costruire un piano, seguire una guida operativa e usare strumenti pratici per risparmio, investimenti, auto, mutuo, anti-truffe e strategia d’uscita.
              </p>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-emerald-700">
                Non è solo teoria: è una guida pratica per evitare errori costosi e prendere decisioni più consapevoli.
              </p>

              <div className="mt-8 grid gap-4 lg:grid-cols-3">
                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6">
                  <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">1. Capisci</p>
                  <h3 className="mt-2 text-xl font-bold tracking-tight">Cos'è un PAC?</h3>
                  <p className="mt-3 text-sm leading-6 text-slate-600">
                    PAC significa Piano di Accumulo: investi una somma sostenibile ogni mese, invece di dover decidere tutto in una volta.
                  </p>
                </div>
                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6">
                  <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">2. Scegli</p>
                  <h3 className="mt-2 text-xl font-bold tracking-tight">Trova un modello educativo</h3>
                  <p className="mt-3 text-sm leading-6 text-slate-600">
                    Rispondi a poche domande: l'app ti mostra un possibile modello coerente con il tuo comportamento, non una raccomandazione personalizzata.
                  </p>
                </div>
                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6">
                  <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">3. Agisci</p>
                  <h3 className="mt-2 text-xl font-bold tracking-tight">Arriva al primo PAC</h3>
                  <p className="mt-3 text-sm leading-6 text-slate-600">
                    Dopo il modello, imposti obiettivo, cifra mensile e percorso. La dashboard serve soprattutto a ricordarti l'azione del mese.
                  </p>
                </div>
              </div>

              <div className="mt-8 rounded-3xl border border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-slate-50 p-6 shadow-sm">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-700">Percorso consigliato</p>
                    <h2 className="mt-2 text-2xl font-bold tracking-tight text-slate-950">Una cosa alla volta: test, modello, primo PAC.</h2>
                    <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-700">
                      Le funzioni restano disponibili, ma il percorso principale e sempre uno: capire il metodo e completare il primo investimento mensile.
                    </p>
                  </div>
                  <button
                    onClick={() => purchase.unlocked ? setStep("dashboard") : hasCompletedQuizOrPlan() ? setStep("portfolio") : startQuizFlow()}
                    className="rounded-xl bg-emerald-600 px-6 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-emerald-700 hover:shadow-md active:scale-95"
                  >
                    {purchase.unlocked ? "Vai alla checklist" : "Inizia il percorso guidato"}
                  </button>
                </div>
              </div>

              <div className="mt-8 grid gap-4 md:grid-cols-2">
                <InfoBox
                  title="Cosa fa l'app"
                  tone="green"
                  items={[
                    "Spiega il PAC in modo semplice",
                    "Ti guida verso una cifra mensile sostenibile",
                    "Mostra un modello educativo di riferimento",
                    "Ti aiuta a mantenere continuita nel tempo",
                  ]}
                />
                <InfoBox
                  title="Cosa non fa l'app"
                  tone="amber"
                  items={[
                    "Non fornisce consulenza finanziaria personalizzata",
                    "Non dice cosa comprare o vendere",
                    "Non promette rendimenti",
                    "Non sostituisce studio, responsabilità e valutazione personale",
                  ]}
                />
              </div>

              <details className="mt-8 rounded-3xl border border-slate-200 bg-slate-50 p-6">
                <summary className="cursor-pointer text-lg font-semibold text-slate-900">
                  Vuoi vedere una simulazione prima di iniziare?
                </summary>
                <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
                  Questa parte e opzionale. Serve solo a visualizzare l'effetto della continuita nel tempo.
                </p>

                <div className="mt-5 grid gap-4 md:grid-cols-3">
                  <div>
                    <label className="text-sm font-medium text-slate-700">Euro al mese</label>
                    <input
                      value={homeMonthly}
                      onChange={(e) => setHomeMonthly(e.target.value)}
                      placeholder="200"
                      className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-700">Anni</label>
                    <input
                      value={homeYears}
                      onChange={(e) => setHomeYears(e.target.value)}
                      placeholder="20"
                      className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none"
                    />
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <p className="text-sm font-semibold text-slate-500">Valore stimato</p>
                    <p className="mt-2 text-3xl font-bold tracking-tight text-slate-900">{formatEuro(homeProjection)}</p>
                    <p className="mt-2 text-xs text-slate-500">
                      Simulazione indicativa con rendimento medio del 7% annuo.
                    </p>
                  </div>
                </div>
              </details>
            </div>
          </section>
        )}

        {step === "quiz" && (
          <section className="mx-auto max-w-4xl space-y-6">
            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Prima di rispondere</p>
              <h2 className="mt-2 text-3xl font-bold tracking-tight">Questionario orientativo</h2>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                Rispondi con attenzione e sincerità. Non esiste una risposta giusta: il risultato mostra un possibile modello educativo, non una raccomandazione personalizzata.
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Il risultato non serve a trovare il modello perfetto, ma a orientarti verso un metodo coerente con il tuo comportamento reale.
              </p>
              <p className="mt-4 text-sm font-semibold text-slate-900">Domanda {currentQuestion + 1} di {questions.length}</p>
            </div>

            <div className="h-3 overflow-hidden rounded-full bg-slate-200">
              <div className="h-full rounded-full bg-slate-900 transition-all" style={{ width: `${progress}%` }} />
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
              <h3 className="text-2xl font-semibold">{currentQuestionData.text}</h3>
              {currentQuestionData.helper && <p className="mt-2 text-sm text-slate-500">{currentQuestionData.helper}</p>}

              <div className="mt-6 space-y-3">
                {currentQuestionData.options.map((option, index) => {
                  const selected = answers[currentQuestion] === index;
                  return (
                    <button
                      key={option.label}
                      onClick={() => selectAnswer(index)}
                      className={`w-full rounded-2xl border p-4 text-left transition ${
                        selected
                          ? "border-emerald-300 bg-emerald-50 text-emerald-900 shadow-sm"
                          : "border-slate-200 bg-white text-slate-800 hover:border-slate-400 hover:bg-slate-50"
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>

              <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-between">
                <button
                  onClick={previousQuestion}
                  className="rounded-xl border border-gray-300 bg-white px-5 py-3 font-semibold text-gray-800 transition hover:bg-gray-50 active:scale-95"
                >
                  Indietro
                </button>
                <button
                  onClick={nextQuestion}
                  disabled={!hasAnsweredCurrent}
                  className="rounded-xl bg-emerald-600 px-6 py-3 font-semibold text-white shadow-sm transition hover:bg-emerald-700 hover:shadow-md active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {currentQuestion === questions.length - 1 ? "Vedi anteprima" : "Continua"}
                </button>
              </div>
            </div>
          </section>
        )}

        {step === "preview" && (
          <section className="mx-auto max-w-6xl space-y-6">
            <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <div className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
                <div>
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">Il tuo piano gratuito</p>
                      <h2 className="mt-3 text-4xl font-bold tracking-tight">{scoreResult.portfolio.title}</h2>
                      <p className="mt-2 inline-flex rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-700">
                        {scoreResult.portfolio.badge}
                      </p>
                    </div>

                  </div>

                  <p className="mt-5 max-w-3xl text-lg leading-8 text-slate-600">{scoreResult.portfolio.intro}</p>
                  <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">{scoreResult.portfolio.whyItFits}</p>

                  <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
                    <p className="text-sm font-bold text-emerald-950">Hai completato la prima parte.</p>
                    <p className="mt-2 text-sm leading-6 text-emerald-900">
                      Ora conosci il tuo modello. Il passo successivo non è guardare mille sezioni: è seguire una guida operativa semplice, mese dopo mese.
                    </p>
                  </div>

                  <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <p className="text-sm font-bold text-slate-950">Il piano da solo non basta.</p>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      Il risultato dipende da quello che fai ogni mese. Dopo l'attivazione, la guida operativa diventa il tuo punto di partenza: ti dice quale passo fare e dove trovare lo strumento giusto.
                    </p>
                  </div>

                  <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Gratis, prima di pagare</p>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      Puoi completare il questionario, vedere il modello e impostare il primo piano PAC senza pagare. Il pagamento serve dopo, per usare dashboard completa, tracking, guida operativa e strumenti avanzati.
                    </p>
                  </div>
                </div>

                <PortfolioPieChart composition={scoreResult.portfolio.composition} />
              </div>

              <div className="mt-8 grid gap-4 md:grid-cols-3">
                <MetricCard label="Stabilità" value={scoreResult.totals.stabilita.toString()} />
                <MetricCard label="Equilibrio" value={scoreResult.totals.equilibrio.toString()} />
                <MetricCard label="Crescita" value={scoreResult.totals.crescita.toString()} />
              </div>


              <div className="mt-8 flex justify-end">
                <button
                  onClick={startFreePlan}
                  className="rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 hover:shadow-md active:scale-95"
                >
                  Continua gratis e configura il PAC
                </button>
              </div>

            </div>
          </section>
        )}

        {step === "paywall" && (
          <section className="mx-auto max-w-6xl space-y-6">
            <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
              <div className="grid gap-0 lg:grid-cols-[1.05fr_0.95fr]">
                <div className="p-8 md:p-10">
                  <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Passo successivo</p>
                  <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 md:text-5xl">
                    Non fermarti al piano.
                    <span className="mt-2 block">Ora seguilo con un metodo.</span>
                  </h2>
                  <p className="mt-5 max-w-2xl text-base leading-7 text-slate-600 md:text-lg">
                    Hai già fatto il passo più difficile: hai costruito il tuo modello. Ora puoi trasformarlo in una guida pratica da seguire ogni mese, con strumenti semplici per capire cosa fare, quando controllare il portafoglio e come preparare l'uscita.
                  </p>
                  <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5">
                    <p className="text-sm font-bold text-amber-900">Il rischio non è partire. È abbandonare il metodo.</p>
                    <ul className="mt-3 space-y-2 text-sm leading-6 text-amber-900">
                      <li>• Il Core ti guida mese dopo mese, senza lasciarti solo davanti al piano.</li>
                      <li>• Il Pro ti aiuta quando il portafoglio si sbilancia o devi preparare l'uscita.</li>
                      <li>• Tutto resta educativo: le decisioni finali restano sempre tue.</li>
                    </ul>
                  </div>
                </div>
                <div className="border-l border-slate-200 bg-slate-50 p-8 md:p-10">
                  <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-700">La logica è semplice</p>
                  <div className="mt-6 space-y-5">
                    <div className="rounded-2xl border border-slate-200 bg-white p-5">
                      <p className="text-sm font-semibold text-slate-500">Gratis</p>
                      <p className="mt-1 text-2xl font-bold">Capisci il piano</p>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-white p-5">
                      <p className="text-sm font-semibold text-slate-500">Core</p>
                      <p className="mt-1 text-2xl font-bold">Segui il piano</p>
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-white p-5">
                      <p className="text-sm font-semibold text-slate-500">Pro</p>
                      <p className="mt-1 text-2xl font-bold">Ottimizzi il piano</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {(purchase.expiresAt || isCorePlan) && (
              <PlanValidityBox purchase={purchase} context="paywall" />
            )}

            <div className="grid gap-6 lg:grid-cols-2">
              <div className="relative rounded-3xl border-2 border-slate-900 bg-white p-8 shadow-sm">
                <div className="absolute right-6 top-6 rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white">
                  Consigliato primo anno
                </div>
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Core</p>
                <h3 className="mt-3 text-4xl font-bold tracking-tight">29 EUR / anno</h3>
                <p className="mt-4 text-sm leading-6 text-slate-600">
                  Il metodo completo per partire, seguire il piano mese dopo mese è prendere decisioni più consapevoli nella vita quotidiana.
                </p>
                <div className="mt-6 rounded-2xl bg-slate-50 p-5">
                  <p className="text-sm font-bold text-slate-900">Con Core hai accesso a:</p>
                  <ul className="mt-3 space-y-3 text-sm leading-6 text-slate-700">
                    <li>• Piano e PAC personalizzato</li>
                    <li>• Dashboard operativa e guida mese per mese</li>
                    <li>• Strumenti personalizzati e gestione investimenti</li>
                    <li>• Risparmio, spesa intelligente, auto e mutuo</li>
                    <li>• Anti-truffe con mini gioco da 200 scenari</li>
                    <li>• Badge, titoli e progressi per restare motivato</li>
                  </ul>
                </div>
                <button
                  onClick={() => unlockPlan("core")}
                  className="mt-8 w-full rounded-xl bg-emerald-600 px-6 py-3 font-semibold text-white shadow-sm transition hover:bg-emerald-700 hover:shadow-md active:scale-95"
                >
                  Inizia a gestire il tuo piano - 29 EUR/anno
                </button>
              </div>

              <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
                <div className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Livello avanzato
                </div>
                <p className="mt-5 text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Pro</p>
                <h3 className="mt-3 text-4xl font-bold tracking-tight">{isCorePlan ? proPriceToPay + " EUR upgrade" : "59 EUR / anno"}</h3>
                <p className="mt-4 text-sm leading-6 text-slate-600">
                  Il Pro è pensato per una fase più matura: dal secondo anno, oppure quando il portafoglio cresce e vuoi gestire scostamenti, ribilanciamento e strategie di uscita.
                  {isCorePlan ? " Hai già il Core: per passare al Pro paghi 30 EUR e il piano Pro sarà valido per 365 giorni dalla data di upgrade." : ""}
                </p>
                <div className="mt-6 rounded-2xl bg-slate-50 p-5">
                  <p className="text-sm font-bold text-slate-900">Include tutto il Core, più:</p>
                  <ul className="mt-3 space-y-3 text-sm leading-6 text-slate-700">
                    <li>• Ribilanciamento guidato con calcolo automatico</li>
                    <li>• Strategie di uscita a fine investimento</li>
                    <li>• Questionario guidato per scegliere la strategia più coerente</li>
                    <li>• Supporto decisionale nei momenti critici</li>
                  </ul>
                </div>
                <div className="mt-5 rounded-2xl border border-blue-100 bg-blue-50 p-4 text-sm leading-6 text-blue-900">
                  <strong>Nota onesta:</strong> se stai iniziando ora, il Core e probabilmente sufficiente. Il Pro ha più senso quando hai già capitale investito e vuoi gestire scostamenti importanti.
                </div>
                <button
                  onClick={requestProUpgrade}
                  className="rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 hover:shadow-md active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isCorePlan ? "Passa a Pro - paghi 30 EUR" : "Passa al livello avanzato - 59 EUR/anno"}
                </button>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <h3 className="text-xl font-bold tracking-tight text-slate-900">Core o Pro?</h3>
              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <div className="rounded-2xl bg-slate-50 p-5">
                  <p className="font-bold text-slate-900">Core = segui il piano</p>
                  <p className="mt-2 text-sm leading-6 text-slate-600">Per chi vuole partire, creare abitudine e avere una checklist semplice ogni mese.</p>
                </div>
                <div className="rounded-2xl bg-slate-50 p-5">
                  <p className="font-bold text-slate-900">Pro = ottimizzi il piano</p>
                  <p className="mt-2 text-sm leading-6 text-slate-600">Per chi ha già iniziato e vuole gestire ribilanciamento, scostamenti e uscita dal PAC.</p>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <h3 className="text-xl font-bold tracking-tight">Non vuoi pagare ora?</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Puoi tornare al tuo modello gratuito. Quando sarai pronto, potrai attivare Core o Pro dalle sezioni avanzate.
                  </p>
                </div>
                <button
                  onClick={() => setStep("portfolio")}
                  className="rounded-xl border border-slate-200 bg-white px-6 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  Torna al piano gratuito
                </button>
              </div>
            </div>
          </section>
        )}

        {step === "portfolio" && (
          <section className="space-y-6">
            <div className="overflow-hidden rounded-[2rem] border border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-slate-50 p-8 shadow-sm">
              <div className="grid gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
                <div className="max-w-3xl">
                  <div>
                    <p className="inline-flex rounded-full border border-emerald-200 bg-white px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-emerald-700 shadow-sm">
                      Modello assegnato gratuitamente
                    </p>
                    <h2 className="mt-4 text-4xl font-bold tracking-tight text-slate-950 md:text-5xl">{selectedPortfolio.title}</h2>
                    <p className="mt-3 inline-flex rounded-full bg-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-800">
                      {selectedPortfolio.shortTitle} - {selectedPortfolio.badge}
                    </p>
                  </div>

                  <p className="mt-6 text-lg leading-8 text-slate-700">{selectedPortfolio.intro}</p>
                  <p className="mt-4 text-base leading-7 text-slate-600">{selectedPortfolio.whyItFits}</p>

                  <div className="mt-6 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-2xl border border-emerald-100 bg-white/80 p-4 shadow-sm">
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Metodo</p>
                      <p className="mt-1 text-sm font-bold text-slate-950">PAC mensile</p>
                    </div>
                    <div className="rounded-2xl border border-emerald-100 bg-white/80 p-4 shadow-sm">
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Focus</p>
                      <p className="mt-1 text-sm font-bold text-slate-950">Continuità</p>
                    </div>
                    <div className="rounded-2xl border border-emerald-100 bg-white/80 p-4 shadow-sm">
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Obiettivo</p>
                      <p className="mt-1 text-sm font-bold text-slate-950">Non improvvisare</p>
                    </div>
                  </div>
                </div>

                <div className="rounded-[2rem] border border-white bg-white/80 p-5 shadow-sm">
                  <PortfolioPieChart composition={selectedPortfolio.composition} />
                </div>
              </div>

              <div className="mt-8 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Cosa ricevi gratis</p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Un modello educativo completo: composizione, rischio storico, punti di attenzione e simulazione del percorso.
                </p>
                <div className="mt-5 grid gap-4 md:grid-cols-3">
                  <MetricCard label="Rendimento medio" value={selectedPortfolio.historical.average} />
                  <MetricCard label="Peggior drawdown" value={selectedPortfolio.historical.maxDrawdown} />
                  <MetricCard label="Tempo recupero" value={selectedPortfolio.historical.recovery} />
                </div>
              </div>

              <div className="mt-8 grid gap-4 lg:grid-cols-2">
                <ContentPanel title="Struttura del modello" items={selectedPortfolio.structureSummary} />
                <ContentPanel title="A cosa fare attenzione" items={selectedPortfolio.attention} />
              </div>

              <div className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-5">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">Ribilanciamento annuale</h3>
                <p className="mt-2 text-sm leading-7 text-slate-700">{selectedPortfolio.annualRebalanceNote}</p>
              </div>

              <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Uso educativo</p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Il modello e le categorie mostrate hanno finalità informative. Gli eventuali strumenti indicati sono esempi e non costituiscono raccomandazioni operative.
                </p>
              </div>


            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <h3 className="text-xl font-semibold">Guida PAC educativa passo passo</h3>
                <ol className="mt-4 space-y-3 text-sm leading-7 text-slate-700">
                  {selectedPortfolio.pacGuide.map((stepText, index) => (
                    <li key={stepText} className="flex gap-3">
                      <span className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-600 text-xs font-semibold text-white shadow-sm">
                        {index + 1}
                      </span>
                      <span>{stepText}</span>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <h3 className="text-xl font-semibold">Psicologia e lungo periodo</h3>
                <ul className="mt-4 space-y-3 text-sm leading-7 text-slate-700">
                  {selectedPortfolio.psychology.map((item) => (
                    <li key={item}>• {item}</li>
                  ))}
                </ul>

                <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                  <p className="text-sm font-medium text-amber-900">
                    Se il modello scende, non vuol dire che la strategia non funziona. Le oscillazioni di mercato sono normali.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <h3 className="text-xl font-semibold">Simula il tuo percorso nel tempo</h3>
              <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
                Qui puoi provare una simulazione più personale in base al tuo profilo.
                Il rendimento medio e preimpostato in modo coerente con la famiglia del modello.
              </p>

              <div className="mt-5 grid gap-4 md:grid-cols-4">
                <div>
                  <label className="text-sm font-medium text-slate-700">Euro al mese</label>
                  <input
                    value={portMonthly}
                    onChange={(e) => setPortMonthly(e.target.value)}
                    placeholder="200"
                    className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-700">Anni</label>
                  <input
                    value={portYears}
                    onChange={(e) => setPortYears(e.target.value)}
                    placeholder="20"
                    className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-700">Capitale iniziale</label>
                  <input
                    value={portInitial}
                    onChange={(e) => setPortInitial(e.target.value)}
                    placeholder="0"
                    className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none"
                  />
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm font-semibold text-slate-500">Valore stimato</p>
                  <p className="mt-2 text-3xl font-bold tracking-tight text-slate-900">{formatEuro(portfolioProjection)}</p>
                  <p className="mt-2 text-xs text-slate-500">
                    Rendimento medio stimato: {Math.round(portfolioRate * 100)}% annuo
                  </p>
                </div>
              </div>
            </div>

                        {purchase.unlocked && (
              <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-6 shadow-sm">
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-700">Prossimo passo</p>
                <h3 className="mt-2 text-xl font-bold text-emerald-950">Apri la guida operativa</h3>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-emerald-900">
                  Hai visto il modello. Ora segui la guida operativa per capire cosa fare, in che ordine e quali strumenti usare.
                </p>
                <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-white px-4 py-2 text-sm font-semibold text-emerald-700 shadow-sm">
                  <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                  Piano attivo
                </div>
              </div>
            )}

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <h3 className="text-xl font-semibold">Proiezione esempio: 200 EUR al mese</h3>
              <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
                Simulazione indicativa basata su rendimento medio annuo coerente con questo modello.
                Questi numeri aiutano a capire il ruolo del tempo negli investimenti.
              </p>
              <p className="mt-2 text-xs text-slate-500">
                Rendimento medio stimato: {Math.round(portfolioRate * 100)}% annuo
              </p>

              <div className="mt-6 grid gap-4 md:grid-cols-3">
                <MetricCard label="20 anni" value={selectedPortfolio.growthProjection.twenty} />
                <MetricCard label="25 anni" value={selectedPortfolio.growthProjection.twentyFive} />
                <MetricCard label="30 anni" value={selectedPortfolio.growthProjection.thirty} />
              </div>
            </div>

            <div className="flex justify-end">
              {purchase.unlocked ? (
                <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 shadow-sm">
                  <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                  Piano attivo
                </div>
              ) : (
                <button
                  onClick={async () => {
                    await trackEvent("click_paywall", { source: "portfolio_bottom_cta" });
                    goToPaywallTop();
                  }}
                  className="rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 hover:shadow-md active:scale-95"
                >
                  Accedi alle funzioni complete
                </button>
              )}
            </div>
          </section>
        )}

        {step === "guide" && (
          <section className="space-y-6">
            <div className="rounded-3xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-8 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-700">Guida operativa</p>
              <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-950 md:text-4xl">Il percorso operativo del tuo PAC</h2>
              <p className="mt-4 max-w-3xl text-base leading-7 text-slate-700">
                Prima scegli la cifra mensile, poi apri questa guida, poi guarda gli strumenti. Così non devi cercare le funzioni: segui il percorso.
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  onClick={() => setStep("portfolio")}
                  className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  Torna al modello
                </button>
                <button
                  onClick={() => setStep("strumentis")}
                  className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  Vai agli strumenti
                </button>
              </div>
            </div>

            <div className="rounded-3xl border-2 border-emerald-300 bg-emerald-50 p-7 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-700">Prossimo passo consigliato</p>
              {nextGuideItem ? (
                <div className="mt-3">
                  <h3 className="text-2xl font-bold tracking-tight text-emerald-950">{nextGuideItem.title}</h3>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-emerald-900">{nextGuideItem.description}</p>
                  <div className="mt-5 flex flex-wrap gap-3">
                    {(() => {
                      const hasRequiredAction = Boolean(nextGuideAction && !guideActionVisited[nextGuideItem.id]);
                      const completeButtonClass = hasRequiredAction
                        ? "rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                        : "rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700";

                      return (
                        <>
                          {nextGuideAction && (
                            <button
                              onClick={() => handleGuideToolAction(nextGuideItem.id, nextGuideAction)}
                              className={hasRequiredAction
                                ? "rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700"
                                : "rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                              }
                            >
                              {nextGuideAction.label}
                            </button>
                          )}
                          <button
                            onClick={() => toggleChecklist(nextGuideItem.id)}
                            className={completeButtonClass}
                          >
                            Segna come completato
                          </button>
                        </>
                      );
                    })()}
                  </div>
                </div>
              ) : (
                <div className="mt-3">
                  <h3 className="text-2xl font-bold tracking-tight text-emerald-950">Guida completata</h3>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-emerald-900">
                    Hai completato i passaggi principali. Ora puoi usare dashboard, strumenti e PAC mensile per mantenere il piano nel tempo.
                  </p>
                  <button
                    onClick={() => setStep("dashboard")}
                    className="mt-5 rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-700"
                  >
                    Vai alla dashboard
                  </button>
                </div>
              )}
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-700">Guida operativa</p>
              <h3 className="mt-2 text-2xl font-bold tracking-tight text-slate-950">Cosa fare, in che ordine e dove cliccare</h3>
              <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
                Questa è la guida che prima trovavi in basso nel modello. Ora è una pagina dedicata: usala come percorso principale dopo aver scelto la cifra mensile e prima di guardare gli strumenti.
              </p>

              <div className="mt-5 rounded-2xl bg-slate-50 p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-slate-700">
                      Guida iniziale: {completedInitialChecklist}/{initialChecklistItems.length}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Completa questi passaggi una sola volta. Poi il sistema lavorera per te.
                    </p>
                  </div>
                  <p className="text-sm font-semibold text-slate-900">{checklistPercent}%</p>
                </div>
                <div className="mt-3 h-3 overflow-hidden rounded-full bg-slate-200">
                  <div className="h-full rounded-full bg-slate-900 transition-all duration-700" style={{ width: `${checklistPercent}%` }} />
                </div>
                {setupCompleted && (
                  <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                    <p className="text-sm font-semibold text-emerald-900">
                      Sistema attivato. Ora concentrati su PAC e mantenimento.
                    </p>
                  </div>
                )}
              </div>

              <div className="mt-6 grid gap-6 lg:grid-cols-2">
                <ChecklistGroup
                  title="Setup iniziale"
                  subtitle="Completa questi passaggi per rendere operativo il modello."
                  items={initialChecklistItems}
                  state={checklistState}
                  onToggle={toggleChecklist}
                  getToolAction={getChecklistToolAction}
                  nextItemId={nextGuideItem?.id}
                  actionVisited={guideActionVisited}
                  onToolActionClick={handleGuideToolAction}
                />
                <ChecklistGroup
                  title="Mantenimento nel tempo"
                  subtitle={`Queste abitudini non bloccano il setup. Completate: ${completedMaintenanceChecklist}/${maintenanceChecklistItems.length}`}
                  items={maintenanceChecklistItems}
                  state={checklistState}
                  onToggle={toggleChecklist}
                  getToolAction={getChecklistToolAction}
                  nextItemId={nextGuideItem?.id}
                  actionVisited={guideActionVisited}
                  onToolActionClick={handleGuideToolAction}
                />
              </div>

              <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                <p className="text-sm text-emerald-900">
                  Non devi fare tutto perfettamente al primo giorno. Devi solo impostare un sistema semplice che riesci a mantenere nel tempo.
                </p>
              </div>
            </div>
          </section>
        )}

        {step === "strumentis" && (
          <section className="space-y-6">
            <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.22em] text-emerald-700">Strumenti</p>
                  <h2 className="mt-3 text-3xl font-bold tracking-tight">Foglio strumenti con ISIN / esempi</h2>
                  <p className="mt-3 max-w-4xl text-slate-600">
                    Qui trovi gli strumenti educativi suggeriti dal programma e puoi aggiungere quelli personali che usi davvero. Gli strumenti personali salvati qui diventano disponibili anche nella Dashboard, dentro "Aggiungi investimento".
                  </p>
                </div>
                <button
                  onClick={() => openDashboardTab("guida")}
                  className="rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white shadow-sm shadow-emerald-200 transition hover:bg-emerald-700"
                >
                  Torna alla guida operativa
                </button>
              </div>

              <div className="mt-6 grid gap-3 md:grid-cols-2">
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                  <div className="flex items-center gap-3">
                    <span className="h-3 w-3 rounded-full bg-emerald-600" />
                    <div>
                      <p className="text-sm font-bold text-emerald-900">Programma</p>
                      <p className="text-sm text-emerald-800">Strumenti indicati dall'app come esempi educativi. Non sono eliminabili.</p>
                    </div>
                  </div>
                </div>
                <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-4">
                  <div className="flex items-center gap-3">
                    <span className="h-3 w-3 rounded-full bg-indigo-600" />
                    <div>
                      <p className="text-sm font-bold text-indigo-900">Personale</p>
                      <p className="text-sm text-indigo-800">Strumenti aggiunti da te. Puoi eliminarli e selezionarli nella Dashboard.</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-indigo-200 bg-white p-6 shadow-sm ring-1 ring-indigo-100">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-700">Strumento personale</p>
                  <h3 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">Aggiungi uno strumento</h3>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                    Inserisci solo strumenti che conosci e che appartengono alla categoria corretta. Questa funzione serve per personalizzare il piano, non per ricevere raccomandazioni di acquisto.
                  </p>
                </div>
                <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200">
                  {customInstruments.length} personali
                </span>
              </div>

              <div className="mt-5 grid gap-4 lg:grid-cols-[0.9fr_1.2fr_0.9fr_1.2fr_auto] lg:items-end">
                <div>
                  <label className="text-sm font-medium text-slate-700">Categoria</label>
                  <select
                    value={customInstrumentDraft.category}
                    onChange={(e) => setCustomInstrumentDraft((prev) => ({ ...prev, category: e.target.value as StrumentiCategory }))}
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-indigo-300"
                  >
                    {Object.keys(strumentiLibrary).map((category) => (
                      <option key={category} value={category}>{category}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-700">Nome strumento</label>
                  <input
                    value={customInstrumentDraft.name}
                    onChange={(e) => setCustomInstrumentDraft((prev) => ({ ...prev, name: e.target.value }))}
                    placeholder="Es. ETF personale"
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-indigo-300"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-700">ISIN / ticker</label>
                  <input
                    value={customInstrumentDraft.isin}
                    onChange={(e) => setCustomInstrumentDraft((prev) => ({ ...prev, isin: e.target.value }))}
                    placeholder="Es. IE00..."
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-indigo-300"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-700">Nota opzionale</label>
                  <input
                    value={customInstrumentDraft.note}
                    onChange={(e) => setCustomInstrumentDraft((prev) => ({ ...prev, note: e.target.value }))}
                    placeholder="Es. broker, TER, motivo"
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-indigo-300"
                  />
                </div>
                <button
                  type="button"
                  onClick={addCustomInstrument}
                  className="rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white shadow-sm shadow-emerald-200 transition hover:bg-emerald-700"
                >
                  Aggiungi
                </button>
              </div>

              {customInstrumentMessage ? (
                <p className="mt-4 rounded-2xl bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700 ring-1 ring-slate-200">
                  {customInstrumentMessage}
                </p>
              ) : null}
            </div>

            <div className="grid gap-4">
              {Object.entries(allInstrumentsByCategory).map(([category, rows]) => (
                <div key={category} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <h3 className="text-xl font-semibold">{category}</h3>
                      <p className="mt-1 text-sm text-slate-500">
                        {rows.filter((row) => row.source === "program").length} programma · {rows.filter((row) => row.source === "custom").length} personali
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-200">Programma</span>
                      <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold uppercase tracking-wide text-indigo-700 ring-1 ring-indigo-200">Personale</span>
                    </div>
                  </div>

                  <div className="mt-4 overflow-x-auto">
                    <table className="min-w-full border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50">
                          <th className="px-4 py-3 text-left font-semibold">Strumento</th>
                          <th className="px-4 py-3 text-left font-semibold">ISIN / ticker</th>
                          <th className="px-4 py-3 text-left font-semibold">Origine</th>
                          <th className="px-4 py-3 text-left font-semibold">Nota</th>
                          <th className="px-4 py-3 text-right font-semibold">Azioni</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => {
                          const isCustom = row.source === "custom";
                          return (
                            <tr key={`${row.source}-${row.id || row.isin}-${row.name}`} className="border-b border-slate-100">
                              <td className="px-4 py-3 font-medium text-slate-900">{row.name}</td>
                              <td className="px-4 py-3 font-mono text-xs text-slate-600">{row.isin}</td>
                              <td className="px-4 py-3">
                                <span className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ring-1 ${
                                  isCustom
                                    ? "bg-indigo-50 text-indigo-700 ring-indigo-200"
                                    : "bg-emerald-50 text-emerald-700 ring-emerald-200"
                                }`}>
                                  {isCustom ? "Personale" : "Programma"}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-slate-500">{row.note || "—"}</td>
                              <td className="px-4 py-3 text-right">
                                {isCustom && row.id ? (
                                  <button
                                    type="button"
                                    onClick={() => deleteCustomInstrument(row.id!)}
                                    className="rounded-xl border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-50"
                                  >
                                    Elimina
                                  </button>
                                ) : (
                                  <span className="text-xs font-medium text-slate-400">Bloccato</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {step === "onboarding" && (
          <section className="mx-auto max-w-5xl space-y-6">
            <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">Configura il tuo piano</p>
                  <h2 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">Rendiamo questa dashboard davvero tua</h2>
                  <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
                    Tre passaggi rapidi: obiettivo, PAC mensile e anno finale. Dopo arrivi alla guida operativa con il piano già impostato.
                  </p>
                </div>
              </div>

              <div className="mt-6 h-2 overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-slate-900 transition-all"
                  style={{ width: `${((onboardingStep + 1) / 3) * 100}%` }}
                />
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              {onboardingStep === 0 && (
                <div className="space-y-5">
                  <div>
                    <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">Passo 1 di 3</p>
                    <h3 className="mt-2 text-2xl font-bold tracking-tight">Che obiettivo vuoi costruire?</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      Dagli un nome semplice. Non deve essere perfetto: deve motivarti a restare costante.
                    </p>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <label className="text-sm font-medium text-slate-700">Nome obiettivo</label>
                      <input
                        value={goalTitle}
                        onChange={(e) => setGoalTitle(e.target.value)}
                        placeholder="Es. Libertà finanziaria"
                        className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium text-slate-700">Target finale</label>
                      <input
                        value={goalTarget}
                        onChange={(e) => setGoalTarget(e.target.value)}
                        placeholder="Es. 100000"
                        className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                      />
                    </div>
                  </div>
                </div>
              )}

              {onboardingStep === 1 && (
                <div className="space-y-5">
                  <div>
                    <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">Passo 2 di 3</p>
                    <h3 className="mt-2 text-2xl font-bold tracking-tight">Quanto puoi investire ogni mese?</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      Scegli una cifra sostenibile. Un PAC piccolo ma regolare vale più di uno grande che abbandoni.
                    </p>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <label className="text-sm font-medium text-slate-700">PAC mensile</label>
                      <input
                        value={portMonthly}
                        onChange={(e) => setPortMonthly(e.target.value)}
                        placeholder="Es. 200"
                        className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium text-slate-700">Capitale attuale aggiornato</label>
                      <input
                        value={goalCurrentValue}
                        onChange={(e) => setGoalCurrentValue(e.target.value)}
                        placeholder="Es. 0"
                        className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                      />
                    </div>
                  </div>
                </div>
              )}

              {onboardingStep === 2 && (
                <div className="space-y-5">
                  <div>
                    <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">Passo 3 di 3</p>
                    <h3 className="mt-2 text-2xl font-bold tracking-tight">Quando vuoi arrivarci?</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      Inserisci l'anno finale: l'app calcolera durata, mesi rimanenti e stima del piano.
                    </p>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <label className="text-sm font-medium text-slate-700">Anno fine investimento</label>
                      <input
                        type="number"
                        value={goalEndYear}
                        onChange={(e) => setGoalEndYear(e.target.value)}
                        placeholder="Es. 2055"
                        className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                      />
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Riepilogo</p>
                      <p className="mt-2 text-sm leading-6 text-slate-700">
                        Obiettivo: <strong>{goalTitle || "Il tuo obiettivo"}</strong><br />
                        PAC: <strong>{formatEuro(Number(portMonthly || 0))}/mese</strong><br />
                        Target: <strong>{formatEuro(Number(goalTarget || 0))}</strong>
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <button
                  onClick={() => onboardingStep === 0 ? goToFirstTimeGuide() : setOnboardingStep((prev) => prev - 1)}
                  className="rounded-xl border border-slate-200 px-5 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  {onboardingStep === 0 ? "Salta per ora" : "Indietro"}
                </button>

                <button
                  onClick={() => {
                    if (onboardingStep < 2) {
                      setOnboardingStep((prev) => prev + 1);
                    } else {
                      completeOnboarding();
                    }
                  }}
                  className="rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-emerald-700"
                >
                  {onboardingStep < 2 ? "Continua" : "Attiva il mio piano"}
                </button>
              </div>
            </div>
          </section>
        )}


        {step === "awareness" && (
          <section className="space-y-6">
            <div className="hidden rounded-3xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-8 shadow-sm lg:block">
              <p className="text-sm font-semibold uppercase tracking-[0.22em] text-emerald-700">Pacchetto Core</p>
              <div className="mt-3 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <h2 className="text-3xl font-bold tracking-tight text-slate-950 md:text-5xl">Consapevolezza finanziaria</h2>
                  <p className="mt-4 max-w-4xl text-base leading-7 text-slate-700">
                    Una sezione pratica per liberare denaro, evitare errori costosi e proteggerti dalle truffe. Non giudica le scelte: mostra costo reale, rischi e alternative.
                  </p>
                </div>
                <div className="rounded-2xl border border-emerald-200 bg-white p-5">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Risultati tracciati</p>
                  <p className="mt-2 text-2xl font-bold text-slate-950">{formatEuro(monthlyFreedByAwareness)}/mese</p>
                  <p className="mt-1 text-sm text-slate-600">{formatEuro(yearlyFreedByAwareness)} potenziale annuo liberato</p>
                </div>
              </div>
            </div>

            <div className="hidden rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm lg:block">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.22em] text-emerald-700">Scegli una scheda</p>
                  <h3 className="mt-2 text-xl font-bold tracking-tight text-slate-950">Da dove vuoi partire?</h3>
                </div>
                <p className="max-w-2xl text-sm leading-6 text-slate-600">
                  Queste sono le 4 aree della Consapevolezza. Seleziona una card per aprire lo strumento dedicato.
                </p>
              </div>

              <div className="mt-5 grid gap-3 lg:grid-cols-4">
                {[
                  { key: "risparmio" as AwarenessTab, icon: "💡", title: "Risparmio", subtitle: "Libera soldi ogni mese", detail: "Sprechi, spesa intelligente e azioni pratiche." },
                  { key: "auto" as AwarenessTab, icon: "🚗", title: "Auto", subtitle: "Scopri il costo reale", detail: "Rata, TAEG, maxi rata e rifinanziamento." },
                  { key: "mutuo" as AwarenessTab, icon: "🏠", title: "Mutuo", subtitle: "Valuta la sostenibilità", detail: "Rata, costi reali, stress test e semaforo." },
                  { key: "truffe" as AwarenessTab, icon: "🛡️", title: "Anti-truffe", subtitle: "Allenati sui rischi", detail: "Mini gioco con 200 scenari realistici." },
                ].map((tab) => {
                  const active = awarenessTab === tab.key;
                  return (
                    <button
                      key={tab.key}
                      onClick={() => setAwarenessTab(tab.key)}
                      className={`group relative overflow-hidden rounded-3xl border p-5 text-left transition-all duration-300 ${
                        active
                          ? "border-emerald-400 bg-emerald-50 shadow-sm ring-2 ring-emerald-100"
                          : "border-slate-200 bg-white hover:-translate-y-0.5 hover:border-emerald-200 hover:bg-slate-50 hover:shadow-sm"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className={`flex h-12 w-12 items-center justify-center rounded-2xl text-xl transition ${
                          active ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-700 group-hover:bg-emerald-100"
                        }`}>
                          {tab.icon}
                        </div>
                        <span className={`shrink-0 rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-wide ${
                          active ? "bg-white text-emerald-700 ring-1 ring-emerald-200" : "bg-slate-50 text-slate-500 ring-1 ring-slate-200"
                        }`}>
                          {active ? "Scheda aperta" : "Apri"}
                        </span>
                      </div>
                      <p className="mt-4 text-lg font-bold tracking-tight text-slate-950">{tab.title}</p>
                      <p className={`mt-1 text-sm font-semibold ${active ? "text-emerald-800" : "text-slate-700"}`}>{tab.subtitle}</p>
                      <p className="mt-2 text-sm leading-6 text-slate-600">{tab.detail}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            {awarenessTab === "risparmio" && (
              <div className="space-y-6">
                <div className={`${mobileAwarenessMode === "shopping" ? "hidden lg:block" : ""} rounded-3xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-6 shadow-sm`}>
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-700">Scheda risparmio</p>
                      <h3 className="mt-2 text-2xl font-bold tracking-tight text-slate-950">Libera soldi ogni mese, senza stravolgere la vita</h3>
                      <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-700">
                        Qui trovi azioni semplici e concrete: meno sprechi, meno costi invisibili, più denaro disponibile per PAC, obiettivi e serenità. Scegli 2 o 3 azioni sostenibili: la costanza conta più dei tagli estremi.
                      </p>
                    </div>
                    <div className="rounded-2xl border border-emerald-200 bg-white p-4 text-sm shadow-sm">
                      <p className="font-semibold text-slate-950">Risparmio potenziale liberato</p>
                      <p className="mt-1 text-2xl font-bold text-emerald-700">{formatEuro(monthlyFreedByAwareness)}/mese</p>
                      <p className="mt-1 text-slate-600">{formatEuro(yearlyFreedByAwareness)} all'anno se mantieni le azioni completate.</p>
                    </div>
                  </div>
                </div>

                <div className={`${mobileAwarenessMode === "shopping" ? "hidden lg:block" : ""} rounded-3xl border border-slate-200 bg-white p-5 shadow-sm`}>
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-slate-950">Da dove iniziare</p>
                      <p className="mt-1 text-sm leading-6 text-slate-600">
                        Le card sono ordinate per probabilita di risultato: prima le azioni facili, ricorrenti e con buon impatto. Non devi farle tutte: scegli quelle più adatte alla tua situazione.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs font-semibold">
                      <span className="rounded-full bg-emerald-50 px-3 py-2 text-emerald-700 ring-1 ring-emerald-200">Primary = azione da fare</span>
                      <span className="rounded-full bg-slate-50 px-3 py-2 text-slate-600 ring-1 ring-slate-200">Secondary = azione già completata</span>
                    </div>
                  </div>
                </div>

                <div id="spesa-intelligente" className={`${mobileAwarenessMode === "shopping" ? "block" : "hidden"} rounded-[2rem] border border-emerald-200 bg-gradient-to-br from-white via-emerald-50/40 to-white p-5 shadow-sm lg:block`}> 
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <p className="text-xs font-black uppercase tracking-[0.22em] text-emerald-700">Spesa intelligente</p>
                      <h4 className="mt-2 text-2xl font-black tracking-tight text-slate-950">Prepara la lista prima di entrare al supermercato</h4>
                      <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-700">
                        Parti da prodotti comuni, aggiungi quello che ti serve davvero e spunta le voci mentre fai la spesa. Una lista chiara riduce acquisti impulsivi, doppioni e sprechi.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsSmartShoppingOpen((prev) => !prev)}
                      className={`shrink-0 rounded-xl px-5 py-3 text-sm font-bold transition ${isSmartShoppingOpen ? "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50" : "bg-emerald-600 text-white hover:bg-emerald-700"}`}
                    >
                      {isSmartShoppingOpen ? "Richiudi lista" : "Apri Spesa intelligente"}
                    </button>
                  </div>

                  {!isSmartShoppingOpen && (
                    <div className="mt-5 rounded-2xl border border-emerald-100 bg-white/80 p-4 text-sm leading-6 text-slate-600">
                      Apri il menu quando vuoi preparare o aggiornare la lista. Quando non ti serve, resta chiusa e non occupa spazio nella scheda Risparmio.
                    </div>
                  )}

                  {isSmartShoppingOpen && (
                    <div className="mt-5">
                    <div className="grid w-full min-w-0 grid-cols-2 gap-3 text-sm sm:grid-cols-4 lg:grid-cols-2">
                      <div className="rounded-2xl bg-white p-4 ring-1 ring-emerald-100">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Acquistati</p>
                        <p className="mt-1 text-xl font-black text-slate-950">{shoppingCheckedCount}/{shoppingItems.length}</p>
                      </div>
                      <div className="rounded-2xl bg-white p-4 ring-1 ring-emerald-100">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Da comprare</p>
                        <p className="mt-1 text-xl font-black text-slate-950">{shoppingRemainingCount}</p>
                      </div>
                      <div className="rounded-2xl bg-white p-4 ring-1 ring-emerald-100">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Totale stimato</p>
                        <p className="mt-1 text-xl font-black text-emerald-700">{formatEuro(shoppingTotalEstimated)}</p>
                      </div>
                      <div className="rounded-2xl bg-white p-4 ring-1 ring-emerald-100">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Extra</p>
                        <p className="mt-1 text-xl font-black text-indigo-700">{formatEuro(shoppingExtraEstimated)}</p>
                      </div>
                    </div>


                  <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
                    <strong>Prima regola anti-spreco:</strong> controlla frigo e dispensa prima di aggiungere prodotti. Se lo hai già in casa, non comprarlo di nuovo.
                  </div>

                  <div className="mt-5 grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
                    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h5 className="text-lg font-black text-slate-950">Prodotti comuni</h5>
                          <p className="mt-1 text-sm leading-6 text-slate-600">Aggiungi rapidamente prodotti senza marche. Puoi modificare la lista con prodotti personali quando vuoi.</p>
                        </div>
                        <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700 ring-1 ring-emerald-200">Base</span>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        {commonShoppingProducts.map((product) => (
                          <button
                            key={`${product.category}-${product.name}`}
                            onClick={() => addShoppingPreset(product)}
                            disabled={shoppingLoading}
                            className="rounded-full border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700 transition hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-800 disabled:opacity-50"
                          >
                            + {product.name}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                      <h5 className="text-lg font-black text-slate-950">Aggiungi prodotto</h5>
                      <p className="mt-1 text-sm leading-6 text-slate-600">Usalo per prodotti specifici della tua famiglia o per voci che non trovi tra quelle comuni.</p>
                      <div className="mt-4 grid gap-3 md:grid-cols-[1.1fr_0.8fr_0.6fr]">
                        <label className="text-sm font-semibold text-slate-700">
                          Nome prodotto
                          <input
                            value={shoppingDraft.name}
                            onChange={(event) => setShoppingDraft((prev) => ({ ...prev, name: event.target.value }))}
                            placeholder="Es. caffe, pannolini, detersivo"
                            className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-3 text-sm outline-none transition focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"
                          />
                        </label>
                        <label className="text-sm font-semibold text-slate-700">
                          Categoria
                          <select
                            value={shoppingDraft.category}
                            onChange={(event) => setShoppingDraft((prev) => ({ ...prev, category: event.target.value as ShoppingCategory }))}
                            className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-3 text-sm outline-none transition focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"
                          >
                            {shoppingCategories.map((category) => (
                              <option key={category} value={category}>{category}</option>
                            ))}
                          </select>
                        </label>
                        <label className="text-sm font-semibold text-slate-700">
                          Prezzo stimato
                          <input
                            value={shoppingDraft.estimatedPrice}
                            onChange={(event) => setShoppingDraft((prev) => ({ ...prev, estimatedPrice: event.target.value }))}
                            inputMode="decimal"
                            placeholder="0"
                            className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-3 text-sm outline-none transition focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"
                          />
                        </label>
                      </div>
                      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <label className="inline-flex items-center gap-3 rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm font-semibold text-indigo-800">
                          <input
                            type="checkbox"
                            checked={shoppingDraft.isExtra}
                            onChange={(event) => setShoppingDraft((prev) => ({ ...prev, isExtra: event.target.checked }))}
                            className="h-4 w-4 rounded border-indigo-300 text-indigo-600"
                          />
                          Segnalo come extra/sfizio
                        </label>
                        <button
                          onClick={addCustomShoppingItem}
                          disabled={shoppingLoading || !shoppingDraft.name.trim()}
                          className="rounded-xl bg-emerald-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Aggiungi prodotto
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="mt-5 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                      <div>
                        <h5 className="text-lg font-black text-slate-950">La tua lista attiva</h5>
                        <p className="mt-1 text-sm leading-6 text-slate-600">
                          Spunta ogni voce quando la metti nel carrello. Gli extra restano evidenziati: non sono vietati, ma è meglio vederli separati.
                        </p>
                      </div>
                      {shoppingItems.length > 0 && (
                        <button
                          onClick={() => setShowShoppingResetConfirm(true)}
                          className={`rounded-xl px-5 py-3 text-sm font-bold transition ${shoppingAllChecked ? "bg-emerald-600 text-white hover:bg-emerald-700" : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}
                        >
                          {shoppingAllChecked ? "Prepara nuova lista" : "Reset lista"}
                        </button>
                      )}
                    </div>

                    {shoppingMessage && (
                      <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-semibold text-slate-700">{shoppingMessage}</div>
                    )}

                    {shoppingItems.length === 0 ? (
                      <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm leading-6 text-slate-600">
                        La lista è vuota. Aggiungi qualche prodotto comune oppure crea un prodotto personale.
                      </div>
                    ) : (
                      <div className="mt-5 grid gap-3 lg:grid-cols-2">
                        {shoppingItems.map((item) => (
                          <div key={item.id} className={`flex items-center gap-3 rounded-2xl border p-4 transition ${item.isChecked ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white"}`}>
                            <button
                              onClick={() => toggleShoppingItem(item)}
                              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border text-sm font-black transition ${item.isChecked ? "border-emerald-500 bg-emerald-600 text-white" : "border-slate-300 bg-white text-slate-400 hover:border-emerald-300"}`}
                              aria-label={item.isChecked ? "Segna come non acquistato" : "Segna come acquistato"}
                            >
                              {item.isChecked ? "✓" : ""}
                            </button>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className={`font-bold ${item.isChecked ? "text-emerald-900 line-through decoration-emerald-500/60" : "text-slate-950"}`}>{item.name}</p>
                                <span className={`rounded-full px-2 py-1 text-[11px] font-bold ring-1 ${item.isExtra ? "bg-indigo-50 text-indigo-700 ring-indigo-200" : "bg-emerald-50 text-emerald-700 ring-emerald-200"}`}>
                                  {item.isExtra ? "Extra" : "Necessario"}
                                </span>
                                {item.isCustom && <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-bold text-slate-600 ring-1 ring-slate-200">Personale</span>}
                              </div>
                              <p className="mt-1 text-xs text-slate-500">{item.category} · stimato {formatEuro(item.estimatedPrice)}</p>
                            </div>
                            <button
                              onClick={() => deleteShoppingItem(item)}
                              className="rounded-xl px-3 py-2 text-xs font-bold text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                            >
                              Rimuovi
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                    </div>
                  )}
                </div>

                {showShoppingResetConfirm && (
                  <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 px-4 backdrop-blur-sm">
                    <div className="w-full max-w-md rounded-[2rem] bg-white p-6 shadow-2xl">
                      <p className="text-xs font-black uppercase tracking-[0.22em] text-amber-600">Conferma reset</p>
                      <h4 className="mt-2 text-2xl font-black tracking-tight text-slate-950">
                        {shoppingAllChecked ? "Preparare una nuova lista?" : "Vuoi davvero azzerare la lista?"}
                      </h4>
                      <p className="mt-3 text-sm leading-6 text-slate-600">
                        {shoppingAllChecked
                          ? "Tutte le voci risultano acquistate. Confermando, svuoti la lista e puoi prepararne una nuova."
                          : "Ci sono ancora prodotti non completati. Confermando, perderai tutta la lista attiva."}
                      </p>
                      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                        <button
                          onClick={() => setShowShoppingResetConfirm(false)}
                          className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-bold text-slate-700 transition hover:bg-slate-50"
                        >
                          Annulla
                        </button>
                        <button
                          onClick={resetShoppingList}
                          disabled={shoppingLoading}
                          className="rounded-xl bg-emerald-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-emerald-700 disabled:opacity-50"
                        >
                          Conferma reset
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <div className={`${mobileAwarenessMode === "shopping" ? "hidden lg:grid" : "grid"} gap-4 xl:grid-cols-2`}>
                  {sortedAwarenessActions.map((action, index) => {
                    const done = !!completedAwarenessActions[action.id];
                    return (
                      <div key={action.id} className={`rounded-3xl border p-5 shadow-sm transition ${done ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-white hover:border-emerald-200 hover:shadow-md"}`}>
                        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">#{index + 1}</span>
                              <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">{action.area}</span>
                              {done && <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">Completata</span>}
                            </div>
                            <h4 className="mt-3 text-lg font-bold text-slate-950">{action.title}</h4>
                            <p className="mt-2 text-sm leading-6 text-slate-600">{action.why}</p>
                          </div>
                          <div className="shrink-0 rounded-2xl border border-slate-200 bg-white p-4 text-sm">
                            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Impatto stimato</p>
                            <p className="mt-1 text-lg font-bold text-slate-950">{formatEuro(action.estimatedSavingMonthly)}/mese</p>
                            <p className="mt-1 text-slate-600">{formatEuro(action.estimatedSavingYearly)}/anno</p>
                          </div>
                        </div>

                        <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
                          <div className="rounded-2xl border border-slate-200 bg-white p-3">Tempo: <strong>{action.minutes} min</strong></div>
                          <div className="rounded-2xl border border-slate-200 bg-white p-3">Difficolta: <strong>{action.difficulty}/5</strong></div>
                          <div className="rounded-2xl border border-slate-200 bg-white p-3">Sacrificio: <strong>{action.sacrifice}/5</strong></div>
                        </div>

                        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-sm font-semibold text-slate-950">Come metterla in pratica</p>
                          <ol className="mt-3 space-y-2 text-sm leading-6 text-slate-700">
                            {action.steps.map((stepText, stepIndex) => (
                              <li key={stepText} className="flex gap-2">
                                <span className="font-semibold text-emerald-700">{stepIndex + 1}.</span>
                                <span>{stepText}</span>
                              </li>
                            ))}
                          </ol>
                        </div>

                        <div className="mt-5 flex flex-wrap gap-3">
                          {!done ? (
                            <button
                              onClick={() => toggleAwarenessAction(action.id, true)}
                              className="rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-700"
                            >
                              Segna come fatto
                            </button>
                          ) : (
                            <button
                              onClick={() => toggleAwarenessAction(action.id, false)}
                              className="rounded-xl border border-emerald-200 bg-white px-5 py-3 text-sm font-semibold text-emerald-800 transition hover:bg-emerald-100"
                            >
                              Azione completata
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {awarenessTab === "auto" && (
              <div className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
                <div className="space-y-4">
                  <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                    <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Motore auto</p>
                    <h3 className="mt-2 text-2xl font-bold tracking-tight">Quanto ti costa davvero l'auto?</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      Inserisci i dati del preventivo. La rata è importante, ma il TAEG aiuta a controllare se il costo del finanziamento è coerente con quello che ti è stato comunicato.
                    </p>

                    <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-900">
                      <strong>Cos'è il TAEG?</strong> È il costo annuo del finanziamento. Include interessi e diversi costi collegati, come pratiche, incasso rata o servizi obbligatori. Se hai già la rata, il TAEG serve come controllo intelligente.
                    </div>

                    <div className="mt-5 space-y-5">
                      <div>
                        <p className="text-sm font-bold text-slate-950">1. Dati del finanziamento</p>
                        <div className="mt-3 grid gap-4 md:grid-cols-2">
                          {[
                            ["Prezzo auto", vehiclePrice, setVehiclePrice, "Prezzo totale dell'auto dopo eventuale sconto indicato nel preventivo."],
                            ["Anticipo", vehicleDownPayment, setVehicleDownPayment, "Quanto paghi subito."],
                            ["Importo totale del credito", vehicleTotalCredit, setVehicleTotalCredit, "Se il preventivo lo indica, inseriscilo: rende il calcolo più vicino alla realta. Altrimenti lascia vuoto."],
                            ["Rata mensile dichiarata", vehicleMonthlyPayment, setVehicleMonthlyPayment, "La rata che vedi nel preventivo."],
                            ["TAN annuo (%)", vehicleTan, setVehicleTan, "Serve soprattutto se non c'è maxi rata finale. Se c'è maxi rata, il dato finale inserito rende il calcolo più concreto."],
                            ["TAEG annuo (%)", vehicleTaeg, setVehicleTaeg, "Dato spesso scritto in piccolo: usalo per controllare il costo reale del finanziamento."],
                            ["Durata mesi", vehicleDurationMonths, setVehicleDurationMonths, "Per quanti mesi paghi. Se c'è maxi rata finale, includi anche il mese finale."],
                            ["Maxi rata finale", vehicleBalloonPayment, setVehicleBalloonPayment, "Se non c'è, scrivi 0."],
                          ].map(([label, value, setter, hint]) => (
                            <label key={String(label)} className="text-sm font-medium text-slate-700">
                              {label as string}
                              <input
                                value={value as string}
                                onChange={(e) => (setter as (value: string) => void)(e.target.value)}
                                className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                              />
                              <span className="mt-1 block text-xs leading-5 text-slate-500">{hint as string}</span>
                            </label>
                          ))}
                        </div>
                    <div>
                      <label className="text-sm font-medium text-slate-700">Bonus finanziamento / sconto vincolato (€)</label>
                      <input
                        value={vehicleFinancingBonus}
                        onChange={(e) => setVehicleFinancingBonus(e.target.value)}
                        placeholder="Es. 1800"
                        className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none"
                      />
                      <p className="mt-2 text-xs leading-5 text-slate-500">
                        Inserisci eventuali sconti validi solo con finanziamento. Se hai già inserito l'importo totale del credito, questo campo non modifica la rata stimata dal TAEG.
                      </p>
                    </div>
                        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <label className="text-sm font-medium text-slate-700">
                            Offerta con rottamazione?
                            <select
                              value={vehicleScrappage}
                              onChange={(e) => setVehicleScrappage(e.target.value)}
                              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
                            >
                              <option value="no">No</option>
                              <option value="si">Si</option>
                            </select>
                          </label>
                          <p className="mt-2 text-xs leading-5 text-slate-500">
                            Se scegli Si, l'app ti ricordera di leggere lo sconto come condizione dell'offerta, non come costo cancellato.
                          </p>
                        </div>
                      </div>

                      <div>
                        <p className="text-sm font-bold text-slate-950">2. Costi ricorrenti</p>
                        <div className="mt-3 grid gap-4 md:grid-cols-2">
                          {[
                            ["Reddito netto mensile", vehicleMonthlyIncome, setVehicleMonthlyIncome, "Serve per capire quanto pesa l'auto sul bilancio."],
                            ["Assicurazione annua", vehicleInsuranceYearly, setVehicleInsuranceYearly, "RC auto e coperture principali."],
                            ["Manutenzione annua", vehicleMaintenanceYearly, setVehicleMaintenanceYearly, "Tagliandi, piccoli interventi, imprevisti."],
                            ["Bollo annuo", vehicleRoadTaxYearly, setVehicleRoadTaxYearly, "Se non lo paghi, scrivi 0."],
                            ["Gomme / revisione annue", vehicleTyresYearly, setVehicleTyresYearly, "Stima semplice dei costi periodici."],
                          ].map(([label, value, setter, hint]) => (
                            <label key={String(label)} className="text-sm font-medium text-slate-700">
                              {label as string}
                              <input
                                value={value as string}
                                onChange={(e) => (setter as (value: string) => void)(e.target.value)}
                                className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                              />
                              <span className="mt-1 block text-xs leading-5 text-slate-500">{hint as string}</span>
                            </label>
                          ))}
                        </div>
                      </div>

                      <div>
                        <p className="text-sm font-bold text-slate-950">3. Uso dell'auto</p>
                        <p className="mt-1 text-xs leading-5 text-slate-500">Questi dati servono soprattutto se il contratto ha valore futuro garantito o limiti chilometrici.</p>
                        <div className="mt-3 grid gap-4 md:grid-cols-2">
                          {[
                            ["Km limite annui", vehicleKmLimit, setVehicleKmLimit],
                            ["Km previsti annui", vehicleKmExpected, setVehicleKmExpected],
                          ].map(([label, value, setter]) => (
                            <label key={String(label)} className="text-sm font-medium text-slate-700">
                              {label as string}
                              <input
                                value={value as string}
                                onChange={(e) => (setter as (value: string) => void)(e.target.value)}
                                className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                              />
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className={`rounded-3xl border p-6 shadow-sm ${vehiclePaymentCheckTone === "amber" ? "border-amber-200 bg-amber-50" : vehiclePaymentCheckTone === "emerald" ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white"}`}>
                    <p className={`text-sm font-semibold uppercase tracking-[0.2em] ${vehiclePaymentCheckTone === "amber" ? "text-amber-700" : vehiclePaymentCheckTone === "emerald" ? "text-emerald-700" : "text-slate-500"}`}>Controllo rata e TAEG</p>
                    <h4 className="mt-2 text-xl font-bold text-slate-950">{vehiclePaymentCheckTitle}</h4>
                    <p className="mt-2 text-sm leading-6 text-slate-700">{vehiclePaymentCheckMessage}</p>
                    <div className="mt-4 grid gap-3 md:grid-cols-3">
                      <div className="rounded-2xl bg-white/80 p-4 ring-1 ring-white">
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Rata dichiarata</p>
                        <p className="mt-1 text-lg font-bold text-slate-950">{vehicleHasDeclaredPayment ? `${formatEuro(vehicle.monthlyPayment)}/mese` : "Non inserita"}</p>
                      </div>
                      <div className="rounded-2xl bg-white/80 p-4 ring-1 ring-white">
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Rata da TAEG</p>
                        <p className="mt-1 text-lg font-bold text-slate-950">{vehicleHasTaegEstimate ? `circa ${formatEuro(vehicleEstimatedMonthlyPaymentFromTaeg)}/mese` : "Non stimabile"}</p>
                      </div>
                      <div className="rounded-2xl bg-white/80 p-4 ring-1 ring-white">
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Differenza</p>
                        <p className="mt-1 text-lg font-bold text-slate-950">{vehicleHasDeclaredPayment && vehicleHasTaegEstimate ? formatEuro(vehicleMonthlyPaymentDifferenceRounded) : "-"}</p>
                      </div>
                    </div>
                  </div>

                  <div className={`rounded-3xl border p-6 shadow-sm ${vehicleFirstMonthCapitalRatio > 0 && vehicleFirstMonthCapitalRatio < 0.4 ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white"}`}>
                    <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Dentro la rata</p>
                    <h4 className="mt-2 text-xl font-bold text-slate-950">Quanto della rata sta pagando davvero l'auto?</h4>
                    <p className="mt-2 text-sm leading-6 text-slate-700">{vehicleInsidePaymentMessage}</p>
                    <div className="mt-4 grid gap-3 md:grid-cols-3">
                      <div className="rounded-2xl bg-white/80 p-4 ring-1 ring-white">
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Interessi e costi medi</p>
                        <p className="mt-1 text-lg font-bold text-slate-950">{vehicleInsidePaymentAvailable ? `${formatEuro(vehicleInsidePaymentInterestAndCosts)}/mese` : "Non stimabile"}</p>
                        <p className="mt-1 text-xs text-slate-500">{vehicleInsidePaymentAvailable ? `${Math.round(vehicleInsidePaymentInterestRatio * 100)}% della rata` : "Inserisci rata e importo"}</p>
                      </div>
                      <div className="rounded-2xl bg-white/80 p-4 ring-1 ring-white">
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Quota capitale media</p>
                        <p className="mt-1 text-lg font-bold text-slate-950">{vehicleInsidePaymentAvailable ? `${formatEuro(vehicleInsidePaymentCapital)}/mese` : "Non stimabile"}</p>
                        <p className="mt-1 text-xs text-slate-500">{vehicleInsidePaymentAvailable ? `${Math.round(vehicleInsidePaymentCapitalRatio * 100)}% della rata` : "Riduce il debito sull'auto"}</p>
                      </div>
                      <div className="rounded-2xl bg-white/80 p-4 ring-1 ring-white">
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Capitale ancora da gestire</p>
                        <p className="mt-1 text-lg font-bold text-slate-950">{vehicleInsidePaymentAvailable ? formatEuro(vehicleDebtAfterInstallmentsEstimate) : "Non stimabile"}</p>
                        <p className="mt-1 text-xs text-slate-500">Alla scadenza del periodo</p>
                      </div>
                    </div>
                    <p className="mt-4 text-xs leading-5 text-slate-500">
                      Stima educativa: con maxi rata finale usiamo il valore finale inserito per stimare quanto capitale viene davvero ridotto dalle rate mensili. Il piano ufficiale può distinguere in modo diverso interessi, spese, servizi e imposte: per il dettaglio preciso serve il piano di ammortamento del finanziamento.
                    </p>
                  </div>

                  {(vehicleBalloonExplanation || vehicleScrappageMessage) && (
                    <div className="space-y-3">
                      {vehicleBalloonExplanation && (
                        <div className="rounded-3xl border border-amber-200 bg-amber-50 p-6 shadow-sm">
                          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-amber-700">Maxi rata finale</p>
                          <h4 className="mt-2 text-xl font-bold text-amber-950">La rata mensile non racconta tutto</h4>
                          <p className="mt-2 text-sm leading-6 text-amber-900">{vehicleBalloonExplanation}</p>
                        </div>
                      )}
                      {vehicleScrappageMessage && (
                        <div className="rounded-3xl border border-indigo-200 bg-indigo-50 p-6 shadow-sm">
                          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-700">Rottamazione</p>
                          <h4 className="mt-2 text-xl font-bold text-indigo-950">Sconto utile, condizioni da leggere bene</h4>
                          <p className="mt-2 text-sm leading-6 text-indigo-900">{vehicleScrappageMessage}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {vehicleHasBalloonPayment && (
                    <div className="rounded-3xl border border-orange-200 bg-orange-50 p-6 shadow-sm">
                      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-orange-700">Se rifinanzi la maxi rata</p>
                      <h4 className="mt-2 text-xl font-bold text-orange-950">La rata finale può diventare un secondo finanziamento</h4>
                      <p className="mt-2 text-sm leading-6 text-orange-900">
                        {vehicleRefinanceMessage}
                      </p>

                      <div className="mt-5 grid gap-4 md:grid-cols-2">
                        <label className="text-sm font-medium text-orange-950">
                          Durata nuovo finanziamento (mesi)
                          <input
                            value={vehicleRefinanceMonths}
                            onChange={(e) => setVehicleRefinanceMonths(e.target.value)}
                            className="mt-2 w-full rounded-xl border border-orange-200 bg-white px-4 py-3 outline-none transition focus:border-orange-400"
                          />
                          <span className="mt-2 block text-xs leading-5 text-orange-800">Per quanti mesi pensi di rifinanziare la maxi rata.</span>
                        </label>
                        <label className="text-sm font-medium text-orange-950">
                          Tasso stimato nuovo finanziamento (%)
                          <input
                            value={vehicleRefinanceRate}
                            onChange={(e) => setVehicleRefinanceRate(e.target.value)}
                            className="mt-2 w-full rounded-xl border border-orange-200 bg-white px-4 py-3 outline-none transition focus:border-orange-400"
                          />
                          <span className="mt-2 block text-xs leading-5 text-orange-800">Usa un valore prudente: un nuovo finanziamento potrebbe avere condizioni diverse dal primo.</span>
                        </label>
                      </div>

                      <div className="mt-5 grid gap-4 md:grid-cols-2">
                        <div className="rounded-2xl bg-white/85 p-5 ring-1 ring-orange-100">
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-orange-700">Importo da rifinanziare</p>
                          <p className="mt-2 text-2xl font-bold text-orange-950">{formatEuro(vehicleRefinance.amount)}</p>
                          <p className="mt-1 text-xs text-orange-800">La maxi rata finale inserita.</p>
                        </div>
                        <div className="rounded-2xl bg-white/85 p-5 ring-1 ring-orange-100">
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-orange-700">Nuova rata stimata</p>
                          <p className="mt-2 text-2xl font-bold text-orange-950">{vehicleRefinanceAvailable ? `${formatEuro(vehicleRefinanceMonthlyPayment)}/mese` : "Non stimabile"}</p>
                          {vehicleRefinanceAvailable && vehicleHasDeclaredPayment && (
                            <p className="mt-1 text-xs text-orange-800">
                              {vehicleRefinancePaymentChange > 0
                                ? `+${formatEuro(vehicleRefinancePaymentChange)}/mese rispetto alla rata iniziale.`
                                : `-${formatEuro(Math.abs(vehicleRefinancePaymentChange))}/mese rispetto alla rata iniziale.`}
                            </p>
                          )}
                        </div>
                        <div className="rounded-2xl bg-white/85 p-5 ring-1 ring-orange-100">
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-orange-700">Interessi/costi stimati</p>
                          <p className="mt-2 text-2xl font-bold text-orange-950">{vehicleRefinanceAvailable ? formatEuro(vehicleRefinanceExtraCost) : "Non stimabile"}</p>
                          <p className="mt-1 text-xs text-orange-800">Sul secondo finanziamento.</p>
                        </div>
                        <div className="rounded-2xl border border-orange-300 bg-white p-5 shadow-sm ring-1 ring-orange-100">
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-orange-700">Costo complessivo stimato</p>
                          <p className="mt-2 text-3xl font-black tracking-tight text-orange-950">{vehicleRefinanceAvailable ? formatEuro(vehicleTotalCostWithRefinance) : "Non stimabile"}</p>
                          <p className="mt-2 text-xs leading-5 text-orange-800">
                            Anticipo + rate iniziali + rifinanziamento maxi rata.
                          </p>
                        </div>
                      </div>

                      {vehicleRefinanceAvailable && (
                        <div className="mt-5 rounded-2xl border border-orange-200 bg-white/80 p-5 text-sm leading-6 text-orange-950">
                          <p className="font-bold">Lettura completa</p>
                          <p className="mt-1">
                            Con i dati inseriti, se rifinanzi la maxi rata la sola auto finanziata potrebbe pesare circa <strong>{formatEuro(vehicleTotalCostWithRefinance)}</strong> complessivi, pari a circa <strong>{formatEuro(vehicleTotalCostWithRefinanceMonthly)}/mese</strong> se spalmi anticipo, primo finanziamento e rifinanziamento sul periodo totale. Questo valore non include assicurazione, bollo, gomme e manutenzione.
                          </p>
                        </div>
                      )}

                      <div className="mt-5 rounded-2xl border border-orange-200 bg-white/80 p-4 text-sm leading-6 text-orange-950">
                        <strong>Messaggio chiave:</strong> se non hai la liquidità per pagare la rata finale, la rata bassa iniziale potrebbe trasformarsi in un nuovo impegno mensile. Questa stima non sostituisce un preventivo ufficiale, ma ti aiuta a capire se la maxi rata finale e davvero sostenibile per te.
                      </div>
                    </div>
                  )}

                  <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                    <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Lettura costo reale</p>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      Questa non è una perizia: distingue il costo mensile che percepisci oggi dal costo reale stimato, cioe quanto pesa l'auto se consideri anche anticipo, costi ricorrenti e maxi rata finale.
                    </p>
                    <div className="mt-4 grid gap-4 md:grid-cols-2">
                      <PremiumStatCard eyebrow="Costo mensile percepito" value={formatEuro(vehicleCashMonthlyCost)} note="Rata + costi ricorrenti che senti ogni mese" />
                      <PremiumStatCard eyebrow="Costo reale mensile stimato" value={formatEuro(vehicleRealMonthlyCost)} note={vehicleHasBalloonPayment ? `Include anche circa ${formatEuro(vehicleBalloonMonthlyReserve)}/mese di maxi rata spalmata` : "Include anticipo e costi sul periodo"} />
                      <PremiumStatCard eyebrow="Costo reale annuo" value={formatEuro(vehicleRealYearlyCost)} note="Quanto pesa in un anno" />
                      <PremiumStatCard eyebrow="Maxi rata accantonata" value={vehicleHasBalloonPayment ? `${formatEuro(vehicleBalloonMonthlyReserve)}/mese` : "0 €"} note="Quota da considerare se vuoi prepararti alla scadenza" />
                      <PremiumStatCard eyebrow="Totale finanziamento" value={formatEuro(vehicleTotalPaidFinancing)} note={`Valido se paghi la maxi rata finale senza rifinanziarla. Extra vs prezzo: ${formatEuro(vehicleExtraCost)}${vehicle.totalCredit > 0 ? " · credito usato nel calcolo" : vehicle.financingBonus > 0 ? " · bonus finanziamento considerato nella stima" : ""}`} />
                      <PremiumStatCard eyebrow="Costi di utilizzo" value={`${formatEuro(vehicleRunningCostsMonthly)}/mese`} note={`Oltre alla rata, potresti spendere circa ${formatEuro(vehicleHiddenCosts)} nei prossimi ${vehicle.durationMonths} mesi per assicurazione, bollo, gomme e manutenzione.`} />
                      <PremiumStatCard eyebrow="Anticipo spalmato" value={formatEuro(vehicleDownPaymentMonthlyWeight)} note="Non esce ogni mese, ma pesa nel costo complessivo" />
                      <PremiumStatCard eyebrow="Impatto sul reddito" value={`${Math.round(vehicleIncomeRatio * 100)}%`} note="Quanto reddito mensile assorbe l'auto" />
                    </div>
                    <div className="mt-5 space-y-3">
                      {vehicleAlerts.length ? vehicleAlerts.map((alert) => (
                        <div key={alert} className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
                          {alert}
                        </div>
                      )) : (
                        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900">
                          Nessun alert importante: continua comunque a confrontare alternative, TAEG e condizioni.
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                    <h4 className="text-xl font-bold">Scenari da valutare</h4>
                    <div className="mt-4 grid gap-3">
                      {[
                        ["Paghi la maxi rata", "Diventi proprietàrio, ma devi avere liquidità finale."],
                        ["Rifinanzi la maxi rata", "Paghi ancora interessi sulla stessa auto."],
                        ["Cambi auto", "Chiudi un contratto e ne riapri un altro: attenzione al ciclo di debito."],
                        ["Auto meno costosa", "Stessa mobilita con più capitale libero per emergenze e PAC."],
                      ].map(([title, description]) => (
                        <div key={title} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="font-semibold text-slate-950">{title}</p>
                          <p className="mt-1 text-sm leading-6 text-slate-600">{description}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {awarenessTab === "mutuo" && (
              <div className="space-y-6">
                <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
                  <div className="grid gap-0 lg:grid-cols-[1.05fr_0.95fr]">
                    <div className="p-6 md:p-8">
                      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-700">Mutuo</p>
                      <h3 className="mt-3 text-3xl font-bold tracking-tight text-slate-950">Capisci rata, costi e condizioni prima di firmare</h3>
                      <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
                        Usa la scheda in due modi: valuta la sostenibilità del mutuo e, quando hai una proposta reale, fatti guidare nella lettura del PIES. Se qualcosa manca o non è chiaro, l'app prepara una richiesta precisa per la banca.
                      </p>
                      <div className={`mt-4 flex flex-col gap-3 rounded-2xl border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between ${mortgageSaveStatusClass}`}>
                        <div>
                          <p className="font-bold">{mortgageSaveStatusLabel}</p>
                          <p className="mt-1 text-xs leading-5 opacity-80">I dati di Sostenibilità e Verifica PIES vengono salvati subito in locale e sincronizzati su Supabase dopo una breve pausa.</p>
                          {mortgageSaveMessage && <p className="mt-1 text-xs leading-5 opacity-80">{mortgageSaveMessage}</p>}
                        </div>
                        <button
                          type="button"
                          onClick={forceSaveMortgageCheck}
                          className="shrink-0 rounded-xl border border-current/20 bg-white/70 px-4 py-2 text-xs font-bold uppercase tracking-[0.16em] transition hover:bg-white"
                        >
                          Salva ora
                        </button>
                      </div>
                      <div className="mt-5 grid gap-3 sm:grid-cols-2">
                        <button
                          type="button"
                          onClick={() => setMortgageMode("sostenibilità")}
                          className={`rounded-2xl border p-4 text-left transition ${mortgageMode === "sostenibilità" ? "border-emerald-300 bg-emerald-50 shadow-sm" : "border-slate-200 bg-white hover:border-slate-300"}`}
                        >
                          <span className="text-2xl">📊</span>
                          <span className="mt-3 block text-base font-bold text-slate-950">Calcola sostenibilità</span>
                          <span className="mt-1 block text-sm leading-5 text-slate-600">Rata, reddito, altri debiti, costi iniziali, fondo emergenza e stress test.</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setMortgageMode("pies")}
                          className={`rounded-2xl border p-4 text-left transition ${mortgageMode === "pies" ? "border-emerald-300 bg-emerald-50 shadow-sm" : "border-slate-200 bg-white hover:border-slate-300"}`}
                        >
                          <span className="text-2xl">📄</span>
                          <span className="mt-3 block text-base font-bold text-slate-950">Verifica PIES</span>
                          <span className="mt-1 block text-sm leading-5 text-slate-600">Dati trovati, dati mancanti, indice di chiarezza, email alla banca e report PDF.</span>
                        </button>
                      </div>
                    </div>
                    <div className="border-t border-slate-200 bg-slate-50 p-6 md:p-8 lg:border-l lg:border-t-0">
                      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Regola pratica</p>
                      <p className="mt-3 text-lg font-bold leading-7 text-slate-950">
                        Non valutare il mutuo solo dalla rata. Controlla costo totale, TAEG, polizze, sconti condizionati e cosa succede se vuoi uscire.
                      </p>
                      <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                        <p className="text-sm font-bold text-amber-950">Da ricordare</p>
                        <p className="mt-1 text-sm leading-6 text-amber-900">Se una condizione incide sul costo del mutuo, chiedila per iscritto. Le condizioni dette solo a voce non bastano.</p>
                      </div>
                    </div>
                  </div>
                </div>

                {mortgageMode === "sostenibilità" && (
                  <div className="grid gap-6 lg:grid-cols-[1fr_0.9fr]">
                    <div className="space-y-6">
                      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
                        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Percorso 1</p>
                        <h4 className="mt-2 text-2xl font-bold tracking-tight text-slate-950">Sostenibilita del mutuo</h4>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                          Inserisci i dati che conosci. Se hai una rata proposta dalla banca, usa quella: e più concreta della stima calcolata.
                        </p>

                        <div className="mt-6 grid gap-4 md:grid-cols-2">
                          {[
                            ["Prezzo casa", mortgageHomePrice, setMortgageHomePrice, "Prezzo richiesto per la casa. Oltre al prezzo ci sono anticipo, notaio, imposte e altre spese."],
                            ["Anticipo", mortgageDownPayment, setMortgageDownPayment, "Soldi che metti subito. Non consumare tutta la liquidità solo per aumentare l'anticipo."],
                            ["Importo mutuo", mortgagePrincipal, setMortgagePrincipal, "Se hai già il preventivo della banca, inserisci l'importo esatto. Se lo lasci vuoto, lo stimiamo da prezzo casa meno anticipo."],
                            ["Durata mutuo (anni)", mortgageYears, setMortgageYears, "Durate più lunghe abbassano la rata, ma di solito aumentano gli interessi totali pagati nel tempo."],
                            ["Tasso / TAN (%)", mortgageRate, setMortgageRate, "Inserisci il tasso nominale indicato nel preventivo o nel PIES."],
                            ["Rata dichiarata dalla banca", mortgageDeclaredPayment, setMortgageDeclaredPayment, "Se la banca ti ha dato una rata, inseriscila qui: l'app la usa come dato principale."],
                            ["Reddito netto mensile", mortgageMonthlyIncome, setMortgageMonthlyIncome, "Usa il reddito familiare netto stabile, non entrate occasionali."],
                            ["Altre rate/debiti mensili", mortgageOtherDebtsMonthly, setMortgageOtherDebtsMonthly, "Prestiti, finanziamenti, cessioni, carte rateali: servono per capire il peso totale dei debiti."],
                          ].map(([label, value, setter, help]) => (
                            <label key={String(label)} className="text-sm font-medium text-slate-700">
                              {label as string}
                              <input
                                value={value as string}
                                onChange={(e) => (setter as (value: string) => void)(e.target.value)}
                                className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                              />
                              <span className="mt-1 block text-xs leading-5 text-slate-500">{help as string}</span>
                            </label>
                          ))}
                        </div>

                        <div className="mt-5 grid gap-4 md:grid-cols-2">
                          <label className="text-sm font-medium text-slate-700">
                            Tipo tasso
                            <select
                              value={mortgageRateType}
                              onChange={(e) => setMortgageRateType(e.target.value)}
                              className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                            >
                              <option value="fisso">Fisso</option>
                              <option value="variabile">Variabile</option>
                              <option value="cap">Variabile con cap</option>
                            </select>
                            <span className="mt-1 block text-xs leading-5 text-slate-500">Serve per adattare lo stress test al tipo di rischio.</span>
                          </label>
                          {mortgageRateType === "cap" && (
                            <label className="text-sm font-medium text-slate-700">
                              Tasso massimo / cap (%)
                              <input
                                value={mortgageCapRate}
                                onChange={(e) => setMortgageCapRate(e.target.value)}
                                className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                              />
                              <span className="mt-1 block text-xs leading-5 text-slate-500">È il tasso massimo previsto dal contratto. Serve per stimare la rata nello scenario peggiore.</span>
                            </label>
                          )}
                        </div>
                      </div>

                      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
                        <h4 className="text-xl font-bold text-slate-950">Costi iniziali, casa e fondo emergenza</h4>
                        <p className="mt-2 text-sm leading-6 text-slate-600">Per comprare casa non servono solo anticipo e mutuo. Notaio, imposte, agenzia, trasloco, arredamento e piccoli lavori possono assorbire molta liquidità.</p>
                        <div className="mt-5 grid gap-4 md:grid-cols-2">
                          {[
                            ["Costi iniziali acquisto", mortgageInitialCosts, setMortgageInitialCosts, "Notaio, imposte, agenzia, perizia, istruttoria, trasloco, primi lavori o arredi."],
                            ["Costi casa annui", mortgageRecurringYearly, setMortgageRecurringYearly, "Spese ricorrenti generiche della casa, se vuoi inserirle in modo aggregato."],
                            ["Condominio mensile", mortgageCondoMonthly, setMortgageCondoMonthly, "Spese condominiali ordinarie."],
                            ["Utenze mensili", mortgageUtilitiesMonthly, setMortgageUtilitiesMonthly, "Luce, gas, acqua, internet e costi simili."],
                            ["Assicurazioni annue", mortgageInsuranceYearly, setMortgageInsuranceYearly, "Polizze casa, incendio/scoppio o altre coperture collegate."],
                            ["Manutenzione annua", mortgageMaintenanceYearly, setMortgageMaintenanceYearly, "Piccoli lavori, riparazioni, manutenzione ordinaria."],
                            ["Spese fisse mensili familiari", mortgageFixedExpensesMonthly, setMortgageFixedExpensesMonthly, "Spese essenziali escluse rata e costi casa già inseriti."],
                            ["Liquidita residua dopo acquisto", mortgageLiquidAfterPurchase, setMortgageLiquidAfterPurchase, "Soldi che ti restano dopo anticipo e costi iniziali."],
                            ["Mesi fondo emergenza", mortgageEmergencyMonths, setMortgageEmergencyMonths, "Quanti mesi di sicurezza vuoi mantenere dopo l'acquisto."],
                          ].map(([label, value, setter, help]) => (
                            <label key={String(label)} className="text-sm font-medium text-slate-700">
                              {label as string}
                              <input
                                value={value as string}
                                onChange={(e) => (setter as (value: string) => void)(e.target.value)}
                                className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                              />
                              <span className="mt-1 block text-xs leading-5 text-slate-500">{help as string}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Lettura semplice</p>
                        <h4 className="mt-2 text-xl font-bold text-slate-950">Rata, costo casa e sostenibilità</h4>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                          {mortgagePrincipalForCalc <= 0
                            ? "Inserisci almeno prezzo casa e anticipo, oppure direttamente l'importo del mutuo, per vedere una stima più utile."
                            : mortgageUsesDeclaredPayment
                            ? "Stiamo usando la rata che hai inserito. La stima del tasso resta utile come controllo, ma il dato dichiarato e quello più concreto."
                            : "Non hai inserito una rata dichiarata: la rata viene stimata usando importo, tasso e durata."}
                        </p>
                        <div className="mt-4 grid gap-4 md:grid-cols-2">
                          <PremiumStatCard eyebrow={mortgageUsesDeclaredPayment ? "Rata dichiarata" : "Rata stimata"} value={formatEuro(mortgageMonthlyPayment)} note="Quello che paghi alla banca ogni mese" />
                          <PremiumStatCard eyebrow="Costo reale mensile" value={formatEuro(mortgageRealMonthlyHomeCost)} note="Rata + costi ricorrenti della casa" />
                          <PremiumStatCard eyebrow="Totale rimborsato stimato" value={formatEuro(mortgageTotalPaid)} note={`Rate mutuo per ${mortgageMonths} mesi, esclusi costi casa separati`} />
                          <PremiumStatCard eyebrow="Interessi stimati" value={formatEuro(mortgageTotalInterest)} note="Totale rimborsato meno capitale richiesto" />
                          <PremiumStatCard eyebrow="Peso rata/reddito" value={`${Math.round(mortgagePaymentIncomeRatio * 100)}%`} note="Solo rata mutuo" />
                          <PremiumStatCard eyebrow="Debiti/reddito" value={`${Math.round(mortgageDebtIncomeRatio * 100)}%`} note="Rata mutuo + altre rate" />
                        </div>
                      </div>

                      <div className={`rounded-3xl border p-6 shadow-sm ${
                        mortgageSustainabilityLevel === "buono"
                          ? "border-emerald-200 bg-emerald-50"
                          : mortgageSustainabilityLevel === "medio"
                          ? "border-amber-200 bg-amber-50"
                          : "border-red-200 bg-red-50"
                      }`}>
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Semaforo mutuo</p>
                            <h4 className="mt-2 text-xl font-bold text-slate-950">{mortgageTrafficLight.title}</h4>
                          </div>
                          <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-bold ${mortgageTrafficLight.badgeClass}`}>
                            <span className={`h-2.5 w-2.5 rounded-full ${mortgageTrafficLight.dotClass}`} />
                            {mortgageTrafficLight.label}
                          </span>
                        </div>
                        <p className="mt-4 text-sm leading-6 text-slate-700">{mortgageTrafficLight.shortText}</p>
                        <p className="mt-2 text-sm leading-6 text-slate-700">{mortgageTrafficLight.advice}</p>
                        <div className="mt-4 grid gap-3 md:grid-cols-2">
                          <div className="rounded-2xl bg-white/80 p-4">
                            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Margine mensile residuo</p>
                            <p className="mt-1 text-2xl font-bold text-slate-950">{formatEuro(mortgageMonthlyMargin)}</p>
                            <p className="mt-1 text-xs text-slate-600">Reddito meno spese fisse, altri debiti e costo reale casa.</p>
                          </div>
                          <div className="rounded-2xl bg-white/80 p-4">
                            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Fondo emergenza</p>
                            <p className="mt-1 text-2xl font-bold text-slate-950">{formatEuro(mortgageEmergencyNeeded)}</p>
                            <p className="mt-1 text-xs text-slate-600">Sicurezza consigliata per {mortgage.emergencyMonths} mesi.</p>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                        <h4 className="text-xl font-bold text-slate-950">Costi iniziali e liquidità</h4>
                        <div className="mt-4 grid gap-4 md:grid-cols-2">
                          <PremiumStatCard eyebrow="Soldi iniziali necessari" value={formatEuro(mortgageFrontCashNeeded)} note="Anticipo + costi iniziali" />
                          <PremiumStatCard eyebrow="Liquidita residua" value={formatEuro(mortgage.liquidAfterPurchase)} note="Dopo acquisto" />
                        </div>
                        <div className={`mt-4 rounded-2xl border p-4 ${mortgageEmergencyGap >= 0 ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
                          <p className="text-sm font-semibold text-slate-950">
                            {mortgageEmergencyGap >= 0 ? "Fondo emergenza adeguato" : "Fondo emergenza da rafforzare"}
                          </p>
                          <p className="mt-1 text-sm leading-6 text-slate-700">
                            {mortgageEmergencyGap >= 0
                              ? `Dopo l'acquisto ti resterebbe un margine di circa ${formatEuro(mortgageEmergencyGap)} rispetto al fondo emergenza scelto.`
                              : `Dopo l'acquisto ti mancherebbero circa ${formatEuro(Math.abs(mortgageEmergencyGap))} per arrivare al fondo emergenza scelto.`}
                          </p>
                        </div>
                      </div>

                      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <h4 className="text-xl font-bold text-slate-950">Stress test</h4>
                            <p className="mt-2 text-sm leading-6 text-slate-600">{mortgageStressIntroText}</p>
                          </div>
                          <span className="w-fit rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">
                            {mortgageRateType === "fisso" ? "Tasso fisso" : mortgageRateType === "variabile" ? "Tasso variabile" : "Variabile con cap"}
                          </span>
                        </div>
                        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <p className="text-sm font-semibold text-slate-950">Consiglio mirato</p>
                          <p className="mt-1 text-sm leading-6 text-slate-700">{mortgageStressAdvice}</p>
                        </div>
                        <div className="mt-4 grid gap-3">
                          {mortgageRateType === "fisso" ? (
                            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                              <p className="font-semibold text-slate-950">Rata prevedibile</p>
                              <p className="mt-2 text-sm leading-6 text-slate-600">Con il tasso fisso la rata non dovrebbe cambiare per effetto dei tassi. Qui lo stress test più utile riguarda reddito, spese è fondo emergenza.</p>
                            </div>
                          ) : (
                            mortgageStressTests.map((test) => (
                              <div key={test.shock} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                                <div className="flex items-center justify-between gap-3">
                                  <p className="font-semibold text-slate-950">Tasso +{test.shock}% {test.isCapped ? `(limitato dal cap a ${test.appliedRate}%)` : ""}</p>
                                  <span className={`rounded-full px-3 py-1 text-xs font-bold ${test.risk === "alto" ? "bg-red-100 text-red-700" : test.risk === "medio" ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>
                                    rischio {test.risk}
                                  </span>
                                </div>
                                <p className="mt-2 text-sm text-slate-600">Rata stimata {formatEuro(test.payment)} - costo casa/reddito {Math.round(test.realRatio * 100)}%</p>
                              </div>
                            ))
                          )}
                          {mortgageRateType === "cap" && (
                            <div className={`rounded-2xl border p-4 ${mortgageHasValidCap ? "border-indigo-200 bg-indigo-50" : "border-amber-200 bg-amber-50"}`}>
                              <p className="font-semibold text-slate-950">Rata massima stimata al cap</p>
                              <p className="mt-2 text-sm leading-6 text-slate-700">
                                {mortgageHasValidCap
                                  ? `Se il tasso arrivasse al cap del ${mortgage.capRate}%, la rata stimata sarebbe circa ${formatEuro(mortgageCapPayment)}/mese è il costo casa peserebbe circa ${Math.round(mortgageCapRealRatio * 100)}% del reddito.`
                                  : "Inserisci il tasso massimo / cap per vedere la rata nello scenario peggiore previsto dal contratto."}
                              </p>
                            </div>
                          )}
                          {mortgageIncomeStressTests.map((test) => (
                            <div key={test.drop} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                              <div className="flex items-center justify-between gap-3">
                                <p className="font-semibold text-slate-950">Reddito -{test.drop}%</p>
                                <span className={`rounded-full px-3 py-1 text-xs font-bold ${test.risk === "alto" ? "bg-red-100 text-red-700" : test.risk === "medio" ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>
                                  rischio {test.risk}
                                </span>
                              </div>
                              <p className="mt-2 text-sm text-slate-600">Reddito stimato {formatEuro(test.stressedIncome)} - costo casa/reddito {Math.round(test.ratio * 100)}%</p>
                            </div>
                          ))}
                          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                            <p className="font-semibold text-slate-950">Spese +200€/mese</p>
                            <p className="mt-2 text-sm text-slate-600">Con 200€ di spese in più, il costo casa peserebbe circa {Math.round(mortgageExpenseStress * 100)}% del reddito.</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {mortgageMode === "pies" && (
                  <div className="space-y-6">
                    <div className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
                      <div className="space-y-6">
                        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
                          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Percorso 2</p>
                          <h4 className="mt-2 text-2xl font-bold tracking-tight text-slate-950">Verifica PIES guidata</h4>
                          <p className="mt-2 text-sm leading-6 text-slate-600">
                            Apri il PIES e controlla i blocchi sotto. L'app mostra solo i campi utili in base alle scelte fatte: per esempio cap e floor compaiono solo se il mutuo è variabile con cap. Se inserisci un dato, l'app lo segna automaticamente come trovato; se resta assente o ambiguo, puoi comunque selezionare Non trovato o Non chiaro.
                          </p>
                          <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                            <p className="text-sm font-bold text-slate-950">Non hai ancora il PIES?</p>
                            <p className="mt-1 text-sm leading-6 text-slate-600">Prima di valutare seriamente il mutuo chiedi PIES aggiornato, piano di ammortamento e condizioni economiche complete.</p>
                            <textarea
                              readOnly
                              value={mortgageRequestPiesEmail}
                              className="mt-3 min-h-[180px] w-full rounded-xl border border-slate-200 bg-white p-3 text-sm leading-6 text-slate-700 outline-none"
                            />
                          </div>
                        </div>

                        <div className={`rounded-3xl border p-6 shadow-sm ${mortgageClarityCopy.className}`}>
                          <p className="text-sm font-semibold uppercase tracking-[0.2em] opacity-80">Indice di chiarezza</p>
                          <div className="mt-3 flex items-end gap-3">
                            <p className="text-5xl font-black tracking-tight">{mortgageClarityScore}</p>
                            <p className="pb-2 text-lg font-bold">/100</p>
                          </div>
                          <h4 className="mt-3 text-xl font-bold">{mortgageClarityCopy.label}</h4>
                          <p className="mt-2 text-sm leading-6">{mortgageClarityCopy.message}</p>
                          <p className="mt-2 text-xs font-semibold opacity-80">Il punteggio cresce man mano che i dati vengono segnati come trovati. I dati non trovati o non chiari non fanno aumentare l'indice.</p>
                          <div className="mt-4 grid gap-2 sm:grid-cols-2">
                            <div className="rounded-2xl bg-white/70 p-3">
                              <p className="text-xs font-semibold uppercase tracking-[0.16em] opacity-70">Dati trovati</p>
                              <p className="mt-1 text-2xl font-bold">{mortgagePiesFound.length}/{visibleMortgagePiesFieldDefinitions.length}</p>
                            </div>
                            <div className="rounded-2xl bg-white/70 p-3">
                              <p className="text-xs font-semibold uppercase tracking-[0.16em] opacity-70">Da chiarire</p>
                              <p className="mt-1 text-2xl font-bold">{mortgagePiesIssues.length}</p>
                            </div>
                          </div>
                        </div>

                        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                          <h4 className="text-xl font-bold text-slate-950">Aree controllate</h4>
                          <div className="mt-4 grid gap-3">
                            {mortgageAreaCards.map((area) => (
                              <div key={area.label} className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                                <p className="text-sm font-bold text-slate-950">{area.label}</p>
                                <span className={`rounded-full border px-3 py-1 text-xs font-bold ${area.status.className}`}>{area.status.label}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="space-y-5">
                        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <h4 className="text-lg font-bold text-slate-950">Blocchi della verifica</h4>
                              <p className="mt-1 text-sm leading-6 text-slate-600">
                                Apri un blocco alla volta, compila i dati che trovi e poi passa al successivo. I contatori ti aiutano a capire subito cosa manca.
                              </p>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="w-fit rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">
                                {mortgagePiesSections.length} blocchi
                              </span>
                              <button
                                type="button"
                                onClick={resetMortgagePiesCheck}
                                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 transition hover:bg-slate-100"
                              >
                                Reset verifica PIES
                              </button>
                            </div>
                          </div>
                        </div>

                        {mortgagePiesSections.map((section, index) => {
                          const visibleSectionFields = getVisibleMortgagePiesFieldsForSection(section);
                          const sectionStates = visibleSectionFields.map((field) => {
                            const state = mortgagePiesFields[field.id] ?? { status: "missing" as MortgagePiesStatus, value: "", notes: "" };
                            return { ...state, status: getMortgagePiesEffectiveStatus(field.id, state) };
                          });
                          const foundCount = sectionStates.filter((fieldState) => fieldState.status === "found").length;
                          const unclearCount = sectionStates.filter((fieldState) => fieldState.status === "unclear").length;
                          const missingCount = sectionStates.filter((fieldState) => fieldState.status === "missing").length;
                          const isOpen = openMortgagePiesSectionId === section.id;
                          const allFound = visibleSectionFields.length > 0 && foundCount === visibleSectionFields.length;
                          const hasIssues = unclearCount + missingCount > 0;
                          const summaryLabel = allFound
                            ? "Completato"
                            : hasIssues
                            ? `${missingCount + unclearCount} da chiarire`
                            : "Da compilare";
                          const summaryClass = allFound
                            ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                            : hasIssues
                            ? "border-amber-200 bg-amber-50 text-amber-800"
                            : "border-slate-200 bg-slate-100 text-slate-700";

                          return (
                            <div
                              key={section.id}
                              ref={(element) => {
                                mortgagePiesSectionRefs.current[section.id] = element;
                              }}
                              className={`relative scroll-mt-24 overflow-hidden rounded-3xl border transition-all duration-300 ${
                                isOpen
                                  ? "border-emerald-300 bg-white shadow-xl shadow-emerald-100/80 ring-4 ring-emerald-50"
                                  : "border-slate-200 bg-white shadow-sm hover:border-slate-300 hover:shadow-md"
                              }`}
                            >
                              {isOpen && <span className="absolute left-0 top-0 z-10 h-full w-1.5 bg-emerald-500" aria-hidden="true" />}
                              <button
                                type="button"
                                onClick={() => toggleMortgagePiesSection(section.id, isOpen)}
                                className={`relative flex w-full flex-col gap-4 p-5 text-left transition md:p-6 ${
                                  isOpen ? "bg-gradient-to-br from-emerald-50 via-white to-white" : "hover:bg-slate-50"
                                }`}
                              >
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                  <div className="flex gap-3">
                                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-sm font-black transition ${
                                      isOpen ? "bg-emerald-600 text-white shadow-sm shadow-emerald-200" : "bg-slate-100 text-slate-700"
                                    }`}>
                                      {index + 1}
                                    </span>
                                    <div>
                                      <h4 className="text-xl font-bold text-slate-950">{section.title}</h4>
                                      <p className="mt-2 text-sm leading-6 text-slate-600">{section.explanation}</p>
                                    </div>
                                  </div>
                                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                                    <span className={`rounded-full border px-3 py-1 text-xs font-bold ${summaryClass}`}>{summaryLabel}</span>
                                    <span className="inline-flex items-center justify-center rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white shadow-sm shadow-emerald-200 transition hover:bg-emerald-700">
                                      {isOpen ? "Chiudi" : "Apri"}
                                    </span>
                                  </div>
                                </div>
                                <div className="grid gap-2 sm:grid-cols-3">
                                  <div className={`rounded-2xl p-3 transition ${isOpen ? "border border-emerald-100 bg-white shadow-sm" : "bg-slate-50"}`}>
                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Trovati</p>
                                    <p className="mt-1 text-lg font-black text-emerald-700">{foundCount}</p>
                                  </div>
                                  <div className={`rounded-2xl p-3 transition ${isOpen ? "border border-slate-200 bg-white shadow-sm" : "bg-slate-50"}`}>
                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Non trovati</p>
                                    <p className="mt-1 text-lg font-black text-slate-700">{missingCount}</p>
                                  </div>
                                  <div className={`rounded-2xl p-3 transition ${isOpen ? "border border-amber-100 bg-white shadow-sm" : "bg-slate-50"}`}>
                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Non chiari</p>
                                    <p className="mt-1 text-lg font-black text-amber-700">{unclearCount}</p>
                                  </div>
                                </div>
                              </button>

                              {isOpen && (
                                <div className="border-t border-emerald-100 bg-gradient-to-b from-emerald-50/40 to-white p-5 pt-4 md:p-6 md:pt-5">
                                  <p className="rounded-2xl border border-emerald-100 bg-white p-3 text-xs leading-5 text-slate-700 shadow-sm"><strong>Dove cercare:</strong> {section.where}</p>
                                  <div className="mt-5 space-y-4">
                                    {visibleSectionFields.map((field) => {
                                      const rawState = mortgagePiesFields[field.id] ?? { status: "missing" as MortgagePiesStatus, value: "", notes: "" };
                                      const state = { ...rawState, status: getMortgagePiesEffectiveStatus(field.id, rawState) };
                                      const isExternalPolicyCostNote = field.id === "policyCost" && rawState.value.toLowerCase().includes("costo non indicato") && isPolicyCostSoftFound(mortgagePiesFields);
                                      return (
                                        <div key={field.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                                          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                                            <div>
                                              <p className="font-bold text-slate-950">{field.label}</p>
                                              <p className="mt-1 text-xs leading-5 text-slate-500">{field.placeholder}</p>
                                            </div>
                                            <div className="flex flex-wrap gap-2">
                                              {[
                                                ["found", "Trovato"],
                                                ["missing", "Non trovato"],
                                                ["unclear", "Non chiaro"],
                                              ].map(([status, label]) => (
                                                <button
                                                  key={status}
                                                  type="button"
                                                  onClick={() => updateMortgagePiesField(field.id, { status: status as MortgagePiesStatus })}
                                                  className={`rounded-full border px-3 py-1 text-xs font-bold transition ${
                                                    state.status === status
                                                      ? status === "found"
                                                        ? "border-emerald-200 bg-emerald-100 text-emerald-800"
                                                        : status === "unclear"
                                                        ? "border-amber-200 bg-amber-100 text-amber-800"
                                                        : "border-slate-300 bg-slate-200 text-slate-800"
                                                      : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                                                  }`}
                                                >
                                                  {label}
                                                </button>
                                              ))}
                                            </div>
                                          </div>
                                          <div className="mt-3 grid gap-3 md:grid-cols-2">
                                            {field.selectOptions ? (
                                              <select
                                                value={state.value}
                                                onChange={(e) => updateMortgagePiesSelectValue(field.id, e.target.value)}
                                                className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                                              >
                                                <option value="">Seleziona una risposta</option>
                                                {field.selectOptions.map((option) => (
                                                  <option key={option} value={option}>{option}</option>
                                                ))}
                                              </select>
                                            ) : (
                                              <input
                                                value={state.value}
                                                onChange={(e) => updateMortgagePiesInputValue(field.id, e.target.value)}
                                                placeholder={field.placeholder || "Valore trovato o riferimento"}
                                                className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                                              />
                                            )}
                                            <input
                                              value={state.notes}
                                              onChange={(e) => updateMortgagePiesField(field.id, { notes: e.target.value })}
                                              placeholder="Note, pagina, dubbio"
                                              className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
                                            />
                                          </div>
                                          {isExternalPolicyCostNote && (
                                            <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm leading-6 text-emerald-900">
                                              <strong>Nota:</strong> se la polizza è obbligatoria ma scegliibile presso compagnia esterna, il costo non indicato non è una criticità documentale grave. È comunque utile stimarlo per confrontare meglio le offerte.
                                            </div>
                                          )}
                                          {field.id === "rateLocked" && (
                                            <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm leading-6 text-sky-900">
                                              <strong>Nota:</strong> {getMortgageRateLockInfo()}
                                            </div>
                                          )}
                                          {field.id === "variableSimulation" && (
                                            <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm leading-6 text-sky-900">
                                              <strong>Nota:</strong> {getMortgageRateSimulationInfo()}
                                            </div>
                                          )}
                                          {(["capValue", "floorValue", "maxInstallmentAtCap"].includes(field.id)) && getMortgageRateTypeCategory() === "cap" && (
                                            <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm leading-6 text-sky-900">
                                              <strong>Nota:</strong> nel variabile con cap il cap limita il tasso massimo, il floor limita il tasso minimo e la rata massima stimata aiuta a capire lo scenario peggiore.
                                            </div>
                                          )}
                                          {field.id === "greenDiscountRequirement" && isGreenDiscountSelected() && (
                                            <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm leading-6 text-emerald-900">
                                              <strong>Nota:</strong> se lo sconto dipende dalla classe energetica, verifica quale documentazione serve e cosa succede se il requisito non viene confermato o mantenuto.
                                            </div>
                                          )}
                                          {state.status !== "found" && (
                                            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-900">
                                              <strong>Perché conta:</strong> {getMortgagePiesIssueCopy(field, state.status).why}
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div>
                          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Risultato verifica mutuo</p>
                          <h4 className="mt-2 text-2xl font-bold tracking-tight text-slate-950">Report operativo prima della firma</h4>
                          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                            Questa sintesi non giudica se il mutuo conviene: misura quanto la proposta è chiara, documentata è verificabile.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={openMortgagePdfReport}
                          className="w-fit rounded-xl bg-emerald-600 px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700"
                        >
                          Salva report PDF
                        </button>
                      </div>

                      <div className="mt-5 rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4">
                        <label className="text-sm font-bold text-emerald-950" htmlFor="mortgage-offer-name">Nome preventivo / banca</label>
                        <input
                          id="mortgage-offer-name"
                          value={mortgageOfferName}
                          onChange={(e) => setMortgageOfferName(e.target.value)}
                          placeholder="Es. Mutuo Banca X - prima casa"
                          className="mt-2 w-full rounded-xl border border-emerald-100 bg-white px-4 py-3 text-sm outline-none transition focus:border-emerald-400"
                        />
                        <p className="mt-2 text-xs leading-5 text-emerald-800">Questo nome comparira nel report PDF e ti aiutera a distinguere più preventivi.</p>
                      </div>

                      <div className="mt-6 grid gap-4 md:grid-cols-4">
                        <PremiumStatCard eyebrow="Indice chiarezza" value={`${mortgageClarityScore}/100`} note={mortgageClarityCopy.label} />
                        <PremiumStatCard eyebrow="Dati trovati" value={`${mortgagePiesFound.length}`} note="Campi confermati" />
                        <PremiumStatCard eyebrow="Punti da chiarire" value={`${mortgagePiesIssues.length}`} note="Domande documentali" />
                        <PremiumStatCard eyebrow="Segnali economici" value={`${mortgageEconomicAttentionFlags.length}`} note="Costi o vincoli da verificare" />
                      </div>

                      <div className="mt-6 grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
                        <div className="space-y-4">
                          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                            <h5 className="font-bold text-slate-950">Riepilogo economico semplice</h5>
                            <div className="mt-3 space-y-2">
                              {mortgageMainNumbers.map((item) => (
                                <div key={item.label} className="flex items-center justify-between gap-3 border-b border-slate-200 pb-2 text-sm last:border-b-0 last:pb-0">
                                  <span className="text-slate-600">{item.label}</span>
                                  <span className="font-bold text-slate-950">{item.value}</span>
                                </div>
                              ))}
                            </div>
                            <p className="mt-3 text-xs leading-5 text-slate-500">Questo numero ti aiuta a non valutare il mutuo solo sulla rata mensile.</p>
                          </div>

                          <div className="rounded-2xl border border-orange-100 bg-orange-50/70 p-4">
                            <h5 className="font-bold text-slate-950">Segnali di attenzione economica</h5>
                            <p className="mt-2 text-xs leading-5 text-orange-900">Questi segnali non indicano irregolarità: servono a evidenziare costi o vincoli da capire meglio prima della firma.</p>
                            <div className="mt-4 space-y-3">
                              {mortgageEconomicAttentionFlags.length === 0 ? (
                                <div className="rounded-2xl border border-emerald-200 bg-white p-4 text-sm leading-6 text-emerald-900">
                                  Nessun segnale economico rilevante emerso dai dati inseriti.
                                </div>
                              ) : (
                                mortgageEconomicAttentionFlags.map((flag) => (
                                  <div key={flag.id} className={`rounded-2xl border p-4 ${flag.severity === "Alta" ? "border-orange-200 bg-white text-orange-950" : "border-amber-200 bg-white text-amber-950"}`}>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-black uppercase tracking-wide ${flag.severity === "Alta" ? "bg-orange-100 text-orange-800" : "bg-amber-100 text-amber-800"}`}>{flag.severity}</span>
                                      <p className="font-bold">{flag.title}</p>
                                    </div>
                                    <p className="mt-2 text-sm leading-6 text-slate-700">{flag.why}</p>
                                    <p className="mt-2 rounded-xl bg-slate-50 p-3 text-sm leading-6 text-slate-800"><strong>Cosa chiedere:</strong> {flag.question}</p>
                                  </div>
                                ))
                              )}
                            </div>
                          </div>

                        </div>

                        <div className="space-y-4">
                          <div className="rounded-2xl border border-slate-200 bg-white p-4">
                            <h5 className="font-bold text-slate-950">Punti critici: problema, perché conta, cosa chiedere</h5>
                            <div className="mt-4 space-y-3">
                              {mortgagePiesIssues.length === 0 ? (
                                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-900">
                                  Nessuna criticità documentale rilevante tra i dati controllati. Verifica comunque che il PIES sia aggiornato alle condizioni definitive.
                                </div>
                              ) : (
                                mortgagePiesIssues.slice(0, 8).map((item) => (
                                  <div key={item.field.id} className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                                    <p className="font-bold text-amber-950">{getMortgagePiesIssueCopy(item.field, item.state.status).issue}</p>
                                    <p className="mt-1 text-sm leading-6 text-amber-900"><strong>Perché conta:</strong> {getMortgagePiesIssueCopy(item.field, item.state.status).why}</p>
                                    <p className="mt-1 text-sm leading-6 text-amber-900"><strong>Cosa chiedere:</strong> {getMortgagePiesIssueCopy(item.field, item.state.status).question}</p>
                                  </div>
                                ))
                              )}
                            </div>
                          </div>

                          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                              <h5 className="font-bold text-slate-950">Email generata per la banca</h5>
                              <button
                                type="button"
                                onClick={() => navigator.clipboard?.writeText(mortgageGeneratedEmail)}
                                className="w-fit rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-emerald-700"
                              >
                                Copia email
                              </button>
                            </div>
                            <textarea
                              readOnly
                              value={mortgageGeneratedEmail}
                              className="mt-3 min-h-[260px] w-full rounded-xl border border-slate-200 bg-white p-3 text-sm leading-6 text-slate-700 outline-none"
                            />
                          </div>

                          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                            <h5 className="font-bold text-emerald-950">Prossimi passi</h5>
                            <ul className="mt-2 space-y-2 text-sm leading-6 text-emerald-900">
                              {mortgagePiesIssues.length === 0 ? (
                                <>
                                  <li>• Salva il report e confronta l'offerta con almeno un'altra proposta prima di decidere.</li>
                                  <li>• Verifica che il PIES sia aggiornato alle condizioni definitive prima della firma.</li>
                                </>
                              ) : mortgageClarityScore < 60 ? (
                                <>
                                  <li>• Non firmare senza chiarimenti scritti sui punti evidenziati.</li>
                                  <li>• Invia l'email alla banca e attendi una conferma scritta sui punti evidenziati.</li>
                                </>
                              ) : (
                                <>
                                  <li>• Invia la richiesta di chiarimento alla banca.</li>
                                  <li>• Se la banca chiarisce un dato, puoi tornare nel relativo blocco PIES e aggiornarlo manualmente.</li>
                                </>
                              )}
                              <li>• Usa il report PDF per confrontarti con banca, consulente o professionista di fiducia.</li>
                            </ul>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {awarenessTab === "truffe" && (
              <div className="space-y-6">
                <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
                  <div className="grid gap-0 lg:grid-cols-[1fr_0.9fr]">
                    <div className="p-6 md:p-8">
                      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-700">Anti-truffe</p>
                      <h3 className="mt-3 text-3xl font-bold tracking-tight text-slate-950">Riconosci la truffa</h3>
                      <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
                        Allenati con 5 situazioni realistiche pescate da un archivio di 200 casi. Alcune sono truffe, altre sono situazioni normali ma da verificare con calma.
                      </p>
                      <div className="mt-5 flex flex-wrap gap-2">
                        {["SMS", "Telefonate", "Investimenti", "Marketplace", "Di persona", "Affitti", "Lavoro", "Familiari"].map((tag) => (
                          <span key={tag} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">{tag}</span>
                        ))}
                      </div>
                    </div>
                    <div className="border-t border-slate-200 bg-slate-50 p-6 md:p-8 lg:border-l lg:border-t-0">
                      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Regola d'oro</p>
                      <p className="mt-3 text-lg font-bold leading-7 text-slate-950">
                        Se qualcuno ti mette fretta, ti chiede codici o promette guadagni sicuri, fermati e verifica da un canale ufficiale.
                      </p>
                      <button
                        onClick={startScamGame}
                        className="mt-6 rounded-xl bg-emerald-600 px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700"
                      >
                        {scamGameQuestions.length ? "Nuova partita" : "Inizia il gioco"}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
                  <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Mini gioco</p>
                        <h4 className="mt-2 text-2xl font-bold tracking-tight text-slate-950">Mi fido o mi fermo?</h4>
                      </div>
                      {scamGameQuestions.length > 0 && (
                        <span className="rounded-full bg-emerald-50 px-4 py-2 text-sm font-bold text-emerald-800 ring-1 ring-emerald-200">
                          {scamGameComplete ? `Punteggio ${scamScore}/5` : `Scenario ${scamGameIndex + 1}/5`}
                        </span>
                      )}
                    </div>

                    {!scamGameQuestions.length && (
                      <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm leading-6 text-slate-600">
                        Premi <strong>Inizia il gioco</strong> per ricevere 5 scenari casuali, con almeno un caso più difficile quando disponibile. Hai già visto <strong>{scamAnsweredScenarioCount}/{scamScenarioPool.length}</strong> scenari e completato <strong>{scamPerfectGames}</strong> partite senza errori. Dopo ogni risposta vedrai cosa osservare e quale azione sicura scegliere.
                      </div>
                    )}

                    {currentScamScenario && !scamGameComplete && (
                      <div className="mt-6 space-y-5">
                        <div className="rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-6">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Situazione</p>
                            {currentScamScenario.difficulty && (
                              <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ${
                                currentScamScenario.difficulty === "difficile"
                                  ? "bg-amber-50 text-amber-800 ring-amber-200"
                                  : currentScamScenario.difficulty === "facile"
                                  ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
                                  : "bg-slate-100 text-slate-700 ring-slate-200"
                              }`}>
                                {currentScamScenario.difficulty === "difficile" ? "Difficile" : currentScamScenario.difficulty === "facile" ? "Facile" : "Media"}
                              </span>
                            )}
                          </div>
                          <p className="mt-3 text-lg font-semibold leading-8 text-slate-950">{currentScamScenario.situation}</p>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-2">
                          <button
                            onClick={() => answerScamScenario("trust")}
                            disabled={Boolean(scamSelectedChoice)}
                            className={`rounded-2xl border p-4 text-left transition ${
                              scamSelectedChoice === "trust"
                                ? (currentScamScenario.isRisky ? "border-red-300 bg-red-50" : "border-emerald-300 bg-emerald-50")
                                : "border-slate-200 bg-white hover:bg-slate-50"
                            }`}
                          >
                            <p className="font-bold text-slate-950">Mi fido</p>
                            <p className="mt-1 text-sm text-slate-600">Sembra abbastanza normale e posso procedere.</p>
                          </button>
                          <button
                            onClick={() => answerScamScenario("verify")}
                            disabled={Boolean(scamSelectedChoice)}
                            className={`rounded-2xl border p-4 text-left transition ${
                              scamSelectedChoice === "verify"
                                ? (currentScamScenario.isRisky ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-50")
                                : "border-slate-200 bg-white hover:bg-slate-50"
                            }`}
                          >
                            <p className="font-bold text-slate-950">Mi fermo e verifico</p>
                            <p className="mt-1 text-sm text-slate-600">Non procedo finche non controllo meglio.</p>
                          </button>
                        </div>

                        {scamSelectedChoice && (
                          <div className={`rounded-3xl border p-5 ${
                            (currentScamScenario.isRisky ? scamSelectedChoice === "verify" : scamSelectedChoice === "trust")
                              ? "border-emerald-200 bg-emerald-50"
                              : "border-amber-200 bg-amber-50"
                          }`}>
                            <p className="text-sm font-bold uppercase tracking-[0.16em] text-slate-600">
                              {(currentScamScenario.isRisky ? scamSelectedChoice === "verify" : scamSelectedChoice === "trust") ? "Scelta corretta" : "Qui serve attenzione"}
                            </p>
                            <h5 className="mt-2 text-xl font-bold text-slate-950">
                              {currentScamScenario.isRisky ? "Scenario rischioso" : "Scenario probabilmente normale"}
                            </h5>
                            <p className="mt-2 text-sm leading-6 text-slate-700">{currentScamScenario.explanation}</p>
                            <div className="mt-4 flex flex-wrap gap-2">
                              {currentScamScenario.redFlags.map((flag) => (
                                <span key={flag} className="rounded-full bg-white px-3 py-1 text-xs font-bold text-slate-700 ring-1 ring-slate-200">{flag}</span>
                              ))}
                            </div>
                            <div className="mt-4 rounded-2xl bg-white p-4 text-sm leading-6 text-slate-700 ring-1 ring-slate-200">
                              <strong>Azione sicura:</strong> {currentScamScenario.safeAction}
                            </div>
                            {scamGameIndex < scamGameQuestions.length - 1 ? (
                              <button
                                onClick={goToNextScamScenario}
                                className="mt-5 rounded-xl bg-emerald-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-emerald-700"
                              >
                                Prossimo scenario
                              </button>
                            ) : (
                              <button
                                onClick={() => setScamSelectedChoice(null)}
                                className="mt-5 rounded-xl bg-emerald-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-emerald-700"
                              >
                                Vedi riepilogo
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {scamGameComplete && (
                      <div className="mt-6 rounded-3xl border border-emerald-200 bg-emerald-50 p-6">
                        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-700">Riepilogo partita</p>
                        <h4 className="mt-2 text-3xl font-bold text-emerald-950">Hai riconosciuto {scamScore} scenari su 5</h4>
                        <p className="mt-3 text-sm leading-6 text-emerald-900">
                          {scamScore >= 4
                            ? "Ottimo lavoro: ti sei fermato davanti ai segnali importanti. Continua così: la prudenza è una protezione concreta."
                            : scamScore >= 2
                              ? "Buon allenamento. Alcune situazioni sono costruite per sembrare credibili: l'obiettivo e imparare a riconoscere i pattern."
                              : "Non è un problema sbagliare qui: meglio imparare nell'app che davanti a una truffa vera. Ripeti il gioco e osserva i segnali di rischio."}
                        </p>
                        <div className="mt-4 flex flex-wrap gap-2">
                          {scamEncounteredFlags.slice(0, 8).map((flag) => (
                            <span key={flag} className="rounded-full bg-white px-3 py-1 text-xs font-bold text-emerald-800 ring-1 ring-emerald-200">{flag}</span>
                          ))}
                        </div>
                        <button
                          onClick={startScamGame}
                          className="mt-5 rounded-xl bg-emerald-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-emerald-700"
                        >
                          Gioca di nuovo
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="space-y-4">
                    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                      <h4 className="text-xl font-bold text-slate-950">Segnali di allarme da ricordare</h4>
                      <p className="mt-2 text-sm leading-6 text-slate-600">Non devi conoscere tutte le truffe. Devi riconoscere i segnali che tornano spesso.</p>
                      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                        {["Urgenza", "Richiesta codici", "Guadagno garantito", "Caparra anticipata", "Contanti", "Link non verificato", "Pressione emotiva", "Segretezza"].map((pattern) => (
                          <div key={pattern} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm font-semibold text-slate-800">
                            {pattern}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-3xl border border-amber-200 bg-amber-50 p-6 shadow-sm">
                      <h4 className="text-xl font-bold text-amber-950">Se hai già cliccato o pagato</h4>
                      <ul className="mt-3 space-y-2 text-sm leading-6 text-amber-900">
                        <li>• Blocca carta o conto dal canale ufficiale.</li>
                        <li>• Cambia password e attiva autenticazione a due fattori.</li>
                        <li>• Contatta banca, piattaforma o operatore dal sito ufficiale.</li>
                        <li>• Conserva messaggi, ricevute e screenshot.</li>
                        <li>• Valuta denuncia o segnalazione alle autorità competenti.</li>
                      </ul>
                    </div>
                  </div>
                </div>

                <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
                  <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                    <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Motore anti-truffe</p>
                    <h3 className="mt-2 text-2xl font-bold tracking-tight">Controlla prima di cliccare o pagare</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      Questo motore resta disponibile: seleziona il contesto e spunta i segnali che noti. Alcuni segnali critici, come codici, password, accesso remoto o spostamento di denaro, alzano subito il rischio anche se sono l'unico elemento presente.
                    </p>

                    <label className="mt-5 block text-sm font-medium text-slate-700">
                      Contesto
                      <select
                        value={fraudContext}
                        onChange={(e) => setFraudContext(e.target.value)}
                        className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none"
                      >
                        <option value="sms">SMS / email banca</option>
                        <option value="phone">Telefonata sospetta</option>
                        <option value="investment">Investimento / crypto / trading</option>
                        <option value="marketplace">Marketplace / acquisto online</option>
                      </select>
                    </label>

                    <div className="mt-5 space-y-3">
                      {fraudQuestions.map((question) => (
                        <button
                          key={question.id}
                          onClick={() => setFraudAnswers((prev) => ({ ...prev, [question.id]: !prev[question.id] }))}
                          className={`flex w-full items-center justify-between gap-4 rounded-2xl border p-4 text-left text-sm transition ${
                            fraudAnswers[question.id] ? "border-red-300 bg-red-50" : "border-slate-200 bg-white hover:bg-slate-50"
                          }`}
                        >
                          <span className="space-y-1">
                            <span className="block font-medium text-slate-800">{question.text}</span>
                            <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold ${
                              question.severity === "critico" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800"
                            }`}>
                              {question.severity === "critico" ? "Segnale critico" : "Segnale forte"}
                            </span>
                          </span>
                          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                            {fraudAnswers[question.id] ? "Si" : "No"}
                          </span>
                        </button>
                      ))}
                    </div>

                    <button
                      onClick={() => {
                        setFraudAnswers({});
                        setFraudContext("sms");
                      }}
                      className="mt-5 w-full rounded-xl bg-emerald-600 px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700"
                    >
                      Reset motore anti-truffe
                    </button>
                  </div>

                  <div className="space-y-4">
                    <div className={`rounded-3xl border p-6 shadow-sm ${
                      fraudRiskLevel === "molto alto"
                        ? "border-red-300 bg-red-50"
                        : fraudRiskLevel === "alto"
                          ? "border-red-200 bg-red-50"
                          : fraudRiskLevel === "medio"
                            ? "border-amber-200 bg-amber-50"
                            : "border-emerald-200 bg-emerald-50"
                    }`}>
                      <p className="text-sm font-semibold uppercase tracking-[0.2em]">Rischio stimato</p>
                      <h3 className="mt-2 text-4xl font-bold tracking-tight">{fraudRiskLevel.toUpperCase()}</h3>
                      <p className="mt-3 text-base font-semibold">{fraudPrimaryAction}</p>
                      <p className="mt-2 text-sm leading-6">Score: {fraudRiskScore}. Contesto: {fraudContext}.</p>
                      {mainFraudSignal && (
                        <div className="mt-4 rounded-2xl bg-white/80 p-4 text-sm leading-6 ring-1 ring-slate-200">
                          <p className="font-bold text-slate-950">Segnale principale: {mainFraudSignal.text}</p>
                          <p className="mt-2 text-slate-700"><strong>Perché conta:</strong> {mainFraudSignal.why}</p>
                          <p className="mt-2 text-slate-700"><strong>Cosa fare:</strong> {mainFraudSignal.action}</p>
                        </div>
                      )}
                      {selectedFraudQuestions.length > 1 && (
                        <div className="mt-4 flex flex-wrap gap-2">
                          {selectedFraudQuestions.map((question) => (
                            <span
                              key={question.id}
                              className={`rounded-full px-3 py-1 text-xs font-bold ring-1 ${
                                question.severity === "critico"
                                  ? "bg-red-100 text-red-800 ring-red-200"
                                  : "bg-amber-100 text-amber-800 ring-amber-200"
                              }`}
                            >
                              {question.severity === "critico" ? "Critico" : "Forte"}: {question.text}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                      <h4 className="text-xl font-bold">Azioni sicure</h4>
                      <ul className="mt-4 space-y-3 text-sm leading-6 text-slate-700">
                        <li>• Non cliccare link ricevuti via SMS, email o chat.</li>
                        <li>• Apri solo app e siti ufficiali digitando tu l'indirizzo.</li>
                        <li>• Non comunicare codici OTP, password o PIN.</li>
                        <li>• Se parlano di banca, chiama il numero ufficiale dal sito o dalla carta.</li>
                        <li>• Se promettono guadagni sicuri, fermati: negli investimenti il rischio esiste sempre.</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            )}

          </section>
        )}

        {step === "dashboard" && (
          <section className="space-y-6">
            <div className={`${dashboardActiveTab === "monitor" ? "" : "hidden lg:block"} overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm`}>
              <div className="grid gap-0 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
                <div className="p-6 md:p-8">
                  <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-700">Dashboard</p>
                  <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-950 md:text-4xl">Il tuo piano finanziario</h2>
                  <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600">
                    Segui i prossimi passi, senza confusione. Questa schermata non deve farti controllare tutto: deve dirti cosa fare adesso.
                  </p>

                  <div className="mt-5 flex flex-wrap gap-3">
                    <span className="rounded-full bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200">
                      Profilo: {selectedPortfolio.shortTitle}
                    </span>
                    <span className="rounded-full bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700">
                      {selectedPortfolio.badge}
                    </span>
                  </div>
                </div>

                <div className="border-t border-slate-200 bg-slate-50 p-6 md:p-8 lg:border-l lg:border-t-0">
                  <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Riepilogo rapido</p>
                  <div className="mt-5 grid gap-4 sm:grid-cols-3">
                    <PremiumStatCard
                      eyebrow="Capitale"
                      value={formatEuro(totalInvested)}
                      note="Totale registrato"
                    />
                    <PremiumStatCard
                      eyebrow="Percorso"
                      value={`${dashboardOverallProgress}%`}
                      note="Avanzamento"
                    />
                    <PremiumStatCard
                      eyebrow="Continuita"
                      value={`${currentStreak} mesi`}
                      note="PAC mantenuto"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="hidden gap-4 lg:grid lg:grid-cols-4">
              {([
                {
                  id: "monitor",
                  icon: "📊",
                  eyebrow: "Stato generale",
                  title: "Monitor",
                  text: "Piano, obiettivo, PAC e segnali principali in una vista breve.",
                  badge: setupCompleted ? "Vista principale" : "Dopo la guida",
                },
                {
                  id: "guida",
                  icon: "🧭",
                  eyebrow: "Percorso",
                  title: "Guida",
                  text: "I primi passi e le azioni mensili da completare con ordine.",
                  badge: setupCompleted ? "Disponibile" : "Da completare",
                },
                {
                  id: "portafoglio",
                  icon: "💼",
                  eyebrow: "Operativo",
                  title: "Portafoglio",
                  text: "Registra investimenti, controlla la ripartizione e gestisci gli strumenti.",
                  badge: holdings.length ? `${holdings.length} investimenti` : "Da compilare",
                },
                {
                  id: "progressi",
                  icon: "🏅",
                  eyebrow: "Percorso lungo",
                  title: "Progressi",
                  text: "Badge, titolo investitore e avanzamento nel tempo.",
                  badge: `${unlockedBadges.length}/${badges.length} badge`,
                },
              ] as const).map((card) => {
                const active = dashboardActiveTab === card.id;
                return (
                  <button
                    key={card.id}
                    type="button"
                    onClick={() => setDashboardActiveTab(card.id)}
                    className={`group relative overflow-hidden rounded-3xl border p-5 text-left transition-all duration-300 ${
                      active
                        ? "border-emerald-400 bg-emerald-50 shadow-sm ring-2 ring-emerald-100"
                        : "border-slate-200 bg-white shadow-sm hover:-translate-y-0.5 hover:border-emerald-200 hover:bg-slate-50 hover:shadow-md"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className={`flex h-12 w-12 items-center justify-center rounded-2xl text-xl transition ${
                        active ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-700 group-hover:bg-emerald-100"
                      }`}>
                        {card.icon}
                      </div>
                      <span className={`shrink-0 rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-wide ${
                        active ? "bg-white text-emerald-700 ring-1 ring-emerald-200" : "bg-slate-50 text-slate-500 ring-1 ring-slate-200"
                      }`}>
                        {active ? "Scheda aperta" : "Apri"}
                      </span>
                    </div>
                    <p className={`mt-4 text-xs font-semibold uppercase tracking-[0.2em] ${active ? "text-emerald-700" : "text-slate-500"}`}>{card.eyebrow}</p>
                    <h3 className="mt-2 text-xl font-black tracking-tight text-slate-950">{card.title}</h3>
                    <p className="mt-3 text-sm leading-6 text-slate-600">{card.text}</p>
                    <div className={`mt-4 inline-flex rounded-full px-3 py-1 text-[11px] font-bold ${active ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600"}`}>
                      {card.badge}
                    </div>
                  </button>
                );
              })}
            </div>

            {dashboardActiveTab === "monitor" && (
              <div className="space-y-6">
            <div className="rounded-3xl border border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-white p-6 shadow-sm md:p-8">
              <div className="grid gap-6 lg:grid-cols-[1fr_0.9fr] lg:items-center">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-700">Prossimo passo consigliato</p>
                  <h3 className="mt-3 text-3xl font-bold tracking-tight text-slate-950">{dashboardNextActionTitle}</h3>
                  <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-700">
                    {dashboardNextActionText}
                  </p>
                  <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                    <button
                      type="button"
                      disabled={currentMonthCompleted && setupCompleted && holdings.length > 0}
                      onClick={() => {
                        if (currentMonthCompleted && setupCompleted && holdings.length > 0) {
                          return;
                        }

                        if (!setupCompleted) {
                          openDashboardTab("guida");
                          return;
                        }

                        if (holdings.length === 0) {
                          goToDashboardSection("aggiungi-investimento");
                          return;
                        }

                        goToDashboardSection("azione-del-mese");
                      }}
                      className={`rounded-xl px-6 py-3 text-sm font-semibold shadow-sm transition ${
                        currentMonthCompleted && setupCompleted && holdings.length > 0
                          ? "cursor-not-allowed bg-emerald-600/35 text-white/80 shadow-none"
                          : "bg-emerald-600 text-white hover:bg-emerald-700"
                      }`}
                    >
                      {dashboardNextActionLabel}
                    </button>
                    <button
                      onClick={() => setStep("portfolio")}
                      className="rounded-xl border border-slate-200 bg-white px-6 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                    >
                      Rivedi il modello
                    </button>
                  </div>
                </div>

                <div className="rounded-3xl border border-emerald-100 bg-white p-5 shadow-sm">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">Percorso completato</p>
                      <p className="mt-1 text-xs leading-5 text-slate-500">Setup, investimenti, PAC mensile e continuita.</p>
                    </div>
                    <p className="text-3xl font-bold tracking-tight text-emerald-700">{dashboardOverallProgress}%</p>
                  </div>
                  <div className="mt-5 h-3 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full rounded-full bg-emerald-600 transition-all duration-1000 ease-out"
                      style={{ width: `${dashboardOverallProgress}%` }}
                    />
                  </div>
                  <p className="mt-4 text-sm leading-6 text-slate-600">
                    {setupCompleted
                      ? "La base è pronta. Ora conta mantenere il gesto mensile e aggiornare i dati senza ossessionarsi."
                      : `Ti mancano ${Math.max(0, initialChecklistItems.length - completedInitialChecklist)} passaggi per completare la guida iniziale.`}
                  </p>
                </div>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-4">
              <button
                onClick={() => setStep("awareness")}
                className="rounded-3xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-200 hover:bg-emerald-50/40 hover:shadow-md"
              >
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Core</p>
                <h3 className="mt-3 text-lg font-bold text-slate-950">Consapevolezza</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">Evita errori costosi prima di investire meglio.</p>
              </button>

              <button
                onClick={() => setDashboardActiveTab("portafoglio")}
                className="rounded-3xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-200 hover:bg-emerald-50/40 hover:shadow-md"
              >
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Portafoglio</p>
                <h3 className="mt-3 text-lg font-bold text-slate-950">Investimenti</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">Registra capitale e controlla la ripartizione.</p>
              </button>

              <button
                onClick={() => setDashboardActiveTab("portafoglio")}
                className="rounded-3xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-200 hover:bg-emerald-50/40 hover:shadow-md"
              >
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">PAC</p>
                <h3 className="mt-3 text-lg font-bold text-slate-950">Guida mensile</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">Distribuisci la cifra secondo il modello.</p>
              </button>

              <button
                onClick={() => setDashboardActiveTab("guida")}
                className="rounded-3xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-200 hover:bg-emerald-50/40 hover:shadow-md"
              >
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Checklist</p>
                <h3 className="mt-3 text-lg font-bold text-slate-950">Passi guidati</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">Segui l'ordine giusto, uno step alla volta.</p>
              </button>
            </div>

            {!setupCompleted && (
            <div id="prima-volta-qui" className="scroll-mt-6 rounded-3xl border border-emerald-100 bg-white p-5 shadow-sm md:p-6">
              {(() => {
                const guidedSteps = [
                  {
                    number: "1",
                    title: "Capisci il modello",
                    done: purchase.unlocked,
                    onClick: () => setStep("portfolio"),
                  },
                  {
                    number: "2",
                    title: "Scegli la cifra mensile",
                    done: Number(portMonthly || 0) > 0,
                    onClick: () => setStep("portfolio"),
                  },
                  {
                    number: "3",
                    title: "Attiva il mio piano",
                    done: setupCompleted,
                    onClick: () => openDashboardTab("guida"),
                  },
                  {
                    number: "4",
                    title: "Guarda gli strumenti",
                    done: checklistState.strumenti || holdings.length > 0,
                    onClick: () => {
                      completeChecklistItem("strumenti");
                      setDashboardActiveTab("portafoglio");
                    },
                  },
                  {
                    number: "5",
                    title: "Registra il primo PAC",
                    done: holdings.length > 0,
                    onClick: () => goToDashboardSection("aggiungi-investimento"),
                  },
                  {
                    number: "6",
                    title: "Chiudi il mese",
                    done: currentMonthCompleted,
                    onClick: () => goToDashboardSection("azione-del-mese"),
                  },
                ];
                const activeGuidedStep = guidedSteps.find((item) => !item.done) || guidedSteps[guidedSteps.length - 1];

                return (
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Guida iniziale</p>
                        <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                          {completedInitialChecklist}/{initialChecklistItems.length} completati
                        </span>
                      </div>
                      <h3 className="mt-2 text-xl font-bold tracking-tight text-slate-900">Rendi il piano davvero tuo</h3>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        Prossimo passo: <span className="font-semibold text-slate-900">{activeGuidedStep.title}</span>. Tutto il resto resta disponibile, ma qui vedi solo l'orientamento essenziale.
                      </p>
                      <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-slate-200">
                        <div
                          className="h-full rounded-full bg-emerald-600 transition-all duration-700"
                          style={{ width: `${checklistPercent}%` }}
                        />
                      </div>
                    </div>

                    <button
                      onClick={activeGuidedStep.onClick}
                      className="w-full rounded-2xl bg-emerald-600 px-5 py-4 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 lg:w-auto lg:min-w-[220px]"
                    >
                      Vai al prossimo passo
                    </button>
                  </div>
                );
              })()}
            </div>
            )}


            <div className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
              <div className={`rounded-3xl border p-6 shadow-sm ${
                currentMonthCompleted
                  ? "border-emerald-200 bg-gradient-to-br from-emerald-50 to-white"
                  : "border-amber-200 bg-gradient-to-br from-amber-50 to-white"
              }`}>
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
                  Ritorno mensile
                </p>
                <h3 className="mt-3 text-2xl font-bold tracking-tight text-slate-900">
                  {monthlyReturnTitle}
                </h3>
                <p className="mt-2 text-lg font-semibold text-slate-900">
                  {monthlyReturnAction}
                </p>
                <p className="mt-3 text-sm leading-6 text-slate-600">
                  {monthlyReturnMessage}
                </p>
                <div className="mt-5 rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-slate-800 ring-1 ring-slate-200">
                  {monthlyReturnStatus}
                </div>
              </div>

              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
                  Capitale attuale
                </p>
                <h3 className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
                  {formatEuro(goalCurrentNumber || 0)}
                </h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Questo è il valore che hai inserito in “Aggiorna obiettivo”. Serve come riferimento operativo per capire dove sei oggi rispetto al tuo obiettivo.
                </p>
                <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm font-semibold text-slate-700">
                  <span>Obiettivo: {formatEuro(goalTargetNumber || 0)}</span>
                  <span>{goalProgressPercent.toFixed(1)}%</span>
                </div>
                <div className="mt-3 h-3 overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full rounded-full bg-emerald-600 transition-all duration-1000 ease-out"
                    style={{
                      width: `${goalProgressPercent}%`,
                    }}
                  />
                </div>
              </div>
            </div>

            <div id="azione-del-mese" className={`relative scroll-mt-6 overflow-hidden rounded-3xl border p-6 shadow-sm transition-all duration-700 ${
              currentMonthCompleted
                ? "border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-white"
                : "border-slate-200 bg-white"
            }`}>
              {currentMonthCompleted && (
                <div className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-emerald-100 blur-3xl" />
              )}
              {pacJustCompleted && (
                <div className="pointer-events-none absolute inset-x-6 top-6 z-10 rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4 shadow-sm">
                  <p className="text-sm font-semibold text-emerald-900">🎉 Catena protetta. Mese chiuso.</p>
                  <p className="mt-1 text-xs leading-5 text-emerald-700">
                    +{formatEuro(monthlyPacAmount || 0)} · +{pacImpactPercent.toFixed(1)}% verso {goalTitle || "il tuo obiettivo"}
                  </p>
                </div>
              )}
              <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr] lg:items-center">
                <div>
                  <div className="flex flex-wrap items-center gap-3">
                    <p className={`text-sm font-semibold uppercase tracking-[0.2em] ${
                      currentMonthCompleted ? "text-emerald-700" : "text-slate-500"
                    }`}>
                      Azione del mese
                    </p>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                      Livello: {userLevel}
                    </span>
                  </div>

                  <h3 className="mt-3 text-4xl font-bold tracking-tight text-slate-900">
                    {currentMonthCompleted
                      ? `✅ PAC di ${currentMonthLabel} completato`
                      : hasStartedPac
                      ? `Non spezzare la catena di ${currentMonthLabel}`
                      : "Completa il tuo primo mese di PAC"}
                  </h3>

                  <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
                    {pacPerfectMessage}
                  </p>

                  <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                    <button
                      onClick={() => togglePacMonth(currentMonthKey)}
                      className={`rounded-2xl px-6 py-4 text-base font-semibold shadow-sm transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] ${
                        currentMonthCompleted
                          ? "bg-white text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-50"
                          : "bg-emerald-600 text-white hover:bg-emerald-700"
                      }`}
                    >
                      {currentMonthCompleted
                        ? "Modifica stato mese"
                        : hasStartedPac
                        ? "Proteggi la catena"
                        : "Segna primo mese completato"}
                    </button>

                    <div className="rounded-2xl border border-slate-200 bg-white px-5 py-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Impatto stimato</p>
                      <p className="mt-1 text-sm font-semibold text-slate-900">
                        +{formatEuro(monthlyPacAmount || 0)} · +{pacImpactPercent.toFixed(1)}% verso il target
                      </p>
                    </div>
                  </div>
                </div>

                <div className={`rounded-3xl border p-5 ${
                  currentMonthCompleted
                    ? "border-emerald-200 bg-white"
                    : hasStartedPac
                    ? "border-amber-200 bg-amber-50"
                    : "border-slate-200 bg-slate-50"
                }`}>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-slate-900">🔥 Catena PAC</p>
                    <p className="text-sm font-bold text-slate-900">{currentStreak}/{nextChainTarget}</p>
                  </div>

                  <div className="mt-4 h-5 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className={`h-full rounded-full transition-all duration-1000 ease-out ${
                        currentMonthCompleted ? "bg-emerald-600" : hasStartedPac ? "bg-amber-500" : "bg-slate-900"
                      }`}
                      style={{ width: `${chainProgressPercent}%` }}
                    />
                  </div>

                  <p className="mt-4 text-sm font-semibold leading-6 text-slate-900">
                    {chainTitle}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    {chainMessage}
                  </p>
                  <p className="mt-3 rounded-2xl bg-white px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-600">
                    {chainNextStep}
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
                <div>
                  <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">Non spezzare la catena</p>
                  <h3 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">
                    {hasStartedPac ? `${currentStreak} ${currentStreak === 1 ? "mese" : "mesi"} consecutivi` : "Parti dal primo mese"}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Il PAC è un Piano di Accumulo mensile: il risultato non nasce da un singolo investimento, ma dalla ripetizione del gesto nel tempo.
                  </p>
                </div>

                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-slate-900">Prossimo traguardo</p>
                    <p className="text-sm font-bold text-slate-900">{nextChainTarget} mesi</p>
                  </div>
                  <div className="mt-4 grid grid-cols-12 gap-1">
                    {Array.from({ length: 12 }).map((_, index) => {
                      const active = index < currentStreak;
                      const target = index < nextChainTarget;

                      return (
                        <div
                          key={`chain-${index}`}
                          className={`h-3 rounded-full transition ${
                            active
                              ? "bg-emerald-600"
                              : target
                              ? "bg-slate-300"
                              : "bg-slate-200"
                          }`}
                        />
                      );
                    })}
                  </div>
                  <p className="mt-4 text-sm leading-6 text-slate-600">
                    {hasStartedPac
                      ? "Ogni mese completato mantiene viva la catena. Non serve fare di più: serve non interromperla."
                      : "Completa il primo mese per accendere la catena e iniziare la tua serie."}
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">Livello utente</p>
                  <h3 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">
                    {userLevel}
                  </h3>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                    {userLevelMessage}
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 lg:min-w-[260px]">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Prossimo livello</p>
                  <p className="mt-2 text-sm font-semibold text-slate-900">
                    {nextUserLevelMessage}
                  </p>
                  <div className="mt-4 h-3 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full rounded-full bg-slate-900 transition-all duration-1000 ease-out"
                      style={{ width: `${userLevelProgress}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
                <div>
                  <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">Micro-spunti educativi</p>
                  <h3 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">Prossimo passo</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Pochi suggerimenti, solo quando servono. L'obiettivo è ridurre dubbi e aiutarti a seguire il piano.
                  </p>
                </div>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                  {userLevel}
                </span>
              </div>

              <div className="mt-5 grid gap-3 md:grid-cols-2">
                {smartTips.slice(0, 4).map((tip) => (
                  <div key={tip.title} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <p className="text-sm font-semibold text-slate-900">{tip.title}</p>
                    <p className="mt-1 text-sm leading-6 text-slate-600">{tip.text}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Mese</p>
                <p className="mt-3 text-lg font-semibold text-slate-900">{currentMonthLabel}</p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {currentMonthCompleted ? "Completato e salvato." : "Ancora da chiudere."}
                </p>
              </div>
              <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Ricompensa</p>
                <p className="mt-3 text-lg font-semibold text-slate-900">+{formatEuro(monthlyPacAmount || 0)}</p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Ogni mese chiuso rafforza il piano.
                </p>
              </div>
              <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Obiettivo</p>
                <p className="mt-3 text-lg font-semibold text-slate-900">+{pacImpactPercent.toFixed(1)}%</p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Impatto stimato del PAC mensile sul target.
                </p>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h3 className="text-xl font-semibold">Reminder intelligenti</h3>
                  <p className="mt-1 text-sm text-slate-600">
                    Suggerimenti dinamici basati sui tuoi dati reali, non messaggi generici uguali per tutti.
                  </p>
                </div>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                  {reminderCards.length} attivi
                </span>
              </div>

              <div className="mt-5 grid gap-4 lg:grid-cols-3">
                {reminderCards.map((reminder) => (
                  <ReminderCard
                    key={reminder.title}
                    title={reminder.title}
                    text={reminder.text}
                    tone={reminder.tone}
                  />
                ))}
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">Storico PAC</p>
                  <h3 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">Controlla la continuità nel tempo</h3>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                    Qui trovi gli ultimi 12 mesi. Puoi correggere un mese se serve: i dati restano salvati su Supabase.
                  </p>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4 text-sm font-semibold text-slate-700">
                    {currentMonthCompleted
                      ? `Mese corrente completato`
                      : `Mese corrente da completare`}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowPacHistoryMonths((value) => !value)}
                    className="rounded-2xl bg-emerald-600 px-5 py-4 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700"
                  >
                    {showPacHistoryMonths ? "Nascondi ultimi 12 mesi" : "Mostra ultimi 12 mesi"}
                  </button>
                </div>
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-4">
                <div className="rounded-2xl bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Mesi completati</p>
                  <p className="mt-2 text-2xl font-bold text-slate-900">{pacCompletedMonths}/{pacHistory.length}</p>
                </div>
                <div className="rounded-2xl bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Continuità attuale</p>
                  <p className="mt-2 flex items-center gap-2 text-2xl font-bold text-slate-900">
                    <span>🔥</span>
                    <span>{currentStreak} {currentStreak === 1 ? "mese" : "mesi"}</span>
                  </p>
                </div>
                <div className="rounded-2xl bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Avanzamento ultimi mesi</p>
                  <p className="mt-2 text-2xl font-bold text-slate-900">{pacCompletionPercent}%</p>
                </div>
                <div className="rounded-2xl bg-emerald-50 p-4 ring-1 ring-emerald-100">
                  <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Impatto sul target</p>
                  <p className="mt-2 text-2xl font-bold text-emerald-900">+{pacImpactPercent.toFixed(1)}%</p>
                </div>
              </div>

              <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">Serie verso 12 mesi</p>
                    <p className="mt-1 text-sm leading-6 text-slate-600">{streakMessage}</p>
                    <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{nextMilestone}</p>
                  </div>
                  <p className="text-sm font-semibold text-slate-700">{currentStreak}/12 mesi</p>
                </div>
                <div className="mt-4 h-4 overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full rounded-full bg-emerald-600 transition-all duration-1000 ease-out"
                    style={{ width: `${streakProgressPercent}%` }}
                  />
                </div>
              </div>

              {showPacHistoryMonths && (
              <div className="mt-6">
                <div className="mb-3 flex items-center justify-between">
                  <p className="text-sm font-semibold text-slate-700">Ultimi 12 mesi</p>
                  <p className="text-xs text-slate-500">Clicca un mese per cambiarne lo stato</p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {pacHistory.map((item) => (
                    <button
                      key={item.month}
                      onClick={() => togglePacMonth(item.month)}
                      className={`rounded-2xl border p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm ${
                        item.completed
                          ? "border-emerald-300 bg-emerald-50"
                          : item.month === currentMonthKey
                          ? "border-slate-400 bg-white hover:bg-slate-50"
                          : "border-slate-200 bg-slate-50 hover:bg-slate-100"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-semibold text-slate-900">{getMonthLabel(item.month)}</span>
                        <span
                          className={`rounded-full px-2 py-1 text-xs font-semibold ${
                            item.completed
                              ? "bg-emerald-600 text-white"
                              : "bg-white text-slate-500 ring-1 ring-slate-200"
                          }`}
                        >
                          {item.completed ? "Fatto" : "Da fare"}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
              )}
            </div>

              </div>
            )}

            {dashboardActiveTab === "guida" && (
              <div className="space-y-6">
                <div className="rounded-3xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-8 shadow-sm">
                  <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-700">Guida operativa</p>
                  <h3 className="mt-3 text-3xl font-bold tracking-tight text-slate-950">Il percorso operativo del tuo PAC</h3>
                  <p className="mt-4 max-w-3xl text-base leading-7 text-slate-700">
                    Qui trovi i primi passi del percorso e le azioni di mantenimento da seguire con ordine, senza uscire dalla Dashboard.
                  </p>
                </div>

                <div className="rounded-3xl border-2 border-emerald-300 bg-emerald-50 p-7 shadow-sm">
                  <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-700">Prossimo passo consigliato</p>
                  {nextGuideItem ? (
                    <div className="mt-3">
                      <h3 className="text-2xl font-bold tracking-tight text-emerald-950">{nextGuideItem.title}</h3>
                      <p className="mt-2 max-w-3xl text-sm leading-6 text-emerald-900">{nextGuideItem.description}</p>
                      <div className="mt-5 flex flex-wrap gap-3">
                        {(() => {
                          const nextGuideAction = getChecklistToolAction(nextGuideItem.id);
                          const hasRequiredAction = Boolean(nextGuideAction && !guideActionVisited[nextGuideItem.id]);
                          const completeButtonClass = hasRequiredAction
                            ? "rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                            : "rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700";

                          return (
                            <>
                              {nextGuideAction && (
                                <button
                                  onClick={() => handleGuideToolAction(nextGuideItem.id, nextGuideAction)}
                                  className={hasRequiredAction
                                    ? "rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700"
                                    : "rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                                  }
                                >
                                  {nextGuideAction.label}
                                </button>
                              )}
                              <button onClick={() => toggleChecklist(nextGuideItem.id)} className={completeButtonClass}>
                                Segna come completato
                              </button>
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3">
                      <h3 className="text-2xl font-bold tracking-tight text-emerald-950">Guida completata</h3>
                      <p className="mt-2 max-w-3xl text-sm leading-6 text-emerald-900">
                        Hai completato i passaggi principali. Ora il Monitor diventa la vista più utile per seguire il piano mese dopo mese.
                      </p>
                      <button
                        onClick={() => setDashboardActiveTab("monitor")}
                        className="mt-5 rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-700"
                      >
                        Vai al Monitor
                      </button>
                    </div>
                  )}
                </div>

                <div id="prima-volta-qui" className="scroll-mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-700">Guida operativa</p>
                  <h3 className="mt-2 text-2xl font-bold tracking-tight text-slate-950">Cosa fare, in che ordine e dove cliccare</h3>
                  <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
                    Segui il percorso una voce alla volta. Se un passaggio richiede un'azione operativa, il pulsante principale ti porta direttamente nella card giusta.
                  </p>

                  <div className="mt-5 rounded-2xl bg-slate-50 p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium text-slate-700">
                          Guida iniziale: {completedInitialChecklist}/{initialChecklistItems.length}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          Completa questi passaggi una sola volta. Poi il sistema lavora per te.
                        </p>
                      </div>
                      <p className="text-sm font-semibold text-slate-900">{checklistPercent}%</p>
                    </div>
                    <div className="mt-3 h-3 overflow-hidden rounded-full bg-slate-200">
                      <div className="h-full rounded-full bg-slate-900 transition-all duration-700" style={{ width: `${checklistPercent}%` }} />
                    </div>
                    {setupCompleted && (
                      <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                        <p className="text-sm font-semibold text-emerald-900">
                          Sistema attivato. Ora concentrati su PAC e mantenimento.
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="mt-6 grid gap-6 lg:grid-cols-2">
                    <ChecklistGroup
                      title="Setup iniziale"
                      subtitle="Completa questi passaggi per rendere operativo il modello."
                      items={initialChecklistItems}
                      state={checklistState}
                      onToggle={toggleChecklist}
                      getToolAction={getChecklistToolAction}
                      nextItemId={nextGuideItem?.id}
                      actionVisited={guideActionVisited}
                      onToolActionClick={handleGuideToolAction}
                    />
                    <ChecklistGroup
                      title="Mantenimento nel tempo"
                      subtitle={`Queste abitudini non bloccano il setup. Completate: ${completedMaintenanceChecklist}/${maintenanceChecklistItems.length}`}
                      items={maintenanceChecklistItems}
                      state={checklistState}
                      onToggle={toggleChecklist}
                      getToolAction={getChecklistToolAction}
                      nextItemId={nextGuideItem?.id}
                      actionVisited={guideActionVisited}
                      onToolActionClick={handleGuideToolAction}
                    />
                  </div>
                </div>
              </div>
            )}

            {dashboardActiveTab === "portafoglio" && (
              <div className="space-y-6">
                <div className="rounded-3xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-6 shadow-sm">
                  <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-700">Portafoglio</p>
                  <h3 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Investimenti, strumenti e ripartizione</h3>
                  <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-700">
                    Qui trovi la parte operativa del portafoglio: registri gli investimenti, controlli la ripartizione e gestisci gli strumenti personalizzati.
                  </p>
                  <button
                    type="button"
                    onClick={() => setStep("strumentis")}
                    className="mt-5 rounded-xl border border-emerald-200 bg-white px-5 py-3 text-sm font-bold text-emerald-800 transition hover:bg-emerald-50"
                  >
                    Gestisci strumenti personalizzati
                  </button>
                </div>

            <div id="aggiungi-investimento" className="grid scroll-mt-6 gap-5 rounded-[2rem] border border-slate-200 bg-slate-50/80 p-4 shadow-sm md:p-5 xl:grid-cols-[1.08fr_1.18fr_0.92fr] xl:items-start">
              <div className="space-y-6">
                <div className="rounded-3xl border border-emerald-200 bg-white p-6 shadow-md shadow-emerald-100/60 ring-1 ring-emerald-100">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">Step 1</p>
                      <h3 className="mt-2 text-xl font-bold tracking-tight text-slate-900">Aggiungi investimento</h3>
                    </div>
                    <span className="rounded-full bg-emerald-600 px-3 py-1 text-xs font-semibold text-white">azione principale</span>
                  </div>
                  <p className="mt-2 text-sm text-slate-600">
                    Registra gli strumenti acquistati: ripartizione e lista si aggiornano subito qui accanto.
                  </p>

                  <div className="mt-5 space-y-4">
                    <div>
                      <label className="text-sm font-medium text-slate-700">Categoria</label>
                      <select
                        value={newHolding.category}
                        onChange={(e) => updateCategory(e.target.value as StrumentiCategory)}
                        className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none"
                      >
                        {Object.keys(strumentiLibrary).map((category) => (
                          <option key={category} value={category}>{category}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-sm font-medium text-slate-700">Strumenti</label>
                      <select
                        value={newHolding.strumentiName}
                        onChange={(e) => {
                          const strumenti = allInstrumentsByCategory[newHolding.category].find((item) => item.name === e.target.value);
                          if (!strumenti) return;
                          setNewHolding((prev) => ({ ...prev, strumentiName: strumenti.name, isin: strumenti.isin }));
                        }}
                        className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none"
                      >
                        {allInstrumentsByCategory[newHolding.category].map((strumenti) => (
                          <option key={`${strumenti.source}-${strumenti.id || strumenti.isin}-${strumenti.name}`} value={strumenti.name}>
                            {strumenti.name}{strumenti.source === "custom" ? " · personale" : ""}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-sm font-medium text-slate-700">ISIN / esempi</label>
                      <input
                        value={newHolding.isin}
                        readOnly
                        className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 outline-none"
                      />
                    </div>

                    <div>
                      <label className="text-sm font-medium text-slate-700">Capitale investito</label>
                      <input
                        value={newHolding.amount}
                        onChange={(e) => setNewHolding((prev) => ({ ...prev, amount: e.target.value }))}
                        placeholder="Es. 2500"
                        className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none"
                      />
                    </div>

                    <button
                      onClick={addHolding}
                      className="w-full rounded-xl bg-emerald-600 px-6 py-3 font-semibold text-white shadow-sm shadow-emerald-200 transition hover:bg-emerald-700"
                    >
                      Salva investimento
                    </button>
                  </div>
                </div>

                <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h3 className="text-lg font-semibold text-slate-900">Lettura rapida</h3>
                  <div className="mt-4 space-y-3">
                    <InsightCard
                      title="Categoria principale"
                      text={
                        mostWeightedCategory
                          ? `${mostWeightedCategory.category} e oggi l'area più pesante del modello.`
                          : "Non hai ancora categorie attive: il primo investimento attivera la dashboard."
                      }
                    />
                    <InsightCard
                      title="Scostamento più importante"
                      text={
                        biggestGap
                          ? biggestGap.delta === 0
                            ? `${biggestGap.label} e perfettamente in linea con il target.`
                            : biggestGap.delta > 0
                            ? `${biggestGap.label} e sopra target di ${biggestGap.delta} punti percentuali.`
                            : `${biggestGap.label} e sotto target di ${Math.abs(biggestGap.delta)} punti percentuali.`
                          : "Quando ci saranno dati reali, qui vedrai subito dove intervenire."
                      }
                    />
                    <InsightCard
                      title="Interpretazione"
                      text="L'obiettivo non è prevedere il mercato, ma mantenere il modello coerente con il piano assegnato."
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-6">
                <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Step 2</p>
                      <h3 id="ripartizione-attuale" className="mt-2 scroll-mt-6 text-xl font-bold tracking-tight text-slate-900">Ripartizione attuale</h3>
                      <p className="mt-1 text-sm text-slate-600">
                        Controlla come cambia il capitale dopo ogni investimento inserito.
                      </p>
                    </div>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                      {dashboardBreakdown.length} categorie
                    </span>
                  </div>

                  {dashboardBreakdown.length === 0 ? (
                    <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm leading-6 text-slate-500">
                      Aggiungi il primo investimento: qui comparira la ripartizione automatica del capitale.
                    </div>
                  ) : (
                    <div className="mt-5 space-y-4">
                      {dashboardBreakdown.map((item) => (
                        <div key={item.category} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <div className="flex items-center justify-between gap-4">
                            <div>
                              <p className="font-semibold text-slate-900">{item.category}</p>
                              <p className="mt-1 text-sm text-slate-500">{formatEuro(item.amount)}</p>
                            </div>
                            <div className="text-right">
                              <p className="text-xl font-bold text-slate-900">{item.percentage}%</p>
                              <p className="text-xs uppercase tracking-wide text-slate-500">sul totale</p>
                            </div>
                          </div>
                          <div className="mt-4 h-3 overflow-hidden rounded-full bg-slate-200">
                            <div
                              className="h-full rounded-full bg-slate-900"
                              style={{ width: `${Math.min(item.percentage, 100)}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {monthlyAllocationIsAligned && (
                  <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-5 shadow-sm">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm font-bold text-emerald-950">Quote del mese completate</p>
                        <p className="mt-1 text-sm leading-6 text-emerald-800">
                          Hai inserito gli strumenti. Torna alla guida per chiudere il passaggio e continuare il percorso.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={goBackToGuideFromDashboard}
                        className="shrink-0 rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 hover:shadow-md active:scale-95"
                      >
                        Torna alla guida
                      </button>
                    </div>
                  </div>
                )}

                <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Step 3</p>
                      <h3 id="i-tuoi-investimenti" className="mt-2 scroll-mt-6 text-xl font-bold tracking-tight text-slate-900">I tuoi investimenti</h3>
                    </div>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">{holdings.length} inseriti</span>
                  </div>
                  {holdings.length === 0 ? (
                    <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm leading-6 text-slate-500">
                      Nessun investimento inserito. Dopo il salvataggio, lo strumento apparira qui con categoria, ISIN e importo.
                    </div>
                  ) : (
                    <div className="mt-4 space-y-3">
                      {holdings.map((item) => (
                        <div
                          key={item.id}
                          className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:flex-row md:items-center md:justify-between"
                        >
                          <div>
                            <p className="font-medium">{item.strumentiName}</p>
                            <p className="text-sm text-slate-500">{item.category} - {item.isin}</p>
                          </div>
                          <div className="flex items-center gap-3">
                            <p className="font-semibold">{formatEuro(item.amount)}</p>
                            <button
                              onClick={() => removeHolding(item.id)}
                              className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-50"
                            >
                              Rimuovi
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-6">
                <div className="rounded-3xl border border-emerald-200 bg-white p-6 shadow-md shadow-emerald-100/50 ring-1 ring-emerald-100">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">Step 4</p>
                      <h3 className="mt-2 text-xl font-bold tracking-tight text-slate-900">Guida operativa del mese</h3>
                      <p className="mt-1 text-sm leading-6 text-slate-600">
                        Esegui le quote suggerite e spuntale una alla volta. Questa è la parte pratica del mese, non una registrazione contabile.
                      </p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      allocationChecklistComplete
                        ? "bg-emerald-100 text-emerald-800"
                        : "bg-slate-100 text-slate-700"
                    }`}>
                      {monthlyAllocationAlignedCount}/{monthlyAllocationPlan.length} in linea
                    </span>
                  </div>

                  <div className="mt-5 h-3 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full rounded-full bg-emerald-600 transition-all duration-700"
                      style={{
                        width: `${monthlyAllocationPlan.length > 0 ? (monthlyAllocationAlignedCount / monthlyAllocationPlan.length) * 100 : 0}%`,
                      }}
                    />
                  </div>

                  <div className="mt-5 grid gap-3">
                    {monthlyAllocationPlan.map((item) => {
                      const investedAmount = getInvestedAmountForPortfolioCategory(item.category);
                      const isInLine = item.roundedAmount > 0 && Math.abs(investedAmount - item.roundedAmount) <= 1;

                      return (
                        <button
                          key={`pac-${item.label}-${item.category}`}
                          onClick={() =>
                            setCheckedPacAllocations((prev) => ({
                              ...prev,
                              [item.category]: !prev[item.category],
                            }))
                          }
                          className={`min-h-[156px] w-full min-w-0 rounded-2xl border p-4 text-left transition-all duration-300 hover:-translate-y-0.5 hover:shadow-sm ${
                            isInLine
                              ? "border-emerald-300 bg-emerald-50 shadow-sm ring-1 ring-emerald-100"
                              : "border-slate-200 bg-white hover:bg-slate-50"
                          }`}
                        >
                          <div className="flex h-full min-w-0 flex-col gap-5">
                            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4">
                              <div className="min-w-0">
                                <p className="break-words text-lg font-bold leading-tight tracking-tight text-slate-900">{item.label}</p>
                                <p className="mt-1 text-sm leading-5 text-slate-500">{item.percentage}% del PAC mensile</p>
                              </div>
                              <span className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${
                                isInLine
                                  ? "bg-emerald-600 text-white"
                                  : "bg-slate-100 text-slate-600 ring-1 ring-slate-200"
                              }`}>
                                {isInLine ? "in linea" : "da allineare"}
                              </span>
                            </div>

                            <div className="grid grid-cols-2 gap-3 rounded-2xl bg-white/70 p-3 ring-1 ring-slate-100">
                              <div className="min-w-0">
                                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Da investire</p>
                                <p className="mt-1 whitespace-nowrap text-xl font-bold text-slate-900">{formatEuro(item.roundedAmount)}</p>
                              </div>
                              <div className="min-w-0 text-right">
                                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Inserito</p>
                                <p className={`mt-1 whitespace-nowrap text-xl font-bold ${isInLine ? "text-emerald-700" : "text-slate-900"}`}>
                                  {formatEuro(investedAmount)}
                                </p>
                              </div>
                            </div>

                            <div className="h-3 overflow-hidden rounded-full bg-slate-200">
                              <div
                                className={`h-full rounded-full transition-all duration-700 ${
                                  isInLine ? "bg-emerald-600" : "bg-slate-900"
                                }`}
                                style={{ width: `${Math.min(item.percentage, 100)}%` }}
                              />
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {monthlyAllocationIsAligned && (
                    <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                      <p className="text-sm font-semibold text-emerald-900">
                        Ripartizione del mese in linea.
                      </p>
                      <p className="mt-1 text-xs leading-5 text-emerald-700">
                        Gli importi inseriti corrispondono alle quote suggerite dal modello.
                      </p>
                    </div>
                  )}

                  <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                    <label className="text-sm font-semibold text-emerald-950">PAC mensile da distribuire</label>
                    <input
                      value={portMonthly}
                      onChange={(e) => setPortMonthly(e.target.value)}
                      placeholder="Es. 200"
                      className="mt-2 w-full rounded-xl border border-emerald-200 bg-white px-4 py-3 outline-none transition focus:border-emerald-500"
                    />
                    <p className="mt-2 text-xs leading-5 text-emerald-800">
                      La cifra viene salvata, resta dopo il refresh e viene divisa automaticamente secondo il modello. Non serve essere preciso al centesimo: segui le proporzioni.
                    </p>
                  </div>
                </div>
              </div>
            </div>

                <div id="obiettivo-personale" className="scroll-mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
                <div className="rounded-3xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-6">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                        Obiettivo personale
                      </p>
                      <h3 className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
                        {goalTitle || "Il tuo obiettivo"}
                      </h3>
                      <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                        Aggiorna manualmente il valore reale del tuo capitale: così la barra tiene conto anche di mercato, prelievi e variazioni non visibili negli holdings.
                      </p>
                    </div>

                    <div className="rounded-2xl bg-slate-900 px-5 py-4 text-white">
                      <p className="text-xs uppercase tracking-wide text-slate-300">
                        Progresso
                      </p>
                      <p className="mt-1 text-3xl font-bold tracking-tight">
                        {goalProgressPercent.toFixed(1)}%
                      </p>
                    </div>
                  </div>

                  <div className="mt-6">
                    <div className="h-6 overflow-hidden rounded-full bg-slate-200">
                      <div
                        className="h-full rounded-full bg-slate-900 transition-all duration-1000 ease-out"
                        style={{ width: `${Math.min(goalProgressPercent, 100)}%` }}
                      />
                    </div>

                    <div className="mt-3 flex flex-col gap-2 text-sm text-slate-600 md:flex-row md:items-center md:justify-between">
                      <span>Valore aggiornato: {formatEuro(goalCurrentNumber || 0)}</span>
                      <span>Target finale: {formatEuro(goalTargetNumber || 0)}</span>
                    </div>
                  </div>

                  <div className="mt-6 grid gap-4 sm:grid-cols-3">
                    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Capitale aggiornato
                      </p>
                      <p className="mt-2 text-xl font-bold tracking-tight text-slate-900">
                        {formatEuro(goalCurrentNumber || 0)}
                      </p>
                    </div>

                    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Durata residua
                      </p>
                      <p className="mt-2 text-xl font-bold tracking-tight text-slate-900">
                        {goalDurationYears} anni
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {goalDurationMonths} mesi - fine {safeGoalEndYear}
                      </p>
                    </div>

                    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Stima PAC a fine piano
                      </p>
                      <p className="mt-2 text-xl font-bold tracking-tight text-slate-900">
                        {formatEuro(goalEstimatedFinal || 0)}
                      </p>
                    </div>
                  </div>

                  <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4">
                    <p className="text-sm font-medium leading-6 text-slate-800">
                      {goalMessage}
                    </p>
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      La stima a fine piano usa solo PAC mensile, anno finale e rendimento stimato. Il capitale aggiornato serve invece per misurare il progresso reale verso il target.
                    </p>
                    {hasReachedPersonalGoal ? (
                      <button
                        type="button"
                        onClick={replayPersonalGoalCelebration}
                        className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-bold text-emerald-800 transition hover:bg-emerald-100"
                      >
                        Rivedi celebrazione obiettivo
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6">
                  <h4 className="text-lg font-semibold text-slate-900">
                    Aggiorna obiettivo
                  </h4>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Inserisci manualmente il valore aggiornato del capitale. Questo dato può includere fluttuazioni di mercato, prelievi o variazioni che gli holdings non mostrano. Non serve aggiornarlo ogni giorno: usalo per avere consapevolezza, non per reagire al mercato.
                  </p>

                  <div key={goalDraftFormKey} className="mt-5 space-y-4">
                    <div>
                      <label className="text-sm font-medium text-slate-700">
                        Nome obiettivo
                      </label>
                      <input
                        ref={draftGoalTitleRef}
                        defaultValue={draftGoalTitle}
                        onFocus={() => goalSaveStatus !== "idle" && setGoalSaveStatus("idle")}
                        placeholder="Es. Libertà finanziaria"
                        className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
                      />
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label className="text-sm font-medium text-slate-700">
                          Valore attuale aggiornato
                        </label>
                        <input
                          ref={draftGoalCurrentValueRef}
                          defaultValue={draftGoalCurrentValue}
                          onFocus={() => goalSaveStatus !== "idle" && setGoalSaveStatus("idle")}
                          placeholder="Es. 12000"
                          className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
                        />
                      </div>

                      <div>
                        <label className="text-sm font-medium text-slate-700">
                          Valore precedente
                        </label>
                        <input
                          ref={draftGoalPreviousValueRef}
                          defaultValue={draftGoalPreviousValue}
                          onFocus={() => goalSaveStatus !== "idle" && setGoalSaveStatus("idle")}
                          placeholder="Es. 10000"
                          className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
                        />
                      </div>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label className="text-sm font-medium text-slate-700">
                          Target finale
                        </label>
                        <input
                          ref={draftGoalTargetRef}
                          defaultValue={draftGoalTarget}
                          onFocus={() => goalSaveStatus !== "idle" && setGoalSaveStatus("idle")}
                          placeholder="Es. 100000"
                          className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
                        />
                      </div>

                      <div>
                        <label className="text-sm font-medium text-slate-700">
                          Anno fine investimento
                        </label>
                        <input
                          type="number"
                          ref={draftGoalEndYearRef}
                          defaultValue={draftGoalEndYear}
                          onFocus={() => goalSaveStatus !== "idle" && setGoalSaveStatus("idle")}
                          onBlur={(e) => setDraftGoalEndYear(e.target.value)}
                          placeholder="Es. 2055"
                          className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
                        />
                      </div>
                    </div>

                    <div className="rounded-2xl border border-slate-200 bg-white p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Durata calcolata
                      </p>
                      <p className="mt-2 text-lg font-bold text-slate-900">
                        {draftGoalDurationYears} anni - {draftGoalDurationMonths} mesi
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        Calcolata automaticamente dall'anno corrente fino al {safeDraftGoalEndYear}.
                      </p>
                    </div>

                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                        Salvataggio
                      </p>
                      <p className="mt-2 text-sm leading-6 text-emerald-900">
                        I campi restano fluidi mentre scrivi. Quando hai finito, premi <strong>Salva aggiornamento</strong>: l'app aggiorna la Dashboard e salva su Supabase.
                      </p>
                    </div>

                    <div>
                      <label className="text-sm font-medium text-slate-700">
                        Motivo del cambiamento
                      </label>
                      <select
                        ref={draftGoalReasonRef}
                        defaultValue={draftGoalReason}
                        onChange={() => setGoalSaveStatus("idle")}
                        className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
                      >
                        <option value="stabile">Aggiornamento periodico</option>
                        <option value="investimento">Nuovo investimento</option>
                        <option value="prelievo">Ho usato parte dei soldi</option>
                        <option value="mercato">Oscillazione di mercato</option>
                      </select>
                    </div>

                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                      <button
                        type="button"
                        onClick={saveGoalUpdateFromDashboard}
                        disabled={goalSaveStatus === "saving"}
                        className="rounded-2xl bg-emerald-600 px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {goalSaveStatus === "saving" ? "Salvataggio..." : "Salva aggiornamento"}
                      </button>
                      {goalSaveStatus === "saved" ? (
                        <span className="text-sm font-semibold text-emerald-700">Aggiornamento salvato.</span>
                      ) : null}
                      {goalSaveStatus === "error" ? (
                        <span className="text-sm font-semibold text-rose-700">Salvataggio non riuscito. Riprova.</span>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            </div>


            <div className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Focus del mese</p>
                <p className="mt-3 text-lg font-semibold text-slate-900">
                  {currentMonthEntry?.completed ? "Mantieni il ritmo" : "Completa il PAC del mese"}
                </p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {currentMonthEntry?.completed
                    ? "Hai già fatto il passo più importante: ora evita decisioni impulsive."
                    : "Un solo click rende il mese visibile nella tua continuita."}
                </p>
              </div>

              <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Badge vicino</p>
                <p className="mt-3 text-lg font-semibold text-slate-900">
                  {nextBadge ? nextBadge.title : "Tutti i badge attivi"}
                </p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {nextBadge ? nextBadge.description : "Hai sbloccato tutti i badge disponibili in questa fase."}
                </p>
              </div>

              <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Regola sana</p>
                <p className="mt-3 text-lg font-semibold text-slate-900">Costanza, non perfezione</p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Il PAC funziona quando diventa sostenibile e ripetibile, non quando richiede sforzi estremi.
                </p>
              </div>
            </div>


              </div>
            )}

            {dashboardActiveTab === "progressi" && (
              <div className="space-y-6">
                <div className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-emerald-700">Percorso lungo termine</p>
                      <h3 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">Badge del percorso</h3>
                      <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                        Non sono premi casuali: ogni badge misura un comportamento utile nel tempo. Setup, consapevolezza, costanza, capitale e identità.
                      </p>
                    </div>
                    <div className="rounded-2xl bg-slate-50 px-4 py-3 text-right ring-1 ring-slate-200">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Risultati sbloccati</p>
                      <p className="mt-1 text-2xl font-black text-slate-900">{unlockedBadges.length}<span className="text-base font-semibold text-slate-400">/{badges.length}</span></p>
                    </div>
                  </div>

                  <div className="mt-6 overflow-hidden rounded-[2rem] border border-slate-900 bg-slate-950 p-5 text-white shadow-sm">
                    <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
                      <div className="flex items-start gap-4">
                        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-3xl bg-white/10 text-3xl ring-1 ring-white/15">
                          {currentInvestorTitle.icon}
                        </div>
                        <div>
                          <p className="text-xs font-black uppercase tracking-[0.22em] text-emerald-300">Titolo attuale</p>
                          <h4 className="mt-2 text-3xl font-black tracking-tight">{currentInvestorTitle.title}</h4>
                          <p className="mt-1 text-sm font-semibold text-slate-200">{currentInvestorTitle.subtitle}</p>
                          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">{currentInvestorTitle.description}</p>
                        </div>
                      </div>

                      <div className="rounded-3xl bg-white/10 p-4 ring-1 ring-white/15">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-black">{nextInvestorTitle ? "Prossimo titolo" : "Titoli completati"}</p>
                          <span className="rounded-full bg-emerald-400/15 px-3 py-1 text-xs font-black text-emerald-200">
                            {nextInvestorTitle ? nextInvestorTitle.progressLabel : "massimo livello"}
                          </span>
                        </div>
                        <p className="mt-2 text-lg font-black">{nextInvestorTitle ? nextInvestorTitle.title : "Sei al livello più alto"}</p>
                        <p className="mt-2 text-sm leading-6 text-slate-300">
                          {nextInvestorTitle ? nextInvestorTitle.nextHint : "Continua a proteggere la costanza: il titolo resta forte se il comportamento continua."}
                        </p>
                        <div className="mt-4 h-3 overflow-hidden rounded-full bg-white/15">
                          <div
                            className="h-full rounded-full bg-emerald-400 transition-all duration-700"
                            style={{ width: `${nextInvestorTitle ? Math.min(nextTitleProgressPercent, 100) : 100}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 overflow-hidden rounded-[1.75rem] border border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-slate-50 p-5">
                    <div className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
                      <div className="flex items-start gap-4">
                        <div className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-2xl shadow-sm ${
                          nextBadge ? "bg-slate-900 text-white" : "bg-emerald-600 text-white"
                        }`}>
                          {nextBadge ? nextBadge.icon : "🏆"}
                        </div>
                        <div>
                          <p className="text-xs font-bold uppercase tracking-[0.22em] text-emerald-700">
                            {nextBadge ? "Badge vicino" : "Percorso completato"}
                          </p>
                          <h4 className="mt-2 text-2xl font-black tracking-tight text-slate-950">
                            {nextBadge ? nextBadge.title : "Tutti i badge attivi"}
                          </h4>
                          <p className="mt-2 text-sm leading-6 text-slate-600">
                            {nextBadge ? nextBadge.description : "Hai completato tutti i badge disponibili in questa fase."}
                          </p>
                          <p className="mt-3 inline-flex rounded-full bg-white px-4 py-2 text-sm font-bold text-slate-800 shadow-sm ring-1 ring-slate-200">
                            {nextBadgeAction}
                          </p>
                        </div>
                      </div>

                      <div className="rounded-3xl bg-white/80 p-4 ring-1 ring-emerald-100">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-bold text-slate-900">Avanzamento badge</p>
                          <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-black text-emerald-700">
                            {Math.round((unlockedBadges.length / Math.max(badges.length, 1)) * 100)}%
                          </span>
                        </div>
                        <div className="mt-3 h-3 overflow-hidden rounded-full bg-slate-200">
                          <div
                            className="h-full rounded-full bg-emerald-600 transition-all duration-700"
                            style={{ width: `${Math.round((unlockedBadges.length / Math.max(badges.length, 1)) * 100)}%` }}
                          />
                        </div>
                        <p className="mt-3 text-xs leading-5 text-slate-500">
                          I badge futuri restano visibili come obiettivi, ma quelli più lontani rimangono discreti per non creare pressione.
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                    {(["inizio", "consapevolezza", "costanza", "capitale", "identità"] as Badge["tier"][]).map((tier) => {
                      const tierLabels: Record<Badge["tier"], string> = {
                        inizio: "Attivazione",
                        consapevolezza: "Consapevolezza",
                        costanza: "Costanza",
                        capitale: "Capitale",
                        identità: "Identità",
                      };
                      const tierBadges = orderedBadges.filter((badge) => badge.tier === tier);
                      const tierUnlocked = tierBadges.filter((badge) => badge.unlocked).length;

                      return (
                        <div key={tier} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-xs font-black uppercase tracking-[0.18em] text-slate-500">{tierLabels[tier]}</p>
                            <span className="rounded-full bg-white px-2 py-1 text-xs font-bold text-slate-600 ring-1 ring-slate-200">
                              {tierUnlocked}/{tierBadges.length}
                            </span>
                          </div>
                          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
                            <div
                              className="h-full rounded-full bg-slate-900 transition-all duration-700"
                              style={{ width: `${Math.round((tierUnlocked / Math.max(tierBadges.length, 1)) * 100)}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {orderedBadges.map((badge) => {
                      const isNext = nextBadge?.id === badge.id;
                      const progressPercent = Math.round((badge.progress / Math.max(badge.target, 1)) * 100);

                      return (
                        <div
                          key={badge.id}
                          className={`group relative overflow-hidden rounded-2xl border p-4 transition-all duration-300 ${
                            badge.unlocked
                              ? "border-emerald-300 bg-emerald-50 shadow-sm ring-1 ring-emerald-100"
                              : isNext
                              ? "border-slate-300 bg-white shadow-sm ring-2 ring-emerald-100"
                              : "border-slate-200 bg-slate-50/80 opacity-80"
                          }`}
                        >
                          {badge.unlocked && (
                            <div className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-emerald-200/50 blur-2xl" />
                          )}

                          <div className="relative flex items-start justify-between gap-4">
                            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg shadow-sm ${
                              badge.unlocked
                                ? "bg-emerald-600 text-white"
                                : isNext
                                ? "bg-slate-900 text-white"
                                : "bg-white text-slate-400 ring-1 ring-slate-200"
                            }`}>
                              {badge.unlocked ? "✓" : badge.icon}
                            </div>
                            <span className={`rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-wide ${
                              badge.unlocked
                                ? "bg-emerald-600 text-white"
                                : isNext
                                ? "bg-emerald-100 text-emerald-800"
                                : "bg-white text-slate-500 ring-1 ring-slate-200"
                            }`}>
                              {badge.unlocked ? "sbloccato" : isNext ? "prossimo" : "in arrivo"}
                            </span>
                          </div>

                          <div className="relative mt-4">
                            <p className="text-lg font-black tracking-tight text-slate-950">{badge.title}</p>
                            <p className="mt-2 min-h-[48px] text-sm leading-6 text-slate-600">
                              {badge.unlocked || isNext ? badge.description : badge.lockedHint}
                            </p>
                          </div>

                          <div className="relative mt-4 rounded-xl bg-white/80 p-2.5 ring-1 ring-slate-100">
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Progresso</p>
                              <p className="text-xs font-black text-slate-800">{badge.progressLabel}</p>
                            </div>
                            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200">
                              <div
                                className={`h-full rounded-full transition-all duration-700 ${
                                  badge.unlocked ? "bg-emerald-600" : isNext ? "bg-slate-900" : "bg-slate-300"
                                }`}
                                style={{ width: `${Math.min(progressPercent, 100)}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

          </section>
        )}        {showRetakeWarning && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
            <div className="w-full max-w-2xl rounded-3xl bg-white p-6 shadow-2xl">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Rifare il questionario</p>
              <h3 className="mt-3 text-2xl font-bold tracking-tight text-slate-900">
                Sei sicuro di voler cambiare il tuo piano?
              </h3>

              <p className="mt-4 text-sm leading-6 text-slate-600">
                Il questionario va fatto con attenzione: non esiste una risposta giusta e il risultato è un modello educativo, non una raccomandazione personalizzata.
              </p>

              <p className="mt-3 text-sm leading-6 text-slate-600">
                Rifarlo spesso può cambiare modello, PAC e riferimenti della dashboard. Questo rischia di spostare il focus dal metodo alla ricerca continua di un risultato diverso.
              </p>

              {retakeMeta.count > 0 && (
                <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                  <p className="text-sm font-semibold text-amber-900">
                    Hai già rifatto il test {retakeMeta.count} {retakeMeta.count === 1 ? "volta" : "volte"}.
                  </p>
                  <p className="mt-1 text-sm leading-6 text-amber-800">
                    La costanza è più importante della ricerca del modello perfetto.
                  </p>
                </div>
              )}

              {retakeIsBlocked ? (
                <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4">
                  <p className="text-sm font-semibold text-red-900">
                    Per proteggere la coerenza del piano, potrai rifare il test tra {retakeDaysRemaining} {retakeDaysRemaining === 1 ? "giorno" : "giorni"}.
                  </p>
                  <p className="mt-1 text-sm leading-6 text-red-800">
                    Nel frattempo continua con il modello attuale: cambiare spesso può indebolire il percorso.
                  </p>
                </div>
              ) : (
                <div className="mt-4">
                  <label className="text-sm font-medium text-slate-700">
                    Perché vuoi rifarlo?
                  </label>
                  <select
                    value={retakeReason}
                    onChange={(e) => setRetakeReason(e.target.value)}
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
                  >
                    <option value="situazione">La mia situazione e cambiata</option>
                    <option value="non_mi_riconosco">Non mi riconosco nel risultato</option>
                    <option value="alternative">Voglio capire alternative</option>
                    <option value="altro">Altro</option>
                  </select>
                </div>
              )}

              <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
                <button
                  onClick={cancelRetakeQuiz}
                  className="rounded-xl border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  Mantieni il mio piano
                </button>
                <button
                  onClick={confirmRetakeQuiz}
                  disabled={retakeIsBlocked}
                  className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  Rifai comunque il test
                </button>
              </div>
            </div>
          </div>
        )}

        {step === "admin" && (
          <AdminDashboard
            overview={adminOverview}
            loading={adminLoading}
            message={adminMessage}
            resetConfirm={adminResetConfirm}
            resetLoading={adminResetLoading}
            onResetConfirmChange={setAdminResetConfirm}
            onRefresh={loadAdminOverview}
            onReset={resetAdminTestData}
            onExitAdmin={() => setStep("dashboard")}
          />
        )}

        {step === "rebalance" && (
          <section className="space-y-6">
            {!isProPlan ? (
              <div className="rounded-3xl border border-emerald-100 bg-gradient-to-br from-white via-emerald-50/40 to-white p-8 shadow-sm">
                <div className="inline-flex rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-emerald-700">Funzione Pro</div>
                <h2 className="mt-4 text-3xl font-bold tracking-tight">Ribilanciamento guidato</h2>
                <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
                  Il ribilanciamento ti aiuta a riportare il portafoglio vicino al piano scelto, senza inseguire il mercato e senza prendere decisioni impulsive. È una funzione utile quando hai già iniziato e vuoi controllare se la tua ripartizione sta restando coerente.
                </p>
                <button
                  onClick={requestProUpgrade}
                  className="rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 hover:shadow-md active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isCorePlan ? "Passa a Pro - paghi 30 EUR" : "Vedi piano Pro"}
                </button>
              </div>
            ) : (
              <>
                <div className="overflow-hidden rounded-3xl border border-emerald-100 bg-gradient-to-br from-white via-emerald-50/50 to-slate-50 p-8 shadow-sm">
                  <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-700">Piano Pro</p>
                      <h2 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">Ribilanciamento guidato</h2>
                      <p className="mt-4 max-w-4xl text-base leading-7 text-slate-600">
                        Il ribilanciamento non serve a prevedere il mercato. Serve a controllare se il portafoglio si sta allontanando dal tuo modello e a decidere, con calma, dove indirizzare i prossimi PAC.
                      </p>
                    </div>
                    <div className="grid w-full min-w-0 gap-2 rounded-2xl border border-white bg-white/80 p-4 shadow-sm">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-500">Patrimonio inserito</span>
                        <strong className="text-slate-900">{formatEuro(rebalanceTotalInvested)}</strong>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-500">PAC disponibile</span>
                        <strong className="text-slate-900">{formatEuro(rebalancePacNumber)}</strong>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-500">Scostamento totale</span>
                        <strong className={totalRebalanceAbsoluteDrift === 0 ? "text-emerald-700" : totalRebalanceAbsoluteDrift <= 8 ? "text-amber-700" : "text-red-700"}>{totalRebalanceAbsoluteDrift}%</strong>
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 grid gap-3 md:grid-cols-3">
                    <div className="rounded-2xl border border-emerald-100 bg-white p-4">
                      <p className="text-sm font-bold text-slate-900">1. Inserisci i valori</p>
                      <p className="mt-1 text-sm leading-6 text-slate-600">Inserisci gli importi attuali per ogni categoria.</p>
                    </div>
                    <div className="rounded-2xl border border-emerald-100 bg-white p-4">
                      <p className="text-sm font-bold text-slate-900">2. Leggi lo scostamento</p>
                      <p className="mt-1 text-sm leading-6 text-slate-600">Vedi cosa e sopra peso, sotto peso o in linea.</p>
                    </div>
                    <div className="rounded-2xl border border-emerald-100 bg-white p-4">
                      <p className="text-sm font-bold text-slate-900">3. Orienta il prossimo PAC</p>
                      <p className="mt-1 text-sm leading-6 text-slate-600">Correggi gradualmente, senza vendere in modo impulsivo.</p>
                    </div>
                  </div>
                </div>

                <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
                  <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Dati di partenza</p>
                      <h3 className="mt-2 text-xl font-bold tracking-tight">Quanto hai oggi in ogni asset?</h3>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        Inserisci il valore attuale delle categorie del tuo modello. Il calcolo considera normale uno scostamento fino all'1% per asset, ma mostra comunque numeri precisi per orientare il PAC.
                      </p>
                    </div>

                    <div className="mt-5 grid gap-4 sm:grid-cols-[1fr_1.2fr]">
                      <label className="block rounded-2xl border border-slate-200 bg-slate-50 p-4">
                        <span className="text-sm font-semibold text-slate-800">PAC mensile per riequilibrare</span>
                        <input
                          type="number"
                          min="0"
                          value={rebalancePacAmount}
                          onChange={(e) => setRebalancePacAmount(e.target.value)}
                          placeholder="Es. 200"
                          className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                        />
                      </label>
                      <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4 text-sm leading-6 text-emerald-900">
                        <strong>Consiglio semplice:</strong> se lo scostamento non è enorme, spesso è meglio correggere con i prossimi PAC invece di vendere strumenti. Meno fretta, meno costi, meno decisioni impulsive.
                      </div>
                    </div>

                    <div className="mt-6 rounded-3xl border border-slate-200 bg-slate-50 p-5">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                        <div>
                          <h4 className="text-base font-bold text-slate-900">Valori attuali per asset</h4>
                          <p className="mt-1 text-sm leading-6 text-slate-600">
                            Inserisci gli importi in euro. Il target indica la percentuale che il tuo modello vorrebbe mantenere nel tempo. Uno scostamento fino all'1% viene considerato fisiologico, ma puoi comunque usare le quote sotto per riportarti al target preciso.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setRebalanceValues({})}
                          className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
                        >
                          Svuota valori
                        </button>
                      </div>

                      <div className="mt-5 grid gap-4 sm:grid-cols-2">
                        {selectedPortfolio.composition.map((item) => (
                          <label key={item.category} className="block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                            <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                              <span className="h-3 w-3 rounded-full" style={{ backgroundColor: getAssetColor(item.category) }} />
                              {item.label}
                              <span className="ml-auto rounded-full bg-slate-100 px-2 py-1 text-[11px] font-bold text-slate-500">
                                target {item.percentage}%
                              </span>
                            </span>
                            <input
                              type="number"
                              min="0"
                              step="1"
                              value={rebalanceValues[item.category] || ""}
                              onChange={(e) =>
                                setRebalanceValues((prev) => ({
                                  ...prev,
                                  [item.category]: e.target.value,
                                }))
                              }
                              placeholder="Es. 1000"
                              className="mt-3 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                            />
                          </label>
                        ))}
                      </div>
                    </div>

                    <div className="mt-5 grid gap-3 sm:grid-cols-3">
                      <div className="rounded-2xl bg-slate-50 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Patrimonio</p>
                        <p className="mt-1 text-xl font-bold text-slate-900">{formatEuro(rebalanceTotalInvested)}</p>
                      </div>
                      <div className="rounded-2xl bg-slate-50 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">PAC</p>
                        <p className="mt-1 text-xl font-bold text-slate-900">{formatEuro(rebalancePacNumber)}</p>
                      </div>
                      <div className="rounded-2xl bg-slate-50 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Rientro</p>
                        <p className="mt-1 text-xl font-bold text-slate-900">{rebalanceMonthsNumber > 0 ? `${rebalanceMonthsNumber} ${rebalanceMonthsNumber === 1 ? "mese" : "mesi"}` : "-"}</p>
                      </div>
                    </div>
                    <p className="mt-4 text-xs leading-5 text-slate-500">
                      Il risultato è educativo: non dice cosa comprare o vendere, ma ti aiuta a capire se il portafoglio sta rispettando il modello scelto.
                    </p>
                  </div>

                  <div className="space-y-6">
                    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div>
                          <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Lettura rapida</p>
                          <h3 className="mt-2 text-xl font-bold tracking-tight">Quanto sei vicino al piano?</h3>
                          <p className="mt-3 text-sm leading-6 text-slate-600">{rebalanceStatus}</p>
                        </div>
                        <div className={totalRebalanceAbsoluteDrift === 0 ? "rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-700" : totalRebalanceAbsoluteDrift <= 8 ? "rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-700" : "rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700"}>
                          {rebalanceTotalInvested <= 0 ? "Inserisci dati" : totalRebalanceAbsoluteDrift === 0 ? "In linea" : totalRebalanceAbsoluteDrift <= 8 ? "Da monitorare" : "Da correggere"}
                        </div>
                      </div>

                      <div className="mt-5 space-y-3">
                        {rebalanceCoverage.map((item) => {
                          const assetStatus = item.delta === 0 ? "In linea" : item.delta > 0 ? "Sopra peso" : "Sotto peso";
                          const assetStatusClass = item.delta === 0 ? "bg-emerald-100 text-emerald-700" : item.delta > 0 ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700";
                          const driftWidth = Math.min(100, Math.abs(item.delta) * 4);
                          return (
                            <div key={item.category} className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
                              <div className="flex items-start justify-between gap-4">
                                <div>
                                  <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                                    <span className="h-3 w-3 rounded-full" style={{ backgroundColor: getAssetColor(item.category) }} />
                                    {item.label}
                                  </p>
                                  <p className="mt-2 text-xs text-slate-500">Attuale {item.currentPercentage}% ({formatEuro(item.currentAmount)}) · Obiettivo {item.targetPercentage}%</p>
                                </div>
                                <span className={`rounded-full px-3 py-1 text-xs font-bold ${assetStatusClass}`}>{assetStatus}</span>
                              </div>
                              <div className="mt-3 h-2 overflow-hidden rounded-full bg-white">
                                <div className={item.delta === 0 ? "h-full bg-emerald-500" : item.delta > 0 ? "h-full bg-amber-500" : "h-full bg-blue-500"} style={{ width: `${driftWidth}%` }} />
                              </div>
                              <p className="mt-2 text-xs font-semibold text-slate-600">Differenza precisa: {item.preciseDelta > 0 ? "+" : ""}{item.preciseDelta}% rispetto al modello{item.delta === 0 && item.preciseDelta !== 0 ? " (entro soglia 1%)" : ""}</p>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                      <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Regola pratica</p>
                      <h3 className="mt-2 text-xl font-bold tracking-tight">Ribilanciare non significa correre</h3>
                      <div className="mt-4 grid gap-3 sm:grid-cols-3">
                        <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4 text-sm leading-6 text-emerald-900">
                          <strong>Piccolo scostamento</strong><br />Non è un problema. Se vuoi precisione, usa le quote del PAC suggerite sotto.
                        </div>
                        <div className="rounded-2xl border border-amber-100 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
                          <strong>Scostamento medio</strong><br />Usa i prossimi PAC per rafforzare ciò che è sotto peso.
                        </div>
                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700">
                          <strong>Scostamento alto</strong><br />Valuta con calma costi, fiscalita e alternative prima di vendere.
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                    <div>
                      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Cosa fare ora</p>
                      <h3 className="mt-2 text-2xl font-bold tracking-tight">Orientamento dei prossimi PAC</h3>
                      <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                        Questa sezione suggerisce come distribuire temporaneamente il nuovo capitale per avvicinarti alle percentuali del modello. Se bastano pochi mesi, il piano non deve mettere tutto su un solo asset: indica anche la quota da mantenere sugli altri strumenti per non creare un nuovo squilibrio.
                      </p>
                    </div>
                    {rebalanceBiggestGap && (
                      <div className="rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
                        Scostamento maggiore: <strong>{rebalanceBiggestGap.label}</strong> ({rebalanceBiggestGap.preciseDelta > 0 ? "+" : ""}{rebalanceBiggestGap.preciseDelta}%)
                      </div>
                    )}
                  </div>

                  {rebalanceTotalInvested <= 0 ? (
                    <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-900">
                      Inserisci prima i valori attuali dei tuoi asset.
                    </div>
                  ) : rebalancePlan.length === 0 ? (
                    <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm leading-6 text-emerald-900">
                      Il portafoglio è già molto vicino al modello. Non emergono categorie da rafforzare: puoi continuare con il PAC ordinario e ricontrollare con calma.
                    </div>
                  ) : (
                    <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                      {rebalancePlan.map((item) => (
                        <div key={item.category} className="rounded-2xl border border-emerald-100 bg-gradient-to-br from-emerald-50 to-white p-5 shadow-sm">
                          <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: getAssetColor(item.category) }} />
                            {item.label}
                          </p>
                          <div className="mt-3 flex items-end justify-between gap-3">
                            <p className="text-3xl font-bold tracking-tight text-slate-900">{item.suggestedPercentage}%</p>
                            <span className={`rounded-full px-3 py-1 text-xs font-bold ${item.role === "correzione" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                              {item.role === "correzione" ? "quota di rientro" : "quota di mantenimento"}
                            </span>
                          </div>
                          <p className="mt-2 text-sm leading-6 text-slate-600">Circa <strong>{formatEuro(item.roundedAmount)}</strong> al mese{rebalanceMonthsNumber > 0 ? <> per {rebalanceMonthsNumber} {rebalanceMonthsNumber === 1 ? "mese" : "mesi"}</> : null}.</p>
                          {rebalanceMonthsNumber > 0 && <p className="mt-1 text-xs text-slate-500">Totale simulato: {formatEuro(item.totalAmount)}. Valore preciso: {formatEuro(item.exactTotalAmount)}.</p>}
                        </div>
                      ))}
                    </div>
                  )}

                  {rebalanceTotalInvested > 0 && (
                    <div className="mt-6 space-y-4">
                      <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50 p-5">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-700">Soluzione più prudente</p>
                            <p className="mt-2 text-lg font-bold text-slate-900">Rientro graduale usando solo i prossimi PAC</p>
                          </div>
                          {automaticRebalance.feasible && <span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-emerald-700">circa {rebalanceMonthsNumber} {rebalanceMonthsNumber === 1 ? "mese" : "mesi"}</span>}
                        </div>
                        <p className="mt-3 text-sm leading-6 text-slate-700">
                          Pro: evita vendite immediate, riduce il rischio di agire sull'emotività e usa il nuovo capitale per tornare verso il piano. La quota di rientro corregge l'asset sotto peso, mentre la quota di mantenimento continua a finanziare gli altri asset per non creare un nuovo squilibrio. Contro: se lo scostamento e grande può richiedere più tempo.
                        </p>
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
                          <p className="text-sm font-bold text-slate-900">Alternativa: vendere e riallocare</p>
                          <p className="mt-2 text-sm leading-6 text-slate-700">
                            Puoi simulare la vendita delle categorie sopra peso e l'acquisto di quelle sotto peso. Importo indicativo da riallocare: <strong>{formatEuro(estimatedSaleAmount)}</strong>.
                          </p>
                          <p className="mt-3 rounded-xl bg-white p-3 text-xs leading-5 text-amber-900">
                            Prima di vendere, valuta costi, tasse è conseguenze. In Italia l'aliquota ordinaria sulle plusvalenze finanziarie e generalmente il 26%, salvo casi particolari.
                          </p>
                        </div>
                        <div className="rounded-2xl border border-slate-200 bg-white p-5">
                          <p className="text-sm font-bold text-slate-900">Alternativa: PAC temporaneamente più alto</p>
                          <p className="mt-2 text-sm leading-6 text-slate-600">
                            Se vuoi rientrare prima senza vendere, puoi aumentare temporaneamente il PAC a circa <strong>{formatEuro(acceleratedRebalancePac)}</strong> al mese per circa <strong>{acceleratedRebalanceMonths} {acceleratedRebalanceMonths === 1 ? "mese" : "mesi"}</strong>.
                          </p>
                          <p className="mt-3 text-xs leading-5 text-slate-500">
                            Pro: accelera il rientro. Contro: richiede più liquidità mensile per un periodo limitato.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm leading-6 text-slate-600">
                    <strong>Lettura pratica:</strong> se una categoria è molto sopra il modello, il calcolatore tende a non aumentarla nei PAC temporanei; orienta invece il nuovo capitale verso le categorie sotto peso. Quando il portafoglio torna vicino al modello, puoi riprendere il PAC ordinario e ricontrollare periodicamente.
                  </div>
                </div>
              </>
            )}
          </section>
        )}

        {step === "exit" && (
          <section className="space-y-6">
            {!isProPlan ? (
              <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Funzione Pro</p>
                <h2 className="mt-3 text-3xl font-bold tracking-tight">Strategie di uscita dal PAC</h2>
                <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
                  Questa sezione è inclusa nel piano Pro da 59 EUR/anno. Serve quando il capitale è cresciuto e vuoi pianificare come ridurre il rischio, vendere gradualmente o trasformare il capitale in rendita.
                </p>
                <button
                  onClick={requestProUpgrade}
                  className="rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 hover:shadow-md active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isCorePlan ? "Passa a Pro - paghi 30 EUR" : "Vedi piano Pro"}
                </button>
              </div>
            ) : (
              <>
                <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
                  <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Piano Pro</p>
                  <h2 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">Strategia di uscita guidata</h2>
                  <p className="mt-4 max-w-4xl text-base leading-7 text-slate-600">
                    Uscire da un investimento non significa vendere tutto di colpo. Significa trasformare il piano in soldi disponibili, con metodo, tempi chiari e senza farsi guidare dal panico.
                  </p>
                  <div className="mt-5 grid gap-3 md:grid-cols-4">
                    {["Scegli l'obiettivo", "Controlla quando servono i soldi", "Riduci il rischio gradualmente", "Segui una regola scritta"].map((item, index) => (
                      <div key={item} className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4 text-sm leading-6 text-emerald-900">
                        <span className="mb-2 flex h-7 w-7 items-center justify-center rounded-full bg-emerald-600 text-xs font-bold text-white">{index + 1}</span>
                        {item}
                      </div>
                    ))}
                  </div>
                  <div className="mt-6 grid gap-3 md:grid-cols-2">
                    <button
                      type="button"
                      onClick={openExitQuestionnaire}
                      className="rounded-2xl border border-emerald-600 bg-emerald-600 p-5 text-left text-white shadow-sm transition hover:bg-emerald-700"
                    >
                      <span className="block text-sm font-bold">Non so cosa scegliere: guidami</span>
                      <span className="mt-1 block text-xs leading-5 text-emerald-50">Rispondi a poche domande e salva una strategia coerente con la tua situazione.</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setExitMode("manual")}
                      className={`rounded-2xl border p-5 text-left transition ${exitMode === "manual" ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-white"}`}
                    >
                      <span className="block text-sm font-bold">Voglio scegliere io</span>
                      <span className={`mt-1 block text-xs leading-5 ${exitMode === "manual" ? "text-slate-200" : "text-slate-500"}`}>Confronta le strategie, leggi pro e contro e seleziona quella che preferisci.</span>
                    </button>
                  </div>
                </div>

                <div className="rounded-3xl border border-amber-200 bg-gradient-to-br from-amber-50 to-white p-6 shadow-sm">
                  <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-700">Sezione anti-panico</p>
                  <h3 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">Prima di vendere per paura, fermati un minuto</h3>
                  <p className="mt-3 max-w-4xl text-sm leading-6 text-slate-700">
                    Questa sezione serve a frenare le vendite impulsive. Se vuoi uscire solo perché il mercato e sceso, perché hai letto una notizia negativa o perché tutti sembrano preoccupati, potresti decidere nel momento peggiore. Prima chiediti: il mio obiettivo e cambiato? Mi servono davvero quei soldi ora? Ho un piano per cosa fare dopo la vendita?
                  </p>
                  <div className="mt-4 grid gap-3 md:grid-cols-3">
                    <div className="rounded-2xl bg-white p-4 text-sm leading-6 text-slate-700">
                      <strong>Paura</strong><br />
                      Se la scelta nasce dall'ansia, aspetta e rileggi il piano prima di vendere.
                    </div>
                    <div className="rounded-2xl bg-white p-4 text-sm leading-6 text-slate-700">
                      <strong>Bisogno reale</strong><br />
                      Se i soldi servono per un obiettivo concreto, pianifica l'uscita con metodo.
                    </div>
                    <div className="rounded-2xl bg-white p-4 text-sm leading-6 text-slate-700">
                      <strong>Metodo</strong><br />
                      Una vendita graduale e spesso più gestibile di una decisione impulsiva.
                    </div>
                  </div>
                </div>

                <div className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
                  <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                    <h3 className="text-xl font-bold tracking-tight">Dati della simulazione</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-600">Inserisci pochi dati: non servono numeri perfetti. Servono per capire quanto vendere, in quanto tempo e con quali attenzioni.</p>
                    <div className="mt-6 grid gap-4 sm:grid-cols-2">
                      <label className="block"><span className="text-sm font-medium text-slate-700">Capitale investito</span><input type="number" min="0" value={exitInvestedAmount} onChange={(e) => setExitInvestedAmount(e.target.value)} placeholder="Es. 100000" className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400" /><span className="mt-2 block text-xs leading-5 text-slate-500">Quanto hai versato nel tempo. Serve per stimare il guadagno e le eventuali tasse.</span></label>
                      <label className="block"><span className="text-sm font-medium text-slate-700">Valore attuale</span><input type="number" min="0" value={exitCurrentAmount} onChange={(e) => setExitCurrentAmount(e.target.value)} placeholder="Es. 130000" className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400" /><span className="mt-2 block text-xs leading-5 text-slate-500">Quanto vale oggi il capitale che stai valutando di usare o proteggere.</span></label>
                      <label className="block"><span className="text-sm font-medium text-slate-700">Obiettivo finale</span><input type="number" min="0" value={exitGoalAmount} onChange={(e) => setExitGoalAmount(e.target.value)} placeholder="Es. 120000" className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400" /><span className="mt-2 block text-xs leading-5 text-slate-500">La cifra che ti serve davvero. Quando sei vicino, proteggere può contare più di inseguire altro rendimento.</span></label>
                      <label className="block"><span className="text-sm font-medium text-slate-700">Durata uscita graduale</span><input type="number" min="1" value={exitMonths} onChange={(e) => setExitMonths(e.target.value)} placeholder="Es. 12" className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400" /><span className="mt-2 block text-xs leading-5 text-slate-500">In quanti mesi vuoi trasformare il capitale in liquidità. Più mesi = uscita più morbida.</span></label>
                    </div>
                    <div className="mt-5 grid gap-3 sm:grid-cols-2">
                      <MetricCard label="Plusvalenza stimata" value={formatEuro(exitProfit)} />
                      <MetricCard label="Tasse vendita unica" value={formatEuro(exitEstimatedTax)} />
                    </div>
                    <p className="mt-4 rounded-2xl bg-amber-50 p-4 text-xs leading-5 text-amber-900">Nota fiscale: la simulazione usa il 26% sulle plusvalenze in modo semplificato. Costi, minusvalenze, strumenti specifici e regime fiscale possono cambiare il risultato reale.</p>
                  </div>

                  <div className="space-y-6">
                    {savedExitAdvice && (
                      <div className="rounded-3xl border-2 border-emerald-200 bg-emerald-50 p-6 shadow-sm">
                        <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-700">Nostro consiglio salvato</p>
                        <h3 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">{exitStrategyLabels[savedExitAdvice]}</h3>
                        <ul className="mt-4 space-y-2 text-sm leading-6 text-slate-700">
                          {exitAdviceReasons.map((reason) => (<li key={reason}>• {reason}</li>))}
                        </ul>
                      </div>
                    )}
                    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Strategie disponibili</p>
                      <h3 className="mt-2 text-2xl font-bold tracking-tight">Scegli sempre tu</h3>
                      <p className="mt-2 text-sm leading-6 text-slate-600">Il questionario ti orienta, ma la decisione finale resta tua. Leggi quando usarla, pro e contro prima di applicarla.</p>
                      <div className="mt-5 grid gap-3 sm:grid-cols-2">
                        {(Object.keys(exitStrategyLabels) as ExitStrategyKey[]).map((key) => (
                          <button key={key} type="button" onClick={() => setSelectedExitStrategy(key)} className={`rounded-2xl border p-4 text-left transition ${selectedExitStrategy === key ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-white"}`}>
                            <span className="block text-sm font-bold">{exitStrategyLabels[key]}</span>
                            {savedExitAdvice === key && <span className={`mt-1 inline-block rounded-full px-2 py-1 text-[11px] font-bold ${selectedExitStrategy === key ? "bg-white/15 text-white" : "bg-emerald-100 text-emerald-700"}`}>Consigliata</span>}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Strategia selezionata</p>
                      <h3 className="mt-2 text-3xl font-bold tracking-tight">{selectedExitDetails.title}</h3>
                      <p className="mt-3 max-w-4xl text-sm leading-6 text-slate-600">{selectedExitDetails.plain}</p>
                      <p className="mt-3 max-w-4xl rounded-2xl bg-slate-50 p-4 text-sm leading-6 text-slate-700">
                        Lettura semplice: prima capisci perché vuoi uscire, poi scegli il ritmo. Non devi prevedere il mercato: devi sapere quale bisogno stai proteggendo.
                      </p>
                    </div>
                    {savedExitAdvice && selectedExitStrategy !== savedExitAdvice && (
                      <div className="rounded-2xl bg-amber-50 p-4 text-xs leading-5 text-amber-900">Strategia consigliata dal questionario: <strong>{exitStrategyLabels[savedExitAdvice]}</strong>. Puoi comunque scegliere liberamente questa alternativa.</div>
                    )}
                  </div>

                  <div className="mt-6 grid gap-6 lg:grid-cols-3">
                    <div className="rounded-2xl bg-slate-50 p-5">
                      <h4 className="font-bold text-slate-900">Quando usarla</h4>
                      <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-600">{selectedExitDetails.when.map((item) => <li key={item}>• {item}</li>)}</ul>
                    </div>
                    <div className="rounded-2xl bg-emerald-50 p-5">
                      <h4 className="font-bold text-emerald-900">Pro</h4>
                      <ul className="mt-3 space-y-2 text-sm leading-6 text-emerald-900">{selectedExitDetails.pros.map((item) => <li key={item}>• {item}</li>)}</ul>
                    </div>
                    <div className="rounded-2xl bg-rose-50 p-5">
                      <h4 className="font-bold text-rose-900">Contro</h4>
                      <ul className="mt-3 space-y-2 text-sm leading-6 text-rose-900">{selectedExitDetails.cons.map((item) => <li key={item}>• {item}</li>)}</ul>
                    </div>
                  </div>

                  <div className="mt-6 rounded-2xl border border-slate-200 p-5">
                    <h4 className="font-bold text-slate-900">Istruzioni passo dopo passo</h4>
                    <ol className="mt-4 space-y-3 text-sm leading-6 text-slate-700">
                      {selectedExitDetails.steps.map((item, index) => (<li key={item} className="flex gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white">{index + 1}</span><span>{item}</span></li>))}
                    </ol>
                    <div className="mt-5 rounded-2xl bg-emerald-50 p-4 text-sm leading-6 text-emerald-900">
                      <strong>Regola pratica:</strong> se non hai un bisogno immediato, spesso è meglio uscire con calma. Se invece i soldi servono davvero, il primo obiettivo è proteggerli, non cercare l'ultimo punto di rendimento.
                    </div>
                  </div>
                </div>
              </>
            )}
          </section>
        )}



      {showExitQuestionnaireWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-700">Attenzione</p>
            <h3 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">Vuoi rifare il questionario?</h3>
            <p className="mt-3 text-sm leading-6 text-slate-600">Rifare il questionario può modificare la strategia consigliata in base alle nuove risposte. Il consiglio salvato verrà aggiornato, ma potrai comunque scegliere liberamente qualsiasi strategia.</p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <button type="button" onClick={() => setShowExitQuestionnaireWarning(false)} className="rounded-xl border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">Non cambiare</button>
              <button type="button" onClick={() => { setShowExitQuestionnaireWarning(false); setExitQuestionnaireStep(0); setShowExitQuestionnaireModal(true); }} className="rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-700">Prosegui</button>
            </div>
          </div>
        </div>
      )}

      {showExitQuestionnaireModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="w-full max-w-xl rounded-3xl bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Questionario guidato</p>
                <h3 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">Troviamo una strategia coerente</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">Una domanda alla volta. Il risultato ti indica una strada possibile, ma potrai comunque scegliere liberamente qualsiasi strategia.</p>
              </div>
              <button type="button" onClick={() => { setShowExitQuestionnaireModal(false); setExitQuestionnaireStep(0); }} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50">Chiudi</button>
            </div>

            <div className="mt-6">
              <div className="mb-5">
                <div className="flex items-center justify-between text-xs font-bold uppercase tracking-[0.16em] text-slate-500">
                  <span>Domanda {exitQuestionnaireStep + 1} di 4</span>
                  <span>{Math.round(((exitQuestionnaireStep + 1) / 4) * 100)}%</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-slate-900 transition-all" style={{ width: `${((exitQuestionnaireStep + 1) / 4) * 100}%` }} />
                </div>
              </div>

              {exitQuestionnaireStep === 0 && (
                <div>
                  <h4 className="text-xl font-bold text-slate-900">Quando ti serviranno i soldi?</h4>
                  <p className="mt-2 text-sm leading-6 text-slate-600">Serve a capire se ha senso ridurre il rischio rapidamente o mantenere più capitale investito.</p>
                  <div className="mt-5 grid gap-3">
                    {[
                      { key: "entro1", label: "Entro 1 anno", hint: "Priorita alla protezione del capitale." },
                      { key: "unoTre", label: "Tra 1 e 3 anni", hint: "Equilibrio tra uscita graduale e rischio." },
                      { key: "oltreTre", label: "Tra più di 3 anni", hint: "Può avere senso una strategia più flessibile." },
                    ].map((item) => (
                      <button key={item.key} type="button" onClick={() => { setExitHorizon(item.key as "entro1" | "unoTre" | "oltreTre"); setExitQuestionnaireStep(1); }} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-left transition hover:border-slate-300 hover:bg-white">
                        <span className="block font-bold text-slate-900">{item.label}</span>
                        <span className="mt-1 block text-sm text-slate-500">{item.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {exitQuestionnaireStep === 1 && (
                <div>
                  <h4 className="text-xl font-bold text-slate-900">Cosa ti preoccupa di più?</h4>
                  <p className="mt-2 text-sm leading-6 text-slate-600">La strategia cambia molto se vuoi ridurre lo stress, proteggere i guadagni o creare rendita.</p>
                  <div className="mt-5 grid gap-3">
                    {[
                      { key: "timing", label: "Vendere nel momento sbagliato", hint: "Meglio evitare una vendita unica." },
                      { key: "guadagni", label: "Perdere i guadagni fatti", hint: "Meglio usare regole chiare di protezione." },
                      { key: "rendita", label: "Creare una rendita costante", hint: "Potrebbe essere adatta una bucket strategy." },
                      { key: "tasse", label: "Pagare troppe tasse subito", hint: "Meglio ragionare su uscite progressive." },
                    ].map((item) => (
                      <button key={item.key} type="button" onClick={() => { setExitMainConcern(item.key as "timing" | "guadagni" | "rendita" | "tasse"); setExitQuestionnaireStep(2); }} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-left transition hover:border-slate-300 hover:bg-white">
                        <span className="block font-bold text-slate-900">{item.label}</span>
                        <span className="mt-1 block text-sm text-slate-500">{item.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {exitQuestionnaireStep === 2 && (
                <div>
                  <h4 className="text-xl font-bold text-slate-900">Qual è l'obiettivo principale?</h4>
                  <p className="mt-2 text-sm leading-6 text-slate-600">Collegare l'uscita a un obiettivo reale rende la scelta più semplice.</p>
                  <div className="mt-5 grid gap-3">
                    {[
                      { key: "spesa", label: "Spesa precisa / casa / progetto", hint: "Conta arrivare a una cifra concreta." },
                      { key: "pensione", label: "Pensione o rendita", hint: "Conta trasformare capitale in entrate stabili." },
                      { key: "protezione", label: "Proteggere capitale", hint: "Conta ridurre volatilità e stress." },
                      { key: "rendimento", label: "Massimizzare rendimento", hint: "Conta lasciare spazio alla crescita." },
                    ].map((item) => (
                      <button key={item.key} type="button" onClick={() => { setExitLifeGoal(item.key as "spesa" | "pensione" | "protezione" | "rendimento"); setExitQuestionnaireStep(3); }} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-left transition hover:border-slate-300 hover:bg-white">
                        <span className="block font-bold text-slate-900">{item.label}</span>
                        <span className="mt-1 block text-sm text-slate-500">{item.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {exitQuestionnaireStep === 3 && (
                <div>
                  <h4 className="text-xl font-bold text-slate-900">Se il mercato scende del 10%, cosa preferisci?</h4>
                  <p className="mt-2 text-sm leading-6 text-slate-600">Questa risposta aiuta a scegliere una strategia che puoi seguire senza farti prendere dall'emotività.</p>
                  <div className="mt-5 grid gap-3">
                    {[
                      { key: "sicura", label: "Prelevo dalla parte sicura", hint: "Adatto a chi vuole evitare di vendere azioni in ribasso." },
                      { key: "graduale", label: "Continuo con vendite graduali", hint: "Adatto a chi vuole semplicità e disciplina." },
                      { key: "aspettare", label: "Aspetto senza vendere", hint: "Adatto a chi accetta oscillazioni." },
                      { key: "regole", label: "Seguo regole già decise", hint: "Adatto a chi vuole automatizzare le decisioni." },
                    ].map((item) => (
                      <button key={item.key} type="button" onClick={() => completeExitQuestionnaireWith(item.key as "sicura" | "graduale" | "aspettare" | "regole")} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-left transition hover:border-slate-300 hover:bg-white">
                        <span className="block font-bold text-slate-900">{item.label}</span>
                        <span className="mt-1 block text-sm text-slate-500">{item.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="mt-6 flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
              <button type="button" disabled={exitQuestionnaireStep === 0} onClick={() => setExitQuestionnaireStep((prev) => Math.max(0, prev - 1))} className="rounded-xl border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40">Indietro</button>
              <p className="text-right text-xs leading-5 text-slate-500">Il consiglio viene salvato alla fine dell'ultima domanda.</p>
            </div>
          </div>
        </div>
      )}

        <div className="mt-8 rounded-3xl border border-slate-200 bg-white p-5 text-xs leading-6 text-slate-500 shadow-sm">
          {LEGAL_DISCLAIMER}
          <button
            onClick={startQuizFlow}
            className="ml-3 rounded-lg border border-slate-200 px-3 py-1.5 text-slate-600 transition hover:bg-slate-50"
          >
            Rifai test
          </button>
        </div>
      </div>
    </main>
  );

}

function CelebrationOverlay({
  celebration,
  onClose,
}: {
  celebration: CelebrationEvent | null;
  onClose: () => void;
}) {
  if (!celebration) return null;

  const isGoal = celebration.kind === "goal";
  const isTitle = celebration.kind === "title";

  if (!isGoal) {
    return (
      <div className="pointer-events-none fixed left-1/2 top-5 z-[80] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 sm:top-7">
        <div className="rounded-[1.75rem] border border-emerald-200 bg-emerald-50 p-4 shadow-2xl shadow-emerald-950/15 ring-1 ring-emerald-100 sm:p-5">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white text-3xl shadow-sm ring-1 ring-emerald-100 sm:h-16 sm:w-16">
              {celebration.icon}
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-emerald-700">
                {isTitle ? "Nuovo titolo sbloccato" : "Nuovo traguardo"}
              </p>
              <h3 className="mt-1 text-base font-black text-slate-950 sm:text-lg">{celebration.title}</h3>
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-700 sm:text-sm">{celebration.subtitle}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/75 px-4 py-6 backdrop-blur-md">
      <div className="w-full max-w-2xl overflow-hidden rounded-[2rem] border border-emerald-200/30 bg-gradient-to-br from-slate-950 via-emerald-950 to-slate-900 text-white shadow-2xl">
        <div className="relative p-6 sm:p-8">
          <div className="absolute -right-16 -top-16 h-48 w-48 rounded-full bg-emerald-400/30 blur-3xl" />
          <div className="absolute -bottom-20 left-8 h-44 w-44 rounded-full bg-sky-400/20 blur-3xl" />
          <div className="absolute left-1/2 top-0 h-px w-3/4 -translate-x-1/2 bg-gradient-to-r from-transparent via-emerald-300/80 to-transparent" />

          <div className="relative">
            <div className="flex items-start gap-4">
              <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-3xl bg-emerald-400/15 text-4xl ring-1 ring-emerald-200/30">
                {celebration.icon}
              </div>
              <div>
                <p className="text-xs font-black uppercase tracking-[0.24em] text-emerald-300">
                  Obiettivo personale raggiunto
                </p>
                <h3 className="mt-2 text-2xl font-black tracking-tight sm:text-4xl">{celebration.title}</h3>
              </div>
            </div>

            <div className="mt-6 rounded-3xl bg-white/10 p-5 ring-1 ring-white/10">
              <p className="text-base leading-7 text-slate-100 sm:text-lg">{celebration.subtitle}</p>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl bg-white/10 p-4 ring-1 ring-white/10">
                <p className="text-xs font-black uppercase tracking-[0.18em] text-emerald-200">Metodo</p>
                <p className="mt-1 text-sm text-slate-200">Hai seguito un percorso, non un impulso.</p>
              </div>
              <div className="rounded-2xl bg-white/10 p-4 ring-1 ring-white/10">
                <p className="text-xs font-black uppercase tracking-[0.18em] text-emerald-200">Costanza</p>
                <p className="mt-1 text-sm text-slate-200">Hai continuato anche quando era più facile rimandare.</p>
              </div>
              <div className="rounded-2xl bg-white/10 p-4 ring-1 ring-white/10">
                <p className="text-xs font-black uppercase tracking-[0.18em] text-emerald-200">Risultato</p>
                <p className="mt-1 text-sm text-slate-200">Questo traguardo racconta una scelta mantenuta nel tempo.</p>
              </div>
            </div>

            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="inline-flex rounded-full bg-emerald-400/15 px-4 py-2 text-xs font-black text-emerald-200 ring-1 ring-emerald-300/20">
                Prenditi un momento: questo risultato merita di essere celebrato.
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-2xl bg-emerald-500 px-5 py-3 text-sm font-black text-white shadow-lg shadow-emerald-900/30 transition hover:bg-emerald-600"
              >
                Continua il tuo percorso
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


function AdminDashboard({
  overview,
  loading,
  message,
  resetConfirm,
  resetLoading,
  onResetConfirmChange,
  onRefresh,
  onReset,
  onExitAdmin,
}: {
  overview: AdminOverview | null;
  loading: boolean;
  message: string;
  resetConfirm: string;
  resetLoading: boolean;
  onResetConfirmChange: (value: string) => void;
  onRefresh: () => void;
  onReset: () => void;
  onExitAdmin: () => void;
}) {
  const totals = overview?.totals || {};
  const purchases = overview?.purchases || {};
  const usage = overview?.usage || {};
  const mortgage = overview?.mortgage || {};
  const anomalies = overview?.anomalies || [];
  const events = overview?.events || [];
  const marketing = overview?.marketing || {};
  const referrals = overview?.referrals || [];
  const discountCodes = overview?.discount_codes || [];

  const stat = (obj: Record<string, number>, key: string) => Number(obj[key] || 0);

  return (
    <section className="space-y-6">
      <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="grid gap-0 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="p-6 md:p-8">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-700">Area riservata</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-950 md:text-4xl">Plancia admin</h2>
            <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
              Vista interna per leggere rapidamente dati, utilizzo, piani e anomalie. È protetta lato app e deve essere protetta anche lato Supabase con le funzioni admin dedicate.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={onRefresh}
                disabled={loading}
                className="rounded-xl bg-emerald-600 px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? "Aggiorno..." : "Aggiorna dati"}
              </button>
              <button
                type="button"
                onClick={onExitAdmin}
                className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-bold text-slate-700 transition hover:bg-slate-50"
              >
                Usa app come utente
              </button>
            </div>
          </div>
          <div className="border-t border-slate-200 bg-slate-50 p-6 md:p-8 lg:border-l lg:border-t-0">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Ultimo aggiornamento</p>
            <p className="mt-3 text-2xl font-black text-slate-950">
              {overview?.generated_at ? new Date(overview.generated_at).toLocaleString("it-IT") : "Da caricare"}
            </p>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              Se vedi pochi dati o zeri inattesi, controlla che lo script SQL admin sia stato eseguito su Supabase.
            </p>
          </div>
        </div>
      </div>

      {message && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold leading-6 text-amber-900">
          {message}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <AdminStatCard icon="👥" title="Utenti registrati" value={stat(totals, "registered_users")} note={`${stat(totals, "confirmed_users")} email confermate`} />
        <AdminStatCard icon="✅" title="Onboarding completati" value={stat(totals, "profiles_completed")} note="Profili con modello salvato" />
        <AdminStatCard icon="💳" title="Piani attivi" value={stat(purchases, "active_total")} note={`${stat(purchases, "core_active")} Core · ${stat(purchases, "pro_active")} Pro`} />
        <AdminStatCard icon="🏠" title="Verifiche mutuo" value={stat(mortgage, "saved_checks")} note={`${stat(mortgage, "pies_reports")} report/email tracciati`} />
        <AdminStatCard icon="🔗" title="Referral / promo" value={stat(marketing, "referral_visits") + stat(marketing, "discount_code_views")} note={`${stat(marketing, "marketing_purchases")} acquisti attribuiti`} />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">Piani e acquisti</p>
              <h3 className="mt-2 text-2xl font-black text-slate-950">Stato commerciale</h3>
            </div>
            <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-800 ring-1 ring-emerald-200">Supabase</span>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <AdminMiniRow label="Core attivi" value={stat(purchases, "core_active")} />
            <AdminMiniRow label="Pro attivi" value={stat(purchases, "pro_active")} />
            <AdminMiniRow label="Upgrade Core → Pro" value={stat(purchases, "upgrades")} />
            <AdminMiniRow label="Piani scaduti" value={stat(purchases, "expired")} />
            <AdminMiniRow label="Scadenza mancante" value={stat(purchases, "missing_expiry")} />
            <AdminMiniRow label="Sbloccati senza piano" value={stat(purchases, "unlocked_without_plan")} />
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">Utilizzo funzioni</p>
          <h3 className="mt-2 text-2xl font-black text-slate-950">Segnali rapidi</h3>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <AdminMiniRow label="Investimenti registrati" value={stat(usage, "holdings")} />
            <AdminMiniRow label="PAC segnati" value={stat(usage, "pac_completed")} />
            <AdminMiniRow label="Azioni risparmio" value={stat(usage, "awareness_completed")} />
            <AdminMiniRow label="Voci lista spesa" value={stat(usage, "shopping_items")} />
            <AdminMiniRow label="Strumenti personalizzati" value={stat(usage, "custom_instruments")} />
            <AdminMiniRow label="Eventi tracciati" value={stat(usage, "events")} />
          </div>
        </div>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">Referral e codici sconto</p>
            <h3 className="mt-2 text-2xl font-black text-slate-950">Lettura marketing privata</h3>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
              Qui vedrai quanto vengono usati i link partner e i codici promo: visite, registrazioni, acquisti Core/Pro e valore attribuito. I dati iniziano a popolarsi quando un link contiene parametri come <span className="font-bold text-slate-800">?ref=partner</span> o <span className="font-bold text-slate-800">?promo=LANCIO20</span>.
            </p>
          </div>
          <div className="grid w-full gap-3 sm:grid-cols-3 lg:max-w-xl">
            <AdminMiniRow label="Visite referral" value={stat(marketing, "referral_visits")} />
            <AdminMiniRow label="Codici visti" value={stat(marketing, "discount_code_views")} />
            <AdminMiniRow label="Acquisti attribuiti" value={stat(marketing, "marketing_purchases")} />
          </div>
        </div>

        <div className="mt-6 grid gap-6 xl:grid-cols-2">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Referral / partner</p>
            <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200">
              {referrals.length ? referrals.slice(0, 8).map((row) => (
                <AdminMarketingRow
                  key={row.code}
                  title={row.partner_name || row.code}
                  subtitle={row.partner_name ? row.code : "Link referral"}
                  visits={row.visits}
                  purchases={row.purchases}
                  core={row.core_purchases}
                  pro={row.pro_purchases}
                  revenue={row.revenue}
                  extra={`${row.signups} registrazioni`}
                />
              )) : (
                <p className="bg-slate-50 p-4 text-sm leading-6 text-slate-600">Nessun referral tracciato. Esempio link futuro: <span className="font-bold text-slate-800">?ref=studio-rossi</span>.</p>
              )}
            </div>
          </div>

          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Codici sconto / promo</p>
            <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200">
              {discountCodes.length ? discountCodes.slice(0, 8).map((row) => (
                <AdminMarketingRow
                  key={row.code}
                  title={row.code}
                  subtitle={row.description || "Codice promo"}
                  visits={row.visits}
                  purchases={row.purchases}
                  core={row.core_purchases}
                  pro={row.pro_purchases}
                  revenue={row.revenue}
                  extra={row.discount_type ? `${row.discount_type}${row.discount_value ? ` · ${row.discount_value}` : ""}` : ""}
                />
              )) : (
                <p className="bg-slate-50 p-4 text-sm leading-6 text-slate-600">Nessun codice promo tracciato. Esempio link futuro: <span className="font-bold text-slate-800">?promo=LANCIO20</span>.</p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">Anomalie</p>
          <h3 className="mt-2 text-2xl font-black text-slate-950">Controlli da guardare</h3>
          <div className="mt-5 space-y-3">
            {anomalies.length ? anomalies.map((row, index) => (
              <div key={`${row.label}-${index}`} className={`rounded-2xl border p-4 ${row.severity === "danger" ? "border-red-200 bg-red-50 text-red-900" : row.severity === "warning" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200 bg-slate-50 text-slate-700"}`}>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-black">{row.label}</p>
                  <p className="text-xl font-black">{row.value}</p>
                </div>
              </div>
            )) : (
              <p className="rounded-2xl bg-slate-50 p-4 text-sm leading-6 text-slate-600">Nessuna anomalia rilevata o funzione admin non ancora configurata.</p>
            )}
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">Eventi principali</p>
          <h3 className="mt-2 text-2xl font-black text-slate-950">Ultimi dati tracking</h3>
          <div className="mt-5 space-y-3">
            {events.length ? events.slice(0, 10).map((event) => (
              <div key={event.event_name} className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm font-bold text-slate-700">{event.event_name}</p>
                <p className="text-lg font-black text-slate-950">{event.count}</p>
              </div>
            )) : (
              <p className="rounded-2xl bg-slate-50 p-4 text-sm leading-6 text-slate-600">Nessun evento disponibile. Il tracking parte quando gli utenti usano l'app.</p>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-3xl border border-red-200 bg-red-50 p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-red-700">Reset dati test</p>
            <h3 className="mt-2 text-2xl font-black text-red-950">Azzera i dati applicativi</h3>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-red-900">
              Usa questo comando solo durante i test. Cancella dati applicativi, acquisti, eventi, obiettivi, mutui, lista spesa, strumenti e checklist. Non cancella gli account Auth e non rimuove l'utente admin.
            </p>
          </div>
          <div className="w-full max-w-sm shrink-0 space-y-3">
            <input
              value={resetConfirm}
              onChange={(e) => onResetConfirmChange(e.target.value)}
              placeholder="Scrivi AZZERA per confermare"
              className="w-full rounded-xl border border-red-200 bg-white px-4 py-3 text-sm font-semibold text-red-950 outline-none focus:border-red-400"
            />
            <button
              type="button"
              onClick={onReset}
              disabled={resetLoading || resetConfirm.trim().toUpperCase() !== "AZZERA"}
              className="w-full rounded-xl bg-red-600 px-5 py-3 text-sm font-black text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {resetLoading ? "Reset in corso..." : "Azzera dati di test"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}


function AdminMarketingRow({
  title,
  subtitle,
  visits,
  purchases,
  core,
  pro,
  revenue,
  extra,
}: {
  title: string;
  subtitle: string;
  visits: number;
  purchases: number;
  core: number;
  pro: number;
  revenue: number;
  extra?: string;
}) {
  return (
    <div className="border-b border-slate-200 bg-white p-4 last:border-b-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="truncate text-sm font-black text-slate-950">{title}</p>
          <p className="mt-1 truncate text-xs font-semibold text-slate-500">{subtitle}</p>
          {extra && <p className="mt-1 text-xs text-slate-400">{extra}</p>}
        </div>
        <p className="text-sm font-black text-emerald-700">{revenue.toLocaleString("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 })}</p>
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2 text-center">
        <div className="rounded-xl bg-slate-50 p-2"><p className="text-xs text-slate-500">Visite</p><p className="font-black text-slate-900">{visits}</p></div>
        <div className="rounded-xl bg-slate-50 p-2"><p className="text-xs text-slate-500">Acquisti</p><p className="font-black text-slate-900">{purchases}</p></div>
        <div className="rounded-xl bg-slate-50 p-2"><p className="text-xs text-slate-500">Core</p><p className="font-black text-slate-900">{core}</p></div>
        <div className="rounded-xl bg-slate-50 p-2"><p className="text-xs text-slate-500">Pro</p><p className="font-black text-slate-900">{pro}</p></div>
      </div>
    </div>
  );
}

function AdminStatCard({ icon, title, value, note }: { icon: string; title: string; value: number; note: string }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-2xl ring-1 ring-emerald-100">{icon}</div>
      <p className="mt-4 text-sm font-semibold uppercase tracking-[0.14em] text-slate-500">{title}</p>
      <p className="mt-2 text-3xl font-black text-slate-950">{value}</p>
      <p className="mt-1 text-sm leading-6 text-slate-500">{note}</p>
    </div>
  );
}

function AdminMiniRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-sm font-semibold text-slate-600">{label}</p>
      <p className="text-xl font-black text-slate-950">{value}</p>
    </div>
  );
}

function TopBar({
  step,
  unlocked,
  isProPlan,
  userEmail,
  onGoHome,
  onGoPortfolio,
  onGoGuide,
  onGoAwareness,
  onGoStrumentis,
  onGoDashboard,
  onGoDashboardTab,
  onGoAwarenessTab,
  onGoShoppingList,
  onGoRebalance,
  onGoExit,
  isAdminAccount,
  onGoAdmin,
  onLogout,
  onOpenProfile,
  onResetProfile,
  resetLoading,
}: {
  step: AppStep;
  unlocked: boolean;
  isProPlan: boolean;
  userEmail: string;
  onGoHome: () => void;
  onGoPortfolio: () => void;
  onGoGuide: () => void;
  onGoAwareness: () => void;
  onGoStrumentis: () => void;
  onGoDashboard: () => void;
  onGoDashboardTab: (tab: DashboardTab) => void;
  onGoAwarenessTab: (tab: AwarenessTab) => void;
  onGoShoppingList: () => void;
  onGoRebalance: () => void;
  onGoExit: () => void;
  isAdminAccount: boolean;
  onGoAdmin: () => void;
  onLogout: () => void;
  onOpenProfile: () => void;
  onResetProfile: () => void;
  resetLoading: boolean;
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileDashboardOpen, setMobileDashboardOpen] = useState(false);
  const [mobileAwarenessOpen, setMobileAwarenessOpen] = useState(false);

  const closeMobileMenu = () => setMobileMenuOpen(false);
  const runMobileAction = (action: () => void) => {
    action();
    closeMobileMenu();
  };

  const dashboardMobileItems: Array<{ id: DashboardTab; label: string; icon: string; description: string }> = [
    { id: "monitor", label: "Monitor", icon: "📊", description: "Stato generale, piano e PAC." },
    { id: "guida", label: "Guida", icon: "🧭", description: "Passi iniziali e azioni operative." },
    { id: "portafoglio", label: "Portafoglio", icon: "💼", description: "Investimenti, ripartizione e strumenti." },
    { id: "progressi", label: "Progressi", icon: "🏅", description: "Badge e avanzamento." },
  ];

  const awarenessMobileItems: Array<{ id: AwarenessTab; label: string; icon: string; description: string }> = [
    { id: "risparmio", label: "Risparmio", icon: "💶", description: "Azioni pratiche e spesa intelligente." },
    { id: "auto", label: "Auto", icon: "🚗", description: "Costo reale e finanziamento." },
    { id: "mutuo", label: "Mutuo", icon: "🏠", description: "Sostenibilità e Verifica PIES." },
    { id: "truffe", label: "Anti-truffe", icon: "🛡️", description: "Motore e mini gioco." },
  ];

  return (
    <>
      <header className="mb-5 flex w-full min-w-0 flex-row items-center justify-between gap-3 rounded-3xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-500">Soldi Semplici</p>
          <p className="truncate text-sm text-slate-400">{userEmail}</p>
        </div>

        <nav className="hidden flex-wrap items-center gap-2 lg:flex">
          {!unlocked && <NavButton active={step === "home"} onClick={onGoHome}>Home</NavButton>}
          {unlocked && (
            <>
              <NavButton active={step === "portfolio"} onClick={onGoPortfolio}>Modello</NavButton>
              <NavButton active={step === "dashboard"} onClick={onGoDashboard}>Dashboard</NavButton>
              <NavButton active={step === "awareness"} onClick={onGoAwareness}>Consapevolezza</NavButton>
              <NavButton active={step === "rebalance"} onClick={onGoRebalance}>Ribilanciamento</NavButton>
              <NavButton active={step === "exit"} onClick={onGoExit}>Strategia uscita</NavButton>
              {isAdminAccount && <NavButton active={step === "admin"} onClick={onGoAdmin}>Admin</NavButton>}
            </>
          )}
          <button
            onClick={onOpenProfile}
            className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-black text-emerald-800 shadow-sm transition hover:border-emerald-300 hover:bg-emerald-100"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-white text-xs shadow-sm">👤</span>
            <span>Profilo</span>
          </button>
        </nav>

        <button
          type="button"
          onClick={() => setMobileMenuOpen(true)}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-800 shadow-sm transition hover:bg-slate-50 lg:hidden"
          aria-label="Apri menu"
        >
          <span className="flex flex-col gap-1.5">
            <span className="block h-0.5 w-5 rounded-full bg-slate-800" />
            <span className="block h-0.5 w-5 rounded-full bg-slate-800" />
            <span className="block h-0.5 w-5 rounded-full bg-slate-800" />
          </span>
        </button>
      </header>

      {mobileMenuOpen && (
        <div className="fixed inset-0 z-[70] lg:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            className="absolute inset-0 bg-slate-950/45"
            aria-label="Chiudi menu"
            onClick={closeMobileMenu}
          />
          <aside className="absolute right-0 top-0 flex h-full w-[min(92vw,390px)] flex-col overflow-y-auto bg-white shadow-2xl">
            <div className="border-b border-slate-200 bg-gradient-to-br from-emerald-700 to-emerald-500 p-5 text-white">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-xl font-black text-emerald-700 shadow-sm">S</div>
                  <p className="mt-3 text-lg font-black tracking-tight">Soldi Semplici</p>
                  <p className="mt-1 text-xs font-bold uppercase tracking-[0.18em] text-emerald-100">La tua finanza. In modo semplice.</p>
                </div>
                <button
                  type="button"
                  onClick={closeMobileMenu}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-white/15 text-2xl font-light text-white transition hover:bg-white/25"
                  aria-label="Chiudi menu"
                >
                  ×
                </button>
              </div>
              <div className="mt-4 rounded-2xl bg-white/12 p-3 ring-1 ring-white/15">
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-100">Account</p>
                <p className="mt-1 truncate text-sm font-bold text-white">{userEmail}</p>
                <p className="mt-1 text-xs text-emerald-50">Piano e sicurezza sono nella voce Profilo.</p>
              </div>
            </div>

            <div className="flex-1 space-y-3 p-4">
              {!unlocked && (
                <MobileDrawerItem
                  active={step === "home"}
                  icon="🏠"
                  label="Home"
                  description="Torna alla schermata iniziale."
                  onClick={() => runMobileAction(onGoHome)}
                />
              )}

              {unlocked && (
                <>
                  <MobileDrawerItem
                    active={step === "portfolio"}
                    icon="📐"
                    label="Modello"
                    description="Rivedi il modello scelto e il piano attivo."
                    onClick={() => runMobileAction(onGoPortfolio)}
                  />

                  <MobileDrawerGroupButton
                    active={step === "dashboard"}
                    open={mobileDashboardOpen}
                    icon="📊"
                    label="Dashboard"
                    description="Apri le card operative della Dashboard."
                    onClick={() => {
                      setMobileDashboardOpen((value) => !value);
                      setMobileAwarenessOpen(false);
                    }}
                  />
                  {mobileDashboardOpen && (
                    <div className="space-y-2 pl-4">
                      {dashboardMobileItems.map((item) => (
                        <MobileDrawerSubItem
                          key={item.id}
                          icon={item.icon}
                          label={item.label}
                          description={item.description}
                          onClick={() => runMobileAction(() => onGoDashboardTab(item.id))}
                        />
                      ))}
                    </div>
                  )}

                  <MobileDrawerGroupButton
                    active={step === "awareness"}
                    open={mobileAwarenessOpen}
                    icon="🧠"
                    label="Consapevolezza"
                    description="Scegli la scheda da aprire."
                    onClick={() => {
                      setMobileAwarenessOpen((value) => !value);
                      setMobileDashboardOpen(false);
                    }}
                  />
                  {mobileAwarenessOpen && (
                    <div className="space-y-2 pl-4">
                      {awarenessMobileItems.map((item) => (
                        <MobileDrawerSubItem
                          key={item.id}
                          icon={item.icon}
                          label={item.label}
                          description={item.description}
                          onClick={() => runMobileAction(() => onGoAwarenessTab(item.id))}
                        />
                      ))}
                      <MobileDrawerSubItem
                        icon="🛒"
                        label="Lista spesa"
                        description="Crea e spunta la lista mentre fai la spesa."
                        onClick={() => runMobileAction(onGoShoppingList)}
                      />
                    </div>
                  )}

                  <MobileDrawerItem
                    active={step === "rebalance"}
                    icon="⚖️"
                    label="Ribilanciamento"
                    description="Valuta se il portafoglio si è allontanato dal modello."
                    onClick={() => runMobileAction(onGoRebalance)}
                  />

                  <MobileDrawerItem
                    active={step === "exit"}
                    icon="🚪"
                    label="Strategia uscita"
                    description="Gestisci le decisioni nei momenti delicati."
                    onClick={() => runMobileAction(onGoExit)}
                  />

                  {isAdminAccount && (
                    <MobileDrawerItem
                      active={step === "admin"}
                      icon="🛠️"
                      label="Admin"
                      description="Plancia interna riservata a Tiziano."
                      onClick={() => runMobileAction(onGoAdmin)}
                    />
                  )}
                </>
              )}
            </div>

            <div className="border-t border-slate-200 p-4">
              <button
                type="button"
                onClick={() => runMobileAction(onOpenProfile)}
                className="w-full rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-left shadow-sm transition hover:border-emerald-300 hover:bg-emerald-100"
              >
                <span className="flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white text-lg shadow-sm">👤</span>
                  <span>
                    <span className="block text-sm font-black text-emerald-900">Profilo</span>
                    <span className="mt-1 block text-xs font-semibold text-emerald-700">Piano, password e logout</span>
                  </span>
                </span>
              </button>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}

function MobileDrawerItem({
  active,
  icon,
  label,
  description,
  onClick,
}: {
  active?: boolean;
  icon: string;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-2xl border p-4 text-left transition ${
        active ? "border-emerald-200 bg-emerald-50 text-emerald-950" : "border-slate-200 bg-white text-slate-900 hover:bg-slate-50"
      }`}
    >
      <div className="flex items-start gap-3">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-lg ${active ? "bg-emerald-600 text-white" : "bg-slate-100"}`}>{icon}</span>
        <span>
          <span className="block text-sm font-black">{label}</span>
          <span className="mt-1 block text-xs leading-5 text-slate-500">{description}</span>
        </span>
      </div>
    </button>
  );
}

function MobileDrawerGroupButton({
  active,
  open,
  icon,
  label,
  description,
  onClick,
}: {
  active?: boolean;
  open: boolean;
  icon: string;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-2xl border p-4 text-left transition ${
        active || open ? "border-emerald-200 bg-emerald-50 text-emerald-950" : "border-slate-200 bg-white text-slate-900 hover:bg-slate-50"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-lg ${active || open ? "bg-emerald-600 text-white" : "bg-slate-100"}`}>{icon}</span>
          <span>
            <span className="block text-sm font-black">{label}</span>
            <span className="mt-1 block text-xs leading-5 text-slate-500">{description}</span>
          </span>
        </div>
        <span className={`mt-1 text-lg font-black transition ${open ? "rotate-90" : ""}`}>›</span>
      </div>
    </button>
  );
}

function MobileDrawerSubItem({
  icon,
  label,
  description,
  onClick,
}: {
  icon: string;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-2xl border border-slate-200 bg-slate-50 p-3 text-left transition hover:border-emerald-200 hover:bg-emerald-50"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-base shadow-sm">{icon}</span>
        <span>
          <span className="block text-sm font-black text-slate-900">{label}</span>
          <span className="mt-0.5 block text-xs leading-5 text-slate-500">{description}</span>
        </span>
      </div>
    </button>
  );
}

function NavButton({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-xl px-4 py-2 text-sm font-medium transition ${
        active ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
      }`}
    >
      {children}
    </button>
  );
}

function PortfolioPieChart({ composition }: { composition: PortfolioTemplate["composition"] }) {
  let current = 0;
  const gradient = composition
    .map((item) => {
      const start = current;
      const end = current + item.percentage;
      current = end;
      return `${getAssetColor(item.category)} ${start}% ${end}%`;
    })
    .join(", ");

  return (
    <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">Suddivisione del modello</h3>
      <div className="mt-6 flex flex-col items-center gap-6 sm:flex-row sm:items-center">
        <div
          className="h-56 w-56 shrink-0 rounded-full border border-slate-200 shadow-inner"
          style={{ background: `conic-gradient(${gradient})` }}
          aria-label="Grafico a torta del modello educativo"
        />
        <div className="w-full space-y-2">
          {composition.map((item) => (
            <div key={item.label} className="flex items-center justify-between rounded-xl bg-white px-3 py-2 text-sm">
              <span className="flex items-center gap-2 text-slate-700">
                <span className="h-3 w-3 rounded-full" style={{ backgroundColor: getAssetColor(item.category) }} />
                {item.label}
              </span>
              <span className="font-semibold text-slate-900">{item.percentage}%</span>
            </div>
          ))}
        </div>
      </div>
      <p className="mt-5 text-xs leading-5 text-slate-500">
        Colori: rosso azionario, blu obbligazioni, giallo oro, grigio materie prime, verde liquidità.
      </p>
    </div>
  );
}


function SoldiSempliciLogo({
  size = "compact",
  showTagline = false,
  className = "",
}: {
  size?: "compact" | "large";
  showTagline?: boolean;
  className?: string;
}) {
  const isLarge = size === "large";

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <div
        className={`grid shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-700 shadow-sm ${
          isLarge ? "h-16 w-16" : "h-12 w-12"
        }`}
      >
        <svg viewBox="0 0 96 96" aria-hidden="true" className={isLarge ? "h-12 w-12" : "h-9 w-9"}>
          <path
            d="M70 18C59 9 41 8 27 17C12 27 8 48 18 64C28 81 51 87 68 76"
            fill="none"
            stroke="white"
            strokeWidth="7.5"
            strokeLinecap="round"
            opacity="0.95"
          />
          <path
            d="M61 69C71 64 77 55 80 44"
            fill="none"
            stroke="white"
            strokeWidth="7.5"
            strokeLinecap="round"
            opacity="0.95"
          />
          <path d="M80 44L88 57L73 55Z" fill="white" opacity="0.95" />
          <text
            x="48"
            y="62"
            textAnchor="middle"
            fontSize="47"
            fontWeight="900"
            fontFamily="Inter, Arial, sans-serif"
            fill="white"
          >
            S
          </text>
        </svg>
      </div>
      <div className="leading-none">
        <div className={`${isLarge ? "text-3xl md:text-4xl" : "text-xl"} font-extrabold tracking-tight text-slate-950`}>
          <span>soldi </span>
          <span className="text-emerald-600">semplici</span>
        </div>
        {showTagline ? (
          <p className="mt-2 text-xs font-bold uppercase tracking-[0.28em] text-slate-500">
            La tua finanza. <span className="text-emerald-600">In modo semplice.</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}

function FeatureCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
      <h3 className="font-semibold text-slate-900">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-slate-600">{text}</p>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 shadow-sm h-full flex flex-col justify-between">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 truncate">{label}</p>
      <p className="mt-2 text-lg font-bold tracking-tight text-slate-900 break-words">{value}</p>
    </div>
  );
}


function PlanValidityBox({
  purchase,
  compact = false,
  context = "dashboard",
}: {
  purchase: PurchaseState;
  compact?: boolean;
  context?: "dashboard" | "paywall" | "pro";
}) {
  const status = getPurchaseStatusCopy(purchase);
  const tone = status.isActive ? "emerald" : "amber";
  const days = status.days ?? 0;

  return (
    <div className={`rounded-3xl border p-5 shadow-sm ${tone === "emerald" ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className={`text-xs font-bold uppercase tracking-[0.2em] ${tone === "emerald" ? "text-emerald-700" : "text-amber-700"}`}>Validità piano</p>
          <h3 className="mt-2 text-xl font-black tracking-tight text-slate-950">{status.statusLabel}</h3>
          <p className="mt-1 text-sm leading-6 text-slate-700">
            {status.isActive ? <>Valido fino al <strong>{status.expiresLabel}</strong>.</> : <>Scadenza: <strong>{status.expiresLabel}</strong>.</>}
          </p>
          {!compact && context === "paywall" && purchase.plan === "core" && status.isActive && (
            <p className="mt-2 text-sm leading-6 text-slate-700">
              Passando a Pro oggi paghi 30 EUR e il piano Pro riparte per 365 giorni dalla data di upgrade.
            </p>
          )}
          {!compact && context === "pro" && purchase.plan === "core" && status.isActive && (
            <p className="mt-2 text-sm leading-6 text-slate-700">
              Hai Core attivo: puoi passare a Pro pagando solo la differenza. Il Pro sarà valido per 365 giorni dall'upgrade.
            </p>
          )}
        </div>
        <div className="rounded-2xl bg-white px-5 py-4 text-center shadow-sm ring-1 ring-white/70">
          <p className="text-3xl font-black tracking-tight text-slate-950">{days}</p>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">giorni rimasti</p>
        </div>
      </div>
    </div>
  );
}

function PremiumStatCard({
  eyebrow,
  value,
  note,
}: {
  eyebrow: string;
  value: string;
  note: string;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-gradient-to-b from-white to-slate-50 p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">{eyebrow}</p>
      <p className="mt-3 text-2xl font-bold tracking-tight text-slate-900 break-words">{value}</p>
      <p className="mt-2 text-sm text-slate-500">{note}</p>
    </div>
  );
}

function InsightCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-2xl bg-slate-50 p-4">
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      <p className="mt-2 text-sm leading-6 text-slate-600">{text}</p>
    </div>
  );
}

function ReminderCard({
  title,
  text,
  tone,
}: {
  title: string;
  text: string;
  tone: "neutral" | "warning" | "success";
}) {
  const toneClasses =
    tone === "warning"
      ? "border-amber-200 bg-amber-50"
      : tone === "success"
      ? "border-emerald-200 bg-emerald-50"
      : "border-slate-200 bg-slate-50";

  return (
    <div className={`rounded-2xl border p-4 ${toneClasses}`}>
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      <p className="mt-2 text-sm leading-6 text-slate-700">{text}</p>
    </div>
  );
}

function ContentPanel({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <h3 className="text-xl font-semibold">{title}</h3>
      <ul className="mt-4 space-y-3 text-sm leading-7 text-slate-700">
        {items.map((item) => <li key={item}>• {item}</li>)}
      </ul>
    </div>
  );
}

function InfoBox({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: "green" | "amber";
}) {
  const classes =
    tone === "green"
      ? "bg-emerald-50 border-emerald-200 text-emerald-900"
      : "bg-amber-50 border-amber-200 text-amber-900";

  return (
    <div className={`rounded-2xl border p-5 ${classes}`}>
      <h3 className="font-semibold">{title}</h3>
      <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-700">
        {items.map((item) => <li key={item}>• {item}</li>)}
      </ul>
    </div>
  );
}

function PriceLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-white/10 pb-3 text-sm">
      <span className="text-slate-300">{label}</span>
      <span className="font-semibold text-white">{value}</span>
    </div>
  );
}

function GuidedStepCard({
  number,
  title,
  text,
  action,
  done,
  active,
  onClick,
}: {
  number: string;
  title: string;
  text: string;
  action: string;
  done?: boolean;
  active?: boolean;
  onClick: () => void;
}) {
  const isSecondary = done || !active;

  return (
    <div
      className={`flex h-full flex-col rounded-3xl border p-5 transition ${
        active
          ? "border-emerald-300 bg-white shadow-md shadow-emerald-100/70"
          : done
          ? "border-emerald-200 bg-emerald-50/70"
          : "border-slate-200 bg-slate-50"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-full text-sm font-bold ${done ? "bg-emerald-600 text-white" : active ? "bg-emerald-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200"}`}>
          {done ? "✓" : number}
        </div>
        <span className={`rounded-full px-3 py-1 text-[11px] font-semibold ${done ? "bg-white text-emerald-700 ring-1 ring-emerald-100" : active ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100" : "bg-white text-slate-500 ring-1 ring-slate-200"}`}>
          {done ? "Completato" : active ? "Da fare ora" : "Prossimo"}
        </span>
      </div>
      <h4 className="mt-4 text-base font-bold leading-6 text-slate-900">{title}</h4>
      <p className="mt-2 min-h-[72px] flex-1 text-sm leading-6 text-slate-600">{text}</p>
      <button
        type="button"
        onClick={onClick}
        className={`mt-5 w-full rounded-2xl px-4 py-3 text-sm font-semibold transition ${
          isSecondary
            ? "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            : "bg-emerald-600 text-white shadow-sm hover:bg-emerald-700"
        }`}
      >
        {action}
      </button>
    </div>
  );
}

function ChecklistGroup({
  title,
  subtitle,
  items,
  state,
  onToggle,
  getToolAction,
  nextItemId,
  actionVisited = {},
  onToolActionClick,
}: {
  title: string;
  subtitle?: string;
  items: ChecklistItem[];
  state: Record<string, boolean>;
  onToggle: (id: string) => void;
  getToolAction?: (id: string) => { label: string; onClick: () => void } | null;
  nextItemId?: string | null;
  actionVisited?: Record<string, boolean>;
  onToolActionClick?: (id: string, action: { label: string; onClick: () => void }) => void;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
      <h4 className="text-lg font-semibold">{title}</h4>
      {subtitle ? <p className="mt-1 text-sm leading-6 text-slate-600">{subtitle}</p> : null}

      <div className="mt-4 space-y-3">
        {items.map((item) => {
          const checked = Boolean(state[item.id]);
          const isNext = !checked && item.id === nextItemId;
          const toolAction = getToolAction ? getToolAction(item.id) : null;
          const toolActionIsPrimary = Boolean(toolAction && isNext && !actionVisited[item.id]);

          return (
            <div
              key={item.id}
              className={`w-full rounded-2xl border p-4 text-left transition ${
                checked
                  ? "border-emerald-300 bg-emerald-50"
                  : isNext
                    ? "border-emerald-300 bg-emerald-50 shadow-sm"
                    : "border-slate-200 bg-white"
              }`}
            >
              <button
                type="button"
                onClick={() => onToggle(item.id)}
                className="flex w-full items-start gap-3 text-left"
              >
                <span
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    checked ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-700"
                  }`}
                >
                  {checked ? "✓" : ""}
                </span>

                <span className="flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-900">{item.title}</span>
                    {isNext ? (
                      <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">
                        Prossimo step
                      </span>
                    ) : null}
                  </span>

                  <span className="mt-1 block text-sm leading-6 text-slate-600">
                    {item.description}
                  </span>
                </span>
              </button>

              {toolAction ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (onToolActionClick) onToolActionClick(item.id, toolAction);
                    else toolAction.onClick();
                  }}
                  className={`mt-3 inline-flex rounded-xl px-3 py-2 text-xs font-semibold shadow-sm transition ${
                    toolActionIsPrimary
                      ? "bg-emerald-600 text-white hover:bg-emerald-700"
                      : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  {toolAction.label}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}


// === UPGRADE BADGE VISIVO ===
// Badge ora centrati in alto, più grandi, con animazione e stile premium
// Esempio stile:
// position: fixed; top: 20px; left: 50%; transform: translateX(-50%)
// bg: emerald-50, border emerald-200
// animazione: scale + fade
// auto dismiss mantenuto

