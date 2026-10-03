import { promises as fs } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import type { ChatSession } from '@/lib/types/chat';
import type { SceneOutline } from '@/lib/types/generation';
import type { Slide } from '@/lib/types/slides';
import type { Scene, Stage } from '@/lib/types/stage';

export const CLASSROOMS_DIR = path.join(process.cwd(), 'data', 'classrooms');
export const CLASSROOM_JOBS_DIR = path.join(process.cwd(), 'data', 'classroom-jobs');
export const CLASSROOM_LOGS_DIR = path.join(process.cwd(), 'data', 'classroom-logs');

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function ensureClassroomsDir() {
  await ensureDir(CLASSROOMS_DIR);
}

export async function ensureClassroomJobsDir() {
  await ensureDir(CLASSROOM_JOBS_DIR);
}

export async function ensureClassroomLogsDir() {
  await ensureDir(CLASSROOM_LOGS_DIR);
}

export async function writeJsonFileAtomic(filePath: string, data: unknown) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(tempFilePath, content, 'utf-8');
  await fs.rename(tempFilePath, filePath);
}

export function buildRequestOrigin(req: NextRequest): string {
  return req.headers.get('x-forwarded-host')
    ? `${req.headers.get('x-forwarded-proto') || 'http'}://${req.headers.get('x-forwarded-host')}`
    : req.nextUrl.origin;
}

export type ClassroomPersistenceStatus =
  | 'generating'
  | 'completed'
  | 'failed';

export interface PersistedClassroomData {
  id: string;
  stage: Stage;
  scenes: Scene[];
  currentSceneId?: string | null;
  chats?: ChatSession[];
  outlines?: SceneOutline[];
  status: ClassroomPersistenceStatus;
  error?: string;
  requirement?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClassroomHistoryItem {
  id: string;
  name: string;
  description?: string;
  sceneCount: number;
  createdAt: number;
  updatedAt: number;
  status: ClassroomPersistenceStatus;
  error?: string;
  requirement?: string;
  thumbnail?: Slide;
}

export function isValidClassroomId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

function classroomFilePath(id: string): string {
  return path.join(CLASSROOMS_DIR, `${id}.json`);
}

export async function readClassroom(id: string): Promise<PersistedClassroomData | null> {
  const filePath = classroomFilePath(id);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content) as PersistedClassroomData;

