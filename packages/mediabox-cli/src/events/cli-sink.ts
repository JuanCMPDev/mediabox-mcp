import type { DeployEvent, EventHandler } from "@mediabox/core";
import type { Ora } from "ora";
import * as log from "../utils/logger.js";

/**
 * Render a stream of DeployEvents as terminal output (spinners, success
 * lines, warnings, errors). Exactly one spinner is active at a time, keyed
 * by phase; phase transitions close the previous spinner and print a
 * section header when the top-level prefix changes.
 */
export function createCliEventSink(): EventHandler {
  let activeSpinner: Ora | null = null;
  let activePhase: string | null = null;
  let lastPhaseGroup: string | null = null;

  const closeActive = (kind: "succeed" | "fail" | "warn" | "drop", msg?: string) => {
    if (!activeSpinner) return;
    if (kind === "succeed") activeSpinner.succeed(msg ?? activeSpinner.text);
    else if (kind === "fail") activeSpinner.fail(msg ?? activeSpinner.text);
    else if (kind === "warn") activeSpinner.warn(msg ?? activeSpinner.text);
    else activeSpinner.stop();
    activeSpinner = null;
    activePhase = null;
  };

  const phaseGroup = (phase: string): string => {
    const idx = phase.indexOf(":");
    return idx > 0 ? phase.slice(0, idx) : phase;
  };

  const maybePrintHeader = (phase: string) => {
    const group = phaseGroup(phase);
    if (group === lastPhaseGroup) return;
    lastPhaseGroup = group;
    const titles: Record<string, string> = {
      "config": "Validation",
      "generate": "Phase 2 — Generating configuration files",
      "deploy": "Phase 3 — Docker lifecycle",
      "discover": "Discovering API keys",
      "configure": "Phase 4 — Configuring services",
      "write": "Phase 4 — Updating environment",
    };
    const title = titles[group];
    if (title) log.header(title);
  };

  return (event: DeployEvent) => {
    if (event.kind === "log") {
      if (event.level === "info") log.info(event.message);
      return;
    }

    // Any non-log event has a phase
    const { phase, message } = event;

    if (event.kind === "start") {
      // Different phase → close the previous spinner (if any) as dropped
      if (activePhase && activePhase !== phase) closeActive("drop");
      maybePrintHeader(phase);
      activePhase = phase;
      activeSpinner = log.spinner(message);
      return;
    }

    if (event.kind === "progress") {
      if (activeSpinner && activePhase === phase) {
        const pct = event.percent !== undefined ? ` (${event.percent}%)` : "";
        activeSpinner.text = `${message}${pct}`;
      } else {
        // no active spinner — just emit a one-liner
        log.info(message);
      }
      return;
    }

    if (event.kind === "success") {
      if (activeSpinner && activePhase === phase) {
        closeActive("succeed", message);
      } else {
        log.success(message);
      }
      return;
    }

    if (event.kind === "warn") {
      if (activeSpinner && activePhase === phase) {
        closeActive("warn", message);
      } else {
        log.warn(message);
      }
      return;
    }

    if (event.kind === "error") {
      if (activeSpinner && activePhase === phase) {
        closeActive("fail", message);
      } else {
        log.error(message);
      }
      return;
    }
  };
}
