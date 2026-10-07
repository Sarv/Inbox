import { Loader2, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useMountedTimeout } from '../../../hooks/useMountedTimeout';
import {
  loadAISettings, PROVIDER_CONFIGS, removeProvider, setDefaultProvider, syncAIProviderToMain,
  testProvider, type AIProvider,
} from '../../../services/ai-service';
import { AISetupStep, type AISetupStage } from '../../onboarding/AISetupStep';
import { ProviderIcon } from '../../onboarding/ProviderIcon';
import { SetupDialog } from '../../SetupDialog';
import { IconButton } from '../../Tooltip';

interface ProvidersTabProps {
  aiProviders: AIProvider[];
  setAiProviders: React.Dispatch<React.SetStateAction<AIProvider[]>>;
}

export function ProvidersTab({ aiProviders, setAiProviders }: ProvidersTabProps) {
  const [flow, setFlow] = useState<{ editing?: AIProvider } | null>(null);
  const [stage, setStage] = useState<AISetupStage>('provider');
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; success: boolean; message: string } | null>(null);
  const [keyStorageWarning, setKeyStorageWarning] = useState(false);
  const [saving, setSaving] = useState(false);
  const testRequest = useRef(0);
  const schedule = useMountedTimeout();
  useEffect(() => () => { testRequest.current++; }, []);

  const refresh = () => {
    setAiProviders(loadAISettings().providers);
    void syncAIProviderToMain();
  };

  const openFlow = (editing?: AIProvider) => {
    setStage(editing ? 'connection' : 'provider');
    setFlow(editing ? { editing } : {});
  };

  const handleTestProvider = async (provider: AIProvider) => {
    const request = ++testRequest.current;
    setTestingProviderId(provider.id);
    setTestResult(null);
    const result = await testProvider(provider);
    if (request !== testRequest.current) return;
    setTestResult({ id: provider.id, ...result });
    setTestingProviderId(null);
    schedule(() => { if (request === testRequest.current) setTestResult(null); }, 5000);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div><h3 className="text-lg font-semibold">AI providers</h3><p className="mt-1 text-sm text-muted-foreground">Connect a provider and choose the model Inbox uses.</p></div>
        <button type="button" onClick={() => openFlow()} className="flex shrink-0 items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"><Plus className="h-4 w-4" />Add provider</button>
      </div>
      {keyStorageWarning && <p role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm">Your device has no available system keyring. This API key is saved without encryption. Enable a system keyring for encrypted storage.</p>}
      {aiProviders.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-8 text-center"><p className="font-medium">No AI providers connected</p><p className="mt-2 text-sm text-muted-foreground">Add Sarv AI, OpenAI, Google Gemini or your own AI server.</p></div>
      ) : (
        <div className="space-y-3">
          {aiProviders.map((provider) => (
            <div key={provider.id} className={`flex flex-wrap items-center justify-between gap-4 rounded-2xl border p-4 ${provider.isDefault ? 'border-primary bg-primary/5' : 'border-border bg-muted/30'}`}>
              <div className="flex min-w-0 items-center gap-3">
                <ProviderIcon id={provider.type === 'sarv' ? 'sarv-ai' : provider.type} className="h-9 w-9 shrink-0" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 font-medium">{provider.name}{provider.isDefault && <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary"><Star className="h-3 w-3 fill-primary" />Default</span>}</div>
                  <div className="text-sm text-muted-foreground">Model: {PROVIDER_CONFIGS[provider.type].models.find((model) => model.id === provider.model)?.name || provider.model}</div>
                  {provider.authMethod === 'oauth' && <div className="text-xs text-muted-foreground">Connected as {provider.oauthEmail}</div>}
                  {provider.baseUrl && <div className="mt-0.5 break-all text-xs text-muted-foreground">{provider.baseUrl}</div>}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {testResult?.id === provider.id && <span role="status" className={`rounded-lg px-2 py-1 text-xs ${testResult.success ? 'bg-green-500/10 text-green-600' : 'bg-destructive/10 text-destructive'}`}>{testResult.message}</span>}
                <button type="button" aria-label={`Test ${provider.name}`} onClick={() => { void handleTestProvider(provider); }} disabled={testingProviderId === provider.id} className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50">{testingProviderId === provider.id && <Loader2 className="h-4 w-4 animate-spin" />}Test</button>
                <IconButton onClick={() => openFlow(provider)} icon={<Pencil className="h-4 w-4" />} tooltip={`Edit ${provider.name}`} size="sm" />
                {!provider.isDefault && <button type="button" onClick={() => { setDefaultProvider(provider.id); refresh(); }} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-accent">Make default</button>}
                <IconButton onClick={() => { removeProvider(provider.id); refresh(); }} icon={<Trash2 className="h-4 w-4" />} tooltip={`Remove ${provider.name}`} className="text-destructive hover:bg-destructive/10" size="sm" />
              </div>
            </div>
          ))}
        </div>
      )}
      {flow && (
        <SetupDialog title={flow.editing ? `Edit ${flow.editing.name}` : 'Add AI provider'} steps={['Provider', 'Connection', 'Model']} activeStep={(['provider', 'connection', 'model'] as const).indexOf(stage)} closeDisabled={saving} onClose={() => setFlow(null)}>
          <AISetupStep
            context="settings" editingProvider={flow.editing} stage={stage} active preferSarv={false}
            onStageChange={setStage} onBackToEmail={() => setFlow(null)} onSavingChange={setSaving}
            onComplete={(result) => {
              if (result.enabled) {
                refresh();
                setKeyStorageWarning(result.keyStorageEncrypted === false);
              }
              setFlow(null);
            }}
          />
        </SetupDialog>
      )}
    </div>
  );
}
