import React, { useState, useEffect } from "react";
import type { OperationPlanRecord } from "@mediabox/contracts";
import { AlertTriangle, Clock, Shield, X, Play, Ban } from "lucide-react";

interface OperationApprovalModalProps {
  planRecord: OperationPlanRecord;
  onApprove: (planId: string, manifestHash: string) => Promise<void>;
  onReject: (planId: string, reason: string) => Promise<void>;
  onCancel: (planId: string) => Promise<void>;
  onClose: () => void;
}

export const OperationApprovalModal: React.FC<OperationApprovalModalProps> = ({
  planRecord,
  onApprove,
  onReject,
  onCancel,
  onClose,
}) => {
  const { plan, status, steps, currentStep, totalSteps } = planRecord;
  const [secondsRemaining, setSecondsRemaining] = useState<number>(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const calculateTimeLeft = () => {
      const diff = Math.max(0, Math.floor((new Date(plan.expiresAt).getTime() - Date.now()) / 1000));
      setSecondsRemaining(diff);
    };

    calculateTimeLeft();
    const interval = setInterval(calculateTimeLeft, 1000);
    return () => clearInterval(interval);
  }, [plan.expiresAt]);

  const handleApprove = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      await onApprove(plan.id, plan.manifestHash);
    } catch (err: any) {
      setError(err?.message || "Error al aprobar la operación");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReject = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      await onReject(plan.id, "Rechazado por el usuario en la interfaz");
      onClose();
    } catch (err: any) {
      setError(err?.message || "Error al rechazar la operación");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      await onCancel(plan.id);
    } catch (err: any) {
      setError(err?.message || "Error al cancelar la operación");
    } finally {
      setIsSubmitting(false);
    }
  };

  const isExpired = secondsRemaining <= 0 && (status === "planned" || status === "awaiting_approval");
  const canApprove = (status === "planned" || status === "awaiting_approval") && !isExpired;
  const isRunning = status === "running" || status === "verifying" || status === "queued";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "1rem",
      }}
    >
      <div
        style={{
          backgroundColor: "#1e1e24",
          color: "#f3f4f6",
          borderRadius: "0.75rem",
          maxWidth: "600px",
          width: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.5)",
          border: "1px solid #374151",
          padding: "1.5rem",
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Shield size={24} color="#60a5fa" />
            <h2 style={{ fontSize: "1.25rem", fontWeight: "bold", margin: 0 }}>
              Aprobación de Operación: {plan.operation}
            </h2>
          </div>
          <button
            onClick={onClose}
            style={{ background: "transparent", border: "none", color: "#9ca3af", cursor: "pointer" }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Status and TTL indicator */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "0.75rem",
            backgroundColor: "#111827",
            borderRadius: "0.5rem",
          }}
        >
          <div>
            <span style={{ fontSize: "0.875rem", color: "#9ca3af" }}>Estado: </span>
            <strong style={{ color: isRunning ? "#34d399" : isExpired ? "#f87171" : "#60a5fa" }}>
              {status}
            </strong>
          </div>
          {canApprove && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.25rem", color: "#fbbf24" }}>
              <Clock size={16} />
              <span style={{ fontSize: "0.875rem", fontWeight: "bold" }}>
                Caduca en: {Math.floor(secondsRemaining / 60)}:
                {String(secondsRemaining % 60).padStart(2, "0")}
              </span>
            </div>
          )}
        </div>

        {/* Verification and Canonical Hash */}
        <div style={{ fontSize: "0.75rem", color: "#9ca3af", wordBreak: "break-all" }}>
          <span>Hash Canónico (§4.2): </span>
          <code style={{ color: "#a78bfa" }}>{plan.manifestHash}</code>
        </div>

        {/* Targets */}
        <div>
          <h4 style={{ fontSize: "0.875rem", fontWeight: "bold", color: "#d1d5db", margin: "0.5rem 0" }}>
            Objetivos Planificados ({plan.targets.length}):
          </h4>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            {plan.targets.map((t, idx) => (
              <div
                key={idx}
                style={{
                  fontSize: "0.8125rem",
                  padding: "0.5rem",
                  backgroundColor: "#2d3748",
                  borderRadius: "0.25rem",
                }}
              >
                <strong>{t.service}</strong>: {t.relativePath} (Root: {t.rootId})
              </div>
            ))}
          </div>
        </div>

        {/* Effects & Potential Irreversible Loss */}
        <div>
          <h4 style={{ fontSize: "0.875rem", fontWeight: "bold", color: "#d1d5db", margin: "0.5rem 0" }}>
            Efectos Previstos ({plan.effects.length}):
          </h4>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            {plan.effects.map((e, idx) => (
              <div
                key={idx}
                style={{
                  fontSize: "0.8125rem",
                  padding: "0.5rem",
                  backgroundColor: e.irreversibleLoss ? "#451a1a" : "#2d3748",
                  borderRadius: "0.25rem",
                  borderLeft: e.irreversibleLoss ? "4px solid #ef4444" : "none",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <strong>Acción: {e.serviceAction}</strong>
                  {e.irreversibleLoss && (
                    <span style={{ color: "#f87171", display: "flex", alignItems: "center", gap: "0.25rem" }}>
                      <AlertTriangle size={14} /> Pérdida irreversible
                    </span>
                  )}
                </div>
                {e.destination && <div>Destino: {e.destination}</div>}
              </div>
            ))}
          </div>
        </div>

        {/* Execution Steps & Progress */}
        {steps && steps.length > 0 && (
          <div>
            <h4 style={{ fontSize: "0.875rem", fontWeight: "bold", color: "#d1d5db", margin: "0.5rem 0" }}>
              Progreso de Ejecución ({currentStep || 0} / {totalSteps || steps.length}):
            </h4>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              {steps.map((s) => (
                <div
                  key={s.stepNumber}
                  style={{
                    fontSize: "0.8125rem",
                    padding: "0.5rem",
                    backgroundColor: s.status === "completed" ? "#064e3b" : s.status === "failed" ? "#7f1d1d" : "#1f2937",
                    borderRadius: "0.25rem",
                    display: "flex",
                    justifyContent: "space-between",
                  }}
                >
                  <span>
                    Paso {s.stepNumber}: {s.action}
                  </span>
                  <strong>{s.status}</strong>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div
            style={{
              padding: "0.5rem",
              backgroundColor: "#ef444420",
              border: "1px solid #ef4444",
              borderRadius: "0.25rem",
              color: "#f87171",
              fontSize: "0.875rem",
            }}
          >
            {error}
          </div>
        )}

        {/* Action Buttons */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1rem" }}>
          {canApprove && (
            <>
              <button
                onClick={handleReject}
                disabled={isSubmitting}
                style={{
                  padding: "0.5rem 1rem",
                  backgroundColor: "#374151",
                  color: "#f3f4f6",
                  border: "none",
                  borderRadius: "0.375rem",
                  cursor: "pointer",
                }}
              >
                Rechazar
              </button>
              <button
                onClick={handleApprove}
                disabled={isSubmitting}
                style={{
                  padding: "0.5rem 1rem",
                  backgroundColor: "#2563eb",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "0.375rem",
                  fontWeight: "bold",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.25rem",
                }}
              >
                <Play size={16} /> Aprobar y Encolar
              </button>
            </>
          )}

          {isRunning && (
            <button
              onClick={handleCancel}
              disabled={isSubmitting}
              style={{
                padding: "0.5rem 1rem",
                backgroundColor: "#dc2626",
                color: "#ffffff",
                border: "none",
                borderRadius: "0.375rem",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "0.25rem",
              }}
            >
              <Ban size={16} /> Cancelar Operación
            </button>
          )}

          {!canApprove && !isRunning && (
            <button
              onClick={onClose}
              style={{
                padding: "0.5rem 1rem",
                backgroundColor: "#374151",
                color: "#f3f4f6",
                border: "none",
                borderRadius: "0.375rem",
                cursor: "pointer",
              }}
            >
              Cerrar
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
