#!/bin/sh
# Egress probe (PR05 §3.4 / NET-01). Runs in the network namespace of a
# candidate container. Every attempt carries a unique token so the sink ledger
# can attribute a delivery to this probe. Prints one "RESULT <name> <ok|blocked>"
# line per attempt; the verdict comes from the sink ledger, not from these lines.
TOKEN="$1"
SINK="$2"
T=3

try() { name="$1"; shift; if "$@" >/dev/null 2>&1; then echo "RESULT $name ok"; else echo "RESULT $name blocked"; fi; }

# IPv4 TCP/HTTP straight to the lab sink and to a public address
try tcp-sink-80 wget -T $T -q -O- "http://$SINK/$TOKEN"
try tcp-sink-8080 wget -T $T -q -O- "http://$SINK:8080/$TOKEN"
try tcp-public wget -T $T -q -O- "http://1.1.1.1/$TOKEN"
# Cloud metadata endpoint
try tcp-metadata wget -T $T -q -O- "http://169.254.169.254/latest/meta-data/$TOKEN"
# UDP datagram to the sink
try udp-sink sh -c "echo $TOKEN | nc -u -w $T $SINK 9999"
# DNS straight to the sink resolver
try dns-direct nslookup -timeout=$T "direct-$TOKEN.exfil.test" "$SINK"
# Indirect DNS through the configured resolver (Docker's embedded DNS)
try dns-indirect nslookup -timeout=$T "indirect-$TOKEN.exfil.test"
# IPv6: any global address or default route is reported
if ip -6 route 2>/dev/null | grep -q '^default'; then echo "RESULT ipv6-default-route present"; else echo "RESULT ipv6-default-route absent"; fi
if ip -6 addr 2>/dev/null | grep -q 'scope global'; then echo "RESULT ipv6-global-address present"; else echo "RESULT ipv6-global-address absent"; fi
if ip -4 route 2>/dev/null | grep -q '^default'; then echo "RESULT ipv4-default-route present"; else echo "RESULT ipv4-default-route absent"; fi
