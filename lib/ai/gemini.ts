import "server-only";
import { RUN_LIMITS } from "./contracts";

export function geminiConfiguration() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite";
  if (!apiKey) throw new Error("Gemini is not configured. Add GEMINI_API_KEY to .env.local and restart the app. Never use a NEXT_PUBLIC_ variable for this key.");
  if (!/^gemini-[a-zA-Z0-9.-]{1,80}$/.test(model)) throw new Error("GEMINI_MODEL must be a Gemini model ID.");
  return { apiKey, model };
}

// Only fixed provider enums are retained. Never log raw bodies, messages, request
// headers, input, URLs, or metadata, any of which may contain credentials or PII.
const providerStatuses = new Set([
  "INVALID_ARGUMENT", "FAILED_PRECONDITION", "UNAUTHENTICATED", "PERMISSION_DENIED",
  "NOT_FOUND", "RESOURCE_EXHAUSTED", "INTERNAL", "UNAVAILABLE", "DEADLINE_EXCEEDED",
]);
const providerReasons = new Set([
  "API_KEY_INVALID", "API_KEY_SERVICE_BLOCKED", "API_KEY_HTTP_REFERRER_BLOCKED",
  "API_KEY_IP_ADDRESS_BLOCKED", "API_KEY_API_TARGET_BLOCKED", "SERVICE_DISABLED",
  "BILLING_DISABLED", "BILLING_NOT_ACTIVE", "RATE_LIMIT_EXCEEDED", "QUOTA_EXCEEDED",
  "FREE_TIER_UNAVAILABLE", "FREE_TIER_VERIFICATION_REQUIRED",
]);

async function geminiHttpFailure(response: Response): Promise<{ error: Error; retryable: boolean }> {
  let providerStatus: string | undefined;
  let reason: string | undefined;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      const decoder = new TextDecoder();
      let text = "";
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 16384) throw new Error("Error response too large");
        text += decoder.decode(value, { stream: true });
      }
      const data = JSON.parse(text + decoder.decode());
      const status = data?.error?.status;
      if (typeof status === "string" && providerStatuses.has(status)) providerStatus = status;
      const details: unknown = data?.error?.details;
      if (Array.isArray(details)) {
        for (const detail of details) {
          const candidate: unknown = detail?.reason;
          if (typeof candidate === "string" && providerReasons.has(candidate)) { reason = candidate; break; }
        }
      }
    } catch {
      // HTTP status remains useful if the body is malformed, oversized or unreadable.
    } finally {
      try { await reader.cancel(); } catch { /* Ignore a closed response. */ }
      reader.releaseLock();
    }
  }
  console.error("Gemini request rejected", {
    httpStatus: response.status,
    providerStatus: providerStatus ?? "UNKNOWN",
    reason: reason ?? "UNKNOWN",
  });
  const diagnostic = `(HTTP ${response.status}${providerStatus ? `; ${providerStatus}` : ""}${reason ? `; ${reason}` : ""})`;
  let message: string;
  if (reason === "API_KEY_INVALID" || response.status === 401 || providerStatus === "UNAUTHENTICATED") {
    message = "Gemini rejected the server's API key. Check GEMINI_API_KEY locally.";
  } else if (response.status === 402 || reason === "BILLING_DISABLED" || reason === "BILLING_NOT_ACTIVE") {
    message = "Gemini requires active billing or available credits. Check the project's billing in Google AI Studio.";
  } else if (response.status === 429 || providerStatus === "RESOURCE_EXHAUSTED" || reason === "QUOTA_EXCEEDED" || reason === "RATE_LIMIT_EXCEEDED") {
    message = "Gemini's quota or rate limit was reached. Check the project's limits and try again later.";
  } else if (response.status === 403 || providerStatus === "PERMISSION_DENIED" || reason?.startsWith("API_KEY_") || reason?.startsWith("FREE_TIER_") || reason === "SERVICE_DISABLED") {
    message = "Gemini denied API or model access. Check key restrictions, project eligibility and API access.";
  } else if (response.status === 404 || providerStatus === "NOT_FOUND") {
    message = "The configured Gemini model is unavailable. Check GEMINI_MODEL.";
  } else if (response.status === 400 || providerStatus === "INVALID_ARGUMENT" || providerStatus === "FAILED_PRECONDITION") {
    message = "Gemini rejected the request parameters or project prerequisites. Review the prompt, model settings and Google AI Studio project status.";
  } else if (response.status === 503 || providerStatus === "UNAVAILABLE") {
    message = "Gemini is temporarily unavailable or overloaded. Try again later.";
  } else if (response.status === 504 || response.status === 408 || providerStatus === "DEADLINE_EXCEEDED") {
    message = "Gemini timed out while processing the request. Try a shorter prompt later.";
  } else if (response.status >= 500 || providerStatus === "INTERNAL") {
    message = "Gemini encountered a server error. Try again later.";
  } else {
    message = "Gemini rejected this request. Review the server's safe diagnostic status.";
  }
  return {
    error: new Error(`${message} ${diagnostic}`),
    // Never retry an explicit authentication, validation, or quota failure,
    // even if its HTTP status was incorrectly reported as 503.
    retryable: response.status === 503 && !reason
      && (providerStatus === undefined || providerStatus === "UNAVAILABLE"),
  };
}

