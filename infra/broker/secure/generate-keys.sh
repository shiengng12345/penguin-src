#!/usr/bin/env bash
# infra/broker/secure/generate-keys.sh — JWT keys for the local-secure profile.
# Output is gitignored: these are local dev keys, never committed, never reused.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE="apachepulsar/pulsar@sha256:cd5d4a64a32c0770d5d2dbb526169a70081605bbec4b59b73471b68d0a451fb4"

docker run --rm -v "$DIR:/keys" "$IMAGE" \
  bin/pulsar tokens create-key-pair --output-private-key /keys/private.key --output-public-key /keys/public.key

docker run --rm -v "$DIR:/keys" "$IMAGE" \
  bin/pulsar tokens create --private-key file:///keys/private.key --subject admin > "$DIR/admin.jwt"

# A token for a subject with no permissions — this is how we observe a real 403.
docker run --rm -v "$DIR:/keys" "$IMAGE" \
  bin/pulsar tokens create --private-key file:///keys/private.key --subject nobody > "$DIR/nobody.jwt"

# A token for the admin subject that expires almost immediately — this is how
# we observe a real "credential expired" shape, distinct from "credential is
# wrong". The caller must wait for it to lapse before using it (see
# probeAuth's expiredToken shape and the test's use of this file).
docker run --rm -v "$DIR:/keys" "$IMAGE" \
  bin/pulsar tokens create --private-key file:///keys/private.key --subject admin -e 1s > "$DIR/expired.jwt"

echo "wrote private.key public.key admin.jwt nobody.jwt expired.jwt to $DIR"