    return {
      ...parsed,
      status: parsed.status || 'completed',
      updatedAt: parsed.updatedAt || parsed.createdAt,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export async function persistClassroom(
  data: {
    id: string;
    stage: Stage;
    scenes: Scene[];
    currentSceneId?: string | null;
    chats?: ChatSession[];
    outlines?: SceneOutline[];
    status?: ClassroomPersistenceStatus;
    error?: string;
    requirement?: string;
  },
  baseUrl: string,
): Promise<PersistedClassroomData & { url: string }> {
  if (!isValidClassroomId(data.id)) {
    throw new Error(`Invalid classroom id: ${data.id}`);
  }

  const existing = await readClassroom(data.id);
  const now = new Date().toISOString();

  const classroomData: PersistedClassroomData = {
    id: data.id,
    stage: data.stage,
    scenes: data.scenes,
    currentSceneId:
      data.currentSceneId ??
      existing?.currentSceneId ??
      data.scenes[0]?.id ??
      null,
    chats: data.chats ?? existing?.chats ?? [],
    outlines: data.outlines ?? existing?.outlines ?? [],
    status: data.status ?? existing?.status ?? 'completed',
    error:
      data.status === 'completed'
        ? undefined
        : data.error ?? existing?.error,
    requirement: data.requirement ?? existing?.requirement,
    createdAt:
      existing?.createdAt ||
      new Date(data.stage.createdAt || Date.now()).toISOString(),
    updatedAt: now,
  };

  await ensureClassroomsDir();
  await writeJsonFileAtomic(classroomFilePath(data.id), classroomData);

  return {
    ...classroomData,
    url: `${baseUrl}/classroom/${data.id}`,
  };
}

export async function listClassrooms(): Promise<ClassroomHistoryItem[]> {
  await ensureClassroomsDir();

  const entries = await fs.readdir(CLASSROOMS_DIR, {
    withFileTypes: true,
  });

  const classrooms: ClassroomHistoryItem[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const id = entry.name.slice(0, -5);

    if (!isValidClassroomId(id)) {
      continue;
    }

    try {
      const classroom = await readClassroom(id);

      if (!classroom) {
        continue;
      }

      const firstSlideScene = classroom.scenes.find(
        (scene) => scene.content?.type === 'slide',
      );

      const thumbnail =
        firstSlideScene?.content.type === 'slide'
          ? firstSlideScene.content.canvas
          : undefined;

      classrooms.push({
        id: classroom.id,
        name:
          classroom.stage.name ||
          classroom.requirement ||
          'Untitled Classroom',
        description: classroom.stage.description,
        sceneCount: classroom.scenes.length,
        createdAt: new Date(classroom.createdAt).getTime(),
        updatedAt: new Date(classroom.updatedAt).getTime(),
        status: classroom.status,
        error: classroom.error,
        requirement: classroom.requirement,
        thumbnail,
      });
    } catch (error) {
      console.warn(
        `Skipping unreadable classroom history file: ${entry.name}`,
        error,
      );
    }
  }

  classrooms.sort((a, b) => b.updatedAt - a.updatedAt);

  return classrooms;
}

export interface ClassroomFailureDiagnostics {
  classroomId: string;
  timestamp: string;
  error: {
    name?: string;
    message: string;
    stack?: string;
  };
  requirement?: string;
  currentStepIndex?: number;
  currentStepId?: string;
  currentStepLabel?: string;
  statusMessage?: string;
  generationStatus?: string;
  currentGeneratingOrder?: number;
  sceneCount?: number;
  scenes?: Array<{
    id?: string;
    order?: number;
    title?: string;
    type?: string;
  }>;
  outlineCount?: number;
  outlines?: Array<{
    id?: string;
    order?: number;
    title?: string;
  }>;
  failedOutlines?: Array<{
    id?: string;
    order?: number;
    title?: string;
  }>;
  generatingOutlines?: Array<{
    id?: string;
    order?: number;
    title?: string;
  }>;
  sourceFiles?: string[];
  truncationWarnings?: string[];
  userAgent?: string;
  serverDiagnostics?: string[];
}

function classroomFailureLogPath(id: string): string {
  return path.join(CLASSROOM_LOGS_DIR, `${id}.log`);
}

export async function writeClassroomFailureLog(
  diagnostics: ClassroomFailureDiagnostics,
): Promise<string> {
  if (!isValidClassroomId(diagnostics.classroomId)) {
    throw new Error(
      `Invalid classroom id: ${diagnostics.classroomId}`,
    );
  }

  await ensureClassroomLogsDir();

  const lines = [
    'NeoAcademy classroom generation failure',
    '======================================',
    '',
    `Classroom ID: ${diagnostics.classroomId}`,
    `Timestamp: ${diagnostics.timestamp}`,
    `Error name: ${diagnostics.error.name || 'Error'}`,
    `Error message: ${diagnostics.error.message}`,
    '',
    'Generation state',
    '----------------',
    `Generation status: ${diagnostics.generationStatus || 'unknown'}`,
    `Current step index: ${diagnostics.currentStepIndex ?? 'unknown'}`,
    `Current step id: ${diagnostics.currentStepId || 'unknown'}`,
    `Current step label: ${diagnostics.currentStepLabel || 'unknown'}`,
    `Status message: ${diagnostics.statusMessage || ''}`,
    `Current generating order: ${diagnostics.currentGeneratingOrder ?? 'unknown'}`,
    `Scenes generated: ${diagnostics.sceneCount ?? 0}`,
    `Outlines planned: ${diagnostics.outlineCount ?? 0}`,
    '',
    'Requirement',
    '-----------',
    diagnostics.requirement || '',
    '',
    'Source files',
    '------------',
    ...(diagnostics.sourceFiles?.length
      ? diagnostics.sourceFiles.map((fileName) => `- ${fileName}`)
      : ['(none recorded)']),
    '',
    'Completed scenes',
    '----------------',
    ...(diagnostics.scenes?.length
      ? diagnostics.scenes.map(
          (scene) =>
            `- order=${scene.order ?? '?'} id=${scene.id || '?'} ` +
            `type=${scene.type || '?'} title=${scene.title || ''}`,
        )
      : ['(none)']),
    '',
    'Planned outlines',
    '----------------',
    ...(diagnostics.outlines?.length
      ? diagnostics.outlines.map(
          (outline) =>
            `- order=${outline.order ?? '?'} id=${outline.id || '?'} ` +
            `title=${outline.title || ''}`,
        )
      : ['(none)']),
    '',
    'Failed outlines',
    '---------------',
    ...(diagnostics.failedOutlines?.length
      ? diagnostics.failedOutlines.map(
          (outline) =>
            `- order=${outline.order ?? '?'} id=${outline.id || '?'} ` +
            `title=${outline.title || ''}`,
        )
      : ['(none)']),
    '',
    'Still-generating outlines',
    '-------------------------',
    ...(diagnostics.generatingOutlines?.length
      ? diagnostics.generatingOutlines.map(
          (outline) =>
            `- order=${outline.order ?? '?'} id=${outline.id || '?'} ` +
            `title=${outline.title || ''}`,
        )
      : ['(none)']),
    '',
    'Warnings',
    '--------',
    ...(diagnostics.truncationWarnings?.length
      ? diagnostics.truncationWarnings.map((warning) => `- ${warning}`)
      : ['(none)']),
    '',
    'Recent server WARN/ERROR diagnostics',
    '------------------------------------',
    ...(diagnostics.serverDiagnostics?.length
      ? diagnostics.serverDiagnostics
      : ['(none captured)']),
    '',
    'Browser',
    '-------',
    diagnostics.userAgent || '',
    '',
    'Stack trace',
    '-----------',
    diagnostics.error.stack || '(no stack trace available)',
    '',
  ];

  const filePath = classroomFailureLogPath(
    diagnostics.classroomId,
  );

  await fs.writeFile(
    filePath,
    lines.join('\n'),
    'utf-8',
  );

  return filePath;
}

export async function readClassroomFailureLog(
  id: string,
): Promise<string | null> {
  if (!isValidClassroomId(id)) {
    throw new Error(`Invalid classroom id: ${id}`);
  }

  try {
    return await fs.readFile(
      classroomFailureLogPath(id),
      'utf-8',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export async function deleteClassroomFailureLog(
  id: string,
): Promise<void> {
  if (!isValidClassroomId(id)) {
    throw new Error(`Invalid classroom id: ${id}`);
  }

  try {
    await fs.unlink(classroomFailureLogPath(id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }

    throw error;
  }
}
export async function deleteClassroom(id: string): Promise<void> {
  if (!isValidClassroomId(id)) {
    throw new Error(`Invalid classroom id: ${id}`);
  }

  try {
    await fs.unlink(classroomFilePath(id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  await deleteClassroomFailureLog(id);
}