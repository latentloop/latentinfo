#!/usr/bin/env bash
set -euo pipefail

# Build all packages (TypeScript compilation)
turbo run build --filter=frontend --filter=backend --filter=gui

# Bundle backend into a single file with esbuild
pnpm --filter backend run bundle

# Prepare backend bundle directory for packaging:
# - The esbuild bundle (dist/bundle.mjs) contains all JS deps except externals
# - Externals (libsql native addon + pino) need their node_modules
rm -rf packages/gui/.backend-bundle
mkdir -p packages/gui/.backend-bundle/dist

# Copy the bundle
cp packages/backend/dist/bundle.mjs packages/gui/.backend-bundle/dist/

# Install only the externalized production dependencies
# (libsql chain for native addon + pino for logging)
cat > packages/gui/.backend-bundle/package.json << 'PKGJSON'
{
  "private": true,
  "type": "module",
  "dependencies": {
    "@libsql/client": "^0.17.2",
    "pino": "^10.3.1"
  }
}
PKGJSON
cd packages/gui/.backend-bundle
npm install --omit=dev --ignore-scripts 2>&1 | tail -3
cd ../../..

# Remove unnecessary files from externalized node_modules
find packages/gui/.backend-bundle/node_modules \( \
  -name "*.d.ts" -o -name "*.d.mts" -o -name "*.d.cts" -o \
  -name "*.map" -o -name "README*" -o -name "CHANGELOG*" -o \
  -name "LICENSE*" -o -name "*.md" -o \
  -type d -name "test" -o -type d -name "tests" -o -type d -name "@types" \
\) -exec rm -rf {} + 2>/dev/null || true

# Pack the Electron app
pnpm --filter gui run pack
