#!/usr/bin/env bash
# infra/broker/secure/generate-tls-certs.sh — self-signed CA + broker cert for
# the local-secure profile's TLS binary port (6651), so the local rig can
# simulate the shape of the user's QAT connection: pulsar+ssl:// with a JWT.
#
# Output is gitignored: these are local dev certs, never committed, never
# reused outside this machine. Re-run this script any time the certs expire
# or need to be regenerated; it overwrites its own output deterministically.
#
# Also writes a second, unrelated CA (wrong-ca.cert.pem) purely so the
# negative TLS test (tests/broker_secure_tls.rs) has something to fail
# against — connecting with the wrong CA must fail, or TLS was never proven
# to be on (see task-6-brief.md, BINDING RULING R37).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# --- Real CA + broker cert, signed for CN=localhost (what the client dials) ---

openssl genrsa -out ca.key.pem 4096

openssl req -x509 -new -nodes \
  -key ca.key.pem \
  -sha256 -days 3650 \
  -subj "/CN=Penguin Local Secure Broker Test CA" \
  -out ca.cert.pem

openssl genrsa -out broker.key.pem 2048

openssl req -new \
  -key broker.key.pem \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -addext "basicConstraints=CA:FALSE" \
  -addext "keyUsage=digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" \
  -out broker.csr.pem

openssl x509 -req \
  -in broker.csr.pem \
  -CA ca.cert.pem -CAkey ca.key.pem -CAcreateserial \
  -sha256 -days 825 \
  -copy_extensions copy \
  -out broker.cert.pem

# Pulsar's TLS transport wants the broker key in unencrypted PKCS#8, not the
# PKCS#1 `openssl genrsa` default (see Pulsar's own TLS transport docs).
openssl pkcs8 -topk8 -nocrypt \
  -inform PEM -in broker.key.pem \
  -outform PEM -out broker.key-pk8.pem

rm -f ca.cert.srl

# --- A second, unrelated CA for the negative test only ---
# Never used by the broker itself. A client that trusts only this CA must
# fail to validate the broker's real certificate.

openssl genrsa -out wrong-ca.key.pem 4096

openssl req -x509 -new -nodes \
  -key wrong-ca.key.pem \
  -sha256 -days 3650 \
  -subj "/CN=Penguin Wrong CA (negative-test fixture only)" \
  -out wrong-ca.cert.pem

rm -f wrong-ca.key.pem

echo "wrote ca.cert.pem broker.cert.pem broker.key-pk8.pem wrong-ca.cert.pem (and intermediate .csr/.key.pem files) to $DIR"
