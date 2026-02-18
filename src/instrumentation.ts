/**
 * Next.js Instrumentation Hook
 *
 * Called once when the server starts (both dev and production).
 * Used to initialize graceful shutdown handlers.
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only run on the server (not during build or in Edge runtime)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initGracefulShutdown } = await import("@/lib/gracefulShutdown");
    initGracefulShutdown();
  }
}
