# Gamgee

Generate a logo, then export the whole brand kit around it. Runs in the browser,
no account needed.

## What it does

- Describe a brand and get logos back in a handful of styles
- Upload a reference logo and have it read, then generate in that direction
- Download SVG, traced on-device: flat colours are posterized and despeckled
  before tracing, and real gradients come out as `linearGradient` fills rather
  than banded steps
- Export a brand kit: logo variants, favicon and app icons, social cards, merch
  mockups, a colour palette and a printable style guide
- Everything you make is kept on your device in IndexedDB

## Running it

You need a [Together AI](https://www.together.ai/) API key.

```bash
pnpm install
echo "TOGETHER_API_KEY=your-key" > .env.local
pnpm dev
```

Then open http://localhost:3000.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `TOGETHER_API_KEY` | yes | Image generation and reference reading |
| `UPSTASH_REDIS_REST_URL` | no | Rate limiting and the free-credit ledger |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | no | Sign-in |
| `NEXT_PUBLIC_SITE_URL` | no | Canonical URL and social card host |

Without Upstash and Clerk the app runs account-less, and visitors bring their
own key.

## Stack

Next.js (App Router) and TypeScript, Tailwind with Radix primitives, FLUX on
Together AI for generation and editing.
