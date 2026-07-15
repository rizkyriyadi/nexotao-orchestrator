import { Hono } from "hono";
import {
  MODELS,
  DEFAULT_MODEL,
  NEXOTAO_BASE_URL,
  claudeAvailable,
  getProvider,
  hasApiKey,
  maskedApiKey,
  setApiKey,
  setProvider,
} from "../ai.js";
import { getActiveProject, projectStore, setActiveProject } from "../projects.js";

export const aiRoute = new Hono();

aiRoute.get("/ai/models", (c) => c.json({ models: MODELS, default: DEFAULT_MODEL }));

aiRoute.get("/ai/settings", (c) => {
  const p = getActiveProject();
  return c.json({
    provider: getProvider(),
    baseUrl: NEXOTAO_BASE_URL,
    hasKey: hasApiKey(),
    maskedKey: maskedApiKey(),
    claudeAvailable: claudeAvailable(),
    model: p?.model ?? DEFAULT_MODEL,
  });
});

aiRoute.put("/ai/settings", async (c) => {
  const body = await c.req.json<{ provider?: "nexotao" | "claude"; apiKey?: string; model?: string }>();
  if (body.provider) await setProvider(body.provider);
  if (body.apiKey && body.apiKey.trim()) await setApiKey(body.apiKey.trim());
  if (body.model) {
    const p = getActiveProject();
    if (p) {
      await projectStore.setModel(p.id, body.model);
      await setActiveProject(p.id); // refresh the in-process cache
    }
  }
  const p = getActiveProject();
  return c.json({
    provider: getProvider(),
    hasKey: hasApiKey(),
    maskedKey: maskedApiKey(),
    claudeAvailable: claudeAvailable(),
    model: p?.model ?? DEFAULT_MODEL,
  });
});
