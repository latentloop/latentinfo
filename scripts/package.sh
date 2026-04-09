#!/usr/bin/env bash
set -euo pipefail

# Build all packages
turbo run build --filter=frontend --filter=backend --filter=gui

# Create self-contained backend bundle with production dependencies
rm -rf packages/gui/.backend-bundle
pnpm --filter backend deploy packages/gui/.backend-bundle --prod

# Remove self-referencing symlink that pnpm deploy creates back to the
# workspace package — electron-builder fails trying to follow it during
# code signing. (Observed in pnpm 9.x; harmless no-op if absent.)
rm -f packages/gui/.backend-bundle/node_modules/.pnpm/node_modules/backend

# Pack the Electron app
pnpm --filter gui run pack
