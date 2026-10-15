'use client';

import { useEffect, useState, useRef, useMemo } from 'react';
import {
  Bot,
  Check,
  ChevronLeft,
  Globe,
  Paperclip,
  FileText,
  X,
  Globe2,
  ListChecks,
  ShieldCheck,
  BookOpen,
  Library,
} from 'lucide-react';
import { BOOK_STYLES, type BookStyle } from '@/lib/book/styles';
import { Switch } from '@/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderId } from '@/lib/pdf/types';
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import type { WebSearchProviderId } from '@/lib/web-search/types';
import type { ProviderId } from '@/lib/ai/providers';
import type { SettingsSection } from '@/lib/types/settings';
import { MediaPopover } from '@/components/generation/media-popover';

// ─── Constants ───────────────────────────────────────────────
const MAX_PDF_SIZE_MB = 50;
const MAX_PDF_SIZE_BYTES = MAX_PDF_SIZE_MB * 1024 * 1024;

// ─── Types ───────────────────────────────────────────────────
export interface GenerationToolbarProps {
  language: 'en-US';
  onLanguageChange: (lang: 'en-US') => void;
  webSearch: boolean;
  onWebSearchChange: (v: boolean) => void;
  /** Pause after the outline for review / revision before generating scenes. */
  reviewOutline: boolean;
  onReviewOutlineChange: (v: boolean) => void;
  /** Shown for ebooks only: fact-check every section against docs / web. */
  showFactCheck?: boolean;
  /** Ebooks only: documentation on this PC that claims are checked against. */
  referenceLibraries?: Array<{ tool: string; path: string }>;
  onReferenceLibrariesChange?: (v: Array<{ tool: string; path: string }>) => void;
  /** Ebooks only: quick how-to / beginner's guide / in-depth advanced. */
  bookStyle?: BookStyle;
  onBookStyleChange?: (v: BookStyle) => void;
  factCheck?: boolean;
  onFactCheckChange?: (v: boolean) => void;
  onSettingsOpen: (section?: SettingsSection) => void;
  // PDF
  pdfFiles: File[];
  onPdfFilesChange: (files: File[]) => void;
  onPdfError: (error: string | null) => void;
}

