import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `cacheComponents` and `partialPrefetching` came from the scaffold and are off
  // here on purpose. This app is one streaming SSE endpoint and one live page;
  // there is nothing to prerender or partially prefetch, and cacheComponents
  // forbids the explicit `runtime`/`dynamic` route config that makes "never cache
  // a token stream" a stated guarantee rather than an inferred default.

  // The knowledge base is read from disk at runtime, so it has to be traced into
  // the serverless bundle or the deployed app boots with an empty corpus.
  outputFileTracingIncludes: {
    "/api/chat": ["./nimbusstack-knowledge-base/**"],
  },

  // The dev-only badge sits bottom-left, directly over the model picker, so it
  // covers the control during a local walkthrough.
  devIndicators: false,
};

export default nextConfig;
