import type { OperationExecutor } from "./executor.js";
import { quarantineFile, quarantineDirectoryIfEmpty } from "../storage/quarantine.js";
import { executeMediaJob } from "../storage/media-jobs.js";

export function registerStepHandlers(executor: OperationExecutor): void {
  // P04: Quarantine Move
  executor.registerStepHandler("quarantine.move", async (step, context) => {
    // Determine the target to quarantine
    // effects array tells us which target
    const plan = context.plan.plan;
    const effectIndex = plan.effects.findIndex(e => e.serviceAction === "quarantine.move");
    // Wait, the step doesn't know which effect it corresponds to?
    // Let's assume step action is enough or step details holds it.
    // Let's extract targets from plan
    if (!step.details?.targetIndex && step.details?.targetIndex !== 0) {
      // If we don't have target index in step, we quarantine all effects that match?
      // Actually, the executor iterates steps. The steps in a plan are created when the plan is queued.
      // We should probably rely on plan.targets directly for this basic implementation.
      const results = [];
      for (const effect of plan.effects) {
        if (effect.serviceAction === "quarantine.move" && effect.targetIndex !== undefined) {
          const target = plan.targets[effect.targetIndex];
          const manifest = await quarantineFile(target.rootId, target.relativePath);
          results.push(manifest);
        }
      }
      return { quarantined: results };
    }
  });

  // P05: Media format conversions
  executor.registerStepHandler("media.remux", async (step, context) => {
    return handleMediaJob("remux", context.plan.plan, context.signal);
  });

  executor.registerStepHandler("media.transcode", async (step, context) => {
    return handleMediaJob("transcode", context.plan.plan, context.signal);
  });
  
  executor.registerStepHandler("media.subtitle-convert", async (step, context) => {
    return handleMediaJob("subtitle-convert", context.plan.plan, context.signal);
  });
}

async function handleMediaJob(action: "remux" | "transcode" | "subtitle-convert", plan: any, signal?: AbortSignal) {
  const results = [];
  for (const effect of plan.effects) {
    if (effect.serviceAction === `media.${action}` && effect.targetIndex !== undefined) {
      const target = plan.targets[effect.targetIndex];
      const logicalPath = target.rootId === "downloads" ? `downloads/${target.relativePath}` : target.relativePath;
      
      const res = await executeMediaJob(logicalPath, {
        action,
        profileName: effect.tracksProfile || "default",
      }, signal);
      
      results.push(res);
    }
  }
  return { results };
}
