import { currentUser } from "@clerk/nextjs/server";
import { ipAddress } from "@vercel/functions";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { z } from "zod";

/**
 * Reads an uploaded reference logo with a Together vision model and returns a
 * compact, structured read the creator can act on (description + a style/color
 * guess that pre-selects the matching controls). The image is forwarded only to
 * Together via this route and never persisted.
 *
 * Model is a single const for easy swapping. The previous picks (Qwen2.5-VL-72B,
 * Llama-4-Maverick FP8) were removed from Together serverless in early 2026.
 * Currently serverless with vision: Qwen/Qwen3.5-9B, google/gemma-4-31B-it.
 * Uses a direct fetch to /chat/completions (de-risks the pinned SDK's chat API).
 */
const REFERENCE_MODEL = "Qwen/Qwen3.5-9B";

const STYLES = [
  "Minimal",
  "Geometric",
  "Gradient",
  "Mascot",
  "Hand-drawn",
  "Luxury",
  "Retro",
  "3D",
] as const;

const PROMPT = `You are a brand-design analyst. Study this reference logo/image and respond with ONLY a compact JSON object (no prose, no markdown fences) with these keys:
- "description": one tight sentence (max 240 chars) describing the mark's composition, shapes, motif and overall feel. Do NOT state the company name or transcribe any text in the logo.
- "styleGuess": exactly one of ${JSON.stringify(STYLES)}, whichever best matches.
- "dominantColor": the single most prominent brand color sampled from the image itself, as a 6-digit hex in "#RRGGBB" form, or "auto" if it is grayscale or multicolor with no clear dominant. Read the actual pixels; never echo a hex from these instructions.
- "keywords": an array of 3 to 6 short adjectives.
Return only the JSON object.`;

export async function POST(req: Request) {
  const parsed = z
    .object({
      userAPIKey: z.string().max(200).optional(),
      // Let the model reason before answering. Slower and pricier, but it reads
      // colour off the image more reliably instead of guessing from shape.
      deep: z.boolean().optional(),
      // Only an inline image data URL, never an arbitrary http/file URL (which
      // the model backend would otherwise fetch server-side on our behalf).
      image: z
        .string()
        .regex(
          /^data:image\/[a-zA-Z0-9.+-]+;base64,/,
          "Provide an image data URL.",
        ),
    })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return new Response("Invalid request.", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }
  const data = parsed.data;

  // Cap payload size (~4 MB image) before forwarding it to the vision model.
  if (data.image.length > 6_000_000) {
    return new Response("That image is too large.", {
      status: 413,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // With Clerk configured, keyless (server-key) reads require a signed-in
  // user, the same friction as generations; BYOK works signed out.
  const clerkEnabled = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (clerkEnabled && !data.userAPIKey) {
    const user = await currentUser();
    if (!user) {
      return new Response(
        "Sign in to read references with free credits, or add your own Together AI key.",
        { status: 401, headers: { "Content-Type": "text/plain" } },
      );
    }
  }

  // In production, don't spend the owner's server key from a fully unprotected
  // deploy (no BYOK, no Clerk, no Upstash limiter). Allowed in local dev.
  const hasLimiter = !!process.env.UPSTASH_REDIS_REST_URL;
  if (
    process.env.NODE_ENV === "production" &&
    !data.userAPIKey &&
    !clerkEnabled &&
    !hasLimiter
  ) {
    return new Response(
      "Add your own Together AI key to read references here.",
      { status: 401, headers: { "Content-Type": "text/plain" } },
    );
  }

  // Rate-limit anonymous, server-key reads per client IP so the shared key
  // cannot be drained in a loop. BYOK callers spend their own key, so skip.
  if (hasLimiter && !data.userAPIKey) {
    const ratelimit = new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.fixedWindow(40, "1 d"),
      analytics: true,
      prefix: "gamgee-read",
    });
    const ip = ipAddress(req) || "anonymous";
    const { success } = await ratelimit.limit(ip);
    if (!success) {
      return new Response(
        "You've hit the free reference-read limit for now. Add your own Together AI key to keep going.",
        { status: 429, headers: { "Content-Type": "text/plain" } },
      );
    }
  }

  const apiKey = data.userAPIKey?.trim() || process.env.TOGETHER_API_KEY;
  if (!apiKey) {
    return new Response("No API key available.", {
      status: 401,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const baseURL = "https://api.together.xyz/v1";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  // Thinking has to be paid for in tokens: reasoning is emitted before the
  // answer, so a budget that only fits the JSON comes back as an empty string
  // with finish_reason "length" and no error at all. This model's reasoning
  // runs ~1700 tokens; 2000 truncated a third of the time, 4000 never did.
  const ask = (deep: boolean) =>
    fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: REFERENCE_MODEL,
        max_tokens: deep ? 4000 : 320,
        temperature: 0.2,
        // Together's current serverless VLMs think by default.
        chat_template_kwargs: { enable_thinking: deep },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: PROMPT },
              { type: "image_url", image_url: { url: data.image } },
            ],
          },
        ],
      }),
    });

  try {
    const res = await ask(!!data.deep);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401) {
        return new Response("Your API key is invalid.", {
          status: 401,
          headers: { "Content-Type": "text/plain" },
        });
      }
      if (/non-serverless|model_not_available/i.test(body)) {
        return new Response(
          "Reading references needs serverless chat access on your Together account (image generation still works). Check your plan at api.together.ai.",
          { status: 403, headers: { "Content-Type": "text/plain" } },
        );
      }
      if (/request_blocked|tier|not allowed/i.test(body)) {
        return new Response(
          "Your Together account tier doesn't allow this model yet.",
          { status: 403, headers: { "Content-Type": "text/plain" } },
        );
      }
      return new Response("Couldn't read that image. Try another file.", {
        status: 502,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const out = await res.json();
    let text: string = out?.choices?.[0]?.message?.content ?? "";

    // A deep read can still run out of budget mid-thought and answer with
    // nothing. Silently fall back to the fast path rather than showing the
    // user a blank read.
    if (!text.trim() && data.deep) {
      const retry = await ask(false);
      if (retry.ok) {
        const retryOut = await retry.json();
        text = retryOut?.choices?.[0]?.message?.content ?? "";
      }
    }

    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          /* fall through to text-only */
        }
      }
    }

    const styleGuess =
      typeof parsed.styleGuess === "string" &&
      (STYLES as readonly string[]).includes(parsed.styleGuess)
        ? parsed.styleGuess
        : null;
    const dominantColor =
      typeof parsed.dominantColor === "string" &&
      /^#[0-9a-fA-F]{6}$/.test(parsed.dominantColor)
        ? parsed.dominantColor
        : "auto";
    const description =
      typeof parsed.description === "string" && parsed.description.trim()
        ? parsed.description.trim().slice(0, 240)
        : text.replace(/[{}"]/g, " ").trim().slice(0, 240);
    const keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords
          .filter((k): k is string => typeof k === "string")
          .slice(0, 6)
      : [];

    return Response.json(
      { description, styleGuess, dominantColor, keywords },
      { status: 200 },
    );
  } catch {
    return new Response("Couldn't read that image. Try another file.", {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

export const runtime = "edge";
