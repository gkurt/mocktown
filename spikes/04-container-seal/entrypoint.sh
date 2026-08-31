#!/bin/sh
set -e
# Resolve this container's address on the sealed network and answer *every* name with it.
# `address=/#/<ip>` is dnsmasq's catch-all: unknown hostnames resolve here too, so an
# escape attempt reaches the deny wall and becomes evidence rather than an NXDOMAIN the
# app can't explain (04-sandbox.md).
SELF_IP=$(ip -4 addr show scope global | awk '/inet /{print $2}' | cut -d/ -f1 | head -1)
echo "front door self ip: $SELF_IP"
dnsmasq --no-daemon --address=/#/$SELF_IP --log-queries --no-resolv &
exec node /app/front-door.mjs
