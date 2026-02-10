"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.signUp({
      email,
      password,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      router.push("/");
      router.refresh();
    }
  };

  return (
    <div className="h-dvh flex items-center justify-center bg-dark-base px-4">
      <div className="animate-fade-in-up w-full max-w-sm">
        <h1 className="text-gradient mb-1 text-center font-[family-name:var(--font-montserrat)] text-3xl font-extrabold">
          MyApp
        </h1>
        <p className="mb-8 text-center text-sm text-text-secondary">
          Créez votre compte pour commencer
        </p>

        <div className="glass-card px-6 py-6">
          <form onSubmit={handleSignup} className="space-y-4">
            <div>
              <label htmlFor="email" className="mb-1 block text-sm font-medium text-text-secondary">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="input-dark mt-1 block w-full rounded-lg px-3 py-2.5"
              />
            </div>

            <div>
              <label htmlFor="password" className="mb-1 block text-sm font-medium text-text-secondary">
                Mot de passe
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                className="input-dark mt-1 block w-full rounded-lg px-3 py-2.5"
              />
              <p className="mt-1 text-xs text-text-muted">6 caractères minimum</p>
            </div>

            {error && (
              <div className="toast-error animate-fade-in-up rounded-lg px-3 py-2 text-center text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="btn-gradient flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-base"
            >
              {loading && <span className="spinner-sm" />}
              {loading ? "Création..." : "Créer mon compte"}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-text-muted">
          Déjà un compte ?{" "}
          <Link href="/login" className="font-medium text-accent-cyan hover:underline">
            Se connecter
          </Link>
        </p>
      </div>
    </div>
  );
}
