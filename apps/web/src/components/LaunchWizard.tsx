import { useCallback, useState } from 'react';
import type { ConnectionTestResponse } from '../types';
import { Icon } from './Icon';
import { testApiProvider } from '../providers/connection-test';
import {
  DEEPSEEK_RUNTIME_PROVIDER,
  SILICONFLOW_RUNTIME_PROVIDER,
} from '../state/config';

type StepId = 'deepseek' | 'siliconflow';

interface StepState {
  apiKey: string;
  testing: boolean;
  testResult: ConnectionTestResponse | null;
}

const INITIAL_STEPS: Record<StepId, StepState> = {
  deepseek: { apiKey: '', testing: false, testResult: null },
  siliconflow: { apiKey: '', testing: false, testResult: null },
};

export interface WizardKeys {
  deepseekKey: string;
  siliconflowKey: string;
}

interface ProviderConfig {
  protocol: 'anthropic' | 'openai';
  baseUrl: string;
  defaultModel: string;
  label: string;
  desc: string;
}

const STEP_ORDER: StepId[] = ['deepseek', 'siliconflow'];

const WIZARD_COPY = {
  title: 'Quick setup',
  subtitle: 'Connect DeepSeek and SiliconFlow before your first run.',
  stepNumber: (current: number, total: number) => `Step ${current} of ${total}`,
  testSuccess: (model: string, latency: number) => `Connected to ${model} in ${latency} ms`,
  testFailed: 'Connection failed',
  testing: 'Testing...',
  testConnection: 'Test connection',
  skip: 'Skip for now',
  previous: 'Previous',
  next: 'Next',
  saving: 'Saving...',
  complete: 'Complete setup',
} as const;

function getProviderConfig(step: StepId): ProviderConfig {
  switch (step) {
    case 'deepseek':
      return {
        protocol: 'anthropic',
        baseUrl: DEEPSEEK_RUNTIME_PROVIDER.baseUrl,
        defaultModel: DEEPSEEK_RUNTIME_PROVIDER.model,
        label: DEEPSEEK_RUNTIME_PROVIDER.label,
        desc: 'Use the Anthropic-compatible DeepSeek endpoint.',
      };
    case 'siliconflow':
      return {
        protocol: 'openai',
        baseUrl: SILICONFLOW_RUNTIME_PROVIDER.baseUrl,
        defaultModel: SILICONFLOW_RUNTIME_PROVIDER.model,
        label: SILICONFLOW_RUNTIME_PROVIDER.label,
        desc: 'Use the OpenAI-compatible SiliconFlow endpoint.',
      };
  }
}

interface Props {
  onComplete: (keys: WizardKeys) => void;
  onSkip: () => void;
}