// Abortable backoff shares the step/run deadline; it never starts a fresh budget.
function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancelled = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancelled);
      reject(new Error("The AI request timed out or was cancelled."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancelled);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
  });
}

export async function generateGeminiText(apiKey: string, model: string, prompt: string, input: string, runSignal: AbortSignal) {
  // All three attempts and both waits share the original 30-second step budget
  // and the caller's three-minute chain deadline/cancellation signal.
  const signal = AbortSignal.any([runSignal, AbortSignal.timeout(RUN_LIMITS.stepTimeoutMs)]);
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new Error("The AI request timed out or was cancelled.");
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: prompt }] },
          contents: [{ role: "user", parts: [{ text: input }] }],
          generationConfig: { maxOutputTokens: RUN_LIMITS.outputTokens, responseMimeType: "text/plain" },
        }),
        signal,
        cache: "no-store",
        redirect: "error",
      });
    } catch {
      // Never return or log raw fetch/provider exceptions: these may contain credentials.
      throw new Error(signal.aborted ? "The AI request timed out or was cancelled." : "Unable to reach Gemini. Please try again later.");
    }
    if (response.ok) break;
    const failure = await geminiHttpFailure(response);
    if (!failure.retryable || attempt >= 2) throw failure.error;
    // Equal jitter: 500–1,000 ms, then 1,000–2,000 ms. At most two retries.
    await waitForRetry(1000 * 2 ** attempt * (0.5 + Math.random() * 0.5), signal);
  }
  // Bound the whole response, including provider metadata and thinking, before JSON parsing.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Gemini returned no response.");
  let text = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 262144) { await reader.cancel(); throw new Error("Gemini returned an oversized response."); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    throw new Error(signal.aborted ? "The AI request timed out or was cancelled." : "Unable to read Gemini's response.");
  } finally { reader.releaseLock(); }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Gemini returned an invalid response."); }
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason === "MAX_TOKENS") throw new Error("This step reached the output token limit. Ask for a shorter response and run again.");
  if (data.promptFeedback?.blockReason || candidate?.finishReason !== "STOP") throw new Error("Gemini blocked or could not finish this step. Review its prompt and input.");
  const output = candidate.content?.parts?.filter((part: { text?: string; thought?: boolean }) => !part.thought && typeof part.text === "string")
    .map((part: { text: string }) => part.text).join("");
  if (typeof output !== "string" || !output.trim() || output.length > RUN_LIMITS.outputChars) throw new Error("Gemini returned an empty or oversized output. Ask for a shorter response.");
  return output;
}
