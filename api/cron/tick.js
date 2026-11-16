
import crypto from "node:crypto";

export const SUPPORTED_CRON_PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
];

const DEFAULT_MODEL = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-sonnet-20241022",
  gemini: "gemini-2.5-flash",
  openrouter: "openai/gpt-4o-mini",
};

const DEFAULT_PROMPT = "You are an AI assistant.";
const DEFAULT_MESSAGE = "Scheduled run";
const MAX_ERROR_LENGTH = 500;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function getProvider(provider) {
  const normalized = String(provider || "openai").toLowerCase();

  if (!SUPPORTED_CRON_PROVIDERS.includes(normalized)) {
    throw new Error(`Unsupported AI provider: ${normalized}`);
  }

  return normalized;
}

/**
 * Build provider-specific API requests.
 */
export function buildCronRequest(
  provider,
  apiKey,
  model,
  systemPrompt,
  userMessage
) {
  const prov = getProvider(provider);

  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("A valid API key is required");
  }

  const sys = systemPrompt || DEFAULT_PROMPT;
  const msg = userMessage || DEFAULT_MESSAGE;

  if (prov === "anthropic") {
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: model || DEFAULT_MODEL.anthropic,
        max_tokens: 4096,
        system: sys,
        messages: [{ role: "user", content: msg }],
      },
    };
  }

  if (prov === "gemini") {
    const targetModel = model || DEFAULT_MODEL.gemini;

    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(targetModel)}:generateContent`,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: {
        systemInstruction: {
          parts: [{ text: sys }],
        },
        contents: [{
          role: "user",
          parts: [{ text: msg }],
        }],
      },
    };
  }

  if (prov === "openrouter") {
    return {
      url: "https://openrouter.ai/api/v1/chat/completions",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://iloveagents.ai",
        "X-Title": "ILoveAgents",
      },
      body: {
        model: model || DEFAULT_MODEL.openrouter,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: msg },
        ],
        max_tokens: 4096,
      },
    };
  }

  return {
    url: "https://api.openai.com/v1/chat/completions",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: {
      model: model || DEFAULT_MODEL.openai,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: msg },
      ],
      max_tokens: 4096,
    },
  };
}

/**
 * Extract generated text from provider responses.
 */
export function parseCronResponse(provider, json) {
  if (!json || typeof json !== "object") {
    throw new Error("Invalid AI provider response");
  }

  const prov = getProvider(provider);
  let output;

  if (prov === "anthropic") {
    output = json.content
      ?.filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
  } else if (prov === "gemini") {
    output = json.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("\n");
  } else {
    output = json.choices?.[0]?.message?.content;
  }

  if (typeof output !== "string" || !output.trim()) {
    throw new Error("AI provider returned an empty response");
  }

  return output.trim();
}

/**
 * Send email notification through Resend.
 */
export async function sendCronEmailNotification(
  apiKey,
  { to, name, output }
) {
  if (!apiKey) {
    throw new Error("Resend API key is missing");
  }

  if (
    typeof to !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)
  ) {
    throw new Error("Invalid notification email address");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: "Open Agents Hub <automations@openagentshub.dev>",
      to: [to],
      subject: `[Open Agents Hub] Completed: ${name}`,
      html: `
        <h2>${escapeHtml(name)} Run Output</h2>
        <pre>${escapeHtml(output)}</pre>
      `,
    }),
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => ""))
      .slice(0, MAX_ERROR_LENGTH);

    throw new Error(
      `Resend error ${response.status}: ${detail}`
    );
  }

  return response.json();
}

/**
 * IMPORTANT:
 * Base64 decoding is NOT encryption or decryption.
 *
 * Replace this function with your actual server-side pgsodium
 * decryption RPC, using the real RPC name and parameter names
 * defined by your Supabase project.
 *
 * Do not return the encrypted value as an API key.
 */
async function decryptStoredApiKey(supabase, encryptedKey) {
  if (!encryptedKey) {
    throw new Error("Encrypted API key not found");
  }

  throw new Error(
    "API key decryption is not configured. Connect the actual pgsodium decryption RPC."
  );
}

/**
 * Safely read an error message.
 */
function getErrorMessage(error) {
  return String(error?.message || "Execution failed")
    .slice(0, MAX_ERROR_LENGTH);
}

/**
 * Execute an AI provider request.
 */
async function executeProvider(auto, apiKey, userMessage) {
  const provider = getProvider(auto.provider);

  const request = buildCronRequest(
    provider,
    apiKey,
    auto.model,
    auto.system_prompt,
    userMessage
  );

  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => ""))
      .slice(0, MAX_ERROR_LENGTH);

    throw new Error(
      `${provider} API error ${response.status}: ${detail}`
    );
  }

  const json = await response.json();

  return parseCronResponse(provider, json);
}

/**
 * Vercel Cron Handler: /api/cron/tick
 */
export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");

    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || "";

  if (!cronSecret) {
    console.error("CRON_SECRET is not configured");

    return res.status(500).json({
      success: false,
      error: "Cron authentication is not configured",
    });
  }

  const expected = Buffer.from(`Bearer ${cronSecret}`);
  const received = Buffer.from(authHeader);

  if (
    expected.length !== received.length ||
    !crypto.timingSafeEqual(expected, received)
  ) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized",
    });
  }

  const startTime = Date.now();
  const results = [];

  try {
    const supabaseUrl =
      process.env.SUPABASE_URL ||
      process.env.VITE_SUPABASE_URL;

    // Never use the public anon key for privileged cron operations.
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceKey) {
      throw new Error("Supabase server configuration is missing");
    }

    const { createClient } = await import("@supabase/supabase-js");

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const now = new Date().toISOString();

    const { data: dueAutomations, error: fetchError } =
      await supabase
        .from("automations")
        .select("*")
        .eq("enabled", true)
        .lte("next_run_at", now)
        .order("next_run_at", { ascending: true })
        .limit(10);

    if (fetchError) {
      throw fetchError;
    }

    if (!dueAutomations?.length) {
      return res.status(200).json({
        success: true,
        message: "No automations currently due",
        processedCount: 0,
        duration: Date.now() - startTime,
      });
    }

    for (const auto of dueAutomations) {
      const runId = `run_${crypto.randomUUID()}`;
      const autoStart = Date.now();

      let status = "success";
      let output = "";
      let errorMessage = null;

      try {
        const { data: secretData, error: secretError } =
          await supabase
            .from("user_secrets")
            .select("encrypted_key")
            .eq("automation_id", auto.id)
            .single();

        if (secretError) {
          throw new Error("Unable to retrieve stored API key");
        }

        const apiKey = await decryptStoredApiKey(
          supabase,
          secretData?.encrypted_key
        );

        const inputs = auto.inputs || {};

        if (
          typeof inputs !== "object" ||
          Array.isArray(inputs)
        ) {
          throw new Error("Invalid automation inputs");
        }

        const parts = Object.entries(inputs)
          .filter(([, value]) => value !== null && value !== undefined)
          .map(([key, value]) => {
            const formatted = Array.isArray(value)
              ? value.join(", ")
              : typeof value === "object"
                ? JSON.stringify(value)
                : String(value);

            return `${key}: ${formatted}`;
          });

        const userMessage = parts.join("\n\n") || DEFAULT_MESSAGE;

        output = await executeProvider(
          auto,
          apiKey,
          userMessage
        );

        if (
          auto.email_notification &&
          auto.notification_email
        ) {
          if (!process.env.RESEND_API_KEY) {
            throw new Error("Resend API key is not configured");
          }

          await sendCronEmailNotification(
            process.env.RESEND_API_KEY,
            {
              to: auto.notification_email,
              name: auto.name || "Automation",
              output,
            }
          );
        }
      } catch (err) {
        status = "failed";
        errorMessage = getErrorMessage(err);

        console.error(
          `Automation ${auto.id} failed:`,
          errorMessage
        );
      }

      const completedAt = new Date();
      const duration = completedAt.getTime() - autoStart;

      const { error: insertError } = await supabase
        .from("automation_runs")
        .insert({
          id: runId,
          automation_id: auto.id,
          automation_name: auto.name,
          agent_name: auto.agent_name,
          status,
          duration,
          output: status === "success" ? output : "",
          error: errorMessage,
          started_at: new Date(autoStart).toISOString(),
          completed_at: completedAt.toISOString(),
        });

      if (insertError) {
        throw insertError;
      }

      const intervalMs =
        auto.schedule === "hourly"
          ? 60 * 60 * 1000
          : auto.schedule === "weekly"
            ? 7 * 24 * 60 * 60 * 1000
            : 24 * 60 * 60 * 1000;

      const nextRunAt = new Date(
        completedAt.getTime() + intervalMs
      ).toISOString();

      const { error: updateError } = await supabase
        .from("automations")
        .update({
          last_run_at: completedAt.toISOString(),
          next_run_at: nextRunAt,
        })
        .eq("id", auto.id);

      if (updateError) {
        throw updateError;
      }

      results.push({
        id: auto.id,
        name: auto.name,
        status,
        duration,
      });
    }

    return res.status(200).json({
      success: true,
      processedCount: results.length,
      results,
      duration: Date.now() - startTime,
    });
  } catch (error) {
    console.error("Cron execution error:", error);

    return res.status(500).json({
      success: false,
      error: "Cron execution failed",
    });
  }
}
