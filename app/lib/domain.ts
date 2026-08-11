// Resolved from the deployment, never hardcoded: set NEXT_PUBLIC_SITE_URL once
// there is a real domain, and previews keep working off the platform's own vars.
export const domain =
  process.env.NEXT_PUBLIC_SITE_URL
    ? process.env.NEXT_PUBLIC_SITE_URL
    : process.env.VERCEL_BRANCH_URL
      ? `https://${process.env.VERCEL_BRANCH_URL}`
      : process.env.NEXT_PUBLIC_VERCEL_URL
        ? `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`
        : process.env.NEXT_PUBLIC_DEVELOPMENT_URL
          ? process.env.NEXT_PUBLIC_DEVELOPMENT_URL
          : "http://localhost:3000";
