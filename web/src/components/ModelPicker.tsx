import { useEffect, useState } from "react";
import { api } from "../api";
import type { ModelInfo } from "../types";

export function ModelPicker({ value, onChange }: { value: string | null; onChange: (id: string) => void }) {
  const [models, setModels] = useState<ModelInfo[]>([]);

  useEffect(() => {
    api
      .aiModels()
      .then((r) => {
        setModels(r.models);
        if (!value && r.default) onChange(r.default);
      })
      .catch(() => {});
  }, []);

  const recommended = models.filter((m) => m.recommended);
  const others = models.filter((m) => !m.recommended);

  return (
    <div className="space-y-3">
      {recommended.length > 0 && (
        <div>
          <div className="eyebrow mb-1.5 text-prompt">recommended · claude series</div>
          <div className="grid grid-cols-2 gap-2">
            {recommended.map((m) => (
              <ModelCard key={m.id} m={m} active={value === m.id} onClick={() => onChange(m.id)} />
            ))}
          </div>
        </div>
      )}
      {others.length > 0 && (
        <div>
          <div className="eyebrow mb-1.5">other models</div>
          <div className="grid grid-cols-2 gap-2">
            {others.map((m) => (
              <ModelCard key={m.id} m={m} active={value === m.id} onClick={() => onChange(m.id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ModelCard({ m, active, onClick }: { m: ModelInfo; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 rounded border px-3 py-2 text-left transition ${
        active ? "border-ink bg-iron/40" : "border-iron hover:border-stone"
      }`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? "bg-prompt" : "bg-transparent"}`} />
      <span className="min-w-0">
        <span className={`block truncate text-[13px] ${active ? "text-ink" : "text-stone"}`}>{m.name}</span>
        <span className="block font-mono text-[10px] text-bone">{m.id}</span>
      </span>
      {m.vision && <span className="ml-auto font-mono text-[9px] text-bone">vision</span>}
    </button>
  );
}
