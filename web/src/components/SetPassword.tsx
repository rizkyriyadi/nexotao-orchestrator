import { useState } from "react";
import { api } from "../api";

/**
 * First-run screen: the operator creates their own password (stored hashed,
 * server-side). Replaces printing a generated password to the terminal.
 */
export function SetPassword({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);

  const tooShort = pw.length > 0 && pw.length < 12;
  const mismatch = confirm.length > 0 && pw !== confirm;
  const ready = pw.length >= 12 && pw === confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await api.setupPassword(pw);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "setup failed");
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
          <span className="eyebrow ml-auto self-center">first run</span>
        </div>

        <form
          onSubmit={submit}
          className={`rounded-lg border border-line bg-charcoal transition-shadow ${focused ? "signature-glow" : ""}`}
        >
          <div className="border-b border-line px-5 py-3">
            <span className="eyebrow">create a password</span>
          </div>

          <div className="space-y-4 p-5">
            <p className="text-[13px] leading-relaxed text-stone">
              Set the password you’ll use to unlock this console. It’s stored hashed on this machine — never shown again.
            </p>

            <div>
              <label className="eyebrow mb-2 block">password</label>
              <div className="flex items-center gap-2.5 border-b border-iron pb-2">
                <span className="font-mono text-sm text-prompt">›</span>
                <input
                  type="password"
                  autoFocus
                  value={pw}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  onChange={(e) => setPw(e.target.value)}
                  placeholder="at least 12 characters"
                  className="flex-1 bg-transparent font-mono text-sm text-ink outline-none placeholder:text-bone"
                />
              </div>
              {tooShort && <p className="mt-1.5 font-mono text-[11px] text-bone">12 characters minimum</p>}
            </div>

            <div>
              <label className="eyebrow mb-2 block">confirm</label>
              <div className="flex items-center gap-2.5 border-b border-iron pb-2">
                <span className="font-mono text-sm text-prompt">›</span>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="repeat it"
                  className="flex-1 bg-transparent font-mono text-sm text-ink outline-none placeholder:text-bone"
                />
              </div>
              {mismatch && <p className="mt-1.5 font-mono text-[11px] text-danger">passwords don’t match</p>}
            </div>

            {error && <p className="font-mono text-[13px] text-danger">{error}</p>}

            <button
              type="submit"
              disabled={busy || !ready}
              className="w-full rounded bg-ink py-2.5 text-[15px] font-medium text-ember transition hover:bg-linen disabled:opacity-30"
            >
              {busy ? "saving…" : "Set password & continue"}
            </button>
          </div>
        </form>

        <p className="mt-4 max-w-xs text-[13px] leading-relaxed text-bone">
          Forgot it later? Run <span className="font-mono text-stone">nexotao reset-password</span> in your terminal.
        </p>
      </div>
    </div>
  );
}
