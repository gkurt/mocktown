# The application image: what a developer's app, its tests, and any driving agent run in.
# It has no Mocktown code in it at all — only the project CA in the trust store, which is
# 04-sandbox.md's "TLS just works" guarantee, solved at build time.
FROM alpine:3.20

RUN apk add --no-cache curl python3 ca-certificates bind-tools

# Baked CA: system trust store plus every per-runtime knob.
COPY out/ca.pem /usr/local/share/ca-certificates/mocktown-ca.crt
RUN update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/mocktown-ca.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

COPY escape-attempts.py /escape-attempts.py
CMD ["sleep", "3600"]
