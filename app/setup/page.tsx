'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { BookOpen, CheckCircle, Loader2, Server, Key, User } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

type Step = 'account' | 'providers' | 'connectivity' | 'done';

const STEPS: Step[] = ['account', 'providers', 'connectivity', 'done'];

function StepIndicator({ current, step }: { current: Step; step: Step }) {
  const idx = STEPS.indexOf(step);
  const curIdx = STEPS.indexOf(current);
  const done = curIdx > idx;
  const active = curIdx === idx;
  return (
    <div
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold',
        done && 'bg-primary text-primary-foreground',
        active && 'border-2 border-primary text-primary',
        !done && !active && 'border-2 border-muted text-muted-foreground',
      )}
    >
      {done ? <CheckCircle className="h-4 w-4" /> : idx + 1}
    </div>
  );
}

export default function SetupPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('account');
  const [loading, setLoading] = useState(false);

  // Step 1: Admin account
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Step 2: Local AI providers
  const [geminiKeys, setGeminiKeys] = useState('');
  const [ollamaUrl, setOllamaUrl] = useState('http://127.0.0.1:11434/v1');
  const [ttsUrl, setTtsUrl] = useState('http://127.0.0.1:8880/v1');
  const [asrUrl, setAsrUrl] = useState('http://127.0.0.1:8881/v1');

  // Step 3: connectivity results
  const [connectResults, setConnectResults] = useState<Record<string, boolean | null>>({
    ollama: null,
    tts: null,
    asr: null,
  });

  async function handleCreateAccount(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch('/api/setup/create-admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create admin account');
      }
      setStep('providers');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveProviders(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch('/api/setup/save-providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          geminiKeys: geminiKeys
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean),
          ollamaUrl,
          ttsUrl,
          asrUrl,
        }),
      });
      if (!res.ok) throw new Error('Failed to save provider config');
      setStep('connectivity');
      await testConnectivity();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  async function testConnectivity() {
    const services = { ollama: ollamaUrl, tts: ttsUrl, asr: asrUrl };
    const results: Record<string, boolean | null> = { ollama: null, tts: null, asr: null };

    await Promise.allSettled(
      Object.entries(services).map(async ([key, url]) => {
        try {
          const res = await fetch('/api/setup/test-connectivity', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
          });
          results[key] = res.ok;
        } catch {
          results[key] = false;
        }
      }),
    );
    setConnectResults(results);
  }

  function handleFinish() {
    router.push('/login?callbackUrl=/admin');
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-lg space-y-6">
        {/* Header */}
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <BookOpen className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-bold">Welcome to NeoAcademy</h1>
          <p className="text-sm text-muted-foreground">First-run setup — takes about 2 minutes</p>
        </div>

        {/* Step indicators */}
        <div className="flex items-center justify-center gap-3">
          {STEPS.map((s, i) => (
            <div key={s} className="flex items-center gap-3">
              <StepIndicator current={step} step={s} />
              {i < STEPS.length - 1 && <div className="h-px w-8 bg-border" />}
            </div>
          ))}
        </div>

        {/* Step 1: Admin account */}
        {step === 'account' && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <User className="h-5 w-5 text-primary" />
                <CardTitle>Create admin account</CardTitle>
              </div>
              <CardDescription>
                This will be your admin login for managing NeoAcademy
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleCreateAccount} className="space-y-4" id="account-form">
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    placeholder="Your name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="setup-email">Email</Label>
                  <Input
                    id="setup-email"
                    type="email"
                    placeholder="admin@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="setup-password">Password</Label>
                  <Input
                    id="setup-password"
                    type="password"
                    placeholder="Choose a strong password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                  />
                </div>
              </form>
            </CardContent>
            <CardFooter>
              <Button type="submit" form="account-form" className="w-full" disabled={loading}>
                {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Create account & continue
              </Button>
            </CardFooter>
          </Card>
        )}

        {/* Step 2: Provider config */}
        {step === 'providers' && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Key className="h-5 w-5 text-primary" />
                <CardTitle>Configure AI providers</CardTitle>
              </div>
              <CardDescription>
                Configure your local AI servers. Gemini is optional in fully-local mode.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSaveProviders} className="space-y-4" id="providers-form">
                <div className="space-y-2">
                  <Label htmlFor="gemini-keys">
                    Gemini API keys{' '}
                    <span className="text-xs text-muted-foreground">
                      (optional — leave blank for fully-local mode)
                    </span>
                  </Label>
                  <Input
                    id="gemini-keys"
                    placeholder="Optional"
                    value={geminiKeys}
                    onChange={(e) => setGeminiKeys(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ollama-url">Ollama server URL</Label>
                  <Input
                    id="ollama-url"
                    value={ollamaUrl}
                    onChange={(e) => setOllamaUrl(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tts-url">Kokoro TTS URL</Label>
                  <Input
                    id="tts-url"
                    value={ttsUrl}
                    onChange={(e) => setTtsUrl(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="asr-url">Whisper ASR URL</Label>
                  <Input
                    id="asr-url"
                    value={asrUrl}
                    onChange={(e) => setAsrUrl(e.target.value)}
                    required
                  />
                </div>
              </form>
            </CardContent>
            <CardFooter>
              <Button type="submit" form="providers-form" className="w-full" disabled={loading}>
                {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Save & test connectivity
              </Button>
            </CardFooter>
          </Card>
        )}

        {/* Step 3: Connectivity */}
        {step === 'connectivity' && (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Server className="h-5 w-5 text-primary" />
                <CardTitle>Connectivity check</CardTitle>
              </div>
              <CardDescription>Verifying connections to your local AI servers</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {[
                { key: 'ollama', label: 'Ollama (Qwen 3.8 27B)', url: ollamaUrl },
                { key: 'tts', label: 'Kokoro TTS', url: ttsUrl },
                { key: 'asr', label: 'Whisper ASR', url: asrUrl },
              ].map(({ key, label, url }) => (
                <div key={key} className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <p className="text-sm font-medium">{label}</p>
                    <p className="text-xs text-muted-foreground">{url}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {connectResults[key] === null && (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    )}
                    {connectResults[key] === true && (
                      <span className="flex items-center gap-1 text-xs text-green-500">
                        <CheckCircle className="h-4 w-4" /> Connected
                      </span>
                    )}
                    {connectResults[key] === false && (
                      <span className="text-xs text-destructive">Unreachable</span>
                    )}
                  </div>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Unreachable servers can be reconfigured anytime in the admin portal.
              </p>
            </CardContent>
            <CardFooter>
              <Button className="w-full" onClick={() => setStep('done')}>
                Continue
              </Button>
            </CardFooter>
          </Card>
        )}

        {/* Step 4: Done */}
        {step === 'done' && (
          <Card>
            <CardHeader className="text-center">
              <CheckCircle className="mx-auto h-12 w-12 text-green-500" />
              <CardTitle className="mt-2">NeoAcademy is ready!</CardTitle>
              <CardDescription>
                Sign in with your admin account to access the admin portal
              </CardDescription>
            </CardHeader>
            <CardFooter>
              <Button className="w-full" onClick={handleFinish}>
                Go to admin portal
              </Button>
            </CardFooter>
          </Card>
        )}
      </div>
    </div>
  );
}
