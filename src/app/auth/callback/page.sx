"use client";

import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type ConfirmationState = "loading" | "success" | "soft-success" | "error";

export default function AuthCallbackPage() {
  const [state, setState] = useState<ConfirmationState>("loading");
  const [message, setMessage] = useState("Stiamo verificando la conferma della tua email.");

  useEffect(() => {
    let mounted = true;

    async function completeEmailConfirmation() {
      try {
        const params = new URLSearchParams(window.location.search);
        const code = params.get("code");

        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) {
            console.warn("Errore exchangeCodeForSession:", error.message);
          }
        }

        const { data, error } = await supabase.auth.getSession();

        if (!mounted) return;

        if (data.session) {
          setState("success");
          setMessage("Email confermata correttamente. Il tuo account Soldi Semplici è attivo.");
          return;
        }

        if (error) {
          setState("error");
          setMessage("Non siamo riusciti a completare automaticamente la conferma. Puoi comunque tornare all'app e accedere con email e password.");
          return;
        }

        setState("soft-success");
        setMessage("La conferma è stata completata. Ora puoi tornare all'app e accedere con email e password.");
      } catch (error) {
        console.error("Errore conferma email:", error);
        if (!mounted) return;
        setState("error");
        setMessage("Qualcosa non ha funzionato durante la conferma. Torna all'app e prova ad accedere: se l'email è stata confermata, entrerai normalmente.");
      }
    }

    completeEmailConfirmation();

    return () => {
      mounted = false;
    };
  }, []);

  const isLoading = state === "loading";
  const isError = state === "error";

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10 text-slate-950">
      <section className="mx-auto flex min-h-[80vh] max-w-5xl items-center">
        <div className="grid w-full overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-sm lg:grid-cols-[1fr_0.8fr]">
          <div className="p-8 md:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-emerald-700">
              Soldi Semplici
            </p>

            <div className="mt-8 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-2xl">
              {isLoading ? "…" : isError ? "!" : "✓"}
            </div>

            <h1 className="mt-6 text-4xl font-bold tracking-tight md:text-5xl">
              {isLoading
                ? "Verifica in corso"
                : isError
                  ? "Controlliamo l'accesso"
                  : "Email confermata"}
            </h1>

            <p className="mt-5 max-w-2xl text-base leading-7 text-slate-600 md:text-lg">
              {message}
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={() => {
                  window.location.href = "/";
                }}
                className="rounded-xl bg-slate-900 px-6 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isLoading}
              >
                Entra nell'app
              </button>

              <button
                type="button"
                onClick={() => {
                  window.location.href = "/";
                }}
                className="rounded-xl border border-slate-200 bg-white px-6 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Torna alla home
              </button>
            </div>

            <p className="mt-6 text-xs leading-6 text-slate-500">
              Se hai già confermato l'email ma non entri automaticamente, usa il pulsante qui sopra e accedi con le credenziali scelte in fase di registrazione.
            </p>
          </div>

          <aside className="border-t border-slate-200 bg-slate-950 p-8 text-white lg:border-l lg:border-t-0 md:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-emerald-300">
              Prossimo passo
            </p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight">
              Costruisci il piano, poi seguilo con metodo.
            </h2>
            <div className="mt-8 space-y-4">
              <div className="rounded-2xl bg-white/10 p-5">
                <p className="text-sm font-semibold text-emerald-200">1. Completa il test</p>
                <p className="mt-2 text-sm leading-6 text-slate-300">
                  Rispondi alle domande e scopri il modello educativo più adatto al tuo profilo.
                </p>
              </div>
              <div className="rounded-2xl bg-white/10 p-5">
                <p className="text-sm font-semibold text-emerald-200">2. Configura il PAC</p>
                <p className="mt-2 text-sm leading-6 text-slate-300">
                  Imposta una cifra mensile sostenibile e trasforma il piano in un'abitudine.
                </p>
              </div>
              <div className="rounded-2xl bg-white/10 p-5">
                <p className="text-sm font-semibold text-emerald-200">3. Segui la guida operativa</p>
                <p className="mt-2 text-sm leading-6 text-slate-300">
                  Usa la guida per sapere cosa fare, in che ordine e dove cliccare.
                </p>
              </div>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
