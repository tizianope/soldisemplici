"use client";

import { useEffect, useMemo, useState } from "react";
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
  | "open_exit_strategy";

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
    const { data } = await supabase.auth.getUser();
    const userId = data?.user?.id ?? null;

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

type PurchaseState = {
  unlocked: boolean;
  email: string;
  selectedPortfolio?: FinalPortfolioKey;
  plan?: PurchasePlan;
  paidAmount?: number;
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
  | "strumentis"
  | "dashboard"
  | "rebalance"
  | "exit";

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
};

type GoalChangeReason = "investimento" | "prelievo" | "mercato" | "stabile";

const LEGAL_DISCLAIMER =
  "Questa applicazione ha finalita esclusivamente educative e informative. Le informazioni fornite non costituiscono consulenza finanziaria personalizzata ne raccomandazioni di investimento. Qualsiasi decisione di investimento resta sotto la piena responsabilita dell'utente.";

const questions: Question[] = [
  {
    id: 1,
    text: "Se il valore dei tuoi investimenti scendesse del 20%, cosa faresti?",
    helper: "Non cercare la risposta perfetta. Scegli quella piu vicina al tuo istinto.",
    options: [
      { label: "Venderei tutto", scores: { stabilita: 2, equilibrio: 0, crescita: 0 } },
      { label: "Aspetterei con difficolta", scores: { stabilita: 1, equilibrio: 1, crescita: 0 } },
      { label: "Non farei nulla", scores: { stabilita: 0, equilibrio: 2, crescita: 1 } },
      { label: "Investirei di piu", scores: { stabilita: 0, equilibrio: 0, crescita: 2 } },
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
      { label: "Piu di 15 anni", scores: { stabilita: 0, equilibrio: 0, crescita: 2 } },
    ],
  },
  {
    id: 4,
    text: "Qual e il tuo obiettivo principale?",
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
      { label: "Posso investire con regolarita senza problemi", scores: { stabilita: 0, equilibrio: 0, crescita: 2 } },
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
    title: "Stabilita Assoluta",
    shortTitle: "Permanent Portfolio",
    profileFamily: "stabilita",
    badge: "Prudenza massima",
    intro:
      "Questo modello punta prima di tutto a farti restare sereno nel tempo. Non cerca il massimo rendimento possibile, ma un equilibrio molto stabile.",
    whyItFits:
      "E adatto a chi vuole una strategia semplice, con oscillazioni contenute e un approccio molto prudente.",
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
      "Rispettare le percentuali e importante",
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
      "La costanza conta piu del momento perfetto",
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
    title: "Stabilita Dinamica",
    shortTitle: "Prudenza evoluta",
    profileFamily: "stabilita",
    badge: "Prudenza con primo passo verso la crescita",
    intro:
      "Mantiene una struttura prudente, ma introduce un po piu di crescita rispetto al profilo piu conservativo.",
    whyItFits:
      "E adatto a chi vuole stabilita, ma sente di poter fare un primo passo in piu verso il lungo periodo.",
    composition: [
      { label: "Azioni", percentage: 25, category: "Azioni Globali" },
      { label: "Obbligazioni", percentage: 40, category: "Obbligazioni" },
      { label: "Oro", percentage: 20, category: "Oro" },
      { label: "Liquidita", percentage: 15, category: "Liquidita" },
    ],
    structureSummary: ["Prudente ma non immobile", "Crescita graduale", "Buona sostenibilita emotiva"],
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
      "Una crescita lenta ma mantenibile vale piu di una strategia troppo spinta",
      "La serenita operativa e un vantaggio reale",
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
      "E adatto a chi vuole crescere nel tempo ma con una struttura piu robusta e diversificata.",
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
      "Non eliminare le parti difensive perche sembrano lente",
      "La forza qui e nell'equilibrio",
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
      "La disciplina conta piu delle previsioni",
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
    badge: "Piu crescita, ma ancora con controllo",
    intro:
      "Qui la componente di crescita aumenta, ma restano presenti elementi che aiutano a contenere gli eccessi.",
    whyItFits:
      "E adatto a chi vuole far lavorare di piu il capitale, senza arrivare ancora a una strategia davvero aggressiva.",
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
      "Il rischio maggiore e cambiare idea nei momenti difficili",
      "Non confondere lungo periodo con immobilita mentale",
      "La strategia va mantenuta",
    ],
    pacGuide: [
      "Parti anche da 50 EUR o 100 EUR al mese",
      "Automatizza il trasferimento dopo lo stipendio",
      "Attiva gli acquisti automatici ricorrenti",
      "Non dimenticare il PAC nei mesi in cui sei piu impegnato",
    ],
    psychology: [
      "La costanza e piu importante del timing",
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
      "Questo modello cerca una crescita piu significativa, ma senza rinunciare del tutto agli elementi di protezione.",
    whyItFits:
      "E adatto a chi vuole risultati migliori del profilo prudente, ma preferisce non spingersi ancora verso il rischio alto puro.",
    composition: [
      { label: "Azioni", percentage: 40, category: "Azioni Globali" },
      { label: "Obbligazioni", percentage: 40, category: "Obbligazioni" },
      { label: "Oro", percentage: 20, category: "Oro" },
    ],
    structureSummary: ["Buon compromesso tra crescita e stabilita", "Molto adatto a chi vuole salire di livello", "Facile da spiegare e mantenere"],
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
      "La vera forza e nella disciplina",
    ],
    pacGuide: [
      "Bonifico automatico appena entra lo stipendio",
      "Investimento automatico sulla piattaforma",
      "Un strumenti per categoria, rispettando le percentuali",
      "Il piano va mantenuto nei mesi buoni e nei mesi difficili",
    ],
    psychology: [
      "Il risultato si vede nel tempo, non nel breve",
      "Una strategia sostenibile vale piu di una perfetta solo sulla carta",
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
    badge: "Alto potenziale, alta volatilita",
    intro:
      "Questo modello e pensato per chi vuole massimizzare la crescita nel lungo periodo e riesce a sopportare oscillazioni importanti.",
    whyItFits:
      "E adatto a chi ha orizzonte lungo, alta tolleranza emotiva e una forte disciplina nel mantenere la strategia.",
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
      "Non e per chi soffre molto i cali di mercato",
      "Il rischio vero e abbandonare la strategia",
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
      "La costanza conta piu del coraggio iniziale",
      "Il tempo e il vero motore della strategia",
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
      "Apri una piattaforma semplice e adatta al tuo piano. Se sei all'inizio, Trade Republic e una buona opzione: permette acquisti frazionati e rende piu semplice partire con piccole cifre. In ogni caso, verifica sempre costi e funzionamento prima di iniziare.",
  },
  {
    id: "bonifico",
    group: "inizio",
    title: "Imposta il bonifico automatico",
    description:
      "Imposta un bonifico automatico mensile verso il conto investimenti. Scegli una data subito dopo l'accredito dello stipendio, cosi non devi pensarci ogni mese.",
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
      "Configura un piano di accumulo automatico sulla tua piattaforma. Imposta prima il bonifico automatico e poi il PAC, cosi riduci il rischio di saldo insufficiente. Su Trade Republic: vai in Piani di accumulo, scegli gli strumenti e attiva il PAC. Nota: Trade Republic consente l'acquisto automatico a inizio mese o a meta mese; il giorno effettivo puo variare se ci sono festivita o la borsa e chiusa.",
  },
  {
    id: "pac_start",
    group: "inizio",
    title: "Chiudi il primo mese PAC",
    description:
      "Segna il PAC del mese come completato. Questo e il primo gesto concreto che rende operativo il sistema.",
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
      "Apri l'app una volta al mese e verifica che il PAC sia stato eseguito. Non serve controllare ogni giorno: la costanza conta piu della frequenza.",
  },
  {
    id: "rebalance",
    group: "mantenimento",
    title: "Ribilancia solo quando serve",
    description:
      "Se il modello si allontana molto dal target, valuta un ribilanciamento. Non e urgente: e manutenzione periodica.",
  },
  {
    id: "aggiorna_capitale",
    group: "mantenimento",
    title: "Aggiorna il capitale",
    description:
      "Aggiorna il valore totale del capitale quando cambia in modo rilevante. Serve per mantenere consapevolezza, non per reagire al mercato.",
  },
];

