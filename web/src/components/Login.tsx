import { useState } from "react";
import { api } from "../api";

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onSuccess();
    } catch {
      setError("Authentication rejected. Check the password and try again.");
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-ember p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-baseline gap-2.5">
          <span className="font-mono text-sm text-ink">◆</span>
          <span className="heading text-[22px] text-ink">
            nexotao <span className="text-bone">orce</span>
          </span>
          <span className="eyebrow ml-auto self-center">locked</span>
        </div>

        <form
          onSubmit={submit}
          className={`rounded-lg border border-line bg-charcoal transition-shadow ${
            focused ? "signature-glow" : ""
          }`}
        >
          <div className="border-b border-line px-5 py-3">
            <span className="eyebrow">authenticate</span>
          </div>

          <div className="p-5">
            <label className="eyebrow mb-3 block">passphrase</label>
            <div className="flex items-center gap-2.5 border-b border-iron pb-2">
              <span className="font-mono text-sm text-prompt">›</span>
              <input
                type="password"
                autoFocus
                value={password}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="flex-1 bg-transparent font-mono text-sm text-ink outline-none placeholder:text-bone"
              />
            </div>

            {error && <p className="mt-3 font-mono text-[13px] text-danger">{error}</p>}

            <button
              type="submit"
              disabled={busy || !password}
              className="mt-6 w-full rounded bg-ink py-2.5 text-[15px] font-medium text-ember transition hover:bg-linen disabled:opacity-30"
            >
              {busy ? "verifying…" : "Unlock"}
            </button>
          </div>
        </form>

        <p className="mt-4 max-w-xs text-[13px] leading-relaxed text-bone">
          Single operator. This console can run commands on the host — keep the passphrase private.
        </p>
      </div>
    </div>
  );
}
