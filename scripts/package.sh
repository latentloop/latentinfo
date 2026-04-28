#!/usr/bin/env bash
set -euo pipefail

# Build all packages (TypeScript compilation)
turbo run build --filter=frontend --filter=backend --filter=gui

# Pack the Electron app
pnpm --filter gui run pack