export function LaunchWizard({ onComplete, onSkip }: Props) {
  const [currentStepIdx, setCurrentStepIdx] = useState(0);
  const [steps, setSteps] = useState<Record<StepId, StepState>>(INITIAL_STEPS);
  const [completing, setCompleting] = useState(false);

  const currentStep: StepId = STEP_ORDER[currentStepIdx]!;
  const currentState = steps[currentStep];
  const cfg = getProviderConfig(currentStep);

  const setApiKey = useCallback(
    (value: string) => {
      setSteps((prev) => ({
        ...prev,
        [currentStep]: { ...prev[currentStep], apiKey: value, testResult: null },
      }));
    },
    [currentStep],
  );
  const handleTest = useCallback(async () => {
    const key = currentState.apiKey.trim();
    if (!key) return;

    const model = cfg.defaultModel;
    if (!model) return;

    setSteps((prev) => ({
      ...prev,
      [currentStep]: { ...prev[currentStep], testing: true, testResult: null },
    }));

    const result = await testApiProvider({
      protocol: cfg.protocol,
      baseUrl: cfg.baseUrl,
      apiKey: key,
      model,
    });

    setSteps((prev) => ({
      ...prev,
      [currentStep]: { ...prev[currentStep], testing: false, testResult: result },
    }));
  }, [currentState.apiKey, currentStep, cfg.baseUrl, cfg.defaultModel, cfg.protocol]);

  const handleNext = useCallback(() => {
    if (currentStepIdx < STEP_ORDER.length - 1) {
      setCurrentStepIdx((p) => p + 1);
    }
  }, [currentStepIdx]);

  const handlePrev = useCallback(() => {
    if (currentStepIdx > 0) {
      setCurrentStepIdx((p) => p - 1);
    }
  }, [currentStepIdx]);

  const handleComplete = useCallback(() => {
    setCompleting(true);
    onComplete({
      deepseekKey: steps.deepseek.apiKey,
      siliconflowKey: steps.siliconflow.apiKey,
    });
  }, [steps, onComplete]);

  const allPassed = STEP_ORDER.every(
    (id) => steps[id].testResult?.ok === true,
  );
  const canProceed = currentState.testResult?.ok === true;
  const stepCount = STEP_ORDER.length;

  return (
    <div className="modal-backdrop">
      <div className="modal wizard-modal" role="dialog" aria-modal="true" aria-label={WIZARD_COPY.title}>
        <div className="wizard-header">
          <h2 className="wizard-title">{WIZARD_COPY.title}</h2>
          <p className="wizard-subtitle">{WIZARD_COPY.subtitle}</p>
          <div className="wizard-steps-indicator">
            {STEP_ORDER.map((id, idx) => {
              let cls = 'wizard-step-dot';
              if (steps[id].testResult?.ok) cls += ' done';
              else if (idx === currentStepIdx) cls += ' active';
              return (
                <button
                  key={id}
                  type="button"
                  className={cls}
                  disabled={idx > currentStepIdx && !steps[STEP_ORDER[idx - 1]!]?.testResult?.ok}
                  onClick={() => {
                    if (idx <= currentStepIdx || steps[STEP_ORDER[idx - 1]!]?.testResult?.ok) {
                      setCurrentStepIdx(idx);
                    }
                  }}
                >
                  {steps[id].testResult?.ok ? (
                    <Icon name="check" size={12} />
                  ) : (
                    idx + 1
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="wizard-body">
          <div className="wizard-step-header">
            <h3 className="wizard-step-title">
              {`${WIZARD_COPY.stepNumber(currentStepIdx + 1, stepCount)} ${cfg.label}`}
            </h3>
            <p className="wizard-step-desc">{cfg.desc}</p>
          </div>

          <div className="wizard-input-group">
            <label className="wizard-label" htmlFor="wizard-api-key">
              API Key
            </label>
            <input
              id="wizard-api-key"
              className="wizard-input"
              type="password"
              placeholder="sk-..."
              value={currentState.apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && currentState.apiKey.trim()) {
                  void handleTest();
                }
              }}
              autoFocus
              spellCheck={false}
            />
          </div>
          {currentState.testResult && (
            <div className={`wizard-test-result ${currentState.testResult.ok ? 'success' : 'error'}`}>
              {currentState.testResult.ok ? (
                <>
                  <Icon name="check" size={14} />
                  <span>
                    {WIZARD_COPY.testSuccess(
                      currentState.testResult.model ?? cfg.defaultModel,
                      currentState.testResult.latencyMs,
                    )}
                  </span>
                </>
              ) : (
                <>
                  <Icon name="close" size={14} />
                  <span>
                    {WIZARD_COPY.testFailed}
                    {currentState.testResult.detail && (
                      <> — {currentState.testResult.detail}</>
                    )}
                  </span>
                </>
              )}
            </div>
          )}

          <div className="wizard-actions">
            <button
              type="button"
              className="wizard-btn wizard-btn-test"
              onClick={() => void handleTest()}
              disabled={!currentState.apiKey.trim() || currentState.testing }
            >
              {currentState.testing ? (
                <><Icon name="spinner" size={14} className="icon-spin" /> {WIZARD_COPY.testing}</>
              ) : (
                WIZARD_COPY.testConnection
              )}
            </button>
          </div>
        </div>

        <div className="wizard-footer">
          <button
            type="button"
            className="wizard-btn wizard-btn-skip"
            onClick={onSkip}
          >
            {WIZARD_COPY.skip}
          </button>

          <div className="wizard-nav">
            {currentStepIdx > 0 && (
              <button
                type="button"
                className="wizard-btn wizard-btn-prev"
                onClick={handlePrev}
              >
                {WIZARD_COPY.previous}
              </button>
            )}

            {currentStepIdx < stepCount - 1 ? (
              <button
                type="button"
                className="wizard-btn wizard-btn-next"
                onClick={handleNext}
                disabled={!canProceed}
              >
                {WIZARD_COPY.next}
              </button>
            ) : (
              <button
                type="button"
                className="wizard-btn wizard-btn-complete"
                onClick={handleComplete}
                disabled={!allPassed || completing}
              >
                {completing ? (
                  <><Icon name="spinner" size={14} className="icon-spin" /> {WIZARD_COPY.saving}</>
                ) : (
                  WIZARD_COPY.complete
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
