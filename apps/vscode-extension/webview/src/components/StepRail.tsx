import { Check } from 'lucide-react';
import {
  getStepStatus,
  workflowSteps,
  type WorkflowStage,
} from '@forexplore/workflow-core';

interface StepRailProps {
  stage: WorkflowStage;
  activeStep: WorkflowStage;
  onStepChange(step: WorkflowStage): void;
}

export function StepRail({ stage, activeStep, onStepChange }: StepRailProps) {
  return (
    <nav className="step-rail" aria-label="工作流进度">
      {workflowSteps.map((step, index) => {
        const status = getStepStatus(step.id, stage);
        const navigable = status !== 'upcoming';
        return (
          <div
            className={`step is-${status}${activeStep === step.id ? ' is-current-view' : ''}`}
            key={step.id}
          >
            <button
              type="button"
              className="step-button"
              disabled={!navigable}
              aria-current={activeStep === step.id ? 'step' : undefined}
              aria-label={`${step.shortLabel} ${step.label}${navigable ? '' : '（尚未到达）'}`}
              title={navigable ? `查看：${step.label}` : '完成前序步骤后可查看'}
              onClick={() => onStepChange(step.id)}
            >
              <span className="step-marker">
                {status === 'done' ? <Check size={11} strokeWidth={2.6} /> : step.shortLabel}
              </span>
              <span className="step-label">{step.label}</span>
            </button>
            {index < workflowSteps.length - 1 ? <span className="step-line" /> : null}
          </div>
        );
      })}
    </nav>
  );
}