function formatEuro(value: number): string {
  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
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
  activeCategories: number;
}): Badge[] {
  const { purchaseUnlocked, checklistCompleted, totalChecklist, pacHistory, totalInvested, activeCategories } = params;
  const completedMonths = pacHistory.filter((m) => m.completed).length;
  const streak = calculateCurrentStreak(pacHistory);

  let hasGapAndReturn = false;
  for (let i = 1; i < pacHistory.length; i++) {
    if (!pacHistory[i - 1].completed && pacHistory[i].completed) {
      hasGapAndReturn = true;
      break;
    }
  }

  return [
    {
      id: "first_step",
      title: "Hai iniziato davvero",
      description: "Hai completato il questionario e ricevuto il tuo piano di riferimento.",
      unlocked: purchaseUnlocked,
    },
    {
      id: "system_on",
      title: "Sistema attivato",
      description: "Hai completato il setup iniziale: ora il piano e pronto per lavorare nel tempo.",
      unlocked: checklistCompleted >= totalChecklist && totalChecklist > 0,
    },
    {
      id: "pac_started",
      title: "Primo mese chiuso",
      description: "Hai trasformato il piano in azione concreta completando il primo PAC.",
      unlocked: completedMonths >= 1,
    },
    {
      id: "streak_3",
      title: "Routine attivata",
      description: "Hai mantenuto il PAC per 3 mesi consecutivi. Ora sta diventando abitudine.",
      unlocked: streak >= 3,
    },
    {
      id: "streak_6",
      title: "Disciplina reale",
      description: "Hai protetto la catena per 6 mesi. Questo e il comportamento che fa la differenza.",
      unlocked: streak >= 6,
    },
    {
      id: "streak_12",
      title: "Macchina da compounding",
      description: "Hai completato 12 mesi consecutivi. Sei nella zona dove il metodo inizia a pesare davvero.",
      unlocked: streak >= 12,
    },
    {
      id: "restart",
      title: "Non molli facilmente",
      description: "Hai ripreso il piano dopo una pausa. La differenza la fa chi riparte.",
      unlocked: hasGapAndReturn,
    },
    {
      id: "capital_1000",
      title: "Primo capitale serio",
      description: "Hai superato 1.000 EUR di capitale aggiornato. La base e stata costruita.",
      unlocked: totalInvested >= 1000,
    },
    {
      id: "capital_5000",
      title: "Costruttore di capitale",
      description: "Hai superato 5.000 EUR di capitale aggiornato. Il piano sta prendendo forma.",
      unlocked: totalInvested >= 5000,
    },
    {
      id: "capital_10000",
      title: "Base solida",
      description: "Hai superato 10.000 EUR di capitale aggiornato. Ora il percorso e concreto.",
      unlocked: totalInvested >= 10000,
    },
    {
      id: "all_categories",
      title: "Modello operativo",
      description: "Hai attivato le aree previste dal modello: il sistema e piu completo.",
      unlocked: activeCategories >= 1,
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


async function safeLocalSignOut() {
  try {
    await safeLocalSignOut();
  } catch (error) {
    console.warn("Logout locale Supabase ignorato:", error);
  }
}

export default function Home() {
  
  useEffect(() => {
    void trackEvent("open_app");
  }, []);
const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [profileResetLoading, setProfileResetLoading] = useState(false);
  const [profileResetMessage, setProfileResetMessage] = useState("");

  const [goalTitle, setGoalTitle] = useState("Liberta finanziaria");
  const [goalTarget, setGoalTarget] = useState("100000");
  const [goalCurrentValue, setGoalCurrentValue] = useState("0");
  const [goalPreviousValue, setGoalPreviousValue] = useState("0");
  const [goalReason, setGoalReason] = useState<GoalChangeReason>("stabile");
  const [goalEndYear, setGoalEndYear] = useState(String(new Date().getFullYear() + 10));
  const [goalLoaded, setGoalLoaded] = useState(false);
  const [progressStartValue, setProgressStartValue] = useState("0");
  const [progressStartMonth, setProgressStartMonth] = useState("");

  const [step, setStep] = useState<AppStep>("home");
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [answers, setAnswers] = useState<number[]>(Array(questions.length).fill(-1));
  const [showRetakeWarning, setShowRetakeWarning] = useState(false);
  const [retakeReason, setRetakeReason] = useState("situazione");
  const [retakeMeta, setRetakeMeta] = useState<{ count: number; lastAt: string | null }>({
    count: 0,
    lastAt: null,
  });
  const [purchase, setPurchase] = useState<PurchaseState>({ unlocked: false, email: "", paidAmount: 0 });
  const [showProUpgradeModal, setShowProUpgradeModal] = useState(false);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [checklistState, setChecklistState] = useState<Record<string, boolean>>({});
  const [pacHistory, setPacHistory] = useState<PacMonth[]>([]);
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
  const isProPlan = purchase.unlocked && purchase.plan === "pro";
  const isCorePlan = purchase.unlocked && purchase.plan === "core";
  const paidAmount = purchase.paidAmount ?? (purchase.plan === "core" ? 29 : purchase.plan === "pro" ? 59 : 0);
  const proPriceToPay = Math.max(59 - paidAmount, 0);

  useEffect(() => {
    let mounted = true;

    async function initAuth() {
      try {
        const { data, error } = await supabase.auth.getSession();

        if (error) {
          console.warn("Sessione Supabase non valida, pulizia locale:", error.message);
          clearSupabaseAuthStorage();
          if (!mounted) return;
          setUser(null);
          setAuthMessage("Sessione scaduta o non valida. Effettua di nuovo l'accesso.");
          setAuthReady(true);
          return;
        }

        if (!mounted) return;
        setUser(data.session?.user ?? null);
        setAuthReady(true);
      } catch (error) {
        console.warn("Errore inizializzazione auth:", error);
        clearSupabaseAuthStorage();
        if (!mounted) return;
        setUser(null);
        setAuthMessage("Sessione scaduta o non valida. Effettua di nuovo l'accesso.");
        setAuthReady(true);
      }
    }

    initAuth();

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setAuthReady(true);
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
    if (!user) return;
    const savedPurchase = localStorage.getItem(getPurchaseKey(user.id));
    const savedHoldings = localStorage.getItem(getHoldingsKey(user.id));

    if (savedPurchase) setPurchase(JSON.parse(savedPurchase));
    else setPurchase({ unlocked: false, email: user.email || "", selectedPortfolio: undefined, paidAmount: 0 });

    if (savedHoldings) setHoldings(JSON.parse(savedHoldings));
    else setHoldings([]);

    loadUserProfile(user);
    loadHoldingsFromDb(user);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    localStorage.setItem(getPurchaseKey(user.id), JSON.stringify(purchase));
  }, [purchase, user]);

  useEffect(() => {
    if (purchase.unlocked && step === "paywall" && purchase.plan === "pro") {
      setStep("dashboard");
    }
  }, [purchase.unlocked, purchase.plan, step]);

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
    saveGoalToDb();
  }, [
    goalLoaded,
    goalTitle,
    goalTarget,
    goalCurrentValue,
    goalPreviousValue,
    goalReason,
    goalEndYear,
    portMonthly,
    selectedPortfolio.key,
    user,
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

  useEffect(() => {
    if (!user) return;
    loadPacHistoryFromDb(user);
  }, [user, selectedPortfolio.key]);

  // soldi-semplici-scroll-top-key
  useEffect(() => {
    if (["preview", "portfolio", "onboarding"].includes(step)) {
      window.setTimeout(() => {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }, 60);
    }
  }, [step]);

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

  const targetCoverage = useMemo(() => {
    return selectedPortfolio.composition.map((item) => {
      const currentAmount = investedByCategory[item.category] || 0;
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
  }, [selectedPortfolio, investedByCategory, totalInvested]);

  const biggestGap = useMemo(() => {
    if (targetCoverage.length === 0) return null;
    return [...targetCoverage].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
  }, [targetCoverage]);

  const rebalancePacNumber = Math.max(0, Number(rebalancePacAmount || 0));

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
      const currentPercentage = rebalanceTotalInvested > 0 ? Math.round((currentAmount / rebalanceTotalInvested) * 100) : 0;
      const targetAmountNow = rebalanceTotalInvested * (item.percentage / 100);
      const amountGapNow = targetAmountNow - currentAmount;
      const delta = currentPercentage - item.percentage;

      return {
        label: item.label,
        category: item.category,
        targetPercentage: item.percentage,
        currentPercentage,
        currentAmount,
        targetAmountNow,
        amountGapNow,
        delta,
      };
    });
  }, [selectedPortfolio.composition, rebalanceCurrentByCategory, rebalanceTotalInvested]);

  const rebalanceBiggestGap = useMemo(() => {
    if (rebalanceCoverage.length === 0) return null;
    return [...rebalanceCoverage].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
  }, [rebalanceCoverage]);

  const totalRebalanceAbsoluteDrift = rebalanceCoverage.reduce((sum, item) => sum + Math.abs(item.delta), 0);

  const automaticRebalance = useMemo(() => {
    type RebalancePlanItem = (typeof rebalanceCoverage)[number] & {
      suggestedPercentage: number;
      monthlyAmount: number;
      roundedAmount: number;
      totalAmount: number;
    };

    if (rebalanceTotalInvested <= 0 || rebalancePacNumber <= 0) {
      return { months: 0, feasible: false, plan: [] as RebalancePlanItem[] };
    }

    for (let months = 1; months <= 60; months += 1) {
      const futureTotal = rebalanceTotalInvested + rebalancePacNumber * months;
      const gaps = rebalanceCoverage
        .map((item) => ({
          ...item,
          gapAfterPac: futureTotal * (item.targetPercentage / 100) - item.currentAmount,
        }))
        .filter((item) => item.gapAfterPac > 0);
      const totalGap = gaps.reduce((sum, item) => sum + item.gapAfterPac, 0);

      if (totalGap > 0 && rebalancePacNumber * months >= totalGap) {
        const plan = gaps
          .map((item) => {
            const weight = item.gapAfterPac / totalGap;
            const monthlyAmount = rebalancePacNumber * weight;
            return {
              ...item,
              suggestedPercentage: Math.round(weight * 100),
              monthlyAmount,
              roundedAmount: Math.round(monthlyAmount / 5) * 5,
              totalAmount: monthlyAmount * months,
            };
          })
          .filter((item) => item.suggestedPercentage > 0);

        return { months, feasible: true, plan };
      }
    }

    const futureTotal = rebalanceTotalInvested + rebalancePacNumber * 60;
    const gaps = rebalanceCoverage
      .map((item) => ({
        ...item,
        gapAfterPac: futureTotal * (item.targetPercentage / 100) - item.currentAmount,
      }))
      .filter((item) => item.gapAfterPac > 0);
    const totalGap = gaps.reduce((sum, item) => sum + item.gapAfterPac, 0);
    const plan = (totalGap > 0 ? gaps : rebalanceCoverage)
      .map((item) => {
        const gap = "gapAfterPac" in item ? item.gapAfterPac : 0;
        const safeGap = Number(gap) || 0;
              const weight = totalGap > 0 ? safeGap / totalGap : item.targetPercentage / 100;
        const monthlyAmount = rebalancePacNumber * weight;
        return {
          ...item,
          suggestedPercentage: Math.round(weight * 100),
          monthlyAmount,
          roundedAmount: Math.round(monthlyAmount / 5) * 5,
          totalAmount: monthlyAmount * 60,
        };
      })
      .filter((item) => item.suggestedPercentage > 0);

    return { months: 60, feasible: false, plan };
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
    : totalRebalanceAbsoluteDrift <= 10
    ? "Il portafoglio e abbastanza vicino al modello: puoi continuare con il PAC ordinario o fare solo piccoli aggiustamenti."
    : automaticRebalance.feasible
    ? `Il portafoglio si e allontanato dal modello: con il PAC indicato puoi simulare un rientro graduale in circa ${automaticRebalance.months} ${automaticRebalance.months === 1 ? "mese" : "mesi"}.`
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
      reasons.push("la parte difensiva puo finanziare i prelievi quando il mercato scende");
      reasons.push("e una strategia adatta a chi ragiona in termini di rendita");
    } else if (savedExitAdvice === "graduale") {
      reasons.push("vuoi ridurre il rischio di vendere tutto nel momento sbagliato");
      reasons.push("preferisci una procedura semplice e facile da seguire");
      reasons.push("hai bisogno di trasformare il capitale in liquidita in modo ordinato");
    } else if (savedExitAdvice === "regole") {
      reasons.push("vuoi evitare decisioni emotive quando il mercato si muove molto");
      reasons.push("sei disposto a seguire soglie gia decise prima");
      reasons.push("puo aiutare a proteggere parte dei guadagni senza uscire tutto insieme");
    } else if (savedExitAdvice === "obiettivo") {
      reasons.push("hai un traguardo concreto da raggiungere");
      reasons.push("la priorita diventa proteggere il risultato quando sei vicino al target");
      reasons.push("e semplice da capire: il piano dipende dalla distanza dall'obiettivo");
    }
    return reasons;
  }, [savedExitAdvice]);

  const exitRecommendedStrategy = useMemo(() => {
    const key = savedExitAdvice || selectedExitStrategy;
    const explanations: Record<ExitStrategyKey, string> = {
      graduale: "Strategia semplice: trasformi il capitale in liquidita poco alla volta, riducendo il rischio di vendere tutto in una giornata sfavorevole.",
      regole: "Strategia disciplinata: decidi prima soglie e comportamenti, cosi il mercato non ti costringe a scegliere sotto stress.",
      obiettivo: "Strategia concreta: parti dal bisogno reale e riduci il rischio man mano che ti avvicini alla cifra che ti serve.",
      bucket: "Strategia da rendita: separi una parte difensiva da cui prelevare e una parte investita che puo continuare a lavorare.",
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
      plain: "Vendi il capitale a piccole rate invece di fare una vendita unica. Serve a non dipendere troppo dal prezzo di un solo giorno.",
      when: ["Hai un obiettivo vicino", "Vuoi ridurre stress e rischio di timing", "Preferisci una procedura semplice"],
      steps: [
        `Definisci il capitale da proteggere: oggi stai simulando ${formatEuro(exitCurrentNumber)}.`,
        `Dividi l'uscita in ${exitMonthsNumber} ${exitMonthsNumber === 1 ? "mese" : "mesi"}.`,
        `Vendi circa ${formatEuro(exitMonthlySale)} al mese.`,
        "Sposta il ricavato verso liquidita o strumenti piu difensivi.",
        "A fine periodo rivaluta se fermarti, continuare o lasciare investita una quota.",
      ],
      pros: ["Molto comprensibile", "Riduce il rischio di vendere tutto nel momento sbagliato", "Abbassa la pressione emotiva"],
      cons: ["Se il mercato sale potresti vendere troppo presto", "Se il mercato scende vendi comunque una quota", "Ogni vendita puo generare tasse sulle plusvalenze"],
    },
    regole: {
      title: "Uscita a regole",
      plain: "Prima decidi le condizioni, poi segui il piano. E utile se vuoi evitare decisioni impulsive davanti a salite o discese forti.",
      when: ["Hai gia un buon guadagno", "Accetti una strategia piu tecnica", "Vuoi proteggere risultati senza uscire subito da tutto"],
      steps: [
        "Definisci una soglia di guadagno, per esempio +30%.",
        "Definisci una soglia di protezione, per esempio -10% dal massimo raggiunto.",
        `Se la regola scatta, valuta una vendita parziale: con i dati attuali il 25% vale circa ${formatEuro(exitRuleSaleAmount)}.`,
        "Dopo la vendita sposta la parte uscita in strumenti piu difensivi.",
        "Controlla le regole una volta al mese, non ogni giorno.",
      ],
      pros: ["Riduce emotivita", "Protegge parte dei guadagni", "Si adatta meglio ai movimenti del mercato"],
      cons: ["Richiede disciplina", "E piu complessa per un neofita", "Puo generare vendite e tassazione"],
    },
    obiettivo: {
      title: "Uscita per obiettivo",
      plain: "La domanda non e quanto puo salire ancora il mercato, ma se hai raggiunto il motivo per cui investivi.",
      when: ["Hai una spesa concreta", "Vuoi proteggere una cifra precisa", "Non vuoi inseguire rendimento infinito"],
      steps: [
        `Imposta il target: ora e ${formatEuro(exitGoalNumber)}.`,
        `Controlla la distanza: sei circa al ${exitNearGoal}% dell'obiettivo.`,
        "Se sei lontano, continua il piano senza forzare l'uscita.",
        "Se sei vicino, riduci progressivamente il rischio.",
        "Se hai raggiunto il target, valuta uscita graduale o vendita finale.",
      ],
      pros: ["Facile da capire", "Collega gli investimenti alla vita reale", "Evita di rischiare soldi gia necessari"],
      cons: ["Puo ignorare il momento di mercato", "Potresti uscire troppo presto", "La vendita finale puo concentrare tasse in un unico momento"],
    },
    bucket: {
      title: "Bucket strategy 3%",
      plain: "Dividi il capitale in due contenitori: una parte difensiva da cui prelevare e una parte investita che puo continuare a crescere.",
      when: ["Vuoi una rendita", "Hai un orizzonte lungo", "Vuoi evitare di vendere azioni nei ribassi"],
      steps: [
        `Rialloca in modo piu difensivo: esempio ${formatEuro(exitSafeBucket)} in parte prudente e ${formatEuro(exitInvestedBucket)} ancora investiti.`,
        `Imposta un prelievo prudente: circa ${formatEuro(exitAnnualWithdrawal)} all'anno, pari al 3% del capitale simulato.`,
        "Se l'azionario cresce molto, vendi una parte dei guadagni e ricarica la parte difensiva.",
        "Se l'azionario scende, evita di venderlo e preleva dalla parte obbligazionaria o liquida.",
        "Ogni anno controlla se il 3% e ancora sostenibile e se i bucket sono da ribilanciare.",
      ],
      pros: ["Adatta a chi vuole rendita", "Riduce il rischio di vendere azioni nei ribassi", "Lascia una parte del capitale investita"],
      cons: ["Il 3% non e garantito", "Richiede manutenzione annuale", "Il capitale puo comunque oscillare o ridursi"],
    },
  };

  const selectedExitDetails = exitStrategyDetails[selectedExitStrategy];



  const mostWeightedCategory = dashboardBreakdown.length > 0 ? dashboardBreakdown[0] : null;

  const dashboardMessage =
    totalInvested > 0
      ? "Stai costruendo un modello reale con dati persistenti e una struttura sempre piu chiara."
      : "La dashboard e pronta: ora ti manca solo il primo investimento per trasformare il piano in azione.";

  const portfolioRate = getPortfolioRate(selectedPortfolio.profileFamily);

  const currentYear = new Date().getFullYear();
  const goalEndYearNumber = Number(goalEndYear || currentYear);
  const safeGoalEndYear = Math.max(currentYear, goalEndYearNumber);
  const goalDurationYears = safeGoalEndYear - currentYear;
  const goalDurationMonths = goalDurationYears * 12;

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
      return "Il tuo capitale e aumentato. Continua a dare priorita alla costanza piu che alla ricerca del momento perfetto.";
    }

    if (goalDelta < 0 && goalReason === "prelievo") {
      return "Hai utilizzato parte del capitale: puo succedere. L'importante e riprendere il piano con serenita quando possibile.";
    }

    if (goalDelta < 0 && goalReason === "mercato") {
      return "Le oscillazioni di mercato fanno parte del percorso. Una fase negativa non significa che la strategia non funzioni.";
    }

    if (goalDelta < 0) {
      return "Il valore si e ridotto rispetto all'aggiornamento precedente. Mantieni calma e metodo, poi rivaluta il contesto.";
    }

    return "Stai mantenendo il piano. Anche la stabilita e un risultato importante quando il percorso e di lungo periodo.";
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

  useEffect(() => {
    setCheckedPacAllocations({});
  }, [portMonthly, selectedPortfolio.key]);

  const pacImpactPercent =
    goalTargetNumber > 0 ? (monthlyPacAmount / goalTargetNumber) * 100 : 0;
  const nextMilestone =
    currentStreak >= 12
      ? "Hai gia raggiunto il traguardo dei 12 mesi consecutivi."
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
      ? "Stai facendo cio che funziona davvero: ripetere il piano nel tempo."
      : currentStreak >= 3
      ? "Stai costruendo una routine: ora il tuo vantaggio e la continuita."
      : "Hai appena iniziato: il primo obiettivo e rendere il PAC un gesto mensile.";

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
    ? "Il PAC e il Piano di Accumulo mensile: investi una cifra ricorrente, senza provare a prevedere il mercato."
    : currentMonthCompleted
    ? "Hai chiuso il mese. Ora la priorita e proteggere questa continuita nel tempo."
    : "Hai gia iniziato: completa anche questo mese per non interrompere la serie.";
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
          text: "Il setup iniziale va fatto una sola volta. Dopo, il sistema diventa molto piu semplice da mantenere.",
        }
      : null,
    !currentMonthCompleted
      ? {
          title: "Chiudi il mese",
          text: "Segna il PAC solo dopo aver verificato che il versamento o l'acquisto automatico sia partito correttamente.",
        }
      : {
          title: "Mese chiuso",
          text: "Hai fatto il gesto piu importante: ora evita di controllare troppo spesso il mercato.",
        },
    currentStreak < 3
      ? {
          title: "Punta alla prima serie",
          text: "Arrivare a 3 mesi consecutivi e il primo vero segnale che il piano sta diventando abitudine.",
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
          text: `Da ${progressStartLabel} hai costruito ${formatEuro(progressDelta)} in piu. Questo rende il percorso concreto.`,
        }
      : null,
  ].filter(Boolean) as { title: string; text: string }[];
  const pacPerfectMessage = currentMonthCompleted
    ? `Mese chiuso. Sei a ${currentStreak} ${currentStreak === 1 ? "mese" : "mesi"} consecutivi: proteggi questa serie.`
    : hasStartedPac
    ? "Non spezzare la catena: completa il PAC mensile e mantieni vivo il ritmo."
    : "Il primo PAC e il passaggio chiave: da qui il piano smette di essere teoria e diventa abitudine.";
  const badges = buildBadges({
    purchaseUnlocked: purchase.unlocked,
    checklistCompleted: completedInitialChecklist,
    totalChecklist: initialChecklistItems.length,
    pacHistory,
    totalInvested: goalCurrentNumber,
    activeCategories: dashboardBreakdown.length,
  });
  const unlockedBadges = badges.filter((b) => b.unlocked);
  const nextBadge = badges.find((badge) => !badge.unlocked) || null;
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
      ? `Continua cosi: mancano ${Math.max(0, 6 - currentStreak)} mesi a Disciplina reale.`
      : nextBadge?.id === "streak_12"
      ? `Non spezzare la catena: mancano ${Math.max(0, 12 - currentStreak)} mesi a Macchina da compounding.`
      : nextBadge?.id === "capital_1000"
      ? `Aggiorna il capitale: mancano ${formatEuro(Math.max(0, 1000 - goalCurrentNumber))} al primo capitale serio.`
      : nextBadge?.id === "capital_5000"
      ? `Continua a costruire: mancano ${formatEuro(Math.max(0, 5000 - goalCurrentNumber))} a Costruttore di capitale.`
      : nextBadge?.id === "capital_10000"
      ? `Continua a costruire: mancano ${formatEuro(Math.max(0, 10000 - goalCurrentNumber))} a Base solida.`
      : nextBadge?.id === "all_categories"
      ? "Registra almeno una categoria del modello per renderlo operativo."
      : "Hai sbloccato tutti i badge disponibili in questa fase.";

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
    if (completedMonths === 0) return "Hai gia il piano. Ora il prossimo passo e completare il primo mese.";
    if (currentStreak >= 12) return "Stai facendo quello che la maggior parte delle persone non riesce a fare: continuita reale.";
    if (currentStreak >= 6) return "Stai costruendo una disciplina molto solida. Continua cosi.";
    if (currentStreak >= 3) return "Stai costruendo continuita. E cosi che si ottengono risultati.";
    if (pacHistory.some((m, i) => i > 0 && !pacHistory[i - 1].completed && m.completed)) {
      return "Hai ripreso il piano dopo una pausa. Ottima scelta: ripartire conta molto.";
    }
    return "Hai iniziato. E il passo piu importante.";
  }, [pacHistory, currentStreak]);

  async function handleAuthSubmit() {
    setAuthLoading(true);
    setAuthMessage("");

    if (!authEmail || !authPassword) {
      setAuthMessage("Inserisci email e password.");
      setAuthLoading(false);
      return;
    }

    if (authMode === "register") {
      const emailRedirectTo =
        typeof window !== "undefined" ? `${window.location.origin}/auth/callback` : undefined;

      const { error } = await supabase.auth.signUp({
        email: authEmail,
        password: authPassword,
        options: {
          emailRedirectTo,
        },
      });

      if (error) setAuthMessage(error.message);
      else {
        setAuthMessage("Registrazione inviata. Controlla la tua email: dopo la conferma tornerai su una pagina dedicata di Soldi Semplici.");
        setAuthMode("login");
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({
        email: authEmail,
        password: authPassword,
      });

      if (error) setAuthMessage(error.message);
      else setAuthMessage("");
    }

    setAuthLoading(false);
  }

  async function handleLogout() {
    await safeLocalSignOut();
    clearSupabaseAuthStorage();
    setUser(null);
    setStep("home");
    setAnswers(Array(questions.length).fill(-1));
    setCurrentQuestion(0);
  }

  async function clearBrokenSession() {
    clearSupabaseAuthStorage();
    await safeLocalSignOut();
    setUser(null);
    setAuthMessage("Sessione locale pulita. Ora puoi accedere di nuovo.");
    setAuthReady(true);
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
    const { data, error } = await supabase
      .from("user_holdings")
      .select("*")
      .eq("user_id", currentUser.id)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Errore caricamento holdings:", error.message);
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
  }

  async function loadPacHistoryFromDb(currentUser = user) {
    if (!currentUser) return;

    const recentMonths = generateRecentMonths(12).map((month) => ({
      month,
      completed: false,
    }));

    const { data, error } = await supabase
      .from("user_pac_history")
      .select("*")
      .eq("user_id", currentUser.id)
      .eq("portfolio_key", selectedPortfolio.key);

    if (error) {
      console.error("Errore caricamento PAC:", error.message);
      setPacHistory(recentMonths);
      return;
    }

    const mergedHistory = recentMonths.map((month) => {
      const found = data?.find((row: any) => row.month_key === month.month);
      return found ? { ...month, completed: !!found.completed } : month;
    });

    setPacHistory(mergedHistory);
    localStorage.setItem(getPacStorageKey(currentUser.id, selectedPortfolio.key), JSON.stringify(mergedHistory));
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
    const { data, error } = await supabase
      .from("user_checklist")
      .select("*")
      .eq("user_id", currentUser.id)
      .eq("portfolio_key", selectedPortfolio.key);

    if (error) {
      console.error("Errore caricamento guida operativa:", error.message);
      return;
    }

    if (data && data.length > 0) {
      const mapped: Record<string, boolean> = {};
      data.forEach((row: any) => {
        mapped[row.item_id] = !!row.completed;
      });
      setChecklistState(mapped);
    }
  }

  function applyGoalData(data: any) {
    setGoalTitle(data.goal_title || data.goalTitle || "Liberta finanziaria");
    setGoalTarget(String(data.goal_target ?? data.goalTarget ?? "100000"));
    setGoalCurrentValue(String(data.goal_current_value ?? data.goalCurrentValue ?? "0"));
    setGoalPreviousValue(String(data.goal_previous_value ?? data.goalPreviousValue ?? "0"));
    setGoalReason((data.goal_reason || data.goalReason || "stabile") as GoalChangeReason);
    setGoalEndYear(String(data.goal_end_year ?? data.goalEndYear ?? new Date().getFullYear() + 10));
    setPortMonthly(String(data.pac_monthly ?? data.portMonthly ?? "200"));
  }

  async function loadGoalFromDb(currentUser: User) {
    const fallbackGoal = localStorage.getItem(getGoalStorageKey(currentUser.id, selectedPortfolio.key));

    const { data, error } = await supabase
      .from("user_goals")
      .select("*")
      .eq("user_id", currentUser.id)
      .eq("portfolio_key", selectedPortfolio.key)
      .maybeSingle();

    if (error) {
      console.error("Errore caricamento obiettivo:", error.message);

      if (fallbackGoal) {
        try {
          applyGoalData(JSON.parse(fallbackGoal));
        } catch {
          applyGoalData({});
        }
      } else {
        applyGoalData({});
      }

      setGoalLoaded(true);
      return;
    }

    if (data) {
      applyGoalData(data);
      localStorage.setItem(
        getGoalStorageKey(currentUser.id, selectedPortfolio.key),
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

    if (fallbackGoal) {
      try {
        applyGoalData(JSON.parse(fallbackGoal));
      } catch {
        applyGoalData({});
      }
    } else {
      applyGoalData({});
    }

    setGoalLoaded(true);
  }

  async function saveGoalToDb(forceSave = false) {
    if (!user || (!goalLoaded && !forceSave)) return;

    const payload = {
      user_id: user.id,
      portfolio_key: selectedPortfolio.key,
      goal_title: goalTitle,
      goal_target: Number(goalTarget || 0),
      goal_current_value: Number(goalCurrentValue || 0),
      goal_previous_value: Number(goalPreviousValue || 0),
      goal_reason: goalReason,
      goal_end_year: Number(goalEndYear || new Date().getFullYear() + 10),
      pac_monthly: Number(portMonthly || 0),
      updated_at: new Date().toISOString(),
    };

    localStorage.setItem(
      getGoalStorageKey(user.id, selectedPortfolio.key),
      JSON.stringify({
        goalTitle,
        goalTarget,
        goalCurrentValue,
        goalPreviousValue,
        goalReason,
        goalEndYear,
        portMonthly,
      })
    );

    const { error } = await supabase
      .from("user_goals")
      .upsert(payload, {
        onConflict: "user_id,portfolio_key",
      });

    if (error) {
      console.error("Errore salvataggio obiettivo:", error.message);
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
    const { data, error } = await supabase
      .from("user_profiles")
      .select("*")
      .eq("id", currentUser.id)
      .single();

    if (error) {
      if (error.code !== "PGRST116") {
        console.error("Errore caricamento profilo:", error.message);
      }
      return;
    }

    if (data) {
      const savedPortfolio = data.selected_portfolio || undefined;
      const localPurchaseRaw = localStorage.getItem(getPurchaseKey(currentUser.id));
      let localPurchase: PurchaseState | null = null;

      try {
        localPurchase = localPurchaseRaw ? JSON.parse(localPurchaseRaw) : null;
      } catch {
        localPurchase = null;
      }

      const paidUnlocked = !!localPurchase?.unlocked;

      setPurchase({
        unlocked: paidUnlocked,
        email: data.email || currentUser.email || "",
        selectedPortfolio: savedPortfolio,
        plan: localPurchase?.plan,
        paidAmount: localPurchase?.paidAmount ?? (localPurchase?.plan === "core" ? 29 : localPurchase?.plan === "pro" ? 59 : 0),
      });

      if (Array.isArray(data.quiz_answers) && data.quiz_answers.length === questions.length) {
        setAnswers(data.quiz_answers);
      }

      if (savedPortfolio) {
        setStep(paidUnlocked ? "dashboard" : "portfolio");
      }
    }
  }

  function startQuizFlow() {
    if (purchase.unlocked) {
      setShowRetakeWarning(true);
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
      await trackEvent("finish_test", { portfolio: scoreResult.portfolio.title });
      await trackEvent("view_plan", { portfolio: scoreResult.portfolio.title, step: "preview" });
      setStep("preview");
      return;
    }
    setCurrentQuestion((prev) => prev + 1);
  }

  function previousQuestion() {
    if (currentQuestion === 0) {
      setStep("home");
      return;
    }
    setCurrentQuestion((prev) => prev - 1);
  }

  async function unlockPlan(plan: PurchasePlan = "core") {
    const finalPortfolio = purchase.selectedPortfolio || scoreResult.finalPortfolio;
    const currentPaid = purchase.paidAmount ?? (purchase.plan === "core" ? 29 : purchase.plan === "pro" ? 59 : 0);
    const nextPaidAmount = plan === "pro" ? 59 : Math.max(currentPaid, 29);
    const updatedPurchase: PurchaseState = {
      unlocked: true,
      email: user?.email || purchase.email,
      selectedPortfolio: finalPortfolio,
      plan,
      paidAmount: nextPaidAmount,
    };

    setPurchase(updatedPurchase);
    if (user) {
      localStorage.setItem(getPurchaseKey(user.id), JSON.stringify(updatedPurchase));
    }

    if (plan === "core") {
      setGoalTitle("Liberta finanziaria");
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

    if (plan === "core") {
      await trackEvent("buy_core", { amount: 29, portfolio: portfolioMap[finalPortfolio].title });
    } else {
      const eventName = currentPaid >= 29 ? "upgrade_pro" : "buy_pro";
      await trackEvent(eventName, { amount: Math.max(59 - currentPaid, 0), portfolio: portfolioMap[finalPortfolio].title });
    }

    setShowProUpgradeModal(false);
    setStep(plan === "core" ? "onboarding" : "dashboard");
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
    setGoalTitle("Liberta finanziaria");
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
    const firstStrumenti = strumentiLibrary[category][0];
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

  function goToDashboardSection(sectionId: string) {
    setStep("dashboard");
    window.setTimeout(() => {
      document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  }

  function goToFirstTimeGuide() {
    setStep("dashboard");
    window.setTimeout(() => {
      window.scrollTo({ top: 0, behavior: "auto" });
      document.getElementById("prima-volta-qui")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
  }

  function getChecklistToolAction(id: string): { label: string; onClick: () => void } | null {
    if (!purchase.unlocked) return null;

    const actions: Record<string, { label: string; onClick: () => void } | null> = {
      broker: null,
      strumenti: null,
      percentuali: { label: "Calcola quote PAC", onClick: () => goToDashboardSection("pac-mensile") },
      pac_start: { label: "Segna PAC del mese", onClick: () => goToDashboardSection("azione-del-mese") },
      controllo: { label: "Apri controllo mensile", onClick: () => goToDashboardSection("pac-mensile") },
      rebalance: { label: "Controlla ripartizione", onClick: () => goToDashboardSection("ripartizione-attuale") },
      aggiorna_capitale: { label: "Aggiorna capitale", onClick: () => goToDashboardSection("obiettivo") },
    };

    return actions[id] || null;
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
    setPurchase({ unlocked: false, email: user?.email || "", selectedPortfolio: undefined, paidAmount: 0 });
    setHoldings([]);
    setChecklistState({});
    setPacHistory(generateRecentMonths(12).map((month) => ({ month, completed: false })));
    setCheckedPacAllocations({});
    setRetakeMeta({ count: 0, lastAt: null });
    setGoalTitle("Liberta finanziaria");
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
    ]);

    // Seconda protezione per i test: se la DELETE del profilo non passa per policy/RLS,
    // almeno svuotiamo il modello salvato cosi il prossimo quiz non eredita il piano precedente.
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

  if (!authReady) {
    return (
      <main className="min-h-screen bg-slate-50 text-slate-900">
        <div className="mx-auto flex min-h-screen max-w-xl items-center justify-center px-6">
          <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
            <p className="text-lg font-semibold">Caricamento in corso...</p>
          </div>
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="min-h-screen bg-slate-50 text-slate-900">
        <div className="mx-auto grid min-h-screen max-w-6xl gap-6 px-6 py-10 lg:grid-cols-[1.15fr_0.85fr]">
          <section className="relative overflow-hidden rounded-3xl border border-slate-200 bg-white p-8 shadow-sm md:p-10">
            <div className="absolute right-[-90px] top-[-90px] h-64 w-64 rounded-full bg-emerald-100 blur-3xl" />
            <div className="absolute bottom-[-100px] left-[-100px] h-72 w-72 rounded-full bg-sky-100 blur-3xl" />

            <div className="relative">
              <p className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-500">Soldi Semplici</p>
              <h1 className="mt-4 max-w-3xl text-4xl font-bold tracking-tight text-slate-950 md:text-6xl">
                Inizia a investire ogni mese, senza complicarti la vita.
              </h1>
              <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-600">
                Ti guidiamo passo passo: dal primo PAC alla gestione del portafoglio, fino alle strategie di uscita quando sarà il momento.
              </p>

              <div className="mt-8 grid gap-4 md:grid-cols-3">
                <FeatureCard title="Parti da zero" text="Rispondi a poche domande e ottieni un modello educativo semplice da capire." />
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
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
                  {authMode === "login" ? "Bentornato" : "Crea il tuo piano"}
                </p>
                <h2 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
                  {authMode === "login" ? "Accedi" : "Inizia gratis"}
                </h2>
                <p className="mt-3 text-sm leading-6 text-slate-600">
                  {authMode === "login"
                    ? "Rientra nel tuo percorso e continua da dove eri rimasto."
                    : "Crea un account per salvare il tuo piano e arrivare al modello senza pagare."}
                </p>
              </div>

              <div className="mt-6 flex rounded-2xl bg-slate-100 p-1">
                <button
                  type="button"
                  onClick={() => setAuthMode("register")}
                  className={`flex-1 rounded-xl px-4 py-3 text-sm font-medium transition ${
                    authMode === "register" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"
                  }`}
                >
                  Inizia gratis
                </button>
                <button
                  type="button"
                  onClick={() => setAuthMode("login")}
                  className={`flex-1 rounded-xl px-4 py-3 text-sm font-medium transition ${
                    authMode === "login" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"
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

                <div>
                  <label className="text-sm font-medium text-slate-700">Password</label>
                  <input
                    type="password"
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    placeholder="Inserisci la password"
                    className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                  />
                </div>

                {authMessage && (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                    {authMessage}
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleAuthSubmit}
                  disabled={authLoading}
                  className="w-full rounded-xl bg-slate-900 px-6 py-3 font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
                >
                  {authLoading ? "Attendi..." : authMode === "login" ? "Accedi" : "Crea account e inizia gratis"}
                </button>

                <button
                  type="button"
                  onClick={clearBrokenSession}
                  className="w-full rounded-xl border border-slate-200 bg-white px-6 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
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
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 md:py-8">
        <TopBar
          step={step}
          unlocked={purchase.unlocked}
          isProPlan={isProPlan}
          userEmail={user.email || ""}
          onGoHome={() => setStep("home")}
          onGoPortfolio={() => setStep("portfolio")}
          onGoGuide={() => setStep("guide")}
          onGoStrumentis={() => setStep("strumentis")}
          onGoDashboard={() => setStep("dashboard")}
          onGoRebalance={() => {
            void trackEvent("open_rebalance");
            setStep("rebalance");
          }}
          onGoExit={() => {
            void trackEvent("open_exit_strategy");
            setStep("exit");
          }}
          onLogout={handleLogout}
          onResetProfile={resetAll}
          resetLoading={profileResetLoading}
        />

        {profileResetMessage && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-sm">
            {profileResetMessage}
          </div>
        )}

        {showProUpgradeModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
            <div className="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-8 shadow-2xl">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Prima di passare al Pro</p>
              <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900">Il Pro e pensato per una fase piu avanzata</h2>
              <p className="mt-4 text-sm leading-6 text-slate-600">
                Il piano Pro e consigliato non prima del secondo anno e soprattutto quando il portafoglio presenta discostamenti importanti rispetto al modello. Se stai iniziando ora, il Core da 29 EUR/anno resta il piano piu adatto.
              </p>
              <div className="mt-5 rounded-2xl bg-slate-50 p-5 text-sm leading-6 text-slate-700">
                {isCorePlan ? (
                  <p>
                    Hai gia attivo il Core: per fare l'upgrade al Pro paghi solo la differenza tra 59 EUR e quanto hai gia pagato. Importo upgrade: <strong>{proPriceToPay} EUR</strong>.
                  </p>
                ) : (
                  <p>
                    Il Pro costa <strong>59 EUR/anno</strong>. Include tutte le funzioni Core piu ribilanciamento guidato, alert e supporto piu avanzato.
                  </p>
                )}
              </div>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-end">
                <button
                  onClick={cancelProUpgrade}
                  className="rounded-xl border border-slate-300 bg-white px-5 py-3 font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  Resto sul Core
                </button>
                <button
                  onClick={() => unlockPlan("pro")}
                  className="rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white transition hover:bg-slate-800"
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
                Inizia a investire ogni mese, senza complicarti la vita
              </h1>
              <p className="mt-5 max-w-3xl text-lg leading-8 text-slate-600">
                Soldi Semplici ti guida passo passo nella creazione del tuo primo PAC: un piano di investimento mensile pensato per costruire abitudine, continuita e consapevolezza.
              </p>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-500">
                L'app ha finalita educative e informative. Non sostituisce una consulenza finanziaria personalizzata e non promette rendimenti.
              </p>

              <div className="mt-8 grid gap-4 lg:grid-cols-3">
                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6">
                  <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">1. Capisci</p>
                  <h3 className="mt-2 text-xl font-bold tracking-tight">Cos'e un PAC?</h3>
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

              <div className="mt-8 rounded-3xl border border-slate-200 bg-slate-900 p-6 text-white">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-300">Percorso consigliato</p>
                    <h2 className="mt-2 text-2xl font-bold tracking-tight">Una cosa alla volta: test, modello, primo PAC.</h2>
                    <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
                      Le funzioni restano disponibili, ma il percorso principale e sempre uno: capire il metodo e completare il primo investimento mensile.
                    </p>
                  </div>
                  <button
                    onClick={() => purchase.unlocked ? setStep("dashboard") : startQuizFlow()}
                    className="rounded-2xl bg-white px-6 py-4 text-base font-semibold text-slate-900 transition hover:bg-slate-100"
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
                    "Non sostituisce studio, responsabilita e valutazione personale",
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
                Rispondi con attenzione e sincerita. Non esiste una risposta giusta: il risultato mostra un possibile modello educativo, non una raccomandazione personalizzata.
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Il risultato non serve a trovare il modello perfetto, ma a orientarti verso un metodo coerente con il tuo comportamento reale.
              </p>
              <p className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs leading-5 text-slate-500">
                {LEGAL_DISCLAIMER}
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
                          ? "border-slate-900 bg-slate-100 text-slate-900"
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
                  className="rounded-xl border border-slate-200 px-6 py-3 font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  Indietro
                </button>
                <button
                  onClick={nextQuestion}
                  disabled={!hasAnsweredCurrent}
                  className="rounded-xl bg-slate-900 px-6 py-3 font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
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

                    <button
                      onClick={startFreePlan}
                      className="rounded-xl bg-slate-900 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 lg:mt-2"
                    >
                      Continua gratis e configura il PAC
                    </button>
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
                <MetricCard label="Stabilita" value={scoreResult.totals.stabilita.toString()} />
                <MetricCard label="Equilibrio" value={scoreResult.totals.equilibrio.toString()} />
                <MetricCard label="Crescita" value={scoreResult.totals.crescita.toString()} />
              </div>

              <div className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Nota importante</p>
                <p className="mt-2 text-sm leading-6 text-slate-600">{LEGAL_DISCLAIMER}</p>
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
                    Hai costruito il tuo modello gratuito. Ora puoi trasformarlo in una guida pratica da seguire ogni mese, con strumenti semplici per capire cosa fare, quando controllare il portafoglio e come preparare l'uscita.
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
                <div className="bg-slate-900 p-8 text-white md:p-10">
                  <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-300">La logica e semplice</p>
                  <div className="mt-6 space-y-5">
                    <div className="rounded-2xl bg-white/10 p-5">
                      <p className="text-sm font-semibold text-slate-200">Gratis</p>
                      <p className="mt-1 text-2xl font-bold">Capisci il piano</p>
                    </div>
                    <div className="rounded-2xl bg-white/10 p-5">
                      <p className="text-sm font-semibold text-slate-200">Core</p>
                      <p className="mt-1 text-2xl font-bold">Segui il piano</p>
                    </div>
                    <div className="rounded-2xl bg-white/10 p-5">
                      <p className="text-sm font-semibold text-slate-200">Pro</p>
                      <p className="mt-1 text-2xl font-bold">Ottimizzi il piano</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <div className="relative rounded-3xl border-2 border-slate-900 bg-white p-8 shadow-sm">
                <div className="absolute right-6 top-6 rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white">
                  Consigliato primo anno
                </div>
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Core</p>
                <h3 className="mt-3 text-4xl font-bold tracking-tight">29 EUR / anno</h3>
                <p className="mt-4 text-sm leading-6 text-slate-600">
                  Il piano per chi sta iniziando: ti aiuta a trasformare il modello in una routine concreta, senza complicazioni.
                </p>
                <div className="mt-6 rounded-2xl bg-slate-50 p-5">
                  <p className="text-sm font-bold text-slate-900">Ideale se vuoi:</p>
                  <ul className="mt-3 space-y-3 text-sm leading-6 text-slate-700">
                    <li>• Seguire il tuo PAC mese dopo mese</li>
                    <li>• Usare dashboard, checklist e strumenti guidati</li>
                    <li>• Tenere traccia dei tuoi investimenti</li>
                    <li>• Costruire continuita con badge e streak</li>
                  </ul>
                </div>
                <button
                  onClick={() => unlockPlan("core")}
                  className="mt-8 w-full rounded-xl bg-slate-900 px-6 py-3 font-semibold text-white transition hover:bg-slate-800"
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
                  Il Pro e pensato per una fase piu matura: dal secondo anno, oppure quando il portafoglio cresce e vuoi gestire scostamenti, ribilanciamento e strategie di uscita.
                  {isCorePlan ? " Hai gia il Core: per passare al Pro paghi solo la differenza, " + proPriceToPay + " EUR." : ""}
                </p>
                <div className="mt-6 rounded-2xl bg-slate-50 p-5">
                  <p className="text-sm font-bold text-slate-900">Include tutto il Core, piu:</p>
                  <ul className="mt-3 space-y-3 text-sm leading-6 text-slate-700">
                    <li>• Ribilanciamento guidato con calcolo automatico</li>
                    <li>• Strategie di uscita a fine investimento</li>
                    <li>• Questionario guidato per scegliere la strategia piu coerente</li>
                    <li>• Supporto decisionale nei momenti critici</li>
                  </ul>
                </div>
                <div className="mt-5 rounded-2xl border border-blue-100 bg-blue-50 p-4 text-sm leading-6 text-blue-900">
                  <strong>Nota onesta:</strong> se stai iniziando ora, il Core e probabilmente sufficiente. Il Pro ha piu senso quando hai gia capitale investito e vuoi gestire scostamenti importanti.
                </div>
                <button
                  onClick={requestProUpgrade}
                  className="mt-8 w-full rounded-xl border border-slate-300 bg-white px-6 py-3 font-semibold text-slate-800 transition hover:bg-slate-50"
                >
                  {isCorePlan ? "Passa a Pro - paghi " + proPriceToPay + " EUR" : "Passa al livello avanzato - 59 EUR/anno"}
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
                  <p className="mt-2 text-sm leading-6 text-slate-600">Per chi ha gia iniziato e vuole gestire ribilanciamento, scostamenti e uscita dal PAC.</p>
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
            <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="max-w-3xl">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">Modello assegnato</p>
                      <h2 className="mt-3 text-4xl font-bold tracking-tight">{selectedPortfolio.title}</h2>
                      <p className="mt-2 inline-flex rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-700">
                        {selectedPortfolio.shortTitle} - {selectedPortfolio.badge}
                      </p>
                    </div>

                    <button
                      onClick={async () => {
                        if (purchase.unlocked) {
                          setStep("guide");
                        } else {
                          await trackEvent("click_paywall", { source: "portfolio_top_cta" });
                          setStep("paywall");
                        }
                      }}
                      className="rounded-xl bg-slate-900 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 lg:mt-2"
                    >
                      {purchase.unlocked ? "Vai alla guida operativa" : "Accedi alle funzioni complete"}
                    </button>
                  </div>

                  <p className="mt-5 text-lg leading-8 text-slate-600">{selectedPortfolio.intro}</p>
                  <p className="mt-4 text-base leading-7 text-slate-600">{selectedPortfolio.whyItFits}</p>
                </div>

                <div className="w-full max-w-xl">
                  <PortfolioPieChart composition={selectedPortfolio.composition} />
                </div>
              </div>

              <div className="mt-8 grid gap-4 md:grid-cols-3">
                <MetricCard label="Rendimento medio" value={selectedPortfolio.historical.average} />
                <MetricCard label="Peggior drawdown" value={selectedPortfolio.historical.maxDrawdown} />
                <MetricCard label="Tempo recupero" value={selectedPortfolio.historical.recovery} />
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
                  Il modello e le categorie mostrate hanno finalita informative. Gli eventuali strumenti indicati sono esempi e non costituiscono raccomandazioni operative.
                </p>
              </div>


            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <h3 className="text-xl font-semibold">Guida PAC educativa passo passo</h3>
                <ol className="mt-4 space-y-3 text-sm leading-7 text-slate-700">
                  {selectedPortfolio.pacGuide.map((stepText, index) => (
                    <li key={stepText} className="flex gap-3">
                      <span className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
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
                Qui puoi provare una simulazione piu personale in base al tuo profilo.
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
                <button
                  onClick={() => setStep("guide")}
                  className="mt-5 rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-700"
                >
                  Vai alla guida operativa
                </button>
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
                  className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
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
                    {nextGuideAction && (
                      <button
                        onClick={nextGuideAction.onClick}
                        className="rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-700"
                      >
                        {nextGuideAction.label}
                      </button>
                    )}
                    <button
                      onClick={() => toggleChecklist(nextGuideItem.id)}
                      className="rounded-xl border border-emerald-200 bg-white px-5 py-3 text-sm font-semibold text-emerald-800 transition hover:bg-emerald-100"
                    >
                      Segna come completato
                    </button>
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
                />
                <ChecklistGroup
                  title="Mantenimento nel tempo"
                  subtitle={`Queste abitudini non bloccano il setup. Completate: ${completedMaintenanceChecklist}/${maintenanceChecklistItems.length}`}
                  items={maintenanceChecklistItems}
                  state={checklistState}
                  onToggle={toggleChecklist}
                  getToolAction={getChecklistToolAction}
                  nextItemId={nextGuideItem?.id}
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
              <h2 className="text-3xl font-bold tracking-tight">Foglio strumenti con ISIN / esempi</h2>
              <p className="mt-3 max-w-4xl text-slate-600">
                Scegli un strumenti per ogni categoria presente nel tuo modello e rispetta le percentuali indicate.
                Puoi usare anche strumenti diversi da quelli riportati qui, ma devi assicurarti che la tipologia resti la stessa.
              </p>
              <button
                onClick={() => setStep("guide")}
                className="mt-6 rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
              >
                Torna alla guida operativa
              </button>
            </div>

            <div className="grid gap-4">
              {Object.entries(strumentiLibrary).map(([category, rows]) => (
                <div key={category} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h3 className="text-xl font-semibold">{category}</h3>
                  <div className="mt-4 overflow-x-auto">
                    <table className="min-w-full border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50">
                          <th className="px-4 py-3 text-left font-semibold">Strumenti</th>
                          <th className="px-4 py-3 text-left font-semibold">ISIN / esempi</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr key={`${category}-${row.isin}-${row.name}`} className="border-b border-slate-100">
                            <td className="px-4 py-3">{row.name}</td>
                            <td className="px-4 py-3 font-mono text-xs">{row.isin}</td>
                          </tr>
                        ))}
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
                    Tre passaggi rapidi: obiettivo, PAC mensile e anno finale. Dopo arrivi alla guida operativa con il piano gia impostato.
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
                        placeholder="Es. Liberta finanziaria"
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
                      Scegli una cifra sostenibile. Un PAC piccolo ma regolare vale piu di uno grande che abbandoni.
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
                  className="rounded-xl bg-slate-900 px-6 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
                >
                  {onboardingStep < 2 ? "Continua" : "Vai alla guida operativa"}
                </button>
              </div>
            </div>
          </section>
        )}

        {step === "dashboard" && (
          <section className="space-y-6">
            <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                <div className="max-w-3xl">
                  <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">Percorso guidato</p>
                  <h2 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">Il tuo percorso finanziario guidato</h2>
                  <p className="mt-4 text-base leading-7 text-slate-600">
                    Numeri, abitudini e obiettivi nello stesso posto: uno strumento educativo per seguire il metodo nel tempo.
                  </p>
                </div>

                <div className="grid w-full max-w-2xl gap-4 md:grid-cols-3">
                  <PremiumStatCard
                    eyebrow="Capitale"
                    value={formatEuro(totalInvested)}
                    note="Totale registrato"
                  />
                  <PremiumStatCard
                    eyebrow="Modello"
                    value={selectedPortfolio.shortTitle}
                    note={selectedPortfolio.badge}
                  />
                  <PremiumStatCard
                    eyebrow="Continuita"
                    value={`${currentStreak} mesi`}
                    note="PAC mantenuto"
                  />
                </div>
              </div>
            </div>

            <div id="prima-volta-qui" className="scroll-mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Checklist</p>
                  <h3 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">La tua checklist: segui questi passi, uno alla volta</h3>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                    Tutti gli strumenti sono gia disponibili. Questa è la sezione più importante dopo il piano: ti dice cosa fare, in che ordine e dove cliccare.
                  </p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-800">
                  Guida iniziale: {completedInitialChecklist}/{initialChecklistItems.length}
                </div>
              </div>

              <div className="mt-6 grid gap-4 lg:grid-cols-5">
                <GuidedStepCard
                  number="1"
                  title="Capisci il modello"
                  text="Leggi la logica del portafoglio educativo prima di inserire dati."
                  action="Vai al modello"
                  done={purchase.unlocked}
                  onClick={() => setStep("portfolio")}
                />
                <GuidedStepCard
                  number="2"
                  title="Scegli la cifra mensile"
                  text="Usa la simulazione per capire una cifra sostenibile, non perfetta."
                  action="Apri simulazione"
                  done={Number(portMonthly || 0) > 0}
                  onClick={() => setStep("portfolio")}
                />
                <GuidedStepCard
                  number="3"
                  title="Vai alla guida operativa"
                  text="Prima degli strumenti, segui la guida per capire cosa fare e in che ordine."
                  action="Apri guida"
                  done={setupCompleted}
                  onClick={() => setStep("guide")}
                />
                <GuidedStepCard
                  number="4"
                  title="Guarda gli strumenti"
                  text="Vedi categorie ed esempi con ISIN, senza perderti tra troppe scelte."
                  action="Apri strumenti"
                  done={checklistState.strumenti || holdings.length > 0}
                  onClick={() => {
                    completeChecklistItem("strumenti");
                    setStep("strumentis");
                  }}
                />
                <GuidedStepCard
                  number="5"
                  title="Registra il primo PAC"
                  text="Inserisci il primo investimento per rendere il piano concreto."
                  action="Aggiungi investimento"
                  done={holdings.length > 0}
                  onClick={() => goToDashboardSection("aggiungi-investimento")}
                />
                <GuidedStepCard
                  number="6"
                  title="Chiudi il mese"
                  text="Controlla la ripartizione e segna il PAC del mese come completato."
                  action="Vai al PAC mensile"
                  done={currentMonthCompleted}
                  onClick={() => goToDashboardSection("azione-del-mese")}
                />
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Nota educativa</p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                La dashboard serve a monitorare abitudini, PAC e consapevolezza nel tempo. Non fornisce raccomandazioni personalizzate ne indicazioni di acquisto o vendita.
              </p>
            </div>

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
                  Progresso nel tempo
                </p>
                <h3 className="mt-3 text-2xl font-bold tracking-tight text-slate-900">
                  Da {formatEuro(progressStartNumber || 0)} a {formatEuro(goalCurrentNumber || 0)}
                </h3>
                <p className={`mt-3 text-3xl font-bold tracking-tight ${
                  progressTone === "positivo"
                    ? "text-emerald-700"
                    : progressTone === "negativo"
                    ? "text-amber-700"
                    : "text-slate-900"
                }`}>
                  {progressDelta >= 0 ? "+" : ""}{formatEuro(progressDelta)}
                </p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Punto di partenza: {progressStartLabel}. Oggi: {currentMonthLabel}.
                  {progressStartNumber > 0
                    ? ` Variazione: ${progressDeltaPercent >= 0 ? "+" : ""}${progressDeltaPercent.toFixed(1)}%.`
                    : " Aggiorna il capitale per rendere visibile la crescita nel tempo."}
                </p>
                <div className="mt-5 h-3 overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full rounded-full bg-slate-900 transition-all duration-1000 ease-out"
                    style={{
                      width: `${goalTargetNumber > 0 ? Math.min(100, (goalCurrentNumber / goalTargetNumber) * 100) : 0}%`,
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
                          : "bg-slate-900 text-white hover:bg-slate-800"
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
                    Il PAC e un Piano di Accumulo mensile: il risultato non nasce da un singolo investimento, ma dalla ripetizione del gesto nel tempo.
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
                      ? "Ogni mese completato mantiene viva la catena. Non serve fare di piu: serve non interromperla."
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
                    Pochi suggerimenti, solo quando servono. L'obiettivo e ridurre dubbi e aiutarti a seguire il piano.
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
                        Aggiorna manualmente il valore reale del tuo capitale: cosi la barra tiene conto anche di mercato, prelievi e variazioni non visibili negli holdings.
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
                  </div>
                </div>

                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6">
                  <h4 className="text-lg font-semibold text-slate-900">
                    Aggiorna obiettivo
                  </h4>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Inserisci manualmente il valore aggiornato del capitale. Questo dato puo includere fluttuazioni di mercato, prelievi o variazioni che gli holdings non mostrano. Non serve aggiornarlo ogni giorno: usalo per avere consapevolezza, non per reagire al mercato.
                  </p>

                  <div className="mt-5 space-y-4">
                    <div>
                      <label className="text-sm font-medium text-slate-700">
                        Nome obiettivo
                      </label>
                      <input
                        value={goalTitle}
                        onChange={(e) => setGoalTitle(e.target.value)}
                        placeholder="Es. Liberta finanziaria"
                        className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
                      />
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label className="text-sm font-medium text-slate-700">
                          Valore attuale aggiornato
                        </label>
                        <input
                          value={goalCurrentValue}
                          onChange={(e) => setGoalCurrentValue(e.target.value)}
                          placeholder="Es. 12000"
                          className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
                        />
                      </div>

                      <div>
                        <label className="text-sm font-medium text-slate-700">
                          Valore precedente
                        </label>
                        <input
                          value={goalPreviousValue}
                          onChange={(e) => setGoalPreviousValue(e.target.value)}
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
                          value={goalTarget}
                          onChange={(e) => setGoalTarget(e.target.value)}
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
                          value={goalEndYear}
                          onChange={(e) => setGoalEndYear(e.target.value)}
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
                        {goalDurationYears} anni - {goalDurationMonths} mesi
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        Calcolata automaticamente dall'anno corrente fino al {safeGoalEndYear}.
                      </p>
                    </div>

                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                        Salvataggio
                      </p>
                      <p className="mt-2 text-sm leading-6 text-emerald-900">
                        I dati dell'obiettivo e il PAC mensile vengono salvati automaticamente su Supabase e ricaricati dopo refresh o nuovo accesso.
                      </p>
                    </div>

                    <div>
                      <label className="text-sm font-medium text-slate-700">
                        Motivo del cambiamento
                      </label>
                      <select
                        value={goalReason}
                        onChange={(e) => setGoalReason(e.target.value as GoalChangeReason)}
                        className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
                      >
                        <option value="stabile">Aggiornamento periodico</option>
                        <option value="investimento">Nuovo investimento</option>
                        <option value="prelievo">Ho usato parte dei soldi</option>
                        <option value="mercato">Oscillazione di mercato</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="text-sm font-medium uppercase tracking-[0.2em] text-slate-500">Storico PAC</p>
                  <h3 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">Controlla la continuita nel tempo</h3>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                    Qui trovi gli ultimi 12 mesi. Puoi correggere un mese se serve: i dati restano salvati su Supabase.
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4 text-sm font-semibold text-slate-700">
                  {currentMonthCompleted
                    ? `Mese corrente completato`
                    : `Mese corrente da completare`}
                </div>
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-4">
                <div className="rounded-2xl bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Mesi completati</p>
                  <p className="mt-2 text-2xl font-bold text-slate-900">{pacCompletedMonths}/{pacHistory.length}</p>
                </div>
                <div className="rounded-2xl bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Continuita attuale</p>
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
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Focus del mese</p>
                <p className="mt-3 text-lg font-semibold text-slate-900">
                  {currentMonthEntry?.completed ? "Mantieni il ritmo" : "Completa il PAC del mese"}
                </p>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {currentMonthEntry?.completed
                    ? "Hai gia fatto il passo piu importante: ora evita decisioni impulsive."
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

            <div id="aggiungi-investimento" className="grid scroll-mt-6 gap-6 xl:grid-cols-[0.95fr_1.2fr_1fr]">
              <div className="space-y-6">
                <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h3 className="text-xl font-semibold">Aggiungi investimento</h3>
                  <p className="mt-2 text-sm text-slate-600">
                    Registra gli strumenti acquistati per avere una dashboard sempre aggiornata.
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
                          const strumenti = strumentiLibrary[newHolding.category].find((item) => item.name === e.target.value);
                          if (!strumenti) return;
                          setNewHolding((prev) => ({ ...prev, strumentiName: strumenti.name, isin: strumenti.isin }));
                        }}
                        className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none"
                      >
                        {strumentiLibrary[newHolding.category].map((strumenti) => (
                          <option key={strumenti.isin + strumenti.name} value={strumenti.name}>{strumenti.name}</option>
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
                      className="w-full rounded-xl bg-slate-900 px-6 py-3 font-medium text-white transition hover:bg-slate-800"
                    >
                      Salva investimento
                    </button>
                  </div>
                </div>

                <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h3 className="text-xl font-semibold">Lettura rapida</h3>
                  <div className="mt-4 space-y-3">
                    <InsightCard
                      title="Categoria principale"
                      text={
                        mostWeightedCategory
                          ? `${mostWeightedCategory.category} e oggi l'area piu pesante del modello.`
                          : "Non hai ancora categorie attive: il primo investimento attivera la dashboard."
                      }
                    />
                    <InsightCard
                      title="Scostamento piu importante"
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
                      text="L'obiettivo non e prevedere il mercato, ma mantenere il modello coerente con il piano assegnato."
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-6">
                <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 id="ripartizione-attuale" className="scroll-mt-6 text-xl font-semibold">Ripartizione attuale</h3>
                      <p className="mt-1 text-sm text-slate-600">
                        Dove si concentra oggi il tuo capitale.
                      </p>
                    </div>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                      {dashboardBreakdown.length} categorie
                    </span>
                  </div>

                  {dashboardBreakdown.length === 0 ? (
                    <div className="mt-5 rounded-2xl bg-slate-50 p-5 text-sm text-slate-500">
                      Aggiungi il primo investimento per vedere la ripartizione del capitale.
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

                <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h3 id="i-tuoi-investimenti" className="scroll-mt-6 text-xl font-semibold">I tuoi investimenti</h3>
                  {holdings.length === 0 ? (
                    <p className="mt-4 text-sm text-slate-500">Non hai ancora inserito investimenti.</p>
                  ) : (
                    <div className="mt-4 space-y-3">
                      {holdings.map((item) => (
                        <div
                          key={item.id}
                          className="flex flex-col gap-3 rounded-2xl border border-slate-200 p-4 md:flex-row md:items-center md:justify-between"
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
                <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 id="pac-mensile" className="scroll-mt-6 text-xl font-semibold">Esempio PAC mensile</h3>
                      <p className="mt-1 text-sm text-slate-600">
                        Inserisci un importo mensile e l'app mostra una possibile ripartizione educativa secondo il modello.
                      </p>
                    </div>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                      esecuzione guidata
                    </span>
                  </div>

                  <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <label className="text-sm font-medium text-slate-700">PAC mensile da distribuire</label>
                    <input
                      value={portMonthly}
                      onChange={(e) => setPortMonthly(e.target.value)}
                      placeholder="Es. 200"
                      className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 outline-none transition focus:border-slate-400"
                    />
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      Questo e esattamente cosa fare questo mese: la cifra viene salvata, resta dopo il refresh e viene divisa automaticamente secondo il modello. Non serve essere preciso al centesimo: segui le proporzioni.
                    </p>
                  </div>

                  <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">Guida operativa del mese</p>
                        <p className="mt-1 text-xs leading-5 text-slate-500">
                          Spunta ogni quota dopo averla eseguita. Serve come guida pratica, non come registrazione contabile.
                        </p>
                      </div>
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        allocationChecklistComplete
                          ? "bg-emerald-100 text-emerald-800"
                          : "bg-slate-100 text-slate-700"
                      }`}>
                        {checkedAllocationCount}/{monthlyAllocationPlan.length} completate
                      </span>
                    </div>

                    <div className="mt-4 h-3 overflow-hidden rounded-full bg-slate-200">
                      <div
                        className="h-full rounded-full bg-emerald-600 transition-all duration-700"
                        style={{
                          width: `${monthlyAllocationPlan.length > 0 ? (checkedAllocationCount / monthlyAllocationPlan.length) * 100 : 0}%`,
                        }}
                      />
                    </div>
                  </div>

                  <div className="mt-5 space-y-3">
                    {monthlyAllocationPlan.map((item) => {
                      const checked = !!checkedPacAllocations[item.category];

                      return (
                        <button
                          key={`pac-${item.label}-${item.category}`}
                          onClick={() =>
                            setCheckedPacAllocations((prev) => ({
                              ...prev,
                              [item.category]: !prev[item.category],
                            }))
                          }
                          className={`w-full rounded-2xl border p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm ${
                            checked
                              ? "border-emerald-300 bg-emerald-50"
                              : "border-slate-200 bg-white hover:bg-slate-50"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-4">
                            <div className="flex items-start gap-3">
                              <span className={`mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                                checked
                                  ? "bg-emerald-600 text-white"
                                  : "bg-slate-100 text-slate-400 ring-1 ring-slate-200"
                              }`}>
                                {checked ? "✓" : ""}
                              </span>
                              <div>
                                <p className="font-semibold text-slate-900">{item.label}</p>
                                <p className="mt-1 text-sm text-slate-500">{item.percentage}% del PAC mensile</p>
                              </div>
                            </div>
                            <div className="text-right">
                              <p className="text-xl font-bold tracking-tight text-slate-900">
                                {formatEuro(item.roundedAmount)}
                              </p>
                              <p className="mt-1 text-xs text-slate-500">
                                valore preciso: {formatEuro(item.rawAmount)}
                              </p>
                            </div>
                          </div>

                          <div className="mt-4 h-3 overflow-hidden rounded-full bg-slate-200">
                            <div
                              className={`h-full rounded-full transition-all duration-700 ${
                                checked ? "bg-emerald-600" : "bg-slate-900"
                              }`}
                              style={{ width: `${Math.min(item.percentage, 100)}%` }}
                            />
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {allocationChecklistComplete && (
                    <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                      <p className="text-sm font-semibold text-emerald-900">
                        Checklist PAC completata. Ora il mese e davvero operativo.
                      </p>
                      <p className="mt-1 text-xs leading-5 text-emerald-700">
                        Se hai gia eseguito anche il versamento mensile, ricordati di chiudere il PAC del mese nel blocco principale.
                      </p>
                    </div>
                  )}

                  <div className="mt-6 border-t border-slate-200 pt-5">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">Controllo allineamento attuale</p>
                        <p className="mt-1 text-xs text-slate-500">
                          Qui sotto vedi se gli investimenti registrati sono vicini al target.
                        </p>
                      </div>
                      <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                        modello attuale
                      </span>
                    </div>
                  </div>

                  <div className="mt-5 space-y-4">
                    {targetCoverage.map((item) => (
                      <div key={`${item.label}-${item.category}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <p className="font-semibold text-slate-900">{item.label}</p>
                            <p className="mt-1 text-sm text-slate-500">{formatEuro(item.currentAmount)}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-medium text-slate-700">
                              {item.currentPercentage}% / {item.targetPercentage}%
                            </p>
                            <p className={`mt-1 text-xs font-semibold uppercase tracking-wide ${
                              item.delta === 0
                                ? "text-emerald-700"
                                : item.delta > 0
                                ? "text-amber-700"
                                : "text-sky-700"
                            }`}>
                              {item.delta === 0
                                ? "in linea"
                                : item.delta > 0
                                ? `sovrappeso +${item.delta}%`
                                : `sottopeso ${item.delta}%`}
                            </p>
                          </div>
                        </div>

                        <div className="mt-4">
                          <div className="mb-2 flex justify-between text-[11px] uppercase tracking-wide text-slate-500">
                            <span>Attuale</span>
                            <span>Target {item.targetPercentage}%</span>
                          </div>
                          <div className="relative h-3 overflow-hidden rounded-full bg-slate-200">
                            <div
                              className="h-full rounded-full bg-slate-900"
                              style={{ width: `${Math.min(item.currentPercentage, 100)}%` }}
                            />
                            <div
                              className="absolute top-0 h-3 w-[2px] bg-emerald-600"
                              style={{ left: `${Math.min(item.targetPercentage, 100)}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                    <p className="text-sm text-emerald-900">
                      Usa il piano PAC mensile per eseguire senza fare calcoli. Il controllo sotto resta utile per capire se il modello registrato si sta allontanando dal target.
                    </p>
                  </div>
                </div>

                <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-xl font-semibold">Badge del percorso</h3>
                      <p className="mt-1 text-sm text-slate-600">
                        Ogni badge rappresenta un comportamento reale: setup, PAC, continuita e capitale costruito.
                      </p>
                    </div>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                      {unlockedBadges.length}/{badges.length} badge
                    </span>
                  </div>

                  <div className={`mt-5 rounded-3xl border p-5 ${
                    nextBadge
                      ? "border-amber-300 bg-gradient-to-br from-amber-50 to-white"
                      : "border-emerald-300 bg-gradient-to-br from-emerald-50 to-white"
                  }`}>
                    <div className="flex items-start gap-4">
                      <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-xl ${
                        nextBadge ? "bg-amber-500 text-white" : "bg-emerald-600 text-white"
                      }`}>
                        {nextBadge ? "🎯" : "🏆"}
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                          {nextBadge ? "Prossimo badge" : "Percorso completato"}
                        </p>
                        <p className="mt-2 text-xl font-bold tracking-tight text-slate-900">
                          {nextBadge ? nextBadge.title : "Tutti i badge sbloccati"}
                        </p>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                          {nextBadge ? nextBadge.description : "Hai completato tutti i badge disponibili in questa fase."}
                        </p>
                        <p className="mt-3 rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-slate-800 ring-1 ring-slate-200">
                          {nextBadgeAction}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-3">
                    {badges.map((badge) => (
                      <div
                        key={badge.id}
                        className={`rounded-2xl border p-4 transition-all duration-200 ${
                          badge.unlocked
                            ? "border-amber-300 bg-amber-50 shadow-sm"
                            : nextBadge?.id === badge.id
                            ? "border-slate-300 bg-white ring-2 ring-amber-200"
                            : "border-slate-200 bg-slate-50 opacity-75"
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <div
                            className={`flex h-10 w-10 items-center justify-center rounded-full text-lg ${
                              badge.unlocked
                                ? "bg-amber-500 text-white"
                                : nextBadge?.id === badge.id
                                ? "bg-slate-900 text-white"
                                : "bg-slate-200 text-slate-500"
                            }`}
                          >
                            {badge.unlocked ? "🏅" : nextBadge?.id === badge.id ? "🎯" : "🔒"}
                          </div>
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-semibold text-slate-900">{badge.title}</p>
                              {nextBadge?.id === badge.id && (
                                <span className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-amber-800">
                                  prossimo
                                </span>
                              )}
                            </div>
                            <p className="mt-1 text-sm leading-6 text-slate-600">{badge.description}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}        {showRetakeWarning && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
            <div className="w-full max-w-2xl rounded-3xl bg-white p-6 shadow-2xl">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Rifare il questionario</p>
              <h3 className="mt-3 text-2xl font-bold tracking-tight text-slate-900">
                Sei sicuro di voler cambiare il tuo piano?
              </h3>

              <p className="mt-4 text-sm leading-6 text-slate-600">
                Il questionario va fatto con attenzione: non esiste una risposta giusta e il risultato e un modello educativo, non una raccomandazione personalizzata.
              </p>

              <p className="mt-3 text-sm leading-6 text-slate-600">
                Rifarlo spesso puo cambiare modello, PAC e riferimenti della dashboard. Questo rischia di spostare il focus dal metodo alla ricerca continua di un risultato diverso.
              </p>

              {retakeMeta.count > 0 && (
                <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                  <p className="text-sm font-semibold text-amber-900">
                    Hai gia rifatto il test {retakeMeta.count} {retakeMeta.count === 1 ? "volta" : "volte"}.
                  </p>
                  <p className="mt-1 text-sm leading-6 text-amber-800">
                    La costanza e piu importante della ricerca del modello perfetto.
                  </p>
                </div>
              )}

              {retakeIsBlocked ? (
                <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4">
                  <p className="text-sm font-semibold text-red-900">
                    Per proteggere la coerenza del piano, potrai rifare il test tra {retakeDaysRemaining} {retakeDaysRemaining === 1 ? "giorno" : "giorni"}.
                  </p>
                  <p className="mt-1 text-sm leading-6 text-red-800">
                    Nel frattempo continua con il modello attuale: cambiare spesso puo indebolire il percorso.
                  </p>
                </div>
              ) : (
                <div className="mt-4">
                  <label className="text-sm font-medium text-slate-700">
                    Perche vuoi rifarlo?
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

        {step === "rebalance" && (
          <section className="space-y-6">
            {!isProPlan ? (
              <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Funzione Pro</p>
                <h2 className="mt-3 text-3xl font-bold tracking-tight">Ribilanciamento guidato</h2>
                <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
                  Questa sezione e inclusa nel piano Pro da 59 EUR/anno. Il Core resta il piano consigliato per il primo anno; il Pro ha senso quando hai gia iniziato e vuoi monitorare gli scostamenti dal modello.
                </p>
                <button
                  onClick={requestProUpgrade}
                  className="mt-6 rounded-xl bg-slate-900 px-6 py-3 font-semibold text-white transition hover:bg-slate-800"
                >
                  {isCorePlan ? "Passa a Pro - paghi " + proPriceToPay + " EUR" : "Vedi piano Pro"}
                </button>
              </div>
            ) : (
              <>
                <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
                  <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Piano Pro</p>
                  <h2 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">Ribilanciamento guidato</h2>
                  <p className="mt-4 max-w-4xl text-base leading-7 text-slate-600">
                    Confronta la tua ripartizione attuale con il modello educativo e valuta come orientare i prossimi PAC per avvicinarti gradualmente al piano. Non e una raccomandazione di acquisto o vendita: e un calcolatore educativo di scostamento.
                  </p>
                </div>

                <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr]">
                  <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <h3 className="text-xl font-bold tracking-tight">Dati del calcolatore</h3>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                          Inserisci il valore attuale di ogni asset. Il calcolo confronta questi dati con il modello e mostra dove sei sopra o sotto peso.
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          const nextValues: Partial<Record<StrumentiCategory, string>> = {};
                          selectedPortfolio.composition.forEach((item) => {
                            nextValues[item.category] = String(investedByCategory[item.category] || 0);
                          });
                          setRebalanceValues(nextValues);
                        }}
                        className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                      >
                        Carica dalla dashboard
                      </button>
                    </div>

                    <div className="mt-5 grid gap-4 sm:grid-cols-2">
                      <label className="block">
                        <span className="text-sm font-medium text-slate-700">PAC mensile disponibile per il riequilibrio</span>
                        <input
                          type="number"
                          min="0"
                          value={rebalancePacAmount}
                          onChange={(e) => setRebalancePacAmount(e.target.value)}
                          placeholder="Es. 200"
                          className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                        />
                      </label>
                      <div className="rounded-2xl bg-slate-50 p-4 text-sm leading-6 text-slate-600">
                        Inserisci il PAC mensile e i valori attuali qui sotto: l'app calcola da sola per quanti mesi orientare temporaneamente il PAC verso gli asset sotto peso.
                      </div>
                    </div>

                    <div className="mt-6 rounded-3xl border border-slate-200 bg-slate-50 p-5">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                        <div>
                          <h4 className="text-base font-bold text-slate-900">Valori attuali per asset</h4>
                          <p className="mt-1 text-sm leading-6 text-slate-600">
                            Inserisci quanti euro hai oggi in ogni categoria del tuo modello. Questi valori guidano tutto il calcolo dello scostamento.
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
                          <label key={item.category} className="block rounded-2xl border border-slate-200 bg-white p-4">
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
                              className="mt-3 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400"
                            />
                          </label>
                        ))}
                      </div>
                    </div>

                    <div className="mt-5 rounded-2xl bg-slate-50 p-4 text-sm leading-6 text-slate-600">
                      Patrimonio inserito: <strong>{formatEuro(rebalanceTotalInvested)}</strong> · PAC mensile disponibile: <strong>{formatEuro(rebalancePacNumber)}</strong>{rebalanceMonthsNumber > 0 ? <> · Rientro simulato: <strong>{rebalanceMonthsNumber}</strong> {rebalanceMonthsNumber === 1 ? "mese" : "mesi"} ({formatEuro(totalRebalanceBudget)} di nuovi PAC).</> : null}
                    </div>
                    <p className="mt-4 text-xs leading-5 text-slate-500">
                      Puoi inserire i valori manualmente oppure caricarli dagli investimenti registrati nella dashboard. Il risultato resta educativo e non costituisce consulenza personalizzata.
                    </p>
                  </div>

                  <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                    <h3 className="text-xl font-bold tracking-tight">Lettura dello scostamento</h3>
                    <p className="mt-3 text-sm leading-6 text-slate-600">{rebalanceStatus}</p>
                    <div className="mt-5 space-y-3">
                      {rebalanceCoverage.map((item) => (
                        <div key={item.category} className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
                          <div className="flex items-center justify-between gap-4 text-sm">
                            <span className="flex items-center gap-2 font-semibold text-slate-900">
                              <span className="h-3 w-3 rounded-full" style={{ backgroundColor: getAssetColor(item.category) }} />
                              {item.label}
                            </span>
                            <span className={item.delta > 0 ? "font-bold text-red-600" : item.delta < 0 ? "font-bold text-blue-600" : "font-bold text-emerald-600"}>
                              {item.delta > 0 ? "+" : ""}{item.delta}%
                            </span>
                          </div>
                          <p className="mt-2 text-xs text-slate-500">Attuale {item.currentPercentage}% ({formatEuro(item.currentAmount)}) · Modello {item.targetPercentage}%</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                    <div>
                      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Output educativo</p>
                      <h3 className="mt-2 text-2xl font-bold tracking-tight">Possibile orientamento dei prossimi PAC</h3>
                    </div>
                    {rebalanceBiggestGap && (
                      <div className="rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
                        Scostamento maggiore: <strong>{rebalanceBiggestGap.label}</strong> ({rebalanceBiggestGap.delta > 0 ? "+" : ""}{rebalanceBiggestGap.delta}%)
                      </div>
                    )}
                  </div>

                  {rebalanceTotalInvested <= 0 ? (
                    <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-900">
                      Inserisci prima i valori attuali dei tuoi asset oppure caricali dalla dashboard.
                    </div>
                  ) : (
                    <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                      {rebalancePlan.map((item) => (
                        <div key={item.category} className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                          <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: getAssetColor(item.category) }} />
                            {item.label}
                          </p>
                          <p className="mt-3 text-3xl font-bold tracking-tight">{item.suggestedPercentage}%</p>
                          <p className="mt-2 text-sm text-slate-600">Circa {formatEuro(item.roundedAmount)} al mese{rebalanceMonthsNumber > 0 ? <> per {rebalanceMonthsNumber} {rebalanceMonthsNumber === 1 ? "mese" : "mesi"}</> : null}.</p>
                          {rebalanceMonthsNumber > 0 && <p className="mt-1 text-xs text-slate-500">Totale simulato: {formatEuro(item.totalAmount)}.</p>}
                        </div>
                      ))}
                    </div>
                  )}

                  {rebalanceTotalInvested > 0 && (
                    <div className="mt-6 space-y-4">
                      <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50 p-5">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-700">Soluzione piu auspicabile</p>
                            <p className="mt-2 text-lg font-bold text-slate-900">Rientro graduale usando solo i prossimi PAC</p>
                          </div>
                          {automaticRebalance.feasible && <span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-emerald-700">circa {rebalanceMonthsNumber} {rebalanceMonthsNumber === 1 ? "mese" : "mesi"}</span>}
                        </div>
                        <p className="mt-3 text-sm leading-6 text-slate-700">
                          Pro: non richiede vendite, riduce il rischio di decisioni impulsive e usa il nuovo capitale per riportare il portafoglio verso il modello. Contro: se lo scostamento e grande puo richiedere diversi mesi e nel frattempo il portafoglio resta parzialmente sbilanciato.
                        </p>
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
                          <p className="text-sm font-bold text-slate-900">Alternativa 1: vendere e riallocare</p>
                          <p className="mt-2 text-sm leading-6 text-slate-700">
                            Puoi simulare la vendita delle categorie sopra peso e l'acquisto di quelle sotto peso. Scostamento stimato da riallocare: <strong>{formatEuro(estimatedSaleAmount)}</strong>.
                          </p>
                          <p className="mt-3 rounded-xl bg-white p-3 text-xs leading-5 text-amber-900">
                            Attenzione: vendere strumenti in guadagno puo generare tasse sulla plusvalenza. In Italia l'aliquota ordinaria sulle plusvalenze finanziarie e generalmente il 26%, salvo casi particolari. Verifica sempre fiscalita e costi prima di agire.
                          </p>
                        </div>
                        <div className="rounded-2xl border border-slate-200 bg-white p-5">
                          <p className="text-sm font-bold text-slate-900">Alternativa 2: PAC temporaneamente piu alto</p>
                          <p className="mt-2 text-sm leading-6 text-slate-600">
                            Se vuoi rientrare prima senza vendere, puoi aumentare temporaneamente il PAC a circa <strong>{formatEuro(acceleratedRebalancePac)}</strong> al mese per circa <strong>{acceleratedRebalanceMonths} {acceleratedRebalanceMonths === 1 ? "mese" : "mesi"}</strong>, mantenendo la stessa ripartizione temporanea proposta sopra.
                          </p>
                          <p className="mt-3 text-xs leading-5 text-slate-500">
                            Pro: accelera il rientro ed evita vendite. Contro: richiede maggiore liquidita mensile per un periodo limitato.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm leading-6 text-slate-600">
                    Lettura pratica: se una categoria e molto sopra il modello, il calcolatore tende a non aumentarla nei PAC temporanei; orienta invece il nuovo capitale verso le categorie sotto peso. Quando il portafoglio torna vicino al modello, puoi riprendere il PAC ordinario e ricontrollare lo scostamento periodicamente.
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
                  Questa sezione e inclusa nel piano Pro da 59 EUR/anno. Serve quando il capitale e cresciuto e vuoi pianificare come ridurre il rischio, vendere gradualmente o trasformare il capitale in rendita.
                </p>
                <button
                  onClick={requestProUpgrade}
                  className="mt-6 rounded-xl bg-slate-900 px-6 py-3 font-semibold text-white transition hover:bg-slate-800"
                >
                  {isCorePlan ? "Passa a Pro - paghi " + proPriceToPay + " EUR" : "Vedi piano Pro"}
                </button>
              </div>
            ) : (
              <>
                <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
                  <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Piano Pro</p>
                  <h2 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">Strategia di uscita guidata</h2>
                  <p className="mt-4 max-w-4xl text-base leading-7 text-slate-600">
                    Questa sezione ti aiuta a scegliere come uscire da un PAC a fine percorso. Puoi farti guidare da un questionario oppure scegliere manualmente una strategia. Il nostro consiglio viene salvato, ma le altre opzioni restano sempre disponibili.
                  </p>
                  <div className="mt-6 grid gap-3 md:grid-cols-2">
                    <button
                      type="button"
                      onClick={openExitQuestionnaire}
                      className={`rounded-2xl border p-5 text-left transition ${exitMode === "questionario" ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-white"}`}
                    >
                      <span className="block text-sm font-bold">Non so cosa scegliere: guidami</span>
                      <span className={`mt-1 block text-xs leading-5 ${exitMode === "questionario" ? "text-slate-200" : "text-slate-500"}`}>Rispondi a poche domande e salva una strategia coerente con la tua situazione.</span>
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

                <div className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
                  <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                    <h3 className="text-xl font-bold tracking-tight">Dati della simulazione</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-600">Questi numeri servono per rendere concreti esempi, tasse stimate, quote di vendita e bucket.</p>
                    <div className="mt-6 grid gap-4 sm:grid-cols-2">
                      <label className="block"><span className="text-sm font-medium text-slate-700">Capitale investito</span><input type="number" min="0" value={exitInvestedAmount} onChange={(e) => setExitInvestedAmount(e.target.value)} placeholder="Es. 100000" className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400" /></label>
                      <label className="block"><span className="text-sm font-medium text-slate-700">Valore attuale</span><input type="number" min="0" value={exitCurrentAmount} onChange={(e) => setExitCurrentAmount(e.target.value)} placeholder="Es. 130000" className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400" /></label>
                      <label className="block"><span className="text-sm font-medium text-slate-700">Obiettivo finale</span><input type="number" min="0" value={exitGoalAmount} onChange={(e) => setExitGoalAmount(e.target.value)} placeholder="Es. 120000" className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400" /></label>
                      <label className="block"><span className="text-sm font-medium text-slate-700">Durata uscita graduale</span><input type="number" min="1" value={exitMonths} onChange={(e) => setExitMonths(e.target.value)} placeholder="Es. 12" className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none transition focus:border-slate-400" /></label>
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
                    <h4 className="font-bold text-slate-900">Piano step by step</h4>
                    <ol className="mt-4 space-y-3 text-sm leading-6 text-slate-700">
                      {selectedExitDetails.steps.map((item, index) => (<li key={item} className="flex gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white">{index + 1}</span><span>{item}</span></li>))}
                    </ol>
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
            <p className="mt-3 text-sm leading-6 text-slate-600">Rifare il questionario puo modificare la strategia consigliata in base alle nuove risposte. Il consiglio salvato verra aggiornato, ma potrai comunque scegliere liberamente qualsiasi strategia.</p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <button type="button" onClick={() => setShowExitQuestionnaireWarning(false)} className="rounded-xl border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">Non cambiare</button>
              <button type="button" onClick={() => { setShowExitQuestionnaireWarning(false); setExitQuestionnaireStep(0); setShowExitQuestionnaireModal(true); }} className="rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800">Prosegui</button>
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
                <p className="mt-2 text-sm leading-6 text-slate-600">Una domanda alla volta. Il risultato salva il nostro consiglio, ma potrai comunque scegliere liberamente qualsiasi strategia.</p>
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
                  <p className="mt-2 text-sm leading-6 text-slate-600">Serve a capire se ha senso ridurre il rischio rapidamente o mantenere piu capitale investito.</p>
                  <div className="mt-5 grid gap-3">
                    {[
                      { key: "entro1", label: "Entro 1 anno", hint: "Priorita alla protezione del capitale." },
                      { key: "unoTre", label: "Tra 1 e 3 anni", hint: "Equilibrio tra uscita graduale e rischio." },
                      { key: "oltreTre", label: "Tra piu di 3 anni", hint: "Puo avere senso una strategia piu flessibile." },
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
                  <h4 className="text-xl font-bold text-slate-900">Cosa ti preoccupa di piu?</h4>
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
                  <h4 className="text-xl font-bold text-slate-900">Qual e l'obiettivo principale?</h4>
                  <p className="mt-2 text-sm leading-6 text-slate-600">Collegare l'uscita a un obiettivo reale rende la scelta piu semplice.</p>
                  <div className="mt-5 grid gap-3">
                    {[
                      { key: "spesa", label: "Spesa precisa / casa / progetto", hint: "Conta arrivare a una cifra concreta." },
                      { key: "pensione", label: "Pensione o rendita", hint: "Conta trasformare capitale in entrate stabili." },
                      { key: "protezione", label: "Proteggere capitale", hint: "Conta ridurre volatilita e stress." },
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
                  <p className="mt-2 text-sm leading-6 text-slate-600">Questa risposta aiuta a scegliere una strategia che puoi seguire senza farti prendere dall'emotivita.</p>
                  <div className="mt-5 grid gap-3">
                    {[
                      { key: "sicura", label: "Prelevo dalla parte sicura", hint: "Adatto a chi vuole evitare di vendere azioni in ribasso." },
                      { key: "graduale", label: "Continuo con vendite graduali", hint: "Adatto a chi vuole semplicita e disciplina." },
                      { key: "aspettare", label: "Aspetto senza vendere", hint: "Adatto a chi accetta oscillazioni." },
                      { key: "regole", label: "Seguo regole gia decise", hint: "Adatto a chi vuole automatizzare le decisioni." },
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

function TopBar({
  step,
  unlocked,
  isProPlan,
  userEmail,
  onGoHome,
  onGoPortfolio,
  onGoGuide,
  onGoStrumentis,
  onGoDashboard,
  onGoRebalance,
  onGoExit,
  onLogout,
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
  onGoStrumentis: () => void;
  onGoDashboard: () => void;
  onGoRebalance: () => void;
  onGoExit: () => void;
  onLogout: () => void;
  onResetProfile: () => void;
  resetLoading: boolean;
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:flex-row md:items-center md:justify-between">
      <div>
        <p className="text-sm font-medium text-slate-500">Soldi Semplici</p>
        <p className="text-sm text-slate-400">{userEmail}</p>
      </div>

      <nav className="flex flex-wrap items-center gap-2">
        <NavButton active={step === "home"} onClick={onGoHome}>Home</NavButton>
        {unlocked && (
          <>
            <NavButton active={step === "portfolio"} onClick={onGoPortfolio}>Modello</NavButton>
            <NavButton active={step === "guide"} onClick={onGoGuide}>Guida</NavButton>
            <NavButton active={step === "strumentis"} onClick={onGoStrumentis}>Strumenti</NavButton>
            <NavButton active={step === "dashboard"} onClick={onGoDashboard}>Dashboard</NavButton>
            <NavButton active={step === "rebalance"} onClick={onGoRebalance}>Ribilanciamento</NavButton>
            <NavButton active={step === "exit"} onClick={onGoExit}>Strategia uscita</NavButton>
          </>
        )}
        <button
          onClick={onResetProfile}
          disabled={resetLoading}
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800 transition hover:bg-amber-100 disabled:opacity-50"
        >
          {resetLoading ? "Reset..." : "Reset test"}
        </button>
        <button
          onClick={onLogout}
          className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          Logout
        </button>
      </nav>
    </header>
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
        Colori: rosso azionario, blu obbligazioni, giallo oro, grigio materie prime, verde liquidita.
      </p>
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
  onClick,
}: {
  number: string;
  title: string;
  text: string;
  action: string;
  done?: boolean;
  onClick: () => void;
}) {
  return (
    <div className={`rounded-3xl border p-4 transition ${done ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-slate-50"}`}>
      <div className="flex items-center justify-between gap-3">
        <div className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold ${done ? "bg-emerald-600 text-white" : "bg-slate-900 text-white"}`}>
          {done ? "✓" : number}
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${done ? "bg-white text-emerald-700" : "bg-white text-slate-600"}`}>
          {done ? "Fatto" : "Da fare"}
        </span>
      </div>
      <h4 className="mt-4 text-base font-bold leading-6 text-slate-900">{title}</h4>
      <p className="mt-2 min-h-[72px] text-sm leading-6 text-slate-600">{text}</p>
      <button
        type="button"
        onClick={onClick}
        className="mt-4 w-full rounded-2xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
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
}: {
  title: string;
  subtitle?: string;
  items: ChecklistItem[];
  state: Record<string, boolean>;
  onToggle: (id: string) => void;
  getToolAction?: (id: string) => { label: string; onClick: () => void } | null;
  nextItemId?: string | null;
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
                    toolAction.onClick();
                  }}
                  className="mt-3 inline-flex rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-100"
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
