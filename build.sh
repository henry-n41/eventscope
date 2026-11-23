#!/bin/sh
# Rebuild the two browser bundles. app.js = page glue (extension flow); wc.js = WalletConnect phone flow, loaded on demand.
set -e
npx esbuild web/src/wallet.js --bundle --format=esm --minify --platform=browser --outfile=web/app.js
npx esbuild web/src/wc.js --bundle --format=esm --minify --platform=browser --define:global=globalThis --outfile=web/wc.js
