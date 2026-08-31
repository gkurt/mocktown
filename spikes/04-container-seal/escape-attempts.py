#!/usr/bin/env python3
"""
Deliberate escape attempts from inside the sandbox, at the layer where cooperation ends.

04-sandbox.md promises: "Deny-by-default egress ... Raw sockets included — escape is
impossible, not just discouraged." Everything above the socket (proxy env vars, SDK
config, DNS) is cooperative and can be bypassed by code that simply doesn't cooperate.
These attempts don't cooperate: raw TCP and UDP to hard-coded addresses, no DNS, no
proxy, no hostname.

Emits one JSON object so the harness can assert on it.
"""
import json
import socket

TIMEOUT = 4

def tcp(host, port):
    try:
        s = socket.create_connection((host, port), timeout=TIMEOUT)
        s.close()
        return {"escaped": True, "detail": "connected"}
    except Exception as e:
        return {"escaped": False, "detail": f"{type(e).__name__}: {e}"}

def udp(host, port, payload):
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(TIMEOUT)
        s.sendto(payload, (host, port))
        data, _ = s.recvfrom(512)
        s.close()
        return {"escaped": True, "detail": f"got {len(data)} bytes back"}
    except Exception as e:
        return {"escaped": False, "detail": f"{type(e).__name__}: {e}"}

def tcp6(host, port):
    try:
        s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        s.settimeout(TIMEOUT)
        s.connect((host, port, 0, 0))
        s.close()
        return {"escaped": True, "detail": "connected over IPv6"}
    except Exception as e:
        return {"escaped": False, "detail": f"{type(e).__name__}: {e}"}

# A minimal DNS query for example.com, so the UDP attempt is a real resolution attempt
# rather than a packet into the void.
DNS_QUERY = (b"\xab\xcd\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00"
             b"\x07example\x03com\x00\x00\x01\x00\x01")

print(json.dumps({
    # Raw TCP to well-known public addresses, no DNS involved.
    "tcp_cloudflare_dns_443":  tcp("1.1.1.1", 443),
    "tcp_google_dns_443":      tcp("8.8.8.8", 443),
    "tcp_cloudflare_http_80":  tcp("1.1.1.1", 80),
    # Raw UDP DNS, bypassing the sandbox resolver entirely.
    "udp_google_dns_53":       udp("8.8.8.8", 53, DNS_QUERY),
    # IPv6 — 04-sandbox.md flags this as "easy to forget, classic leak".
    "tcp6_cloudflare_dns_443": tcp6("2606:4700:4700::1111", 443),
    "tcp6_google_dns_443":     tcp6("2001:4860:4860::8888", 443),
}, indent=2))