// ─── Component ───────────────────────────────────────────────
export function GenerationToolbar({
  language,
  onLanguageChange,
  webSearch,
  onWebSearchChange,
  reviewOutline,
  onReviewOutlineChange,
  showFactCheck,
  referenceLibraries,
  onReferenceLibrariesChange,
  bookStyle,
  onBookStyleChange,
  factCheck,
  onFactCheckChange,
  onSettingsOpen,
  pdfFiles,
  onPdfFilesChange,
  onPdfError,
}: GenerationToolbarProps) {
  const { t } = useI18n();
  const currentProviderId = useSettingsStore((s) => s.providerId);
  const currentModelId = useSettingsStore((s) => s.modelId);
  const providersConfig = useSettingsStore((s) => s.providersConfig);
  const setModel = useSettingsStore((s) => s.setModel);
  const pdfProviderId = useSettingsStore((s) => s.pdfProviderId);
  const pdfProvidersConfig = useSettingsStore((s) => s.pdfProvidersConfig);
  const setPDFProvider = useSettingsStore((s) => s.setPDFProvider);
  const webSearchProviderId = useSettingsStore((s) => s.webSearchProviderId);
  const webSearchProvidersConfig = useSettingsStore((s) => s.webSearchProvidersConfig);
  const setWebSearchProvider = useSettingsStore((s) => s.setWebSearchProvider);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Default the front-page source parser to MinerU even when an
  // older persisted browser setting still points to another parser.
  useEffect(() => {
    if (pdfProviderId !== 'mineru') {
      setPDFProvider('mineru');
    }
  }, [pdfProviderId, setPDFProvider]);

  // Check if the selected web search provider has a valid config (API key or server-configured)
  const webSearchProvider = WEB_SEARCH_PROVIDERS[webSearchProviderId];
  const webSearchConfig = webSearchProvidersConfig[webSearchProviderId];
  const webSearchAvailable = webSearchProvider
    ? !webSearchProvider.requiresApiKey ||
      !!webSearchConfig?.apiKey ||
      !!webSearchConfig?.isServerConfigured
    : false;

  // Configured LLM providers (only those with valid credentials + models + endpoint)
  const configuredProviders = providersConfig
    ? Object.entries(providersConfig)
        .filter(
          ([, config]) =>
            (!config.requiresApiKey || config.apiKey || config.isServerConfigured) &&
            config.models.length >= 1 &&
            (config.baseUrl || config.defaultBaseUrl || config.serverBaseUrl),
        )
        .map(([id, config]) => ({
          id: id as ProviderId,
          name: config.name,
          icon: config.icon,
          isServerConfigured: config.isServerConfigured,
          models:
            config.isServerConfigured && !config.apiKey && config.serverModels?.length
              ? config.models.filter((m) => new Set(config.serverModels).has(m.id))
              : config.models,
        }))
    : [];

  const currentProviderConfig = providersConfig?.[currentProviderId];

  // Source handler
  const handleFilesSelect = (incomingFiles: File[]) => {
    const validFiles: File[] = [];

    const mineruSelected =
      pdfProviderId === 'mineru';

    for (const file of incomingFiles) {
      const lowerName =
        file.name.toLowerCase();

      const isPdf =
        file.type === 'application/pdf' ||
        lowerName.endsWith('.pdf');

      const isImage =
        file.type === 'image/jpeg' ||
        file.type === 'image/png' ||
        file.type === 'image/webp' ||
        lowerName.endsWith('.jpg') ||
        lowerName.endsWith('.jpeg') ||
        lowerName.endsWith('.png') ||
        lowerName.endsWith('.webp');

      const isDirectSource =
        file.type === 'text/plain' ||
        file.type === 'text/markdown' ||
        file.type === 'application/json' ||
        file.type === 'text/json' ||
        file.type === 'application/xml' ||
        file.type === 'text/xml' ||
        file.type === 'text/csv' ||
        lowerName.endsWith('.txt') ||
        lowerName.endsWith('.md') ||
        lowerName.endsWith('.markdown') ||
        lowerName.endsWith('.json') ||
        lowerName.endsWith('.xml') ||
        lowerName.endsWith('.csv');

      const isDocx =
        file.type ===
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        lowerName.endsWith('.docx');

      const isXlsx =
        file.type ===
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        lowerName.endsWith('.xlsx');

      const supported =
        isPdf ||
        isDirectSource ||
        isDocx ||
        isXlsx ||
        (mineruSelected && isImage);

      if (!supported) {
        continue;
      }

      if (file.size > MAX_PDF_SIZE_BYTES) {
        onPdfError(t('upload.fileTooLarge'));
        return;
      }

      validFiles.push(file);
    }

    if (validFiles.length === 0) {
      return;
    }

    const combined = [...pdfFiles];

    for (const file of validFiles) {
      const duplicate = combined.some(
        (existing) =>
          existing.name === file.name &&
          existing.size === file.size &&
          existing.lastModified === file.lastModified,
      );

      if (!duplicate) {
        combined.push(file);
      }
    }

    onPdfError(null);
    onPdfFilesChange(combined);
  };

  // ─── Pill button helper ─────────────────────────────
  const pillCls =
    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-all cursor-pointer select-none whitespace-nowrap border';
  const pillMuted = `${pillCls} border-border/50 text-muted-foreground/70 hover:text-foreground hover:bg-muted/60`;
  const pillActive = `${pillCls} border-violet-200/60 dark:border-violet-700/50 bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300`;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {/* ── Model selector ── */}
      {configuredProviders.length > 0 ? (
        <ModelSelectorPopover
          configuredProviders={configuredProviders}
          currentProviderId={currentProviderId}
          currentModelId={currentModelId}
          currentProviderConfig={currentProviderConfig}
          setModel={setModel}
          t={t}
        />
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => onSettingsOpen('providers')}
              className={cn(
                pillCls,
                'text-amber-600 dark:text-amber-400 animate-pulse',
                'bg-amber-50 dark:bg-amber-950/30 hover:bg-amber-100 dark:hover:bg-amber-950/50',
              )}
            >
              <Bot className="size-3.5" />
              <span>{t('toolbar.configureProvider')}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('toolbar.configureProviderHint')}</TooltipContent>
        </Tooltip>
      )}

      {/* ── Separator ── */}
      <div className="w-px h-4 bg-border/60 mx-1" />

      {/* ── PDF (parser + upload) combined Popover ── */}
      <Popover>
        <PopoverTrigger asChild>
          {pdfFiles.length > 0 ? (
            <button className={pillActive}>
              <Paperclip className="size-3.5" />
              <span className="max-w-[120px] truncate">
                {pdfFiles.length === 1
                  ? pdfFiles[0].name
                  : `${pdfFiles.length} sources`}
              </span>
              <span
                role="button"
                className="size-4 rounded-full inline-flex items-center justify-center hover:bg-violet-200 dark:hover:bg-violet-800 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  onPdfFilesChange([]);
                }}
              >
                <X className="size-2.5" />
              </span>
            </button>
          ) : (
            <button className={pillMuted}>
              <Paperclip className="size-3.5" />
            </button>
          )}
        </PopoverTrigger>

        <PopoverContent align="start" className="w-80 p-0">
          <div className="flex items-center gap-2 px-3 pt-3 pb-2">
            <span className="text-xs font-medium text-muted-foreground shrink-0">
              {t('toolbar.pdfParser')}
            </span>

            <Select
              value={pdfProviderId}
              onValueChange={(v) =>
                setPDFProvider(v as PDFProviderId)
              }
            >
              <SelectTrigger className="h-7 text-xs flex-1 min-w-0">
                <SelectValue />
              </SelectTrigger>

              <SelectContent>
                {Object.values(PDF_PROVIDERS).map((provider) => {
                  const cfg =
                    pdfProvidersConfig[provider.id];

                  const available =
                    !provider.requiresApiKey ||
                    !!cfg?.apiKey ||
                    !!cfg?.isServerConfigured;

                  return (
                    <SelectItem
                      key={provider.id}
                      value={provider.id}
                      disabled={!available}
                    >
                      <div
                        className={cn(
                          'flex items-center gap-1.5',
                          !available && 'opacity-50',
                        )}
                      >
                        {provider.icon && (
                          <img
                            src={provider.icon}
                            alt={provider.name}
                            className="w-3.5 h-3.5"
                          />
                        )}

                        {provider.name}

                        {cfg?.isServerConfigured && (
                          <span className="text-[9px] px-1 py-0 rounded border text-muted-foreground">
                            {t('settings.serverConfigured')}
                          </span>
                        )}
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          <div className="px-3 pb-3 space-y-2">
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept={
                pdfProviderId === 'mineru'
                  ? '.pdf,.jpg,.jpeg,.png,.webp,.txt,.md,.markdown,.json,.xml,.csv,.docx,.xlsx'
                  : '.pdf,.txt,.md,.markdown,.json,.xml,.csv,.docx,.xlsx'
              }
              multiple
              onChange={(e) => {
                handleFilesSelect(
                  Array.from(e.target.files ?? []),
                );
                e.target.value = '';
              }}
            />

            {pdfFiles.length > 0 && (
              <div className="space-y-1">
                {pdfFiles.map((file, index) => (
                  <div
                    key={`${file.name}-${file.size}-${file.lastModified}`}
                    className="flex items-center gap-2 rounded-lg border px-2 py-2"
                  >
                    <div className="size-7 rounded-md bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center shrink-0">
                      <FileText className="size-3.5 text-violet-600 dark:text-violet-400" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate">
                        {file.name}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {(file.size / 1024 / 1024).toFixed(2)} MB
                      </p>
                    </div>

                    <button
                      type="button"
                      className="size-7 rounded-md inline-flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-muted"
                      onClick={() => {
                        onPdfFilesChange(
                          pdfFiles.filter(
                            (_, fileIndex) =>
                              fileIndex !== index,
                          ),
                        );
                      }}
                      aria-label={`Remove ${file.name}`}
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div
              className={cn(
                'flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-4 transition-colors cursor-pointer',
                isDragging
                  ? 'border-violet-400 bg-violet-50 dark:bg-violet-950/20'
                  : 'border-muted-foreground/20 hover:border-violet-300',
              )}
              onClick={() =>
                fileInputRef.current?.click()
              }
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() =>
                setIsDragging(false)
              }
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);

                handleFilesSelect(
                  Array.from(e.dataTransfer.files ?? []),
                );
              }}
            >
              <Paperclip className="size-5 text-muted-foreground/50 mb-1.5" />

              <p className="text-xs font-medium">
                {pdfFiles.length > 0
                  ? 'Add more sources'
                  : 'Add sources'}
              </p>

              <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                {pdfProviderId === 'mineru'
                  ? t('upload.sourceSizeLimit')
                  : t('upload.pdfSizeLimit')}
              </p>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {/* ── Web Search ── */}
      {webSearchAvailable ? (
        <Popover>
          <PopoverTrigger asChild>
            <button className={webSearch ? pillActive : pillMuted}>
              <Globe2 className={cn('size-3.5', webSearch && 'animate-pulse')} />
              {webSearch && (
                <span>{WEB_SEARCH_PROVIDERS[webSearchProviderId]?.name || 'Search'}</span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-3 space-y-3">
            {/* Toggle */}
            <button
              onClick={() => onWebSearchChange(!webSearch)}
              className={cn(
                'w-full flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-all',
                webSearch
                  ? 'bg-violet-50 dark:bg-violet-950/20 border-violet-200 dark:border-violet-800'
                  : 'border-border hover:bg-muted/50',
              )}
            >
              <Globe2
                className={cn(
                  'size-4 shrink-0',
                  webSearch ? 'text-violet-600 dark:text-violet-400' : 'text-muted-foreground',
                )}
              />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium">
                  {webSearch ? t('toolbar.webSearchOn') : t('toolbar.webSearchOff')}
                </p>
                <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                  {t('toolbar.webSearchDesc')}
                </p>
              </div>
            </button>

            {/* Provider selector */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground shrink-0">
                {t('toolbar.webSearchProvider')}
              </span>
              <Select
                value={webSearchProviderId}
                onValueChange={(v) => setWebSearchProvider(v as WebSearchProviderId)}
              >
                <SelectTrigger className="h-7 text-xs flex-1 min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(WEB_SEARCH_PROVIDERS).map((provider) => {
                    const cfg = webSearchProvidersConfig[provider.id];
                    const available =
                      !provider.requiresApiKey || !!cfg?.apiKey || !!cfg?.isServerConfigured;
                    return (
                      <SelectItem key={provider.id} value={provider.id} disabled={!available}>
                        <div
                          className={cn('flex items-center gap-1.5', !available && 'opacity-50')}
                        >
                          {provider.name}
                          {cfg?.isServerConfigured && (
                            <span className="text-[9px] px-1 py-0 rounded border text-muted-foreground">
                              {t('settings.serverConfigured')}
                            </span>
                          )}
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          </PopoverContent>
        </Popover>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <button className={cn(pillCls, 'text-muted-foreground/40 cursor-not-allowed')} disabled>
              <Globe2 className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('toolbar.webSearchNoProvider')}</TooltipContent>
        </Tooltip>
      )}

      {/* ── Pause for outline review ── */}
      <Tooltip>
        <TooltipTrigger asChild>
          <label
            htmlFor="review-outline-switch"
            className={cn(reviewOutline ? pillActive : pillMuted, 'cursor-pointer select-none')}
          >
            <ListChecks className="size-3.5" />
            <span>Review outline</span>
            <Switch
              id="review-outline-switch"
              checked={reviewOutline}
              onCheckedChange={onReviewOutlineChange}
              className="scale-75 -mr-1"
              aria-label="Pause for outline review"
            />
          </label>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">
          Pause for outline review: stop after the outline is generated so you can edit it or
          revise it with notes before the class is built. Turn off for unattended generation.
        </TooltipContent>
      </Tooltip>

      {/* ── Book style (ebooks) ── */}
      {showFactCheck && (
        <Select value={bookStyle ?? 'advanced'} onValueChange={(v) => onBookStyleChange?.(v as BookStyle)}>
          <SelectTrigger
            size="sm"
            className={cn(pillActive, 'h-7 w-auto gap-1.5 border-0 shadow-none focus-visible:ring-0')}
            aria-label="Book style"
          >
            <BookOpen className="size-3.5" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            {Object.values(BOOK_STYLES).map((style) => (
              <SelectItem key={style.id} value={style.id} textValue={style.label}>
                <div className="flex flex-col">
                  <span>{style.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {style.hint} · ~{style.pages} pages
                  </span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* ── Reference docs (ebooks) ── */}
      {showFactCheck && (
        <ReferenceDocsPopover
          libraries={referenceLibraries ?? []}
          onChange={(v) => onReferenceLibrariesChange?.(v)}
          pillActive={pillActive}
          pillMuted={pillMuted}
        />
      )}

      {/* ── Fact-check (ebooks) ── */}
      {showFactCheck && (
        <Tooltip>
          <TooltipTrigger asChild>
            <label
              htmlFor="fact-check-switch"
              className={cn(factCheck ? pillActive : pillMuted, 'cursor-pointer select-none')}
            >
              <ShieldCheck className="size-3.5" />
              <span>Fact-check</span>
              <Switch
                id="fact-check-switch"
                checked={!!factCheck}
                onCheckedChange={(v) => onFactCheckChange?.(v)}
                className="scale-75 -mr-1"
                aria-label="Fact-check every section"
              />
            </label>
          </TooltipTrigger>
          <TooltipContent className="max-w-72">
            Verify each section's commands, options and APIs against the installed tools' own
            documentation (and web search if enabled), then have a technical editor fix errors.
            Roughly doubles writing time.
          </TooltipContent>
        </Tooltip>
      )}

      {/* ── Separator ── */}
      <div className="w-px h-4 bg-border/60 mx-1" />

      {/* ── Media popover ── */}
      <MediaPopover onSettingsOpen={onSettingsOpen} />
    </div>
  );
}

// ─── ModelSelectorPopover (two-level: provider → model) ─────
interface ConfiguredProvider {
  id: ProviderId;
  name: string;
  icon?: string;
  isServerConfigured?: boolean;
  models: { id: string; name: string }[];
}

function ModelSelectorPopover({
  configuredProviders,
  currentProviderId,
  currentModelId,
  currentProviderConfig,
  setModel,
  t,
}: {
  configuredProviders: ConfiguredProvider[];
  currentProviderId: ProviderId;
  currentModelId: string;
  currentProviderConfig: { name: string; icon?: string } | undefined;
  setModel: (providerId: ProviderId, modelId: string) => void;
  t: (key: string) => string;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  // null = provider list, ProviderId = model list for that provider
  const [drillProvider, setDrillProvider] = useState<ProviderId | null>(null);

  const activeProvider = useMemo(
    () => configuredProviders.find((p) => p.id === drillProvider),
    [configuredProviders, drillProvider],
  );

  return (
    <Popover
      open={popoverOpen}
      onOpenChange={(open) => {
        setPopoverOpen(open);
        if (open) setDrillProvider(null);
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              className={cn(
                'inline-flex items-center justify-center size-7 rounded-full transition-all cursor-pointer select-none',
                'ring-1 ring-border/60 hover:ring-border hover:bg-muted/60',
                currentModelId &&
                  'ring-violet-300 dark:ring-violet-700 bg-violet-50 dark:bg-violet-950/20',
              )}
            >
              {currentProviderConfig?.icon ? (
                <img
                  src={currentProviderConfig.icon}
                  alt={currentProviderConfig.name}
                  className="size-4 rounded-sm"
                />
              ) : (
                <Bot className="size-3.5 text-muted-foreground" />
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          {currentModelId
            ? `${currentProviderConfig?.name || currentProviderId} / ${currentModelId}`
            : t('settings.selectModel')}
        </TooltipContent>
      </Tooltip>

      <PopoverContent align="start" className="w-64 p-0">
        {/* Level 1: Provider list */}
        {!drillProvider && (
          <div className="max-h-72 overflow-y-auto">
            <div className="px-3 py-2 border-b">
              <span className="text-xs font-semibold text-muted-foreground">
                {t('toolbar.selectProvider')}
              </span>
            </div>
            {configuredProviders.map((provider) => {
              const isActive = currentProviderId === provider.id;
              return (
                <button
                  key={provider.id}
                  onClick={() => setDrillProvider(provider.id)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors border-b border-border/30',
                    isActive ? 'bg-violet-50/50 dark:bg-violet-950/10' : 'hover:bg-muted/50',
                  )}
                >
                  {provider.icon ? (
                    <img
                      src={provider.icon}
                      alt={provider.name}
                      className="size-5 rounded-sm shrink-0"
                    />
                  ) : (
                    <Bot className="size-5 text-muted-foreground shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{provider.name}</span>
                    {provider.isServerConfigured && (
                      <span className="text-[9px] px-1 py-0 rounded border text-muted-foreground ml-1.5">
                        {t('settings.serverConfigured')}
                      </span>
                    )}
                  </div>
                  {isActive && currentModelId && (
                    <span className="text-[10px] text-muted-foreground truncate max-w-[80px]">
                      {currentModelId}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Level 2: Model list for selected provider */}
        {drillProvider && activeProvider && (
          <div className="max-h-72 overflow-y-auto">
            {/* Back header */}
            <button
              onClick={() => setDrillProvider(null)}
              className="w-full flex items-center gap-2 px-3 py-2 border-b bg-muted/40 hover:bg-muted/60 transition-colors"
            >
              <ChevronLeft className="size-3.5 text-muted-foreground" />
              {activeProvider.icon ? (
                <img
                  src={activeProvider.icon}
                  alt={activeProvider.name}
                  className="size-4 rounded-sm"
                />
              ) : (
                <Bot className="size-4 text-muted-foreground" />
              )}
              <span className="text-xs font-semibold">{activeProvider.name}</span>
              <span className="text-[10px] text-muted-foreground ml-auto">
                {activeProvider.models.length} {t('settings.modelCount')}
              </span>
            </button>
            {/* Models */}
            {activeProvider.models.map((model) => {
              const isSelected = currentProviderId === drillProvider && currentModelId === model.id;
              return (
                <button
                  key={model.id}
                  onClick={() => {
                    setModel(drillProvider, model.id);
                    setPopoverOpen(false);
                  }}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2 text-left transition-colors border-b border-border/30',
                    isSelected
                      ? 'bg-violet-50 dark:bg-violet-950/20 text-violet-700 dark:text-violet-300'
                      : 'hover:bg-muted/50',
                  )}
                >
                  <span className="flex-1 truncate font-mono text-xs">{model.name}</span>
                  {isSelected && (
                    <Check className="size-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Ebooks: documentation folders / zips on this PC that the book's claims are
 * checked against (e.g. Ghidra's API Javadoc zip, node_modules/typescript/lib).
 */
function ReferenceDocsPopover({
  libraries,
  onChange,
  pillActive,
  pillMuted,
}: {
  libraries: Array<{ tool: string; path: string }>;
  onChange: (v: Array<{ tool: string; path: string }>) => void;
  pillActive: string;
  pillMuted: string;
}) {
  const [tool, setTool] = useState('');
  const [docPath, setDocPath] = useState('');
  const add = () => {
    const t = tool.trim().toLowerCase();
    const p = docPath.trim().replace(/^"|"$/g, '');
    if (!t || !p) return;
    onChange([...libraries.filter((l) => !(l.tool === t && l.path === p)), { tool: t, path: p }]);
    setTool('');
    setDocPath('');
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={cn(libraries.length ? pillActive : pillMuted)} aria-label="Reference docs">
          <Library className="size-3.5" />
          <span>Reference docs{libraries.length ? ` (${libraries.length})` : ''}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 space-y-3 text-sm">
        <div>
          <p className="font-medium">Reference documentation</p>
          <p className="text-xs text-muted-foreground">
            Folders or .zip files on this PC that the book is fact-checked against. A name is only
            reported as non-existent if it appears nowhere in its tool&apos;s documentation.
          </p>
        </div>
        {libraries.length > 0 && (
          <ul className="space-y-1">
            {libraries.map((l) => (
              <li key={`${l.tool}|${l.path}`} className="flex items-center gap-2 rounded border px-2 py-1">
                <span className="shrink-0 rounded bg-muted px-1.5 text-xs font-medium">{l.tool}</span>
                <span className="min-w-0 flex-1 truncate text-xs" title={l.path}>
                  {l.path}
                </span>
                <button
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => onChange(libraries.filter((x) => x !== l))}
                  aria-label={`Remove ${l.tool} documentation`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-1.5">
          <input
            className="w-full rounded border bg-background px-2 py-1 text-xs"
            placeholder="Tool, e.g. ghidra or typescript"
            value={tool}
            onChange={(e) => setTool(e.target.value)}
          />
          <input
            className="w-full rounded border bg-background px-2 py-1 font-mono text-xs"
            placeholder="C:\ghidra_11.4\docs\GhidraAPI_javadoc.zip"
            value={docPath}
            onChange={(e) => setDocPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button
            className="w-full rounded bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
            disabled={!tool.trim() || !docPath.trim()}
            onClick={add}
          >
            Add documentation
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Examples: <b>typescript</b> → <code>…\NeoAcademy\node_modules\typescript\lib</code> ·{' '}
          <b>ghidra</b> → <code>&lt;Ghidra&gt;\docs\GhidraAPI_javadoc.zip</code> · any folder of HTML,
          Markdown or text docs.
        </p>
      </PopoverContent>
    </Popover>
  );
}
