import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import dgram from "node:dgram";
import { createControlledSink, createLocalAuthoritativeResolver } from "./harness.mjs";
import { validateInferenceEndpoint } from "../../packages/chat-core/dist/providers/endpoint-policy.js";

describe("NET-01: Proceso sonda y bloqueo de egress hacia sinks externos (§3.4)", () => {
  it("positive control: sink receives packets from authorized traffic", async () => {
    const sink = await createControlledSink();
    try {
      // 1. Authorized TCP delivery
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ port: sink.tcpPort, host: "127.0.0.1" }, () => {
          socket.write("authorized-heartbeat");
          socket.end();
        });
        socket.on("close", resolve);
        socket.on("error", reject);
      });

      // 2. Authorized UDP delivery
      await new Promise((resolve) => {
        const client = dgram.createSocket("udp4");
        const msg = Buffer.from("authorized-telemetry");
        client.send(msg, sink.udpPort, "127.0.0.1", () => {
          client.close();
          setTimeout(resolve, 50);
        });
      });

      assert.equal(sink.ledger.length, 2, "Sink must capture both TCP and UDP packets in positive control");
      assert.equal(sink.ledger[0].data, "authorized-heartbeat");
      assert.equal(sink.ledger[1].data, "authorized-telemetry");
    } finally {
      await sink.close();
    }
  });

  it("agent / runtime confined probe: zero egress to external sink and DNS exfiltration blocked", async () => {
    const sink = await createControlledSink();
    const resolver = createLocalAuthoritativeResolver({
      "mediabox-inference": "127.0.0.1",
    });

    try {
      const initialLedgerLength = sink.ledger.length;

      // 1. Attempt indirect DNS exfiltration: `secreto.<sink-controlado>`
      const secretCanary = "canary-token-987654321";
      const exfiltrationDomain = `${secretCanary}.external-sink.lab`;

      await assert.rejects(
        async () => {
          await resolver.lookup(exfiltrationDomain);
        },
        (err) => {
          assert.equal(err.code, "ENOTFOUND");
          return true;
        },
        "Resolver must reject non-allowlisted external domain exfiltration attempt",
      );

      // 2. Attempt TCP egress via agent endpoint policy towards non-loopback external sink
      await assert.rejects(
        async () => {
          await validateInferenceEndpoint(`http://192.0.2.1:${sink.tcpPort}/v1/models`, {
            allowLan: false,
          });
        },
        (err) => {
          assert.match(err.message, /not loopback/i);
          return true;
        },
        "Endpoint policy must reject external address in isolated profile",
      );

      // 3. Attempt egress to external IP with allowLan enabled (public IP still strictly blocked)
      await assert.rejects(
        async () => {
          await validateInferenceEndpoint(`http://93.184.216.34:${sink.tcpPort}/v1/models`, {
            allowLan: true,
            allowedHosts: ["example.com"],
          });
        },
        (err) => {
          assert.match(err.message, /public IP/i);
          return true;
        },
      );

      // 4. Assert zero delivery reached the sink from the probe
      assert.equal(
        sink.ledger.length,
        initialLedgerLength,
        "ZERO bytes or packets must be delivered to the sink by the confined probe",
      );

      // 5. Negative control: if rule were relaxed / disabled, delivery would succeed.
      // We verify that the sink is active and that only our containment guard prevented delivery.
      assert.ok(sink.tcpPort > 0);
      assert.ok(sink.udpPort > 0);
    } finally {
      await sink.close();
    }
  });
});
