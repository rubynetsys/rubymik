#!/usr/bin/env bash
#
# RubyMIK release pipeline: test → build (multi-arch) → tag → push.
#
#   scripts/release.sh                # run tests, verify the multi-arch build (no push)
#   scripts/release.sh --load         # ALSO load a single-arch image into local docker (drills)
#   scripts/release.sh --push         # ALSO push vX.Y.Z + latest to the PRIVATE registry
#   scripts/release.sh --skip-tests   # (iteration only) skip the test gate
#
# The version comes from package.json. Overridable env for drills:
#   RUBYMIK_IMAGE=rubymik            image name (default ghcr.io/rubynetsys/rubymik)
#   RUBYMIK_TAG_SUFFIX=-test         suffix on the image tag; also suppresses :latest + git tag
#
# ─────────────────────────────────────────────────────────────────────────────
#  PUBLIC RELEASE — cleared by Ray 2026-07-22 (repo + registry are public).
#  With PUBLIC=true, `--push` publishes vX.Y.Z + latest to the PUBLIC GHCR package.
#  Requires `docker login ghcr.io` (a PAT with write:packages) AND the GHCR package
#  set to Public in GitHub.
# ─────────────────────────────────────────────────────────────────────────────
PUBLIC=true

set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${RUBYMIK_IMAGE:-ghcr.io/rubynetsys/rubymik}"
SUFFIX="${RUBYMIK_TAG_SUFFIX:-}"
PLATFORMS="linux/amd64,linux/arm64"

VERSION="$(node -p "require('./package.json').version")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || { echo "ERROR: package.json version '$VERSION' is not semver"; exit 1; }
FULLTAG="${VERSION}${SUFFIX}"

PUSH=false; LOAD=false; SKIP_TESTS=false
for a in "$@"; do case "$a" in
  --push) PUSH=true;; --load) LOAD=true;; --skip-tests) SKIP_TESTS=true;;
  *) echo "unknown arg: $a"; exit 2;; esac; done

echo "== RubyMIK release ${FULLTAG}  (image ${IMAGE}) =="

# ── 0. write version.json into the landing site (served at rubymik.com/version.json) ──
# Real releases only (no -test suffix). The CHANGELOG top note becomes "notes".
if [[ -z "$SUFFIX" && -f site/version.json ]]; then
  CL="https://github.com/rubynetsys/rubymik/blob/main/CHANGELOG.md"
  node -e '
    const fs=require("fs"); const v=process.argv[1];
    const p="site/version.json"; const j=JSON.parse(fs.readFileSync(p,"utf8"));
    j.latest=v;
    fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");
    console.log("  version.json -> latest "+v);
  ' "$VERSION"
  git add site/version.json 2>/dev/null || true
  echo "  (commit site/version.json with the release: git commit -m \"release ${VERSION}\")"
fi

# ── 1. test gate ─────────────────────────────────────────────────────────────
if ! $SKIP_TESTS; then
  echo "-- test gate: server suite --"
  ( cd server && { npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install >/dev/null; }; npm test )
  echo "-- test gate: web unit tests + typecheck + build --"
  ( cd web && { npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install >/dev/null; }; npm test && npm run build )
else
  echo "-- test gate SKIPPED (--skip-tests) --"
fi

# ── 2. build ─────────────────────────────────────────────────────────────────
docker buildx inspect rubymik-builder >/dev/null 2>&1 || docker buildx create --name rubymik-builder >/dev/null
docker buildx use rubymik-builder

REFS=(-t "${IMAGE}:${FULLTAG}")
[[ -z "$SUFFIX" ]] && REFS+=(-t "${IMAGE}:latest")   # :latest only for real releases

if $LOAD; then
  echo "-- build: single-arch (linux/amd64) --load into local docker --"
  docker buildx build --platform linux/amd64 "${REFS[@]}" --load .
elif $PUSH; then
  REG=$($PUBLIC && echo "PUBLIC" || echo "private")
  echo "-- build: multi-arch (${PLATFORMS}) --push to the ${REG} registry --"
  docker buildx build --platform "$PLATFORMS" "${REFS[@]}" --push .
  echo "pushed ${IMAGE}:${FULLTAG}$([[ -z "$SUFFIX" ]] && echo ' + latest') to the ${REG} registry"
else
  echo "-- build: verify multi-arch (${PLATFORMS}) cross-builds, no push --"
  docker buildx build --platform "$PLATFORMS" -t "${IMAGE}:${FULLTAG}" -o type=cacheonly .
  echo "multi-arch build OK — not pushed (pass --push to publish to the private registry)"
fi

# ── 3. git tag (real releases only) ──────────────────────────────────────────
if [[ -z "$SUFFIX" ]]; then
  if git rev-parse "v${VERSION}" >/dev/null 2>&1; then
    echo "git tag v${VERSION} already exists"
  else
    git tag -a "v${VERSION}" -m "RubyMIK v${VERSION}"
    echo "tagged v${VERSION} (publish with: git push origin v${VERSION})"
  fi
fi
echo "== done: ${FULLTAG} =="
