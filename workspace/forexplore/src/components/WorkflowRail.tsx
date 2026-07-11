import { Check } from 'lucide-react';
import type { WorkflowStage } from '../domain/workflow';
import { getStepStatus, workflowSteps } from '../domain/workflow';

export function WorkflowRail({ stage }: { stage: WorkflowStage }) {
  return (
    <nav className="workflow-rail" aria-label="工作流进度">
      {workflowSteps.map((step, index) => {
        const status = getStepStatus(step.id, stage);
        return (
          <div className={`workflow-step is-${status}`} key={step.id}>
            <span className="workflow-step-marker">
              {status === 'done' ? <Check size={12} strokeWidth={2.5} /> : step.shortLabel}
            </span>
            <span className="workflow-step-label">{step.label}</span>
            {index < workflowSteps.length - 1 ? (
              <span className="workflow-step-line" aria-hidden="true" />
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}
